import * as vscode from 'vscode';
import { SnapshotData } from '../gdbDebugSession';

/**
 * Async Inspector Panel - Webview for displaying async execution trees
 */
export class AsyncInspectorPanel {
    public static currentPanel: AsyncInspectorPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _debugSession: vscode.DebugSession | undefined;
    private _treeRoots: Map<number, TreeNode> = new Map(); // root CID -> tree node
    /** Cache of the last snapshot, used by selectNode to find frame indices. */
    private _lastSnapshot: SnapshotData | undefined;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
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
                        await this.handleSelectNode(message);
                        break;
                    case 'locate':
                        await this.handleLocate(message.symbol);
                        break;
                    case 'refreshCandidates':
                        await this.handleRefreshCandidates();
                        break;
                    case 'updateWhitelistCrates':
                        await this.handleUpdateWhitelistCrates(message.enabledCrates);
                        break;
                }
            },
            null,
            this._disposables
        );

        // Listen for debug session changes
        vscode.debug.onDidChangeActiveDebugSession((session) => {
            this._debugSession = session?.type === 'ardb' ? session : undefined;
        }, null, this._disposables);
    }

    public static createOrShow(extensionUri: vscode.Uri): AsyncInspectorPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it
        if (AsyncInspectorPanel.currentPanel) {
            AsyncInspectorPanel.currentPanel._panel.reveal(column);
            return AsyncInspectorPanel.currentPanel;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'asyncInspector',
            'Async Inspector',
            column || vscode.ViewColumn.Two,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true
            }
        );

        AsyncInspectorPanel.currentPanel = new AsyncInspectorPanel(panel, extensionUri);
        return AsyncInspectorPanel.currentPanel;
    }

    public reveal(): void {
        this._panel.reveal();
    }

    /**
     * Called when the debug adapter sends a "stopped" event.
     * Triggers snapshot refresh automatically when the inferior has been
     * started (not the synthetic "entry" stop).
     */
    public onDebugStopped(session: vscode.DebugSession, stoppedBody: any): void {
        this._debugSession = session;
        const isEntry = stoppedBody?.reason === 'entry';
        console.log(`[AsyncInspector] onDebugStopped reason=${stoppedBody?.reason} isEntry=${isEntry} hasSession=${!!this._debugSession}`);

        if (!isEntry) {
            // Refresh snapshot on breakpoint stop
            this.handleSnapshot().catch((e) => {
                console.error('[AsyncInspector] onDebugStopped handlers failed:', e);
            });
        }
    }

    private async handleReset(): Promise<void> {
        if (this._debugSession) {
            await this._debugSession.customRequest('ardb-reset');
            this._treeRoots.clear();
            this._update();
            vscode.window.showInformationMessage('ARD reset completed');
        }
    }

    private async handleGenWhitelist(): Promise<void> {
        if (this._debugSession) {
            const result = await this._debugSession.customRequest('ardb-gen-whitelist');
            const grouped = result?.groupedWhitelist;
            if (grouped) {
                this._panel.webview.postMessage({
                    command: 'updateGroupedWhitelist',
                    groupedWhitelist: grouped
                });
            }
        }
    }

    private async handleTrace(symbol: string): Promise<void> {
        if (this._debugSession) {
            await this._debugSession.customRequest('ardb-trace', { symbol });
            vscode.window.showInformationMessage(`Tracing: ${symbol}`);
        }
    }

    private async handleSnapshot(): Promise<void> {
        if (!this._debugSession) {
            console.warn('[AsyncInspector] handleSnapshot: no debug session');
            return;
        }

        const result = await this._debugSession.customRequest('ardb-get-snapshot');
        const snapshot = result?.snapshot as SnapshotData | undefined;
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

    private async handleSelectNode(message: any): Promise<void> {
        if (!this._debugSession) {
            return;
        }

        // 1. 树节点在快照合并时已持久化源码位置 —— 直接跳转。
        //    对 async/sync 节点都成立，且不依赖"该节点是否还在最近一次
        //    快照路径里"（旧节点同样可跳）。
        const file = message?.fullname || message?.file;
        const line = message?.line || 0;
        if (file && line > 0) {
            await this.handleSelectFrame(file, line);
            return;
        }

        const cid = message?.cid;
        if (cid !== null && cid !== undefined) {
            // 2. 旧数据回退：按 CID 在最近一次快照路径里找源码位置。
            const snapshot = this._lastSnapshot;
            if (snapshot) {
                for (let i = 0; i < snapshot.path.length; i++) {
                    const node = snapshot.path[i];
                    if (node.type === 'async' && node.cid === cid) {
                        const filePath = node.fullname || node.file;
                        const nodeLine = node.line || 0;
                        if (filePath && nodeLine > 0) {
                            await this.handleSelectFrame(filePath, nodeLine);
                            return;
                        }
                        break;
                    }
                }
            }
        }

        // 3. 同步节点没有源码位置时：用节点记录的 PC 问 GDB。
        const addr = message?.addr;
        if (addr) {
            try {
                const result = await this._debugSession.customRequest('ardb-execute-command', {
                    command: `info line *${addr}`
                });
                const output = result?.result || '';
                const match = output.match(/Line\s+(\d+)\s+of\s+"([^"]+)"/);
                if (match) {
                    await this.handleSelectFrame(match[2], parseInt(match[1], 10));
                    return;
                }
            } catch (error) {
                console.error('Failed to locate node address:', error);
            }
        }

        vscode.window.showWarningMessage('No source info available for this node');
    }

    private async handleLocate(symbol: string): Promise<void> {
        if (!this._debugSession) {
            vscode.window.showWarningMessage('No active debug session');
            return;
        }

        try {
            const result = await this._debugSession.customRequest('ardb-execute-command', {
                command: `info line '${symbol}'`
            });
            const output = result?.result || '';
            const match = output.match(/Line\s+(\d+)\s+of\s+"([^"]+)"/);
            if (match) {
                const line = parseInt(match[1], 10);
                const filePath = match[2];
                await this.handleSelectFrame(filePath, line);
            } else {
                vscode.window.showWarningMessage(`Cannot locate source for: ${symbol}`);
            }
        } catch (error) {
            console.error('Failed to locate symbol:', error);
            vscode.window.showWarningMessage(`Failed to locate: ${symbol}`);
        }
    }

    private async handleRefreshCandidates(): Promise<void> {
        if (this._debugSession) {
            // Try grouped whitelist first
            const result = await this._debugSession.customRequest('ardb-get-whitelist-grouped');
            const grouped = result?.groupedWhitelist;
            if (grouped) {
                this._panel.webview.postMessage({
                    command: 'updateGroupedWhitelist',
                    groupedWhitelist: grouped
                });
            } else {
                // Fallback to flat candidate list
                const candResult = await this._debugSession.customRequest('ardb-get-whitelist-candidates');
                const candidates = candResult?.candidates || [];
                this._panel.webview.postMessage({
                    command: 'updateCandidates',
                    candidates: candidates
                });
            }
        }
    }

    private async handleUpdateWhitelistCrates(enabledCrates: string[]): Promise<void> {
        if (this._debugSession) {
            await this._debugSession.customRequest('ardb-update-whitelist', { enabledCrates });
            vscode.window.showInformationMessage(`Whitelist updated: ${enabledCrates.length} crate(s) enabled`);
        }
    }

    /**
     * Handle frame selection from the webview.
     * Opens the source file at the given line in VS Code editor.
     */
    private async handleSelectFrame(file: string, line: number): Promise<void> {
        if (!file) {
            return;
        }

        try {
            let uri: vscode.Uri;
            if (file.startsWith('/')) {
                uri = vscode.Uri.file(file);
            } else {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
                if (workspaceFolder) {
                    uri = vscode.Uri.joinPath(workspaceFolder, file);
                } else {
                    uri = vscode.Uri.file(file);
                }
            }
            const doc = await vscode.workspace.openTextDocument(uri);
            const targetLine = Math.max(0, line - 1);
            await vscode.window.showTextDocument(doc, {
                selection: new vscode.Range(targetLine, 0, targetLine, 0),
                preserveFocus: false,
                viewColumn: vscode.ViewColumn.One,
            });
        } catch (error) {
            console.error('Failed to open source file:', error);
            vscode.window.showWarningMessage(`Cannot open file: ${file}`);
        }
    }

    private updateTreeFromSnapshot(snapshot: SnapshotData): void {
        if (snapshot.path.length === 0) {
            return;
        }

        // Prefer the first coroutine node (cid != null) as the tree root.
        // The physical-stack fallback (sync code / before the first poll) may
        // produce a path where NO node has a cid (env ptr unreadable) — in
        // that case fall back to the first node so the chain still renders.
        let rootIndex = -1;
        for (let i = 0; i < snapshot.path.length; i++) {
            if (snapshot.path[i].cid !== null) {
                rootIndex = i;
                break;
            }
        }

        if (rootIndex < 0) {
            rootIndex = 0;
        }

        const rootNode = snapshot.path[rootIndex];
        if (!rootNode) {
            return;
        }

        // Coroutine roots are keyed by cid; a physical-stack fallback chain
        // (root cid === null) is transient — replace it on every stop instead
        // of merging chains from different stop locations.
        const rootKey = rootNode.cid ?? -1;
        if (rootNode.cid === null) {
            this._treeRoots.delete(-1);
        }

        let root = this._treeRoots.get(rootKey);
        if (!root) {
            root = {
                type: rootNode.type,
                cid: rootNode.cid,
                func: rootNode.func,
                addr: rootNode.addr,
                poll: rootNode.poll,
                state: rootNode.state,
                space: (rootNode as any).space,
                file: rootNode.file,
                fullname: rootNode.fullname,
                line: rootNode.line,
                children: []
            };
            this._treeRoots.set(rootKey, root);
        } else {
            root.type = rootNode.type;
            root.poll = rootNode.poll;
            root.state = rootNode.state;
            root.space = (rootNode as any).space;
        }

        this.mergePathIntoTree(root, snapshot.path, rootIndex + 1);
    }

    private mergePathIntoTree(
        parent: TreeNode,
        path: Array<SnapshotData['path'][0]>,
        startIndex: number,
    ): void {
        let current = parent;

        for (let i = startIndex; i < path.length; i++) {
            const node = path[i];

            if (node.cid !== null) {
                let child = current.children.find(c => c.cid === node.cid);
                if (!child) {
                    child = {
                        type: node.type,
                        cid: node.cid,
                        func: node.func,
                        addr: node.addr,
                        poll: node.poll,
                        state: node.state,
                        space: (node as any).space,
                        file: node.file,
                        fullname: node.fullname,
                        line: node.line,
                        children: [],
                    };
                    current.children.push(child);
                } else {
                    child.type = node.type;
                    child.poll = node.poll;
                    child.state = node.state;
                    child.space = (node as any).space;
                }
                current = child;
            } else {
                let child = current.children.find(
                    c => c.cid === null && c.func === node.func && c.addr === node.addr
                );
                if (!child) {
                    child = {
                        type: node.type,
                        cid: null,
                        func: node.func,
                        addr: node.addr,
                        poll: node.poll,
                        state: node.state,
                        space: (node as any).space,
                        file: node.file,
                        fullname: node.fullname,
                        line: node.line,
                        children: [],
                    };
                    current.children.push(child);
                }
                current = child;
            }
        }
    }

    private _update(): void {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
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
                            <h3>Logical Call Tree</h3>
                            <div id="treeContainer"></div>
                        </div>
                        <div class="side-panel">
                            <div class="trace-root-section">
                                <h3>Trace Root</h3>
                                <div id="traceRootDisplay" class="trace-root-display">No trace root set. Use "Trace" button in whitelist to set.</div>
                            </div>
                            <div class="whitelist-section">
                                <h3>Whitelist</h3>
                                <div id="whitelistContainer"></div>
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

    public dispose(): void {
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

interface TreeNode {
    type: 'async' | 'sync';
    cid: number | null;
    func: string;
    addr: string;
    poll: number;
    state: number | string;
    space?: 'kernel' | 'user' | 'unknown';
    file?: string;
    fullname?: string;
    line?: number;
    children: TreeNode[];
}
