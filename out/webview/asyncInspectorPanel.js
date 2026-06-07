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
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
/**
 * Async Inspector Panel - Webview for displaying async execution trees
 */
class AsyncInspectorPanel {
    constructor(panel, extensionUri, debugAdapterFactory) {
        this._disposables = [];
        this._treeRoots = new Map(); // root CID -> tree node
        this._lastTransitionPath = [];
        this._outputChannel = vscode.window.createOutputChannel('ARD Inspector');
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
                case 'connectRemote':
                    await this.handleConnectRemote();
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
     */
    onDebugStopped(session, stoppedBody) {
        this._debugSession = session;
        const isEntry = stoppedBody?.reason === 'entry';
        console.log(`[AsyncInspector] onDebugStopped reason=${stoppedBody?.reason} isEntry=${isEntry} hasSession=${!!this._debugSession}`);
        if (!isEntry) {
            // No delay needed — the FIFO command queue in gdbAdapter
            // correctly routes console output even when MI commands
            // are in flight concurrently.
            this.handleSnapshot(true).catch((e) => {
                console.error('[AsyncInspector] onDebugStopped handlers failed:', e);
            });
        }
    }
    async handleReset() {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            await session.reset();
            this._treeRoots.clear();
            this._lastTransitionPath = [];
            this._update();
            vscode.window.showInformationMessage('ARD reset completed');
        }
    }
    async handleConnectRemote() {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            const message = '[ARD] failed to connect remote target :1234: no active debug session';
            this.inspectorLog('error', message);
            vscode.window.showErrorMessage(message);
            this._panel.webview.postMessage({
                command: 'connectRemoteResult',
                status: 'failed',
                message,
            });
            return;
        }
        const result = await session.connectRemote(':1234');
        const level = result.status === 'failed' ? 'error' : 'info';
        this.inspectorLog(level, result.message);
        if (result.status === 'failed') {
            vscode.window.showErrorMessage(result.message);
        }
        else {
            vscode.window.showInformationMessage(result.message);
        }
        this._panel.webview.postMessage({
            command: 'connectRemoteResult',
            status: result.status,
            message: result.message,
        });
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
    async handleSnapshot(suppressOutput = false) {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            console.warn('[AsyncInspector] handleSnapshot: no GDB session from factory');
            return;
        }
        const snapshot = await session.getSnapshot(suppressOutput);
        console.log('[AsyncInspector] handleSnapshot: result =', snapshot ? `thread_id=${snapshot.thread_id}, path.length=${snapshot.path.length}` : 'null');
        if (snapshot) {
            this._lastSnapshot = snapshot;
            this._lastTransitionPath = Array.isArray(snapshot.transition_path)
                ? snapshot.transition_path
                : [];
            this.updateTreeFromSnapshot(snapshot);
            this._panel.webview.postMessage({
                command: 'updateTree',
                treeData: Array.from(this._treeRoots.values()),
                transitionPath: this._lastTransitionPath,
            });
        }
    }
    async handleSelectNode(nodeRef) {
        console.log('[AsyncInspector] selectNode cid=', nodeRef.cid, 'typeof=', typeof nodeRef.cid);
        const snapshot = this._lastSnapshot;
        const target = snapshot ? this.findSnapshotNode(snapshot, nodeRef) : undefined;
        const symbol = target?.func || nodeRef.func || '<unknown>';
        const resolution = await this.resolveNodeSourceLocation(target, nodeRef);
        if (resolution) {
            this.inspectorLog('info', `[Inspector] Node click: ${symbol} -> ${resolution.uri.fsPath}:${resolution.line}`);
            if (resolution.matches && resolution.matches.length > 1) {
                this.inspectorLog('warn', `[Inspector] Warning: multiple matches for ${symbol}, selected ${resolution.uri.fsPath}:${resolution.line}`);
            }
            await this.openSourceAt(resolution.uri, resolution.line);
        }
        else {
            this.inspectorLog('error', `[Inspector] Error: ${symbol} file not found`);
            vscode.window.showWarningMessage(`Cannot locate source for: ${symbol}`);
        }
        if (snapshot && nodeRef.cid !== null) {
            await this.trySelectDebugFrame(snapshot, Number(nodeRef.cid));
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
    inspectorLog(level, message) {
        this._outputChannel.appendLine(message);
        if (level === 'warn') {
            console.warn(message);
        }
        else if (level === 'error') {
            console.error(message);
        }
        else {
            console.log(message);
        }
    }
    findSnapshotNode(snapshot, nodeRef) {
        if (nodeRef.cid !== null && nodeRef.cid !== undefined) {
            const targetCid = Number(nodeRef.cid);
            const cidMatches = snapshot.path.filter(n => n.type === 'async' && Number(n.cid) === targetCid);
            if (cidMatches.length > 0) {
                return cidMatches[cidMatches.length - 1];
            }
        }
        const exactMatches = snapshot.path.filter(n => n.func === nodeRef.func &&
            (!nodeRef.addr || n.addr === nodeRef.addr));
        if (exactMatches.length > 0) {
            return exactMatches[exactMatches.length - 1];
        }
        return undefined;
    }
    async trySelectDebugFrame(snapshot, targetCid) {
        if (!this._debugSession) {
            return;
        }
        let targetFrameIndex = -1;
        for (let i = 0; i < snapshot.path.length; i++) {
            const node = snapshot.path[i];
            if (node.type === 'async' && Number(node.cid) === targetCid) {
                targetFrameIndex = snapshot.path.length - 1 - i;
                break;
            }
        }
        if (targetFrameIndex < 0) {
            return;
        }
        try {
            await this._debugSession.customRequest('stackTrace', {
                threadId: snapshot.thread_id,
                startFrame: 0,
                levels: 200,
            });
            await this._debugSession.customRequest('evaluate', {
                expression: `frame ${targetFrameIndex}`,
                context: 'repl',
            });
        }
        catch (error) {
            console.error('Failed to switch frame:', error);
        }
    }
    buildSearchRoots(initialRoots) {
        const roots = [];
        const seen = new Set();
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
    addPathRoot(roots, seen, candidate) {
        if (typeof candidate !== 'string' || !candidate.trim()) {
            return;
        }
        const expanded = this.expandPathVariables(candidate.trim());
        const resolved = path.isAbsolute(expanded)
            ? path.resolve(expanded)
            : path.resolve(this.getPrimaryWorkspaceRoot() || process.cwd(), expanded);
        if (!seen.has(resolved) && fs.existsSync(resolved)) {
            seen.add(resolved);
            roots.push(resolved);
        }
    }
    expandPathVariables(value) {
        const workspaceRoot = this.getPrimaryWorkspaceRoot() || '';
        const sessionCwd = this.getSessionCwd() || workspaceRoot;
        return value
            .replace(/\$\{workspaceFolder\}/g, workspaceRoot)
            .replace(/\$\{cwd\}/g, sessionCwd);
    }
    getPrimaryWorkspaceRoot() {
        return (this._debugSession?.workspaceFolder?.uri.fsPath ||
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    }
    getSessionCwd() {
        const config = this._debugSession?.configuration;
        const workspaceRoot = this.getPrimaryWorkspaceRoot();
        if (typeof config?.cwd === 'string' && config.cwd.trim()) {
            const expanded = this.expandPathVariablesWithoutCwd(config.cwd, workspaceRoot);
            return path.isAbsolute(expanded)
                ? path.resolve(expanded)
                : path.resolve(workspaceRoot || process.cwd(), expanded);
        }
        return workspaceRoot;
    }
    expandPathVariablesWithoutCwd(value, workspaceRoot) {
        return workspaceRoot
            ? value.replace(/\$\{workspaceFolder\}/g, workspaceRoot)
            : value;
    }
    sourceMapCandidates() {
        const candidates = [];
        const seen = new Set();
        const add = (candidate) => {
            if (!candidate) {
                return;
            }
            const resolved = path.resolve(candidate);
            if (!seen.has(resolved) && fs.existsSync(resolved)) {
                seen.add(resolved);
                candidates.push(resolved);
            }
        };
        const workspaceRoots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
        for (const root of workspaceRoots) {
            add(path.join(root, 'source-map.json'));
            const testcaseRoot = path.join(root, 'testcases');
            try {
                const entries = fs.readdirSync(testcaseRoot, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        add(path.join(testcaseRoot, entry.name, 'source-map.json'));
                    }
                }
            }
            catch {
                // No testcase source maps in this workspace.
            }
        }
        const config = this._debugSession?.configuration;
        if (typeof config?.sourceMap === 'string') {
            add(this.expandPathVariables(config.sourceMap));
        }
        return candidates;
    }
    sourceRootsFromSourceMaps() {
        const roots = [];
        const seen = new Set();
        for (const mapPath of this.sourceMapCandidates()) {
            try {
                const parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
                this.addSourceMapRootFields(roots, seen, parsed);
            }
            catch (error) {
                this.inspectorLog('warn', `[Inspector] Warning: cannot read source map ${mapPath}: ${error}`);
            }
        }
        return roots;
    }
    addSourceMapRootFields(roots, seen, parsed) {
        if (Array.isArray(parsed.sourceRoots)) {
            for (const root of parsed.sourceRoots) {
                this.addPathRoot(roots, seen, root);
            }
        }
        // Prefer concrete source subtrees before broad workspaces.
        this.addPathRoot(roots, seen, parsed.rel4Kernel);
        this.addPathRoot(roots, seen, parsed.rootTaskDemo);
        for (const [key, value] of Object.entries(parsed)) {
            if (key === 'sourceRoots' ||
                key === 'sourceWorkspace' ||
                key === 'rel4Kernel' ||
                key === 'rootTaskDemo') {
                continue;
            }
            if (/(source|root|project|kernel|demo)/i.test(key)) {
                this.addPathRoot(roots, seen, value);
            }
        }
        this.addPathRoot(roots, seen, parsed.sourceWorkspace);
    }
    configuredSourceRoots() {
        const roots = [];
        const seen = new Set();
        const config = this._debugSession?.configuration;
        if (Array.isArray(config?.sourceRoots)) {
            for (const root of config.sourceRoots) {
                this.addPathRoot(roots, seen, root);
            }
        }
        if (typeof config?.cwd === 'string') {
            this.addPathRoot(roots, seen, config.cwd);
        }
        if (typeof config?.program === 'string') {
            const expanded = this.expandPathVariables(config.program);
            this.addPathRoot(roots, seen, path.dirname(expanded));
        }
        return roots;
    }
    sourceSearchRoots() {
        const roots = [];
        const seen = new Set();
        const addExisting = (candidate) => this.addPathRoot(roots, seen, candidate);
        for (const root of this.configuredSourceRoots()) {
            addExisting(root);
        }
        for (const root of this.sourceRootsFromSourceMaps()) {
            addExisting(root);
        }
        const workspaceRoots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
        for (const root of this.buildSearchRoots(workspaceRoots)) {
            addExisting(root);
        }
        return roots;
    }
    async findFilesBySuffix(roots, suffix, limit = 8) {
        const normalizedSuffix = suffix.replace(/\\/g, '/').toLowerCase();
        const matches = [];
        const seen = new Set();
        const walk = async (dir) => {
            let entries;
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                if (matches.length >= limit) {
                    return;
                }
                // 跳过常见无关目录，避免搜索太慢
                if (entry.isDirectory()) {
                    if (entry.name === '.git' ||
                        entry.name === 'node_modules' ||
                        entry.name === 'target' ||
                        entry.name === 'out' ||
                        entry.name === 'build' ||
                        entry.name.startsWith('build-') ||
                        entry.name === '.vscode') {
                        continue;
                    }
                }
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(fullPath);
                }
                else if (entry.isFile()) {
                    const normalizedFull = fullPath.replace(/\\/g, '/').toLowerCase();
                    if (normalizedFull.endsWith(normalizedSuffix)) {
                        console.log('[AsyncInspector] findFileBySuffix hit=' + fullPath);
                        const resolved = path.resolve(fullPath);
                        if (!seen.has(resolved)) {
                            seen.add(resolved);
                            matches.push(resolved);
                        }
                    }
                }
            }
        };
        for (const root of roots) {
            if (matches.length >= limit) {
                break;
            }
            if (this.isBroadRecursiveSearchRoot(root)) {
                continue;
            }
            await walk(root);
        }
        return matches;
    }
    isBroadRecursiveSearchRoot(root) {
        const resolved = path.resolve(root);
        const parsed = path.parse(resolved);
        const home = process.env.HOME ? path.resolve(process.env.HOME) : '';
        return resolved === parsed.root || resolved === home || resolved === path.dirname(home);
    }
    sourceTailsFromFile(file) {
        const normalizedInput = file.replace(/\\/g, '/');
        const tails = [];
        const seen = new Set();
        const add = (tail) => {
            const normalized = tail.replace(/\\/g, '/').replace(/^\/+/, '');
            if (normalized && !seen.has(normalized)) {
                seen.add(normalized);
                tails.push(normalized);
            }
        };
        if (!path.isAbsolute(file)) {
            add(normalizedInput);
        }
        const parts = normalizedInput.split('/').filter(Boolean);
        const markers = ['projects', 'rel4_kernel', 'kernel', 'crates', 'src', 'testsuite', 'tests', 'test', 'examples', 'os'];
        for (let i = 0; i < parts.length; i++) {
            if (markers.includes(parts[i])) {
                add(parts.slice(i).join('/'));
            }
        }
        add(parts.slice(-4).join('/'));
        add(parts.slice(-3).join('/'));
        add(parts.slice(-2).join('/'));
        add(parts.slice(-1).join('/'));
        return tails;
    }
    sourceTailsFromSymbol(symbol) {
        const stripped = symbol
            .replace(/\{async_fn#[^}]+}/g, '')
            .replace(/<[^>]*>/g, '')
            .replace(/::h[0-9a-fA-F]+$/g, '');
        const parts = stripped
            .split('::')
            .map(p => p.trim())
            .filter(p => p && !p.startsWith('{') && !p.includes('$'));
        const tails = [];
        const seen = new Set();
        const add = (tail) => {
            const normalized = tail.replace(/\\/g, '/').replace(/^\/+/, '');
            if (normalized && !seen.has(normalized)) {
                seen.add(normalized);
                tails.push(normalized);
            }
        };
        for (let i = parts.length - 1; i >= 0; i--) {
            const part = parts[i];
            if (/^[A-Z]/.test(part) || part === 'execute' || part === 'poll') {
                continue;
            }
            add(`${part}.rs`);
            if (i > 0) {
                add(`${parts[i - 1]}/${part}.rs`);
            }
            if (i > 1) {
                add(`${parts[i - 2]}/${parts[i - 1]}/${part}.rs`);
            }
        }
        return tails;
    }
    async resolveSourceFile(file, symbol) {
        const searchRoots = this.sourceSearchRoots();
        console.log('[AsyncInspector] resolveSourceUri input file=' + file +
            ' isAbsolute=' + String(path.isAbsolute(file)) +
            ' searchRoots=' + JSON.stringify(searchRoots));
        // 1) 绝对路径且真实存在
        if (path.isAbsolute(file) && fs.existsSync(file)) {
            console.log('[AsyncInspector] resolveSourceUri absolute-hit=' + file);
            this.inspectorLog('info', '[Inspector] Selected file found in workspace');
            return { uri: vscode.Uri.file(file) };
        }
        const tails = [
            ...this.sourceTailsFromFile(file),
            ...(symbol ? this.sourceTailsFromSymbol(symbol) : []),
        ];
        const seenTails = new Set();
        for (const searchTail of tails) {
            if (!searchTail || seenTails.has(searchTail)) {
                continue;
            }
            seenTails.add(searchTail);
            // 2) 用所有 searchRoots 直接拼接尝试
            for (const root of searchRoots) {
                const candidate = path.join(root, searchTail);
                console.log('[AsyncInspector] resolveSourceUri candidate=' + candidate);
                if (fs.existsSync(candidate)) {
                    console.log('[AsyncInspector] resolveSourceUri candidate-hit=' + candidate);
                    this.inspectorLog('info', '[Inspector] Selected file found in workspace');
                    return { uri: vscode.Uri.file(candidate) };
                }
            }
            // 3) 递归后缀搜索
            const matches = await this.findFilesBySuffix(searchRoots, searchTail);
            console.log('[AsyncInspector] resolveSourceUri recursive-found=' + JSON.stringify(matches));
            if (matches.length > 0) {
                this.inspectorLog('info', '[Inspector] Selected file found in workspace');
                return { uri: vscode.Uri.file(matches[0]), matches };
            }
        }
        console.log('[AsyncInspector] resolveSourceUri failed', {
            file,
            tails,
            searchRoots,
        });
        return undefined;
    }
    parseInfoLine(output) {
        const match = output.match(/Line\s+(\d+)\s+of\s+"([^"]+)"/);
        if (!match) {
            return undefined;
        }
        return {
            line: parseInt(match[1], 10),
            file: match[2],
        };
    }
    async querySymbolSourceLocation(symbol) {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session || !symbol || symbol === '<unknown>') {
            return undefined;
        }
        try {
            const escaped = symbol.replace(/'/g, "\\'");
            const output = await session.executeGDBCommand(`info line '${escaped}'`);
            return this.parseInfoLine(output);
        }
        catch (error) {
            console.error('Failed to locate symbol:', error);
            return undefined;
        }
    }
    validLine(line) {
        if (typeof line !== 'number' || !Number.isFinite(line) || line <= 0) {
            return undefined;
        }
        return Math.floor(line);
    }
    async resolveNodeSourceLocation(node, nodeRef) {
        const symbol = node?.func || nodeRef.func || '';
        const snapshotFile = node?.file || node?.fullname || nodeRef.file || nodeRef.fullname || '';
        const snapshotLine = this.validLine(node?.line) || this.validLine(nodeRef.line);
        if (snapshotFile) {
            const resolved = await this.resolveSourceFile(snapshotFile, symbol);
            if (resolved) {
                return {
                    uri: resolved.uri,
                    line: snapshotLine || 1,
                    reason: 'snapshot',
                    matches: resolved.matches,
                };
            }
        }
        const gdbLocation = await this.querySymbolSourceLocation(symbol);
        if (gdbLocation) {
            const resolved = await this.resolveSourceFile(gdbLocation.file, symbol);
            if (resolved) {
                return {
                    uri: resolved.uri,
                    line: gdbLocation.line,
                    reason: 'gdb-info-line',
                    matches: resolved.matches,
                };
            }
        }
        for (const tail of this.sourceTailsFromSymbol(symbol)) {
            const matches = await this.findFilesBySuffix(this.sourceSearchRoots(), tail);
            if (matches.length > 0) {
                return {
                    uri: vscode.Uri.file(matches[0]),
                    line: snapshotLine || 1,
                    reason: 'symbol-source-roots',
                    matches,
                };
            }
        }
        return undefined;
    }
    async openSourceAt(uri, line) {
        const doc = await vscode.workspace.openTextDocument(uri);
        let targetLine = Math.max(0, line - 1);
        if (targetLine >= doc.lineCount) {
            this.inspectorLog('warn', `[Inspector] Warning: line ${line} is outside ${uri.fsPath} (${doc.lineCount} lines), opening last line`);
            targetLine = Math.max(0, doc.lineCount - 1);
        }
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
    async handleSelectFrame(file, line) {
        if (!file) {
            return;
        }
        try {
            const resolved = await this.resolveSourceFile(file);
            if (!resolved) {
                vscode.window.showWarningMessage(`Cannot resolve file: ${file}`);
                return;
            }
            await this.openSourceAt(resolved.uri, line || 1);
        }
        catch (error) {
            console.error('Failed to open source file:', error);
            vscode.window.showWarningMessage(`Cannot open file: ${file}`);
        }
    }
    getSnapshotNodeOrigin(node) {
        const origin = node.origin;
        return typeof origin === 'string' && origin ? origin : undefined;
    }
    copySnapshotMetadata(target, source) {
        target.state_read_status = source.state_read_status;
        target.state_read_error = source.state_read_error;
        target.child_hit_match = source.child_hit_match;
        target.child_hit_thread_id = source.child_hit_thread_id;
        target.child_hit_parent_cid = source.child_hit_parent_cid;
        target.child_hit_parent_symbol = source.child_hit_parent_symbol;
        target.child_hit_child_symbol = source.child_hit_child_symbol;
        target.child_hit_env_addr = source.child_hit_env_addr;
        target.privilege = source.privilege;
        target.transition_event = source.transition_event;
    }
    updateTreeFromSnapshot(snapshot) {
        // The Inspector is a view of the current snapshot, not accumulated
        // trace history. Rebuild so nodes absent from this path disappear.
        this._treeRoots.clear();
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
        }
        else {
            root.poll = rootNode.poll;
            root.state = rootNode.state;
            root.origin = this.getSnapshotNodeOrigin(rootNode);
            root.file = rootNode.file;
            root.fullname = rootNode.fullname;
            root.line = rootNode.line;
        }
        this.copySnapshotMetadata(root, rootNode);
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
            if (node.type === 'async') {
                let child;
                if (node.cid !== null) {
                    // 1) 先按真实 CID 找
                    child = current.children.find(c => c.type === 'async' && c.cid === node.cid);
                    // 2) 如果没找到，再找“同 func 的旧占位节点”并升级
                    if (!child) {
                        const placeholder = current.children.find(c => c.type === 'async' &&
                            c.cid === null &&
                            c.func === node.func);
                        if (placeholder) {
                            placeholder.cid = node.cid;
                            placeholder.addr = node.addr;
                            placeholder.poll = node.poll;
                            placeholder.state = node.state;
                            placeholder.origin = this.getSnapshotNodeOrigin(node);
                            placeholder.file = node.file;
                            placeholder.fullname = node.fullname;
                            placeholder.line = node.line;
                            this.copySnapshotMetadata(placeholder, node);
                            child = placeholder;
                        }
                    }
                    // 3) 不管 child 是按 CID 找到的，还是由 placeholder 升级来的，
                    //    都清理掉同 func 的旧 placeholder，避免树里长期残留重复节点
                    current.children = current.children.filter(c => !(c !== child &&
                        c.type === 'async' &&
                        c.cid === null &&
                        c.func === node.func));
                }
                else {
                    child = current.children.find(c => c.type === 'async' &&
                        c.cid === null &&
                        c.func === node.func &&
                        c.addr === node.addr);
                }
                const nextChild = child ?? {
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
                this.copySnapshotMetadata(nextChild, node);
                if (!child) {
                    current.children.push(nextChild);
                }
                else {
                    nextChild.poll = node.poll;
                    nextChild.state = node.state;
                    nextChild.addr = node.addr;
                    nextChild.origin = this.getSnapshotNodeOrigin(node);
                    nextChild.file = node.file;
                    nextChild.fullname = node.fullname;
                    nextChild.line = node.line;
                    this.copySnapshotMetadata(nextChild, node);
                }
                current = nextChild;
            }
            else if (node.type === 'sync') {
                // Dedup sync nodes by func + addr
                let syncChild = current.children.find(c => c.type === 'sync' && c.func === node.func && c.addr === node.addr);
                if (!syncChild) {
                    syncChild = {
                        type: 'sync',
                        cid: null,
                        func: node.func,
                        addr: node.addr,
                        poll: node.poll ?? 0,
                        state: node.state ?? 'NON-ASYNC',
                        origin: this.getSnapshotNodeOrigin(node),
                        file: node.file,
                        fullname: node.fullname,
                        line: node.line,
                        children: [],
                    };
                    this.copySnapshotMetadata(syncChild, node);
                    current.children.push(syncChild);
                }
                else {
                    syncChild.poll = node.poll ?? 0;
                    syncChild.state = node.state ?? 'NON-ASYNC';
                    syncChild.origin = this.getSnapshotNodeOrigin(node);
                    syncChild.file = node.file;
                    syncChild.fullname = node.fullname;
                    syncChild.line = node.line;
                    this.copySnapshotMetadata(syncChild, node);
                }
                // snapshot.path is one logical chain, so consecutive physical
                // frames must be nested rather than flattened as siblings.
                current = syncChild;
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
                <style>
                    .node-badges {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 4px;
                        margin-bottom: 2px;
                    }
                    .ard-badge {
                        display: inline-block;
                        padding: 1px 5px;
                        border-radius: 3px;
                        border: 1px solid var(--vscode-panel-border);
                        font-size: 10px;
                        font-weight: 600;
                        line-height: 1.4;
                        color: var(--vscode-descriptionForeground);
                    }
                    .ard-badge.async { color: #ff8a8a; }
                    .ard-badge.sync { color: #69db7c; }
                    .ard-badge.kernel { color: #74c0fc; }
                    .ard-badge.user { color: #ffd43b; }
                    .ard-badge.trace { color: #b197fc; }
                    .ard-badge.state-ok { color: #69db7c; }
                    .ard-badge.state-unsupported { color: #ffa94d; }
                    .ard-badge.transition { color: #ff8787; }
                    .node-detail-line {
                        font-size: 11px;
                        color: var(--vscode-descriptionForeground);
                        margin-top: 2px;
                        overflow-wrap: anywhere;
                    }
                    .node-detail-note {
                        color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
                    }
                    .transition-chain {
                        display: block;
                        flex: 1 1 50%;
                        min-height: 0;
                        margin: 0;
                        padding: 8px;
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 4px;
                        background: var(--vscode-editorWidget-background);
                        overflow-y: auto;
                    }
                    .transition-chain-title {
                        font-weight: 600;
                        font-size: 12px;
                        margin-bottom: 6px;
                    }
                    .transition-chain-node {
                        cursor: pointer;
                        padding: 3px 4px;
                        border-radius: 3px;
                        font-size: 11px;
                        overflow-wrap: anywhere;
                    }
                    .transition-chain-node:hover {
                        background-color: var(--vscode-list-hoverBackground);
                    }
                    .transition-chain-arrow {
                        color: var(--vscode-descriptionForeground);
                        font-size: 11px;
                        padding-left: 10px;
                    }
                    .side-panel {
                        min-height: 0;
                        overflow: hidden;
                        gap: 12px;
                    }
                    .candidates-section {
                        flex: 1 1 50%;
                        min-height: 0;
                    }
                    #candidatesList {
                        max-height: none;
                        overflow-y: visible;
                    }
                </style>
                <title>Async Inspector</title>
            </head>
            <body>
                <div class="container">
                    <div class="toolbar">
                        <button id="resetBtn" class="btn">Reset</button>
                        <button id="genWhitelistBtn" class="btn">Gen Whitelist</button>
                        <button id="snapshotBtn" class="btn">Snapshot</button>
                        <button id="connectRemoteBtn" class="btn">Connect :1234</button>
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
                            <div id="transitionChain" class="transition-chain"></div>
                        </div>
                    </div>
                </div>
                <script>
                    window.ardInspectorVscode = window.ardInspectorVscode || acquireVsCodeApi();
                    window.acquireVsCodeApi = function() { return window.ardInspectorVscode; };
                    window.treeData = ${JSON.stringify(Array.from(this._treeRoots.values()))};
                    window.transitionPath = ${JSON.stringify(this._lastTransitionPath)};
                </script>
                <script src="${scriptUri}"></script>
                <script>
                    (function() {
                        var patchScheduled = false;
                        var isPatching = false;

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

                        function valueOrNA(value) {
                            return value === undefined || value === null || value === '' ? 'N/A' : String(value);
                        }

                        function addBadge(container, text, extraClass) {
                            var badge = document.createElement('span');
                            badge.className = 'ard-badge ' + (extraClass || '');
                            badge.textContent = text;
                            container.appendChild(badge);
                        }

                        function stateBadge(node) {
                            var status = node && node.state_read_status;
                            if (status === 'ok') {
                                return { text: 'STATE:OK', cls: 'state-ok' };
                            }
                            if (status === 'unsupported') {
                                return { text: 'STATE:UNSUPPORTED', cls: 'state-unsupported' };
                            }
                            if (status) {
                                return { text: 'STATE:' + String(status).toUpperCase(), cls: 'state-unsupported' };
                            }
                            return { text: 'STATE:N/A', cls: 'state-unsupported' };
                        }

                        function originBadge(node) {
                            var origin = node && node.origin;
                            switch (origin) {
                                case 'trace':
                                    return 'TRACE';
                                case 'trace-upgraded':
                                    return 'TRACE-UPGRADED';
                                case 'inferred':
                                    return 'INFERRED';
                                case 'physical':
                                    return 'PHYSICAL';
                                default:
                                    return 'ORIGIN:N/A';
                            }
                        }

                        function transitionBadge(node) {
                            var event = node && node.transition_event;
                            if (event === 'user_to_kernel') {
                                return 'USER->KERNEL';
                            }
                            if (event === 'kernel_to_user') {
                                return 'KERNEL->USER';
                            }
                            if (event && event !== 'none') {
                                return String(event).toUpperCase();
                            }
                            return '';
                        }

                        function formatEvidence(node) {
                            var origin = node && node.origin;
                            switch (origin) {
                                case 'trace':
                                    return 'Evidence: real poll hit';
                                case 'trace-upgraded':
                                    return 'Evidence: inferred node upgraded by trace hit';
                                case 'inferred':
                                    return 'Evidence: inferred from frame / awaitee';
                                case 'physical':
                                    return 'Evidence: physical stack frame';
                                default:
                                    return 'Evidence: unavailable';
                            }
                        }

                        function formatChildHit(node) {
                            if (!node) {
                                return 'ChildHit: N/A';
                            }
                            var parent = node.child_hit_parent_symbol;
                            var child = node.child_hit_child_symbol;
                            if (parent || child) {
                                return 'ChildHit: ' + valueOrNA(parent) + ' -> ' + valueOrNA(child);
                            }
                            var match = node.child_hit_match;
                            if (match && match !== 'not_applicable') {
                                return 'ChildHit: ' + match;
                            }
                            return 'ChildHit: ' + valueOrNA(match || 'not_applicable');
                        }

                        function appendDetail(info, text, extraClass) {
                            var line = document.createElement('div');
                            line.className = 'node-detail-line ' + (extraClass || '');
                            line.textContent = text;
                            info.appendChild(line);
                        }

                        function transitionNodeText(node) {
                            var privilege = valueOrNA(node && node.privilege).toUpperCase();
                            var type = valueOrNA(node && node.type);
                            var label = (node && (node.label || node.func || node.event || node.symbol)) || 'unknown';
                            if (node && node.type === 'transition') {
                                return '[TRANSITION] ' + valueOrNA(node.event || node.label);
                            }
                            return '[' + privilege + '][' + type + '] ' + label;
                        }

                        function renderTransitionPath(path) {
                            var container = document.getElementById('transitionChain');
                            if (!container) {
                                return;
                            }
                            container.innerHTML = '';
                            container.style.display = 'block';
                            var title = document.createElement('div');
                            title.className = 'transition-chain-title';
                            title.textContent = 'Cross Privilege Chain';
                            container.appendChild(title);

                            if (!Array.isArray(path) || path.length === 0) {
                                var empty = document.createElement('div');
                                empty.className = 'placeholder-text';
                                empty.textContent = 'No cross privilege chain available.';
                                container.appendChild(empty);
                                return;
                            }

                            path.forEach(function(node, index) {
                                if (index > 0) {
                                    var arrow = document.createElement('div');
                                    arrow.className = 'transition-chain-arrow';
                                    arrow.textContent = '↓';
                                    container.appendChild(arrow);
                                }

                                var row = document.createElement('div');
                                row.className = 'transition-chain-node';
                                row.textContent = transitionNodeText(node);
                                row.addEventListener('click', function(event) {
                                    event.stopPropagation();
                                    if (window.ardInspectorVscode) {
                                        window.ardInspectorVscode.postMessage({
                                            command: 'selectNode',
                                            cid: null,
                                            func: node.func || node.label || node.event || '',
                                            addr: node.pc || '',
                                            file: node.file,
                                            fullname: node.fullname,
                                            line: node.line,
                                        });
                                    }
                                });
                                container.appendChild(row);
                            });
                        }

                        function patchNode(node, treeNodeElement) {
                            var info = treeNodeElement.querySelector(':scope > .node-content .node-info');
                            var func = treeNodeElement.querySelector(':scope > .node-content .node-func');
                            var meta = treeNodeElement.querySelector(':scope > .node-content .node-meta');
                            var oldType = treeNodeElement.querySelector(':scope > .node-content .node-type');

                            if (!info || !func || !meta) {
                                return;
                            }

                            if (oldType) {
                                oldType.style.display = 'none';
                            }

                            var oldBadges = info.querySelector(':scope > .node-badges');
                            if (oldBadges) {
                                oldBadges.remove();
                            }
                            var oldDetails = info.querySelectorAll(':scope > .node-detail-line');
                            oldDetails.forEach(function(detail) { detail.remove(); });

                            var badges = document.createElement('div');
                            badges.className = 'node-badges';
                            var typeText = node.type === 'async' ? 'ASYNC' : (node.type === 'transition' ? 'TRANSITION' : 'SYNC');
                            addBadge(badges, typeText, node.type === 'async' ? 'async' : (node.type === 'sync' ? 'sync' : 'transition'));

                            var privilege = node.privilege;
                            if (privilege === 'kernel') {
                                addBadge(badges, 'KERNEL', 'kernel');
                            } else if (privilege === 'user') {
                                addBadge(badges, 'USER', 'user');
                            } else {
                                addBadge(badges, 'PRIV:N/A', '');
                            }

                            addBadge(badges, originBadge(node), 'trace');
                            var state = stateBadge(node);
                            addBadge(badges, state.text, state.cls);
                            var transition = transitionBadge(node);
                            if (transition) {
                                addBadge(badges, transition, 'transition');
                            }

                            info.insertBefore(badges, func);

                            if (node.type === 'async') {
                                meta.textContent =
                                    'CID: ' + valueOrNA(node.cid) +
                                    ' | Poll: ' + valueOrNA(node.poll) +
                                    ' | State: ' + formatDisplayState(node) +
                                    ' | StateRead: ' + valueOrNA(node.state_read_status);
                            } else {
                                meta.textContent = 'Addr: ' + valueOrNA(node.addr);
                            }

                            if (node.transition_event && node.transition_event !== 'none') {
                                appendDetail(info, 'Transition: ' + node.transition_event);
                            } else if (node.transition_event === 'none') {
                                appendDetail(info, 'Transition: none');
                            }
                            appendDetail(info, formatEvidence(node));
                            appendDetail(info, formatChildHit(node));
                            if (node.state_read_error) {
                                appendDetail(info, 'StateReadError: ' + node.state_read_error, 'node-detail-note');
                            }
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
                            var treeNodes = document.querySelectorAll('#treeContainer .tree-node');
                            treeNodes.forEach(function(treeNode, index) {
                                var node = flat[index];
                                if (!node) {
                                    return;
                                }
                                patchNode(node, treeNode);
                            });
                        }

                        function scheduleInspectorPatch(nodes) {
                            window.treeData = nodes || window.treeData || [];
                            if (patchScheduled) {
                                return;
                            }
                            patchScheduled = true;
                            setTimeout(function() {
                                patchScheduled = false;
                                isPatching = true;
                                try {
                                    renderTransitionPath(window.transitionPath || []);
                                    patchTreeMetadata(window.treeData || []);
                                } finally {
                                    isPatching = false;
                                }
                            }, 0);
                        }

                        window.addEventListener('message', function(event) {
                            var message = event.data;
                            if (message && message.command === 'updateTree') {
                                window.transitionPath = message.transitionPath || [];
                                scheduleInspectorPatch(message.treeData);
                            } else if (message && message.command === 'connectRemoteResult') {
                                var button = document.getElementById('connectRemoteBtn');
                                if (button) {
                                    button.disabled = false;
                                    button.textContent = 'Connect :1234';
                                    button.title = message.message || '';
                                }
                            }
                        });

                        var connectRemoteBtn = document.getElementById('connectRemoteBtn');
                        if (connectRemoteBtn) {
                            connectRemoteBtn.addEventListener('click', function() {
                                connectRemoteBtn.disabled = true;
                                connectRemoteBtn.textContent = 'Connecting...';
                                window.ardInspectorVscode.postMessage({
                                    command: 'connectRemote',
                                    host: '127.0.0.1',
                                    port: 1234,
                                });
                            });
                        }

                        var treeContainer = document.getElementById('treeContainer');
                        if (treeContainer && typeof MutationObserver !== 'undefined') {
                            var observer = new MutationObserver(function() {
                                if (!isPatching) {
                                    scheduleInspectorPatch(window.treeData || []);
                                }
                            });
                            observer.observe(treeContainer, { childList: true, subtree: true });
                        }

                        scheduleInspectorPatch(window.treeData || []);
                    })();
                </script>
            </body>
            </html>`;
    }
    dispose() {
        AsyncInspectorPanel.currentPanel = undefined;
        this._panel.dispose();
        this._outputChannel.dispose();
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