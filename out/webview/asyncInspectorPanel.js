"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AsyncInspectorPanel = void 0;
const vscode = __importStar(require("vscode"));
/**
 * Async Inspector Panel - Webview for displaying async execution trees
 */
class AsyncInspectorPanel {
    constructor(panel, extensionUri, debugAdapterFactory) {
        this._disposables = [];
        this._treeRoots = new Map(); // root CID -> tree node
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._debugAdapterFactory = debugAdapterFactory;
        // Set the webview's initial html content
        this._update();
        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'reset':
                    await this.handleReset();
                    break;
                case 'genWhitelist':
                    await this.handleGenWhitelist();
                    break;
                case 'trace':
                    await this.handleTrace(message.symbol);
                    break;
                case 'snapshot':
                    await this.handleSnapshot();
                    break;
                case 'selectNode':
                    await this.handleSelectNode(message.cid);
                    break;
                case 'locate':
                    await this.handleLocate(message.symbol);
                    break;
                case 'refreshCandidates':
                    await this.handleRefreshCandidates();
                    break;
            }
        }, null, this._disposables);
        // Listen for debug session changes
        vscode.debug.onDidChangeActiveDebugSession((session) => {
            this._debugSession = session?.type === 'ardb' ? session : undefined;
        }, null, this._disposables);
    }
    static createOrShow(extensionUri, debugAdapterFactory) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;
        // If we already have a panel, show it
        if (AsyncInspectorPanel.currentPanel) {
            AsyncInspectorPanel.currentPanel._panel.reveal(column);
            return AsyncInspectorPanel.currentPanel;
        }
        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel('asyncInspector', 'Async Inspector', column || vscode.ViewColumn.Two, {
            enableScripts: true,
            localResourceRoots: [extensionUri],
            retainContextWhenHidden: true
        });
        AsyncInspectorPanel.currentPanel = new AsyncInspectorPanel(panel, extensionUri, debugAdapterFactory);
        return AsyncInspectorPanel.currentPanel;
    }
    reveal() {
        this._panel.reveal();
    }
    /**
     * Called when the debug adapter sends a "stopped" event.
     * Triggers snapshot refresh automatically when the inferior has been
     * started (not the synthetic "entry" stop).
     *
     * Uses a small delay to let VS Code's own stopped-event handling
     * (threads, stackTrace) settle first, avoiding request conflicts.
     */
    onDebugStopped(session, stoppedBody) {
        this._debugSession = session;
        const isEntry = stoppedBody?.reason === 'entry';
        console.log(`[AsyncInspector] onDebugStopped reason=${stoppedBody?.reason} isEntry=${isEntry} hasSession=${!!this._debugSession}`);
        // Serialize requests to avoid race conditions in the GDB MI2 command
        // pipeline — concurrent evaluate requests can cause console output to
        // be misrouted via the shared lastSentToken in gdbAdapter.
        setTimeout(async () => {
            try {
                if (!isEntry) {
                    await this.handleSnapshot();
                }
            }
            catch (e) {
                console.error('[AsyncInspector] onDebugStopped handlers failed:', e);
            }
        }, 300);
    }
    async handleReset() {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            await session.reset();
            this._treeRoots.clear();
            this._update();
            vscode.window.showInformationMessage('ARD reset completed');
        }
    }
    async handleGenWhitelist() {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            await session.genWhitelist();
            // Refresh candidates after generating
            await this.handleRefreshCandidates();
        }
    }
    async handleTrace(symbol) {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            await session.traceFunction(symbol);
            vscode.window.showInformationMessage(`Tracing: ${symbol}`);
        }
    }
    async handleSnapshot() {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            console.warn('[AsyncInspector] handleSnapshot: no GDB session from factory');
            return;
        }
        const snapshot = await session.getSnapshot();
        console.log('[AsyncInspector] handleSnapshot: result =', snapshot ? `thread_id=${snapshot.thread_id}, path.length=${snapshot.path.length}` : 'null');
        if (snapshot) {
            this._lastSnapshot = snapshot;
            this.updateTreeFromSnapshot(snapshot);
            this._panel.webview.postMessage({
                command: 'updateTree',
                treeData: Array.from(this._treeRoots.values()),
            });
        }
    }
    async handleSelectNode(cid) {
        if (cid === null || !this._debugSession) {
            return;
        }
        const snapshot = this._lastSnapshot;
        if (!snapshot) {
            return;
        }
        // Find the frame index for this CID in the snapshot path.
        // The snapshot path is ordered root → leaf (async chain).
        // We map this to the physical GDB stack frame index.
        let targetFrameIndex = -1;
        for (let i = 0; i < snapshot.path.length; i++) {
            const node = snapshot.path[i];
            if (node.type === 'async' && node.cid === cid) {
                targetFrameIndex = snapshot.path.length - 1 - i;
                break;
            }
        }
        if (targetFrameIndex >= 0) {
            try {
                // Get real frame IDs from the stack trace
                const stackTrace = await this._debugSession.customRequest('stackTrace', {
                    threadId: snapshot.thread_id,
                    startFrame: 0,
                    levels: 200,
                });
                const frames = stackTrace?.stackFrames || [];
                if (frames.length > targetFrameIndex) {
                    const frame = frames[targetFrameIndex];
                    // Use evaluate to switch GDB to this frame, which updates
                    // the variables view via the debug session
                    await this._debugSession.customRequest('evaluate', {
                        expression: `frame ${targetFrameIndex}`,
                        context: 'repl',
                    });
                    // Also open the source file at the frame location
                    if (frame.source?.path) {
                        await this.handleSelectFrame(frame.source.path, frame.line || 0);
                    }
                }
            }
            catch (error) {
                console.error('Failed to switch frame:', error);
            }
        }
    }
    async handleLocate(symbol) {
        // Use GDB's "info line" command to find the source location of the symbol.
        // The candidate symbols are fully-qualified GDB names (e.g.
        // "my_crate::my_module::my_async_fn") that workspace symbol providers
        // cannot resolve, but GDB can map them to source files directly.
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            vscode.window.showWarningMessage('No active debug session');
            return;
        }
        try {
            const output = await session.executeGDBCommand(`info line '${symbol}'`);
            // GDB output format: "Line 42 of \"src/main.rs\" starts at address ..."
            const match = output.match(/Line\s+(\d+)\s+of\s+"([^"]+)"/);
            if (match) {
                const line = parseInt(match[1], 10);
                const filePath = match[2];
                await this.handleSelectFrame(filePath, line);
            }
            else {
                vscode.window.showWarningMessage(`Cannot locate source for: ${symbol}`);
            }
        }
        catch (error) {
            console.error('Failed to locate symbol:', error);
            vscode.window.showWarningMessage(`Failed to locate: ${symbol}`);
        }
    }
    async handleRefreshCandidates() {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            const candidates = await session.getWhitelistCandidates();
            this._panel.webview.postMessage({
                command: 'updateCandidates',
                candidates: candidates
            });
        }
    }
    /**
     * Handle frame selection from the webview.
     * Opens the source file at the given line in VS Code editor.
     */
    async handleSelectFrame(file, line) {
        if (!file) {
            return;
        }
        try {
            // GDB may return relative paths (e.g. "src/main.rs").
            // Resolve them against the workspace folder to get an absolute path.
            let uri;
            if (file.startsWith('/')) {
                uri = vscode.Uri.file(file);
            }
            else {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
                if (workspaceFolder) {
                    uri = vscode.Uri.joinPath(workspaceFolder, file);
                }
                else {
                    uri = vscode.Uri.file(file);
                }
            }
            const doc = await vscode.workspace.openTextDocument(uri);
            const targetLine = Math.max(0, line - 1); // VS Code lines are 0-based
            await vscode.window.showTextDocument(doc, {
                selection: new vscode.Range(targetLine, 0, targetLine, 0),
                preserveFocus: false,
                viewColumn: vscode.ViewColumn.One,
            });
        }
        catch (error) {
            console.error('Failed to open source file:', error);
            vscode.window.showWarningMessage(`Cannot open file: ${file}`);
        }
    }
    updateTreeFromSnapshot(snapshot) {
        if (snapshot.path.length === 0) {
            return;
        }
        // Find the root async node (first async node in path)
        let rootIndex = -1;
        for (let i = 0; i < snapshot.path.length; i++) {
            if (snapshot.path[i].type === 'async') {
                rootIndex = i;
                break;
            }
        }
        if (rootIndex < 0) {
            return; // No async nodes
        }
        const rootNode = snapshot.path[rootIndex];
        if (rootNode.cid === null) {
            return;
        }
        // Get or create root tree node
        let root = this._treeRoots.get(rootNode.cid);
        if (!root) {
            root = {
                type: 'async',
                cid: rootNode.cid,
                func: rootNode.func,
                addr: rootNode.addr,
                poll: rootNode.poll,
                state: rootNode.state,
                children: []
            };
            this._treeRoots.set(rootNode.cid, root);
        }
        else {
            root.poll = rootNode.poll;
            root.state = rootNode.state;
        }
        // Build the child chain from the snapshot path
        this.mergePathIntoTree(root, snapshot.path, rootIndex + 1);
    }
    /**
     * Merge the snapshot path (from startIndex onward) into the tree under `parent`.
     * - Async nodes are matched by CID and updated or created.
     * - Sync nodes are deduplicated by func+addr to avoid duplicates on re-snapshot.
     * - The path represents a single chain (not a fan-out), so each level
     *   has at most one "current" child being walked.
     */
    mergePathIntoTree(parent, path, startIndex) {
        let current = parent;
        for (let i = startIndex; i < path.length; i++) {
            const node = path[i];
            if (node.type === 'async' && node.cid !== null) {
                // Find existing async child by CID
                let child = current.children.find(c => c.type === 'async' && c.cid === node.cid);
                if (!child) {
                    child = {
                        type: 'async',
                        cid: node.cid,
                        func: node.func,
                        addr: node.addr,
                        poll: node.poll,
                        state: node.state,
                        children: [],
                    };
                    current.children.push(child);
                }
                else {
                    // Update mutable fields
                    child.poll = node.poll;
                    child.state = node.state;
                }
                // Continue deeper into this child
                current = child;
            }
            else if (node.type === 'sync') {
                // Dedup sync nodes by func + addr
                const existing = current.children.find(c => c.type === 'sync' && c.func === node.func && c.addr === node.addr);
                if (!existing) {
                    const syncChild = {
                        type: 'sync',
                        cid: null,
                        func: node.func,
                        addr: node.addr,
                        poll: 0,
                        state: 'NON-ASYNC',
                        children: [],
                    };
                    current.children.push(syncChild);
                    // Sync nodes are leaf-like, don't descend into them
                }
            }
        }
    }
    _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }
    _getHtmlForWebview(webview) {
        // Get paths to webview resources
        const scriptPath = vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'asyncInspector.js');
        const stylePath = vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'asyncInspector.css');
        const scriptUri = webview.asWebviewUri(scriptPath);
        const styleUri = webview.asWebviewUri(stylePath);
        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleUri}" rel="stylesheet">
                <title>Async Inspector</title>
            </head>
            <body>
                <div class="container">
                    <div class="toolbar">
                        <button id="resetBtn" class="btn">Reset</button>
                        <button id="genWhitelistBtn" class="btn">Gen Whitelist</button>
                        <button id="snapshotBtn" class="btn">Snapshot</button>
                    </div>
                    <div class="main-content">
                        <div class="tree-panel">
                            <h3>Async Execution Tree</h3>
                            <div id="treeContainer"></div>
                        </div>
                        <div class="side-panel">
                            <div class="candidates-section">
                                <h3>Candidates</h3>
                                <div id="candidatesList"></div>
                            </div>
                        </div>
                    </div>
                </div>
                <script>
                    window.treeData = ${JSON.stringify(Array.from(this._treeRoots.values()))};
                </script>
                <script src="${scriptUri}"></script>
            </body>
            </html>`;
    }
    dispose() {
        AsyncInspectorPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
exports.AsyncInspectorPanel = AsyncInspectorPanel;
//# sourceMappingURL=asyncInspectorPanel.js.map