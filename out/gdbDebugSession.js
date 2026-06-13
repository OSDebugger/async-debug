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
exports.GDBDebugSession = void 0;
//src/gdbDebugSession.ts
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
/**
 * GDB Debug Session that communicates with GDB via VS Code debug session API
 * and executes ARD-specific commands.
 */
class GDBDebugSession {
    constructor(context) {
        this.context = context;
        // Determine temp directory
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const envTempDir = process.env.ASYNC_RUST_DEBUGGER_TEMP_DIR;
        this.tempDir = envTempDir || (workspaceFolder ? path.join(workspaceFolder, 'temp') : './temp');
        this.logPath = path.join(this.tempDir, 'ardb.log');
        this.whitelistPath = path.join(this.tempDir, 'poll_functions.txt');
        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
        // Setup file watcher for whitelist
        this.setupWhitelistWatcher();
        // Listen for debug session changes
        vscode.debug.onDidStartDebugSession((session) => {
            if (session.type === 'ardb') {
                this.setDebugSession(session);
            }
        });
        vscode.debug.onDidTerminateDebugSession((session) => {
            if (session === this.debugSession) {
                this.debugSession = undefined;
            }
        });
    }
    /**
     * Set the active debug session.
     */
    setDebugSession(session) {
        this.debugSession = session;
        this.configurePaths(this.resolveSessionTempDir(session));
    }
    resolveSessionTempDir(session) {
        const workspaceFolder = session.workspaceFolder?.uri.fsPath ||
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const config = session.configuration || {};
        const configuredCwd = typeof config.cwd === 'string'
            ? this.expandWorkspaceFolder(config.cwd, workspaceFolder)
            : workspaceFolder;
        const configuredTempDir = config.env?.ASYNC_RUST_DEBUGGER_TEMP_DIR;
        if (typeof configuredTempDir === 'string' && configuredTempDir.trim()) {
            const expandedTempDir = this.expandWorkspaceFolder(configuredTempDir, workspaceFolder);
            return path.isAbsolute(expandedTempDir)
                ? expandedTempDir
                : path.resolve(configuredCwd || process.cwd(), expandedTempDir);
        }
        if (workspaceFolder) {
            return path.join(workspaceFolder, 'temp');
        }
        if (configuredCwd) {
            return path.join(configuredCwd, 'temp');
        }
        return this.tempDir;
    }
    expandWorkspaceFolder(value, workspaceFolder) {
        return workspaceFolder
            ? value.replace(/\$\{workspaceFolder\}/g, workspaceFolder)
            : value;
    }
    configurePaths(tempDir) {
        const resolvedTempDir = path.resolve(tempDir);
        if (this.tempDir === resolvedTempDir && this.fileWatcher) {
            return;
        }
        this.tempDir = resolvedTempDir;
        this.logPath = path.join(this.tempDir, 'ardb.log');
        this.whitelistPath = path.join(this.tempDir, 'poll_functions.txt');
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
        this.setupWhitelistWatcher();
    }
    async loadWhitelist() {
        const command = `ardb-load-whitelist ${this.whitelistPath}`;
        const output = await this.executeGDBCommand(command);
        if (!output || output.includes('[ARD] failed')) {
            throw new Error(output.trim() || `No response from: ${command}`);
        }
        console.log(`[GDBDebugSession] ${command}: ${output.trim()}`);
    }
    setupWhitelistWatcher() {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(this.whitelistPath), path.basename(this.whitelistPath)));
        this.fileWatcher.onDidChange(async (uri) => {
            if (uri.fsPath === this.whitelistPath && this.debugSession) {
                // Auto-reload whitelist when file is saved
                try {
                    await this.loadWhitelist();
                    const count = await this.getWhitelistSymbolCount();
                    vscode.window.showInformationMessage(`Whitelist reloaded (${count} symbols found)`);
                }
                catch (error) {
                    console.error('Failed to reload whitelist:', error);
                    vscode.window.showErrorMessage(`Failed to reload whitelist: ${error}`);
                }
            }
        });
    }
    async getWhitelistSymbolCount() {
        try {
            if (fs.existsSync(this.whitelistPath)) {
                const content = fs.readFileSync(this.whitelistPath, 'utf-8');
                const lines = content.split('\n').filter(line => {
                    const trimmed = line.trim();
                    return trimmed && !trimmed.startsWith('#');
                });
                return lines.length;
            }
        }
        catch (error) {
            console.error('Failed to read whitelist:', error);
        }
        return 0;
    }
    /**
     * Execute a GDB command via the debug session.
     * Note: This requires the debug adapter to support custom requests.
     */
    async executeGDBCommand(command, suppressOutput = false) {
        if (!this.debugSession) {
            throw new Error('No active debug session');
        }
        try {
            const response = await this.debugSession.customRequest('evaluate', {
                expression: command,
                context: suppressOutput ? 'watch' : 'repl'
            });
            return response?.result || '';
        }
        catch (error) {
            console.error('GDB Command Failed:', command, error);
            return '';
        }
    }
    async executeGDBCommandInternal(command) {
        return this.executeGDBCommand(command, true);
    }
    /**
     * Connect the active GDB process to a remote target without starting a
     * second GDB process. Existing launch.json targetRemote support remains
     * the preferred automatic path.
     */
    async connectRemote(target = ':1234') {
        if (!this.debugSession) {
            return {
                status: 'failed',
                message: `[ARD] failed to connect remote target ${target}: no active debug session`,
            };
        }
        let connectionState = await this.executeGDBCommandInternal('python import gdb; print(gdb.selected_inferior().connection)');
        if (/attributeerror|python exception|undefined command|error while executing python/i.test(connectionState)) {
            connectionState = await this.executeGDBCommandInternal('info target');
        }
        if (/RemoteTargetConnection|remote (?:serial )?target|remote debugging using|gdb-specific protocol|what="remote /i.test(connectionState)) {
            const message = `[ARD] remote target already connected to ${target}`;
            await this.writeDebugConsoleMessage(message);
            return { status: 'already-connected', message };
        }
        const output = await this.executeGDBCommandInternal(`target remote ${target}`);
        const failed = !output || /could not connect|connection refused|connection timed out|operation not permitted|no route to host|connection reset|remote communication error|command failed|not available|program is being debugged already/i.test(output);
        if (failed) {
            const detail = this.summarizeGDBError(output);
            const message = `[ARD] failed to connect remote target ${target}: ${detail}`;
            await this.writeDebugConsoleMessage(message);
            return { status: 'failed', message, detail };
        }
        const message = `[ARD] connected to remote target ${target}`;
        await this.writeDebugConsoleMessage(message);
        return { status: 'connected', message };
    }
    summarizeGDBError(output) {
        const lines = (output || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
        const errorLine = [...lines].reverse().find(line => /could not connect|connection refused|connection timed out|operation not permitted|no route to host|connection reset|remote communication error|command failed|not available|program is being debugged already/i.test(line));
        return (errorLine || lines[lines.length - 1] || 'no response from GDB')
            .replace(/\s+/g, ' ')
            .slice(0, 180);
    }
    async writeDebugConsoleMessage(message) {
        const escaped = message.replace(/\\/g, '\\\\');
        await this.executeGDBCommand(`echo ${escaped}\\n`);
    }
    /**
     * Get snapshot from GDB using ardb-get-snapshot command.
     * Parses the JSON directly from the evaluate response.
     */
    async getSnapshot(suppressOutput = false) {
        if (!this.debugSession) {
            console.warn('[GDBDebugSession] getSnapshot: no debug session');
            return undefined;
        }
        try {
            const output = await this.executeGDBCommand('ardb-get-snapshot', suppressOutput);
            if (!suppressOutput) {
                console.log('[GDBDebugSession] ardb-get-snapshot raw output length:', output.length, 'first 200 chars:', output.substring(0, 200));
            }
            if (!output) {
                return this.lastSnapshot;
            }
            // The output may contain non-JSON lines before/after the JSON object.
            // Find the first '{' and last '}' to extract the JSON payload.
            const jsonStart = output.indexOf('{');
            const jsonEnd = output.lastIndexOf('}');
            if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
                return this.lastSnapshot;
            }
            const jsonStr = output.substring(jsonStart, jsonEnd + 1);
            const snapshot = JSON.parse(jsonStr);
            if (snapshot.thread_id !== undefined && snapshot.path) {
                this.lastSnapshot = snapshot;
                return snapshot;
            }
            return this.lastSnapshot;
        }
        catch (error) {
            console.error('Failed to get snapshot:', error);
            return this.lastSnapshot;
        }
    }
    async getSnapshotPath(suppressOutput = false) {
        try {
            const output = await this.executeGDBCommand('ardb-get-snapshot-path', suppressOutput);
            const result = this.parseJSONResult(output);
            if (result && result.thread_id !== undefined && Array.isArray(result.path)) {
                this.lastSnapshotPath = result;
                return result;
            }
            return this.lastSnapshotPath;
        }
        catch (error) {
            console.error('Failed to get snapshot path:', error);
            return this.lastSnapshotPath;
        }
    }
    async getTransitionChain(suppressOutput = false) {
        try {
            const output = await this.executeGDBCommand('ardb-get-transition-chain', suppressOutput);
            const result = this.parseJSONResult(output);
            if (result && result.thread_id !== undefined && Array.isArray(result.transition_path)) {
                this.lastTransitionChain = result;
                return result;
            }
            return this.lastTransitionChain;
        }
        catch (error) {
            console.error('Failed to get transition chain:', error);
            return this.lastTransitionChain;
        }
    }
    parseJSONResult(output) {
        if (!output) {
            return undefined;
        }
        const jsonStart = output.indexOf('{');
        const jsonEnd = output.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
            return undefined;
        }
        return JSON.parse(output.substring(jsonStart, jsonEnd + 1));
    }
    /**
     * Execute ardb-reset command.
     */
    async reset() {
        await this.executeGDBCommand('ardb-reset');
        // Clear log file
        if (fs.existsSync(this.logPath)) {
            fs.writeFileSync(this.logPath, '');
        }
    }
    /**
     * Execute ardb-gen-whitelist command and open the file.
     */
    async genWhitelist() {
        try {
            await this.executeGDBCommand('ardb-gen-whitelist');
            if (!fs.existsSync(this.whitelistPath)) {
                throw new Error(`Generated whitelist not found: ${this.whitelistPath}`);
            }
            await this.loadWhitelist();
            const count = await this.getWhitelistSymbolCount();
            vscode.window.showInformationMessage(`Whitelist generated and loaded (${count} symbols found)`);
            const doc = await vscode.workspace.openTextDocument(this.whitelistPath);
            await vscode.window.showTextDocument(doc);
        }
        catch (error) {
            console.error('Failed to generate and load whitelist:', error);
            vscode.window.showErrorMessage(`Failed to generate and load whitelist: ${error}`);
        }
    }
    /**
     * Execute ardb-trace command.
     */
    async traceFunction(symbol) {
        await this.executeGDBCommand(`ardb-trace ${symbol}`);
    }
    /**
     * Get log entries for a specific CID.
     */
    async getLogEntriesForCID(cid) {
        try {
            if (!fs.existsSync(this.logPath)) {
                return [];
            }
            const content = fs.readFileSync(this.logPath, 'utf-8');
            const lines = content.split('\n');
            const cidPattern = new RegExp(`coro#${cid}`);
            return lines.filter(line => cidPattern.test(line)).slice(-10); // Last 10 entries
        }
        catch (error) {
            console.error('Failed to read log:', error);
            return [];
        }
    }
    /**
     * Get whitelist candidates from poll_functions.txt.
     */
    async getWhitelistCandidates() {
        try {
            if (!fs.existsSync(this.whitelistPath)) {
                return [];
            }
            const content = fs.readFileSync(this.whitelistPath, 'utf-8');
            const candidates = [];
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const parts = trimmed.split(/\s+/);
                    const symbol = parts.length >= 2 ? parts[1] : trimmed;
                    if (symbol) {
                        candidates.push(symbol);
                    }
                }
            }
            return candidates;
        }
        catch (error) {
            console.error('Failed to read whitelist:', error);
            return [];
        }
    }
    dispose() {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }
    }
}
exports.GDBDebugSession = GDBDebugSession;
//# sourceMappingURL=gdbDebugSession.js.map