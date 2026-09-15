import * as vscode from 'vscode';
import type { HistoryRelationAnnotation, ObserverTreeData } from '../gdbDebugSession';
import {
    collectTestcaseSourceRoots,
    resolveTestcaseSourcePath,
} from '../sourcePathResolver';
import {
    RelationFromParentV1,
    SnapshotPathNodeV1,
    SnapshotV1,
} from '../runtimeTraceBridge';

type RuntimeObserverNode = ObserverTreeData['roots'][number];
type AsyncTreeMode = 'observer' | 'snapshot';

/**
 * Async Inspector Panel - Webview for displaying async execution trees
 */
export class AsyncInspectorPanel {
    public static currentPanel: AsyncInspectorPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _debugSession: vscode.DebugSession | undefined;
    private _observerTreeRoots: TreeNode[] = [];
    private _observerRelationAnnotations: HistoryRelationAnnotation[] = [];
    private _observerRoot: string | null = null;
    private _currentTreeMode: AsyncTreeMode = 'observer';
    private _snapshotTreeRoots: TreeNode[] = [];
    private _snapshotRequestId = 0;
    private _observerRequestId = 0;
    private _treeViewRequestId = 0;
    /** Detached current-state projection; never used to populate the History Store. */
    private _lastSnapshot: SnapshotV1 | undefined;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        const session = vscode.debug.activeDebugSession;
        this._debugSession = session?.type === 'ardb' ? session : undefined;

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'reset':
                        await this.handleReset(message.viewRequestId);
                        break;
                    case 'genWhitelist':
                        await this.handleGenWhitelist();
                        break;
                    case 'trace':
                        await this.handleTrace(message.symbol);
                        break;
                    case 'snapshot':
                        await this.handleSnapshot(message.viewRequestId);
                        break;
                    case 'refreshObserver':
                        this._currentTreeMode = 'observer';
                        this._treeViewRequestId = message.viewRequestId;
                        await this.fetchObserverTree();
                        break;
                    case 'clearHistory':
                        await this.handleClearHistory();
                        break;
                    case 'selectNode':
                        if (message.viewRequestId === this._treeViewRequestId) {
                            await this.handleSelectNode(message.cid, message.symbol, message.snapshotIndex, message.mode);
                        }
                        break;
                    case 'locate':
                        await this.handleLocate(message.symbol);
                        break;
                    case 'refreshCandidates':
                        await this.handleRefreshCandidates();
                        break;
                    case 'updateWhitelistCrates':
                        await this.handleUpdateWhitelistCrates(message.enabledCrates, message.asyncOnly === true);
                        break;
                }
            },
            null,
            this._disposables
        );

        // Listen for debug session changes
        vscode.debug.onDidChangeActiveDebugSession((session) => {
            this.setDebugSession(session?.type === 'ardb' ? session : undefined);
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
     * Snapshot refresh is manual; only Observer mode refreshes its
     * Trace Root projection of the History Store on a non-entry stop.
     */
    public onDebugStopped(session: vscode.DebugSession, stoppedBody: any): void {
        this.setDebugSession(session);
        const isEntry = stoppedBody?.reason === 'entry';
        console.log(`[AsyncInspector] onDebugStopped reason=${stoppedBody?.reason} isEntry=${isEntry} hasSession=${!!this._debugSession}`);

        if (!isEntry && this._currentTreeMode === 'observer') {
            this.refreshStoppedState().catch((e) => {
                console.error('[AsyncInspector] onDebugStopped handlers failed:', e);
            });
        }
    }

    private async refreshStoppedState(): Promise<void> {
        await this.fetchObserverTree();
    }

    private setDebugSession(session: vscode.DebugSession | undefined): void {
        if (this._debugSession === session) {
            return;
        }
        this._debugSession = session;
        ++this._snapshotRequestId;
        ++this._observerRequestId;
        this._lastSnapshot = undefined;
        this._snapshotTreeRoots = [];
        this._observerTreeRoots = [];
        this._observerRelationAnnotations = [];
        this._observerRoot = null;
        this.postTree();
    }

    private async handleReset(viewRequestId: number): Promise<void> {
        ++this._snapshotRequestId;
        ++this._observerRequestId;
        this._currentTreeMode = 'observer';
        this._treeViewRequestId = viewRequestId;
        this._lastSnapshot = undefined;
        this._snapshotTreeRoots = [];
        this._observerTreeRoots = [];
        this._observerRelationAnnotations = [];
        this._observerRoot = null;
        this.postTree();
        if (this._debugSession) {
            await this._debugSession.customRequest('ardb-reset');
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
            this._observerRoot = symbol || null;
            await this.fetchObserverTree();
            vscode.window.showInformationMessage(`Trace root: ${this._observerRoot || '<none>'}`);
        }
    }

    private async handleSnapshot(viewRequestId: number): Promise<void> {
        this._currentTreeMode = 'snapshot';
        this._treeViewRequestId = viewRequestId;
        const requestId = ++this._snapshotRequestId;
        const session = this._debugSession;
        this._lastSnapshot = undefined;
        this._snapshotTreeRoots = [];
        this.postTree('snapshot');
        if (!session) {
            console.warn('[AsyncInspector] handleSnapshot: no debug session');
            return;
        }

        try {
            const result = await session.customRequest('ardb-get-snapshot');
            if (requestId !== this._snapshotRequestId || session !== this._debugSession) {
                return;
            }
            const snapshot = result?.snapshot as SnapshotV1 | null | undefined;
            this._lastSnapshot = snapshot && !snapshot.empty ? snapshot : undefined;
            this._snapshotTreeRoots = this._lastSnapshot
                ? buildCurrentExecutionForest(this._lastSnapshot)
                : [];
            this.postTree('snapshot');
        } catch (error) {
            if (requestId === this._snapshotRequestId && session === this._debugSession
                && this._currentTreeMode === 'snapshot') {
                vscode.window.showWarningMessage(`Cannot refresh Snapshot: ${error}`);
            }
        }
    }

    private async fetchObserverTree(): Promise<void> {
        const requestId = ++this._observerRequestId;
        const session = this._debugSession;
        this._observerTreeRoots = [];
        this._observerRelationAnnotations = [];
        this.postTree('observer');
        if (!session) {
            console.warn('[AsyncInspector] fetchObserverTree: no debug session');
            return;
        }

        try {
            const response = await session.customRequest('ardb-get-observer-tree');
            if (requestId !== this._observerRequestId || session !== this._debugSession) {
                return;
            }
            const observerTree = response?.observerTree as ObserverTreeData | undefined;
            this._observerTreeRoots = observerTree && Array.isArray(observerTree.roots)
                ? this.normalizeRuntimeObserverNodes(observerTree.roots)
                : [];
            this._observerRelationAnnotations = observerTree
                && Array.isArray(observerTree.relation_annotations)
                ? observerTree.relation_annotations.map(annotation => ({
                    ...annotation,
                    relation: { ...annotation.relation },
                }))
                : [];
            this._observerRoot = observerTree?.observer_root || null;
            this.postTree('observer');
        } catch (error) {
            if (requestId === this._observerRequestId && session === this._debugSession
                && this._currentTreeMode === 'observer') {
                vscode.window.showWarningMessage(`Cannot refresh Observer: ${error}`);
            }
        }
    }

    private async handleClearHistory(): Promise<void> {
        const session = this._debugSession;
        if (!session) {
            return;
        }
        ++this._observerRequestId;
        try {
            await session.customRequest('ardb-clear-history-tree');
            if (session !== this._debugSession) {
                return;
            }
            // Also invalidate Observer reads started while Clear History was pending.
            ++this._observerRequestId;
            this._observerTreeRoots = [];
            this._observerRelationAnnotations = [];
            this._observerRoot = null;
            this._panel.webview.postMessage({
                command: 'updateTreeView',
                observerRoot: this._observerRoot,
            });
            this.postTree('observer');
        } catch (error) {
            vscode.window.showWarningMessage(`Cannot clear History: ${error}`);
        }
    }

    private normalizeRuntimeObserverNodes(nodes: RuntimeObserverNode[]): TreeNode[] {
        return nodes.map(node => ({
            type: node.type === 'sync' ? 'sync' : 'async',
            cid: typeof node.cid === 'number' ? node.cid : null,
            func: typeof node.func === 'string' ? node.func : '<unknown>',
            addr: typeof node.addr === 'string' ? node.addr : null,
            poll: typeof node.poll === 'number' ? node.poll : 0,
            state: typeof node.state === 'number' || typeof node.state === 'string'
                ? node.state
                : null,
            snapshotIndex: -1,
            semanticKind: typeof node.semantic_kind === 'string'
                ? node.semantic_kind
                : undefined,
            source: node.source,
            active: typeof node.active === 'boolean' ? node.active : false,
            enter_count: typeof node.enter_count === 'number' ? node.enter_count : 0,
            children: this.normalizeRuntimeObserverNodes(
                Array.isArray(node.children) ? node.children : []
            ),
        }));
    }

    private postTree(mode: AsyncTreeMode = this._currentTreeMode): void {
        if (mode !== this._currentTreeMode) {
            return;
        }
        this._panel.webview.postMessage({
            command: 'updateTreeView',
            mode,
            viewRequestId: this._treeViewRequestId,
            observerRoot: this._observerRoot,
        });
        this._panel.webview.postMessage({
            command: 'updateTree',
            mode,
            viewRequestId: this._treeViewRequestId,
            treeData: mode === 'observer' ? this._observerTreeRoots : this._snapshotTreeRoots,
        });
    }

    private async handleSelectNode(
        cid: number | null,
        symbol?: string,
        snapshotIndex?: number,
        mode?: AsyncTreeMode,
    ): Promise<void> {
        if (!this._debugSession || (mode && mode !== this._currentTreeMode)) {
            return;
        }

        const pending = [...(this._currentTreeMode === 'snapshot'
            ? this._snapshotTreeRoots : this._observerTreeRoots)];
        while (pending.length > 0) {
            const node = pending.pop()!;
            if (node.func === symbol && node.cid === cid
                && (this._currentTreeMode === 'observer' || node.snapshotIndex === snapshotIndex)) {
                // A manually captured Snapshot can outlive its stop. Use its
                // source location, never interpret its path index as a live frame.
                const source = node.source as SnapshotPathNodeV1['source'];
                if (this._currentTreeMode === 'snapshot' && source?.path) {
                    const localPath = resolveTestcaseSourcePath(
                        source.path, this.testcaseSourceRoots(), message => console.debug(message),
                    );
                    if (localPath) {
                        await this.handleSelectFrame(localPath, source.line || 0);
                        return;
                    }
                }
                await this.handleLocate(node.func, node.addr);
                return;
            }
            pending.push(...node.children);
        }
    }

    private testcaseSourceRoots(): string[] {
        return collectTestcaseSourceRoots(
            (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath),
            this._extensionUri.fsPath,
        );
    }

    private async handleLocate(symbol: string, addr?: string | null): Promise<void> {
        if (!this._debugSession) {
            vscode.window.showWarningMessage('No active debug session');
            return;
        }

        const symbolCandidates = [symbol];
        const closureCandidate = symbol.replace(
            /\{async_fn#(\d+)\}/g,
            '{closure#$1}'
        );
        if (closureCandidate !== symbol) {
            symbolCandidates.push(closureCandidate);
        }
        const outerFunctionCandidate = symbol.replace(
            /::\{async_fn#\d+\}$/,
            ''
        );
        if (outerFunctionCandidate && !symbolCandidates.includes(outerFunctionCandidate)) {
            symbolCandidates.push(outerFunctionCandidate);
        }

        const attempts = symbolCandidates.map(candidate => ({
            label: candidate,
            command: `info line '${candidate}'`,
        }));
        if (typeof addr === 'string' && /^0x[0-9a-fA-F]+$/.test(addr)) {
            attempts.push({
                label: `*${addr}`,
                command: `info line *${addr}`,
            });
        }

        for (let index = 0; index < attempts.length; index++) {
            const attempt = attempts[index];
            if (index > 0) {
                console.debug(`[ARD] try fallback: ${symbol} -> ${attempt.label}`);
            }
            try {
                const result = await this._debugSession.customRequest('ardb-execute-command', {
                    command: attempt.command,
                });
                const output = result?.result || '';
                const match = output.match(/Line\s+(\d+)\s+of\s+"([^"]+)"/);
                if (match) {
                    const line = parseInt(match[1], 10);
                    const filePath = match[2];
                    console.debug(`[ARD] resolved: ${filePath}:${line}`);
                    const localFilePath = resolveTestcaseSourcePath(
                        filePath,
                        this.testcaseSourceRoots(),
                        message => console.debug(message),
                    );
                    if (localFilePath) {
                        await this.handleSelectFrame(localFilePath, line);
                        return;
                    }
                }
                console.debug(`[ARD] locate symbol failed: ${attempt.label}`);
            } catch (error) {
                console.debug(`[ARD] locate symbol failed: ${attempt.label}`, error);
            }
        }

        vscode.window.showWarningMessage(`Cannot locate source for: ${symbol}`);
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

    private async handleUpdateWhitelistCrates(enabledCrates: string[], asyncOnly = false): Promise<void> {
        if (this._debugSession) {
            await this._debugSession.customRequest('ardb-update-whitelist', { enabledCrates, asyncOnly });
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
                        <button id="snapshotBtn" class="btn view-btn">Snapshot</button>
                        <button id="observerBtn" class="btn view-btn active">Observer</button>
                        <button id="clearHistoryBtn" class="btn">Clear History</button>
                    </div>
                    <div class="main-content">
                        <div class="tree-panel">
                            <div class="execution-graph-header">
                                <h3 id="treeViewTitle">Async Inspector — Observer</h3>
                            </div>
                            <div id="treeContainer"></div>
                        </div>
                        <div class="side-panel">
                            <div class="trace-root-section">
                                <h3>Trace Root</h3>
                                <div id="traceRootDisplay" class="trace-root-display">No trace root set. Use "Trace" in the whitelist to select one.</div>
                            </div>
                            <div class="whitelist-section">
                                <h3>Whitelist</h3>
                                <div id="whitelistContainer"></div>
                            </div>
                        </div>
                    </div>
                </div>
                <script>
                    window.treeMode = ${JSON.stringify(this._currentTreeMode)};
                    window.treeViewRequestId = ${JSON.stringify(this._treeViewRequestId)};
                    window.treeData = ${JSON.stringify(this._currentTreeMode === 'observer' ? this._observerTreeRoots : this._snapshotTreeRoots)};
                    window.observerRoot = ${JSON.stringify(this._observerRoot)};
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

export interface TreeNode {
    type: 'async' | 'sync';
    cid: number | null;
    func: string;
    addr: string | null;
    poll: number;
    state: number | string | null;
    snapshotIndex: number;
    semanticKind?: string;
    source?: unknown;
    relationFromParent?: RelationFromParentV1;
    active?: boolean;
    enter_count?: number;
    children: TreeNode[];
}

function treeNodeFromSnapshot(node: SnapshotPathNodeV1, snapshotIndex: number): TreeNode {
    return {
        type: node.kind === 'async' ? 'async' : 'sync',
        cid: node.cid,
        func: node.function,
        addr: node.future_address,
        poll: node.poll.sequence,
        state: node.poll.state,
        snapshotIndex,
        source: node.source ? { ...node.source } : undefined,
        active: node.active,
        relationFromParent: node.relation_from_parent
            ? { ...node.relation_from_parent, evidence: [...node.relation_from_parent.evidence] }
            : undefined,
        children: [],
    };
}

function wouldCreateCycle(parent: TreeNode, child: TreeNode): boolean {
    const pending = [...child.children];
    while (pending.length > 0) {
        const descendant = pending.pop()!;
        if (descendant === parent) {
            return true;
        }
        pending.push(...descendant.children);
    }
    return parent === child;
}

/** Build a detached current execution forest using only observed await facts. */
export function buildCurrentExecutionForest(snapshot: SnapshotV1): TreeNode[] {
    const nodes = snapshot.async_path.map(treeNodeFromSnapshot);
    const nodesByCid = new Map<number, TreeNode>();
    for (const node of nodes) {
        if (node.cid !== null && !nodesByCid.has(node.cid)) {
            nodesByCid.set(node.cid, node);
        }
    }

    const attached = new Set<TreeNode>();
    for (let index = 0; index < snapshot.async_path.length; index++) {
        const sourceNode = snapshot.async_path[index];
        const child = nodes[index];
        const relation = sourceNode.relation_from_parent;
        if (!relation
            || relation.kind !== 'await'
            || relation.confidence !== 'observed'
            || relation.parent_cid === null
            || relation.child_cid === null
            || relation.child_cid !== sourceNode.cid
            || relation.child_future_address !== sourceNode.future_address) {
            continue;
        }

        const parent = nodesByCid.get(relation.parent_cid);
        const indexedChild = nodesByCid.get(relation.child_cid);
        if (!parent || indexedChild !== child || wouldCreateCycle(parent, child)) {
            continue;
        }
        parent.children.push(child);
        attached.add(child);
    }

    return nodes.filter(node => !attached.has(node));
}
