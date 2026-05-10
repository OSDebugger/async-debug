import * as vscode from 'vscode';
import { ARDDebugAdapterFactory } from '../debugAdapter';
import { SnapshotData } from '../gdbDebugSession';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Async Inspector Panel - Webview for displaying async execution trees
 */
export class AsyncInspectorPanel {
    public static currentPanel: AsyncInspectorPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _debugAdapterFactory: ARDDebugAdapterFactory | undefined;
    private _debugSession: vscode.DebugSession | undefined;
    private _treeRoots: Map<number, TreeNode> = new Map(); // root CID -> tree node
    /** Cache of the last snapshot, used by selectNode to find frame indices. */
    private _lastSnapshot: SnapshotData | undefined;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, debugAdapterFactory: ARDDebugAdapterFactory) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._debugAdapterFactory = debugAdapterFactory;

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

    public static createOrShow(extensionUri: vscode.Uri, debugAdapterFactory: ARDDebugAdapterFactory): AsyncInspectorPanel {
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

        AsyncInspectorPanel.currentPanel = new AsyncInspectorPanel(panel, extensionUri, debugAdapterFactory);
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
            // No delay needed — the FIFO command queue in gdbAdapter
            // correctly routes console output even when MI commands
            // are in flight concurrently.
            this.handleSnapshot().catch((e) => {
                console.error('[AsyncInspector] onDebugStopped handlers failed:', e);
            });
        }
    }

    private async handleReset(): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            await session.reset();
            this._treeRoots.clear();
            this._update();
            vscode.window.showInformationMessage('ARD reset completed');
        }
    }

    private async handleGenWhitelist(): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            await session.genWhitelist();
            // Refresh candidates after generating
            await this.handleRefreshCandidates();
        }
    }

    private async handleTrace(symbol: string): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            await session.traceFunction(symbol);
            vscode.window.showInformationMessage(`Tracing: ${symbol}`);
        }
    }

    private async handleSnapshot(): Promise<void> {
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

    private async handleSelectNode(nodeRef: {
        cid: number | null;
        func?: string;
        addr?: string;
        file?: string;
        fullname?: string;
        line?: number;
    }): Promise<void> {
        if (!this._debugSession) {
            return;
        }
        console.log('[AsyncInspector] selectNode cid=', nodeRef.cid, 'typeof=', typeof nodeRef.cid);
        const snapshot = this._lastSnapshot;
        if (!snapshot) {
            return;
        }

        // Case 1: normal CID-backed async node
        if (nodeRef.cid !== null) {
            const targetCid = Number(nodeRef.cid);
            let targetFrameIndex = -1;
            for (let i = 0; i < snapshot.path.length; i++) {
                const node = snapshot.path[i];
                if (node.type === 'async' && Number(node.cid) === targetCid) {
                    targetFrameIndex = snapshot.path.length - 1 - i;
                    break;
                }
            }

            if (targetFrameIndex >= 0) {
                try {
                    const stackTrace = await this._debugSession.customRequest('stackTrace', {
                        threadId: snapshot.thread_id,
                        startFrame: 0,
                        levels: 200,
                    });

                    const frames = stackTrace?.stackFrames || [];
                    if (frames.length > targetFrameIndex) {
                        const frame = frames[targetFrameIndex];

                        await this._debugSession.customRequest('evaluate', {
                            expression: `frame ${targetFrameIndex}`,
                            context: 'repl',
                        });

                        const snapNode = snapshot.path.find(
                            n => n.type === 'async' && Number(n.cid) === targetCid
                        );

                        const sourcePath =
                            snapNode?.file ||
                            snapNode?.fullname ||
                            frame.source?.path ||
                            '';

                        const sourceLine =
                            snapNode?.line ||
                            frame.line ||
                            0;
                        console.log('[AsyncInspector] root-select', {
                            nodeRef,
                            targetCid,
                            snapNode,
                            sourcePath,
                            sourceLine,
                        });
                        if (sourcePath) {
                            await this.handleSelectFrame(sourcePath, sourceLine);
                        }
                    }
                } catch (error) {
                    console.error('Failed to switch frame:', error);
                }
            }

            return;
        }

        // Case 2: async node without CID — fallback to source jump only
        const target = snapshot.path.find(
            n =>
                n.type === 'async' &&
                n.cid === null &&
                n.func === nodeRef.func &&
                n.addr === nodeRef.addr
        );

        const filePath =
            target?.file ||
            target?.fullname ||
            nodeRef.file ||
            nodeRef.fullname ||
            '';

        const line =
            target?.line ||
            nodeRef.line ||
            0;
        console.log('[AsyncInspector] child-select', {
            nodeRef,
            target,
            filePath,
            line,
        });

        if (filePath) {
            await this.handleSelectFrame(filePath, line);
        }
    }

    private async handleLocate(symbol: string): Promise<void> {
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
            } else {
                vscode.window.showWarningMessage(`Cannot locate source for: ${symbol}`);
            }
        } catch (error) {
            console.error('Failed to locate symbol:', error);
            vscode.window.showWarningMessage(`Failed to locate: ${symbol}`);
        }
    }

    private async handleRefreshCandidates(): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            const candidates = await session.getWhitelistCandidates();
            this._panel.webview.postMessage({
                command: 'updateCandidates',
                candidates: candidates
            });
        }
    }
    private buildSearchRoots(initialRoots: string[]): string[] {
        const roots: string[] = [];
        const seen = new Set<string>();

        for (const start of initialRoots) {
            let current = path.resolve(start);

            // 向上爬几层，避免 workspace 开在过深子目录时找不到真正源码根
            for (let i = 0; i < 8; i++) {
                if (!seen.has(current)) {
                    seen.add(current);
                    roots.push(current);
                }

                const parent = path.dirname(current);
                if (parent === current) {
                    break;
                }
                current = parent;
            }
        }

        return roots;
    }
    private async findFileBySuffix(
        roots: string[],
        suffix: string,
    ): Promise<string | undefined> {
        const normalizedSuffix = suffix.replace(/\\/g, '/').toLowerCase();

        const walk = async (dir: string): Promise<string | undefined> => {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                return undefined;
            }

            for (const entry of entries) {
                // 跳过常见无关目录，避免搜索太慢
                if (entry.isDirectory()) {
                    if (
                        entry.name === '.git' ||
                        entry.name === 'node_modules' ||
                        entry.name === 'target' ||
                        entry.name === 'out' ||
                        entry.name === '.vscode'
                    ) {
                        continue;
                    }
                }

                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    const found = await walk(fullPath);
                    if (found) {
                        return found;
                    }
                } else if (entry.isFile()) {
                    const normalizedFull = fullPath.replace(/\\/g, '/').toLowerCase();
                    if (normalizedFull.endsWith(normalizedSuffix)) {
                        console.log('[AsyncInspector] findFileBySuffix hit=' + fullPath);
                        return fullPath;
                    }
                }
            }

            return undefined;
        };

        for (const root of roots) {
            const found = await walk(root);
            if (found) {
                return found;
            }
        }

        return undefined;
    }

    private async resolveSourceUri(file: string): Promise<vscode.Uri | undefined> {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const workspaceRoots = workspaceFolders.map(f => f.uri.fsPath);
        const searchRoots = this.buildSearchRoots(workspaceRoots);
        const normalizedInput = file.replace(/\\/g, '/');

        console.log(
            '[AsyncInspector] resolveSourceUri input file=' + file +
            ' isAbsolute=' + String(path.isAbsolute(file)) +
            ' workspaceRoots=' + JSON.stringify(workspaceRoots) +
            ' searchRoots=' + JSON.stringify(searchRoots)
        );

        // 1) 绝对路径且真实存在
        if (path.isAbsolute(file) && fs.existsSync(file)) {
            console.log('[AsyncInspector] resolveSourceUri absolute-hit=' + file);
            return vscode.Uri.file(file);
        }

        // 2) 坏掉的绝对路径 -> 降级成相对后缀
        let searchTail = normalizedInput;
        if (path.isAbsolute(file)) {
            const parts = normalizedInput.split('/').filter(Boolean);
            const markers = ['testsuite', 'src', 'tests', 'test', 'examples', 'os'];
            let markerIndex = -1;

            for (let i = 0; i < parts.length; i++) {
                if (markers.includes(parts[i])) {
                    markerIndex = i;
                    break;
                }
            }

            if (markerIndex >= 0) {
                searchTail = parts.slice(markerIndex).join('/');
            } else {
                searchTail = parts.slice(-3).join('/');
            }
        }

        // 3) 用所有 searchRoots 直接拼接尝试
        for (const root of searchRoots) {
            const candidate = path.join(root, searchTail);
            console.log('[AsyncInspector] resolveSourceUri candidate=' + candidate);
            if (fs.existsSync(candidate)) {
                console.log('[AsyncInspector] resolveSourceUri candidate-hit=' + candidate);
                return vscode.Uri.file(candidate);
            }
        }

        // 4) 递归后缀搜索
        const found = await this.findFileBySuffix(searchRoots, searchTail);
        console.log('[AsyncInspector] resolveSourceUri recursive-found=' + String(found));
        if (found) {
            return vscode.Uri.file(found);
        }

        console.log('[AsyncInspector] resolveSourceUri failed', {
            file,
            searchTail,
            searchRoots,
        });

        return undefined;
    }

    private async openSourceAt(uri: vscode.Uri, line: number): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(uri);
        const targetLine = Math.max(0, line - 1);
        await vscode.window.showTextDocument(doc, {
            selection: new vscode.Range(targetLine, 0, targetLine, 0),
            preserveFocus: false,
            viewColumn: vscode.ViewColumn.One,
        });
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
            const uri = await this.resolveSourceUri(file);
            if (!uri) {
                vscode.window.showWarningMessage(`Cannot resolve file: ${file}`);
                return;
            }

            await this.openSourceAt(uri, line);
        } catch (error) {
            console.error('Failed to open source file:', error);
            vscode.window.showWarningMessage(`Cannot open file: ${file}`);
        }
    }

    private getSnapshotNodeOrigin(node: SnapshotData['path'][0]): string | undefined {
        const origin = node.origin;
        return typeof origin === 'string' && origin ? origin : undefined;
    }

    private updateTreeFromSnapshot(snapshot: SnapshotData): void {
        if (snapshot.path.length === 0) {
            return;
        }

        let rootIndex = -1;
        for (let i = 0; i < snapshot.path.length; i++) {
            if (snapshot.path[i].type === 'async') {
                rootIndex = i;
                break;
            }
        }

        if (rootIndex < 0) {
            return;
        }

        const rootNode = snapshot.path[rootIndex];
        if (rootNode.cid === null) {
            return;
        }

        let root = this._treeRoots.get(rootNode.cid);
        if (!root) {
            root = {
                type: 'async',
                cid: rootNode.cid,
                func: rootNode.func,
                addr: rootNode.addr,
                poll: rootNode.poll,
                state: rootNode.state,
                origin: this.getSnapshotNodeOrigin(rootNode),
                file: rootNode.file,
                fullname: rootNode.fullname,
                line: rootNode.line,
                children: []
            };
            this._treeRoots.set(rootNode.cid, root);
        } else {
            root.poll = rootNode.poll;
            root.state = rootNode.state;
            root.origin = this.getSnapshotNodeOrigin(rootNode);
            root.file = rootNode.file;
            root.fullname = rootNode.fullname;
            root.line = rootNode.line;
        }

        this.mergePathIntoTree(root, snapshot.path, rootIndex + 1);
    }
    /**
     * Merge the snapshot path (from startIndex onward) into the tree under `parent`.
     * - Async nodes are matched by CID and updated or created.
     * - Sync nodes are deduplicated by func+addr to avoid duplicates on re-snapshot.
     * - The path represents a single chain (not a fan-out), so each level
     *   has at most one "current" child being walked.
     */
    private mergePathIntoTree(
        parent: TreeNode,
        path: Array<SnapshotData['path'][0]>,
        startIndex: number,
    ): void {
        let current = parent;

        for (let i = startIndex; i < path.length; i++) {
            const node = path[i];

            if (node.type === 'async') {
                let child: TreeNode | undefined;

                if (node.cid !== null) {
                    // 1) 先按真实 CID 找
                    child = current.children.find(
                        c => c.type === 'async' && c.cid === node.cid
                    );

                    // 2) 如果没找到，再找“同 func 的旧占位节点”并升级
                    if (!child) {
                        const placeholder = current.children.find(
                            c =>
                                c.type === 'async' &&
                                c.cid === null &&
                                c.func === node.func
                        );

                        if (placeholder) {
                            placeholder.cid = node.cid;
                            placeholder.addr = node.addr;
                            placeholder.poll = node.poll;
                            placeholder.state = node.state;
                            placeholder.origin = this.getSnapshotNodeOrigin(node);
                            placeholder.file = node.file;
                            placeholder.fullname = node.fullname;
                            placeholder.line = node.line;
                            child = placeholder;
                        }
                    }

                    // 3) 不管 child 是按 CID 找到的，还是由 placeholder 升级来的，
                    //    都清理掉同 func 的旧 placeholder，避免树里长期残留重复节点
                    current.children = current.children.filter(
                        c =>
                            !(
                                c !== child &&
                                c.type === 'async' &&
                                c.cid === null &&
                                c.func === node.func
                            )
                    );
                } else {
                    child = current.children.find(
                        c =>
                            c.type === 'async' &&
                            c.cid === null &&
                            c.func === node.func &&
                            c.addr === node.addr
                    );
                }

                const nextChild: TreeNode = child ?? {
                    type: 'async',
                    cid: node.cid,
                    func: node.func,
                    addr: node.addr,
                    poll: node.poll,
                    state: node.state,
                    origin: this.getSnapshotNodeOrigin(node),
                    children: [],
                    file: node.file,
                    fullname: node.fullname,
                    line: node.line,
                };

                if (!child) {
                    current.children.push(nextChild);
                } else {
                    nextChild.poll = node.poll;
                    nextChild.state = node.state;
                    nextChild.addr = node.addr;
                    nextChild.origin = this.getSnapshotNodeOrigin(node);
                    nextChild.file = node.file;
                    nextChild.fullname = node.fullname;
                    nextChild.line = node.line;
                }

                current = nextChild;
            } else if (node.type === 'sync') {
                // Dedup sync nodes by func + addr
                const existing = current.children.find(
                    c => c.type === 'sync' && c.func === node.func && c.addr === node.addr
                );
                if (!existing) {
                    const syncChild: TreeNode = {
                        type: 'sync',
                        cid: null,
                        func: node.func,
                        addr: node.addr,
                        poll: 0,
                        state: 'NON-ASYNC',
                        origin: this.getSnapshotNodeOrigin(node),
                        children: [],
                    };
                    current.children.push(syncChild);
                } else {
                    existing.origin = this.getSnapshotNodeOrigin(node);
                }
            }else if (node.type === 'sync') {
                // Dedup sync nodes by func + addr
                const existing = current.children.find(
                    c => c.type === 'sync' && c.func === node.func && c.addr === node.addr
                );
                if (!existing) {
                    const syncChild: TreeNode = {
                        type: 'sync',
                        cid: null,
                        func: node.func,
                        addr: node.addr,
                        poll: 0,
                        state: 'NON-ASYNC',
                        origin: this.getSnapshotNodeOrigin(node),
                        children: [],
                    };
                    current.children.push(syncChild);
                    // Sync nodes are leaf-like, don't descend into them
                }
            }
        }
    }

    private _update(): void {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
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
                    <div style="padding: 0 10px 10px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.4;">
                        Snapshot reflects the current stopped execution context. Trace hits may not appear in the tree unless execution is stopped near the related poll/await site.
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
                <script>
                    (function() {
                        function flattenTree(nodes, out) {
                            out = out || [];
                            if (!Array.isArray(nodes)) {
                                return out;
                            }
                            nodes.forEach(function(node) {
                                out.push(node);
                                flattenTree(node.children, out);
                            });
                            return out;
                        }

                        function formatDisplayState(node) {
                            var state = node ? node.state : undefined;
                            if (state === 'NON-ASYNC') {
                                return 'NON-ASYNC';
                            }
                            if (typeof state === 'number') {
                                return String(state);
                            }
                            if (typeof state === 'string' && state !== 'N/A') {
                                return state;
                            }

                            switch (node && node.origin) {
                                case 'trace':
                                    return 'unavailable';
                                case 'trace-upgraded':
                                    return 'trace-hit, state unavailable';
                                case 'physical':
                                    return 'physical-only';
                                case 'inferred':
                                    return 'inferred';
                                default:
                                    return 'unavailable';
                            }
                        }

                        function patchTreeMetadata(nodes) {
                            var flat = flattenTree(nodes || []);
                            var metas = document.querySelectorAll('#treeContainer .tree-node .node-meta');
                            metas.forEach(function(meta, index) {
                                var node = flat[index];
                                if (!node) {
                                    return;
                                }

                                var origin = node.origin || 'unknown';
                                var text = meta.textContent || '';
                                text = text.replace(/\\s*\\|\\s*Origin:\\s*[^|]+$/, '');
                                text = text.replace(/State:\\s*[^|]+/, 'State: ' + formatDisplayState(node));

                                if ((origin === 'physical' || origin === 'inferred') && Number(node.poll) === 0) {
                                    text = text.replace(/Poll:\\s*0\\b/, 'Poll: -');
                                }

                                meta.textContent = text + ' | Origin: ' + origin;
                            });
                        }

                        window.addEventListener('message', function(event) {
                            var message = event.data;
                            if (message && message.command === 'updateTree') {
                                setTimeout(function() {
                                    patchTreeMetadata(message.treeData);
                                }, 0);
                            }
                        });

                        setTimeout(function() {
                            patchTreeMetadata(window.treeData || []);
                        }, 0);
                    })();
                </script>
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
    origin?: string;
    file?: string;
    fullname?: string;
    line?: number;
    children: TreeNode[];
}
