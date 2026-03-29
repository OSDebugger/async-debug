import * as child_process from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    DebugSession,
    InitializedEvent,
    StoppedEvent,
    ContinuedEvent,
    TerminatedEvent,
    OutputEvent,
    BreakpointEvent,
    Thread,
    Source,
    StackFrame,
    Scope,
    Variable,
    Breakpoint,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { parseMILine, MIRecord } from './miParser';

// ---------------------------------------------------------------------------
// Exported interfaces (used by asyncInspectorPanel and extension)
// ---------------------------------------------------------------------------

export interface SnapshotData {
    thread_id: number;
    path: Array<{
        type: 'async' | 'sync';
        cid: number | null;
        func: string;
        addr: string;
        poll: number;
        state: number | string;
        file?: string;
        fullname?: string;
        line?: number;
    }>;
}

export interface GroupedWhitelist {
    version: number;
    crates: {
        [crateName: string]: {
            is_user_crate: boolean;
            symbols: Array<{
                name: string;
                file: string | null;
                line: number | null;
                kind: 'async' | 'sync';
            }>;
        };
    };
}

export interface InferredTraceRoot {
    trace_root: string | null;
    all_async_frames: string[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GDBDebugSessionOptions {
    pythonPath: string;
    tempDir: string;
}

// ---------------------------------------------------------------------------
// GDBDebugSession
// ---------------------------------------------------------------------------

export class GDBDebugSession extends DebugSession {

    // Configuration
    private pythonPath: string;
    private tempDir: string;
    private logPath: string;
    private whitelistPath: string;
    private groupedWhitelistPath: string;

    // GDB subprocess
    private gdbProcess: child_process.ChildProcess | undefined;
    private gdbOutputBuffer = '';

    // MI command tracking
    private nextToken = 1;
    private pendingCommands: Map<number, {
        resolve: (record: MIRecord) => void;
        reject: (err: Error) => void;
        consoleOutput: string[];
    }> = new Map();
    private commandQueue: number[] = [];

    // Inferior state
    private inferiorStarted = false;
    private program = '';
    private programArgs: string[] = [];
    private cwd = '';

    // Breakpoint state
    private fileBreakpoints: Map<string, number[]> = new Map();
    private gdbBkptToDap: Map<number, { id: number; line: number; verified: boolean }> = new Map();
    private nextDapBreakpointId = 1;
    private functionBreakpointNumbers: number[] = [];

    // Variable / scope state
    private nextVarRef = 1;
    private varRefMap: Map<
        number,
        | { type: 'scope'; scopeKind: 'args' | 'locals'; threadId: number; frameLevel: number }
        | { type: 'var'; varName: string }
    > = new Map();
    private createdVarObjects: string[] = [];

    constructor(opts: GDBDebugSessionOptions) {
        super();
        this.pythonPath = opts.pythonPath;
        this.tempDir = opts.tempDir;
        this.logPath = path.join(opts.tempDir, 'ardb.log');
        this.whitelistPath = path.join(opts.tempDir, 'poll_functions.txt');
        this.groupedWhitelistPath = path.join(opts.tempDir, 'poll_functions_grouped.json');
    }

    // -----------------------------------------------------------------------
    // DAP: initialize
    // -----------------------------------------------------------------------

    protected initializeRequest(
        response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments,
    ): void {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsEvaluateForHovers = false;
        response.body.supportsFunctionBreakpoints = true;
        (response.body as any).supportsVariableType = true;

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    // -----------------------------------------------------------------------
    // DAP: launch
    // -----------------------------------------------------------------------

    protected launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: DebugProtocol.LaunchRequestArguments,
    ): void {
        const config = args as any;
        this.program = config.program || '';
        this.programArgs = config.args || [];
        this.cwd = config.cwd || process.cwd();

        if (!this.program) {
            this.sendErrorResponse(response, 1, 'No program specified in launch configuration');
            return;
        }

        // Ensure temp dir exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }

        this.launchGDB();
        this.inferiorStarted = false;
        this.sendResponse(response);
    }

    // -----------------------------------------------------------------------
    // DAP: configurationDone
    // -----------------------------------------------------------------------

    protected configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments,
    ): void {
        this.sendResponse(response);

        // Emit synthetic stopped event so VS Code enters paused state,
        // giving the user time to configure ARD before running the program.
        const event = new StoppedEvent('entry', 1);
        (event.body as any).description = 'Program loaded. Configure ARD, then press Continue to run.';
        (event.body as any).allThreadsStopped = true;
        this.sendEvent(event);
    }

    // -----------------------------------------------------------------------
    // DAP: setBreakpoints
    // -----------------------------------------------------------------------

    protected async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments,
    ): Promise<void> {
        const source = args.source;
        const filePath = source.path || '';
        const requestedLines = args.breakpoints || [];

        if (!filePath) {
            response.body = { breakpoints: [] };
            this.sendResponse(response);
            return;
        }

        try {
            // Delete old breakpoints for this file
            const oldNumbers = this.fileBreakpoints.get(filePath) || [];
            for (const num of oldNumbers) {
                await this.sendMICommand(`-break-delete ${num}`).catch(() => {});
                this.gdbBkptToDap.delete(num);
            }
            this.fileBreakpoints.delete(filePath);

            // Insert new breakpoints
            const newNumbers: number[] = [];
            const dapBreakpoints: DebugProtocol.Breakpoint[] = [];

            for (const bp of requestedLines) {
                const location = `${filePath}:${bp.line}`;
                try {
                    const record = await this.sendMICommand(`-break-insert -f ${location}`);
                    const bkpt = record.data?.bkpt;
                    const gdbNumber = parseInt(bkpt?.number || '0', 10);
                    const actualLine = parseInt(bkpt?.line || `${bp.line}`, 10);
                    const verified = bkpt?.pending === undefined;

                    if (bp.condition && gdbNumber > 0) {
                        await this.sendMICommand(`-break-condition ${gdbNumber} ${bp.condition}`).catch(() => {});
                    }

                    const dapId = this.nextDapBreakpointId++;
                    newNumbers.push(gdbNumber);
                    this.gdbBkptToDap.set(gdbNumber, { id: dapId, line: actualLine, verified });

                    const dbp = new Breakpoint(verified, actualLine);
                    dbp.setId(dapId);
                    (dbp as any).source = new Source(source.name || '', filePath);
                    dapBreakpoints.push(dbp);
                } catch (err: any) {
                    const dapId = this.nextDapBreakpointId++;
                    const dbp = new Breakpoint(false, bp.line);
                    dbp.setId(dapId);
                    (dbp as any).message = err.message || 'Failed to set breakpoint';
                    (dbp as any).source = new Source(source.name || '', filePath);
                    dapBreakpoints.push(dbp);
                }
            }

            this.fileBreakpoints.set(filePath, newNumbers);
            response.body = { breakpoints: dapBreakpoints };
            this.sendResponse(response);
        } catch (err: any) {
            this.sendErrorResponse(response, 2, err.message);
        }
    }

    // -----------------------------------------------------------------------
    // DAP: setFunctionBreakpoints
    // -----------------------------------------------------------------------

    protected async setFunctionBreakPointsRequest(
        response: DebugProtocol.SetFunctionBreakpointsResponse,
        args: DebugProtocol.SetFunctionBreakpointsArguments,
    ): Promise<void> {
        const requestedFunctions = args.breakpoints || [];

        try {
            // Delete old function breakpoints
            for (const num of this.functionBreakpointNumbers) {
                await this.sendMICommand(`-break-delete ${num}`).catch(() => {});
                this.gdbBkptToDap.delete(num);
            }
            this.functionBreakpointNumbers = [];

            const dapBreakpoints: DebugProtocol.Breakpoint[] = [];

            for (const fbp of requestedFunctions) {
                try {
                    const record = await this.sendMICommand(`-break-insert -f ${fbp.name}`);
                    const bkpt = record.data?.bkpt;
                    const gdbNumber = parseInt(bkpt?.number || '0', 10);
                    const actualLine = parseInt(bkpt?.line || '0', 10);
                    const verified = bkpt?.pending === undefined;

                    if (fbp.condition && gdbNumber > 0) {
                        await this.sendMICommand(`-break-condition ${gdbNumber} ${fbp.condition}`).catch(() => {});
                    }

                    const dapId = this.nextDapBreakpointId++;
                    this.functionBreakpointNumbers.push(gdbNumber);
                    this.gdbBkptToDap.set(gdbNumber, { id: dapId, line: actualLine, verified });

                    const dbp = new Breakpoint(verified, actualLine);
                    dbp.setId(dapId);
                    if (bkpt?.fullname) {
                        (dbp as any).source = new Source(bkpt.file || '', bkpt.fullname);
                    }
                    dapBreakpoints.push(dbp);
                } catch (err: any) {
                    const dapId = this.nextDapBreakpointId++;
                    const dbp = new Breakpoint(false);
                    dbp.setId(dapId);
                    (dbp as any).message = err.message || 'Failed to set function breakpoint';
                    dapBreakpoints.push(dbp);
                }
            }

            response.body = { breakpoints: dapBreakpoints };
            this.sendResponse(response);
        } catch (err: any) {
            this.sendErrorResponse(response, 3, err.message);
        }
    }

    // -----------------------------------------------------------------------
    // DAP: continue
    // -----------------------------------------------------------------------

    protected async continueRequest(
        response: DebugProtocol.ContinueResponse,
        args: DebugProtocol.ContinueArguments,
    ): Promise<void> {
        try {
            await this.cleanupVariables();

            if (!this.inferiorStarted) {
                this.inferiorStarted = true;
                await this.sendMICommand('-exec-run');
            } else {
                await this.sendMICommand('-exec-continue');
            }
            response.body = { allThreadsContinued: true };
            this.sendResponse(response);
        } catch (err: any) {
            console.log(`[Adapter] continue failed: ${err.message}`);
            this.sendErrorResponse(response, 4, err.message);
        }
    }

    // -----------------------------------------------------------------------
    // DAP: next / stepIn / stepOut / pause
    // -----------------------------------------------------------------------

    protected async nextRequest(
        response: DebugProtocol.NextResponse,
        args: DebugProtocol.NextArguments,
    ): Promise<void> {
        if (!this.inferiorStarted) {
            this.sendErrorResponse(response, 5, 'Program has not started yet. Press Continue first.');
            return;
        }
        try {
            await this.cleanupVariables();
            await this.sendMICommand('-exec-next');
            this.sendResponse(response);
        } catch (err: any) {
            this.sendErrorResponse(response, 5, err.message);
        }
    }

    protected async stepInRequest(
        response: DebugProtocol.StepInResponse,
        args: DebugProtocol.StepInArguments,
    ): Promise<void> {
        if (!this.inferiorStarted) {
            this.sendErrorResponse(response, 6, 'Program has not started yet. Press Continue first.');
            return;
        }
        try {
            await this.cleanupVariables();
            await this.sendMICommand('-exec-step');
            this.sendResponse(response);
        } catch (err: any) {
            this.sendErrorResponse(response, 6, err.message);
        }
    }

    protected async stepOutRequest(
        response: DebugProtocol.StepOutResponse,
        args: DebugProtocol.StepOutArguments,
    ): Promise<void> {
        if (!this.inferiorStarted) {
            this.sendErrorResponse(response, 7, 'Program has not started yet. Press Continue first.');
            return;
        }
        try {
            await this.cleanupVariables();
            await this.sendMICommand('-exec-finish');
            this.sendResponse(response);
        } catch (err: any) {
            this.sendErrorResponse(response, 7, err.message);
        }
    }

    protected async pauseRequest(
        response: DebugProtocol.PauseResponse,
        args: DebugProtocol.PauseArguments,
    ): Promise<void> {
        if (!this.inferiorStarted) {
            this.sendErrorResponse(response, 8, 'Program has not started yet.');
            return;
        }
        try {
            await this.sendMICommand('-exec-interrupt');
            this.sendResponse(response);
        } catch (err: any) {
            this.sendErrorResponse(response, 8, err.message);
        }
    }

    // -----------------------------------------------------------------------
    // DAP: threads
    // -----------------------------------------------------------------------

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        if (!this.inferiorStarted) {
            response.body = { threads: [new Thread(1, 'main (not started)')] };
            this.sendResponse(response);
            return;
        }

        try {
            const record = await this.sendMICommand('-thread-info');
            const threads: Thread[] = [];
            const miThreads = record.data?.threads;

            if (Array.isArray(miThreads)) {
                for (const t of miThreads) {
                    const id = parseInt(t.id || '1', 10);
                    const targetId = t['target-id'] || '';
                    const name = t.name || targetId || `Thread ${id}`;
                    threads.push(new Thread(id, name));
                }
            }

            if (threads.length === 0) {
                threads.push(new Thread(1, 'main'));
            }

            response.body = { threads };
            this.sendResponse(response);
        } catch {
            response.body = { threads: [new Thread(1, 'main')] };
            this.sendResponse(response);
        }
    }

    // -----------------------------------------------------------------------
    // DAP: stackTrace
    // -----------------------------------------------------------------------

    protected async stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments,
    ): Promise<void> {
        const threadId = args.threadId || 1;

        if (!this.inferiorStarted) {
            response.body = { stackFrames: [], totalFrames: 0 };
            this.sendResponse(response);
            return;
        }

        try {
            await this.sendMICommand(`-thread-select ${threadId}`);

            const escaped = 'ardb-get-snapshot';
            const record = await this.sendMICommand(`-interpreter-exec console "${escaped}"`);
            const output = record.data?.msg || '';
            const snapshot = this.parseSnapshot(output);

            if (snapshot && snapshot.path.length > 0) {
                const reversedPath = [...snapshot.path].reverse();
                const stackFrames: DebugProtocol.StackFrame[] = [];

                for (let i = 0; i < reversedPath.length; i++) {
                    const node = reversedPath[i];
                    const frameId = threadId * 10000 + i;

                    let name: string;
                    if (node.type === 'async') {
                        name = `[async CID:${node.cid}] ${node.func}`;
                    } else {
                        name = node.func || '<unknown>';
                    }

                    const sf = new StackFrame(
                        frameId,
                        name,
                        (node.fullname || node.file) ? new Source(node.file || '', node.fullname || node.file || '') : undefined,
                        node.line || 0,
                        0,
                    );

                    if (node.addr) {
                        sf.instructionPointerReference = node.addr;
                    }

                    stackFrames.push(sf);
                }

                response.body = { stackFrames, totalFrames: stackFrames.length };
                this.sendResponse(response);
            } else {
                await this.fallbackPhysicalStackTrace(response, threadId);
            }
        } catch (err: any) {
            console.log(`[Adapter] snapshot stackTrace failed, falling back: ${err.message}`);
            try {
                await this.fallbackPhysicalStackTrace(response, threadId);
            } catch (err2: any) {
                console.log(`[Adapter] stackTrace fallback also failed: ${err2.message}`);
                response.body = { stackFrames: [], totalFrames: 0 };
                this.sendResponse(response);
            }
        }
    }

    // -----------------------------------------------------------------------
    // DAP: scopes
    // -----------------------------------------------------------------------

    protected scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments,
    ): void {
        const frameId = args.frameId ?? 0;
        const threadId = Math.floor(frameId / 10000);
        const frameLevel = frameId % 10000;

        const argsRef = this.nextVarRef++;
        const localsRef = this.nextVarRef++;
        this.varRefMap.set(argsRef, { type: 'scope', scopeKind: 'args', threadId, frameLevel });
        this.varRefMap.set(localsRef, { type: 'scope', scopeKind: 'locals', threadId, frameLevel });

        response.body = {
            scopes: [
                new Scope('Arguments', argsRef, false),
                new Scope('Locals', localsRef, false),
            ],
        };
        this.sendResponse(response);
    }

    // -----------------------------------------------------------------------
    // DAP: variables
    // -----------------------------------------------------------------------

    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments,
    ): Promise<void> {
        const ref = args.variablesReference ?? 0;
        const entry = this.varRefMap.get(ref);

        if (!entry) {
            response.body = { variables: [] };
            this.sendResponse(response);
            return;
        }

        try {
            if (entry.type === 'scope') {
                await this.handleScopeVariables(response, entry.threadId, entry.frameLevel, entry.scopeKind);
            } else {
                await this.handleVarChildren(response, entry.varName);
            }
        } catch (err: any) {
            console.log(`[Adapter] variables failed: ${err.message}`);
            response.body = { variables: [] };
            this.sendResponse(response);
        }
    }

    // -----------------------------------------------------------------------
    // DAP: evaluate
    // -----------------------------------------------------------------------

    protected async evaluateRequest(
        response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments,
    ): Promise<void> {
        if (!this.gdbProcess || !args.expression) {
            response.body = { result: '', variablesReference: 0 };
            this.sendResponse(response);
            return;
        }

        const expr = args.expression;
        const context = args.context || 'repl';
        const escaped = expr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

        try {
            const record = await this.sendMICommand(`-interpreter-exec console "${escaped}"`);
            const result = record.data?.msg || '';

            if (context === 'repl' && result) {
                this.sendEvent(new OutputEvent(
                    result.endsWith('\n') ? result : result + '\n',
                    'console',
                ));
            }

            response.body = { result: result || 'OK', variablesReference: 0 };
            this.sendResponse(response);
        } catch (err: any) {
            const msg = err.message || 'Command failed';
            if (context === 'repl') {
                this.sendEvent(new OutputEvent(
                    msg.endsWith('\n') ? msg : msg + '\n',
                    'stderr',
                ));
            }
            response.body = { result: msg, variablesReference: 0 };
            this.sendResponse(response);
        }
    }

    // -----------------------------------------------------------------------
    // DAP: disconnect
    // -----------------------------------------------------------------------

    protected disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
        args: DebugProtocol.DisconnectArguments,
    ): void {
        // Kill GDB process
        if (this.gdbProcess) {
            this.gdbProcess.kill();
            this.gdbProcess = undefined;
        }

        // Reject all pending MI commands
        for (const [token, pending] of this.pendingCommands) {
            pending.reject(new Error('Debug session disconnected'));
        }
        this.pendingCommands.clear();
        this.commandQueue = [];

        // Reset state
        this.inferiorStarted = false;
        this.fileBreakpoints.clear();
        this.gdbBkptToDap.clear();
        this.functionBreakpointNumbers = [];
        this.varRefMap.clear();
        this.createdVarObjects = [];

        this.sendResponse(response);
        // DO NOT call process.exit() — we are in-process!
    }

    // -----------------------------------------------------------------------
    // DAP: customRequest — dispatch ardb-* commands
    // -----------------------------------------------------------------------

    protected customRequest(
        command: string,
        response: DebugProtocol.Response,
        args: any,
    ): void {
        switch (command) {
            case 'ardb-get-snapshot':
                this.handleArdGetSnapshot(response).catch(err => {
                    this.sendErrorResponse(response, 100, err.message);
                });
                break;

            case 'ardb-reset':
                this.handleArdReset(response).catch(err => {
                    this.sendErrorResponse(response, 101, err.message);
                });
                break;

            case 'ardb-gen-whitelist':
                this.handleArdGenWhitelist(response).catch(err => {
                    this.sendErrorResponse(response, 102, err.message);
                });
                break;

            case 'ardb-trace':
                this.handleArdTrace(response, args).catch(err => {
                    this.sendErrorResponse(response, 103, err.message);
                });
                break;

            case 'ardb-get-whitelist-grouped':
                this.handleArdGetWhitelistGrouped(response).catch(err => {
                    this.sendErrorResponse(response, 104, err.message);
                });
                break;

            case 'ardb-get-whitelist-candidates':
                this.handleArdGetWhitelistCandidates(response).catch(err => {
                    this.sendErrorResponse(response, 105, err.message);
                });
                break;

            case 'ardb-update-whitelist':
                this.handleArdUpdateWhitelist(response, args).catch(err => {
                    this.sendErrorResponse(response, 106, err.message);
                });
                break;

            case 'ardb-infer-trace-root':
                this.handleArdInferTraceRoot(response).catch(err => {
                    this.sendErrorResponse(response, 107, err.message);
                });
                break;

            case 'ardb-get-log-entries':
                this.handleArdGetLogEntries(response, args).catch(err => {
                    this.sendErrorResponse(response, 108, err.message);
                });
                break;

            case 'ardb-execute-command':
                this.handleArdExecuteCommand(response, args).catch(err => {
                    this.sendErrorResponse(response, 109, err.message);
                });
                break;

            default:
                super.customRequest(command, response, args);
                break;
        }
    }

    // -----------------------------------------------------------------------
    // Custom request handlers
    // -----------------------------------------------------------------------

    private async handleArdGetSnapshot(response: DebugProtocol.Response): Promise<void> {
        const escaped = 'ardb-get-snapshot';
        const record = await this.sendMICommand(`-interpreter-exec console "${escaped}"`);
        const output = record.data?.msg || '';
        const snapshot = this.parseSnapshot(output);
        response.body = { snapshot: snapshot || null };
        this.sendResponse(response);
    }

    private async handleArdReset(response: DebugProtocol.Response): Promise<void> {
        const escaped = 'ardb-reset';
        await this.sendMICommand(`-interpreter-exec console "${escaped}"`);
        // Clear log file
        if (fs.existsSync(this.logPath)) {
            fs.writeFileSync(this.logPath, '');
        }
        response.body = {};
        this.sendResponse(response);
    }

    private async handleArdGenWhitelist(response: DebugProtocol.Response): Promise<void> {
        const escaped = 'ardb-gen-whitelist';
        await this.sendMICommand(`-interpreter-exec console "${escaped}"`);
        // Read grouped result from disk
        const grouped = this.readGroupedWhitelistFromDisk();
        response.body = { groupedWhitelist: grouped || null };
        this.sendResponse(response);
    }

    private async handleArdTrace(response: DebugProtocol.Response, args: any): Promise<void> {
        const symbol = args?.symbol || '';
        const escaped = `ardb-trace ${symbol}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        await this.sendMICommand(`-interpreter-exec console "${escaped}"`);
        response.body = {};
        this.sendResponse(response);
    }

    private async handleArdGetWhitelistGrouped(response: DebugProtocol.Response): Promise<void> {
        // Disk read first (fast path)
        const grouped = this.readGroupedWhitelistFromDisk();
        if (grouped) {
            response.body = { groupedWhitelist: grouped };
            this.sendResponse(response);
            return;
        }

        // Fallback to GDB command
        const escaped = 'ardb-get-whitelist-grouped';
        const record = await this.sendMICommand(`-interpreter-exec console "${escaped}"`);
        const output = record.data?.msg || '';
        const parsed = this.parseJsonFromOutput(output) as GroupedWhitelist | undefined;
        response.body = { groupedWhitelist: parsed || null };
        this.sendResponse(response);
    }

    private async handleArdGetWhitelistCandidates(response: DebugProtocol.Response): Promise<void> {
        const candidates = this.readWhitelistCandidatesFromDisk();
        response.body = { candidates };
        this.sendResponse(response);
    }

    private async handleArdUpdateWhitelist(response: DebugProtocol.Response, args: any): Promise<void> {
        const enabledCrates = args?.enabledCrates || [];
        const payload = JSON.stringify({ enabled_crates: enabledCrates });
        const escaped = `ardb-update-whitelist ${payload}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        await this.sendMICommand(`-interpreter-exec console "${escaped}"`);
        response.body = {};
        this.sendResponse(response);
    }

    private async handleArdInferTraceRoot(response: DebugProtocol.Response): Promise<void> {
        const escaped = 'ardb-infer-trace-root';
        const record = await this.sendMICommand(`-interpreter-exec console "${escaped}"`);
        const output = record.data?.msg || '';
        const result = this.parseJsonFromOutput(output) as InferredTraceRoot | undefined;
        response.body = { inferredTraceRoot: result || null };
        this.sendResponse(response);
    }

    private async handleArdGetLogEntries(response: DebugProtocol.Response, args: any): Promise<void> {
        const cid = args?.cid;
        let entries: string[] = [];

        if (cid !== undefined && fs.existsSync(this.logPath)) {
            try {
                const content = fs.readFileSync(this.logPath, 'utf-8');
                const lines = content.split('\n');
                const cidPattern = new RegExp(`coro#${cid}`);
                entries = lines.filter(line => cidPattern.test(line)).slice(-10);
            } catch {
                // ignore read errors
            }
        }

        response.body = { entries };
        this.sendResponse(response);
    }

    private async handleArdExecuteCommand(response: DebugProtocol.Response, args: any): Promise<void> {
        const command = args?.command || '';
        const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const record = await this.sendMICommand(`-interpreter-exec console "${escaped}"`);
        const result = record.data?.msg || '';
        response.body = { result };
        this.sendResponse(response);
    }

    // -----------------------------------------------------------------------
    // GDB subprocess management
    // -----------------------------------------------------------------------

    private launchGDB(): void {
        const gdbArgs = [
            '--interpreter=mi2',
            '-ex', `python import sys; sys.path.insert(0, '${this.pythonPath}'); import async_rust_debugger`,
            '-ex', 'set pagination off',
            this.program,
            ...this.programArgs,
        ];

        // Set ASYNC_RUST_DEBUGGER_TEMP_DIR so the Python plugin can find it
        const env = { ...process.env, ASYNC_RUST_DEBUGGER_TEMP_DIR: this.tempDir };

        this.gdbProcess = spawn('gdb', gdbArgs, { cwd: this.cwd, env });

        this.gdbProcess.stdout?.on('data', (data: Buffer) => {
            this.handleGDBOutput(data);
        });

        this.gdbProcess.stderr?.on('data', (data: Buffer) => {
            console.log(`[GDB Error]: ${data.toString()}`);
        });

        this.gdbProcess.on('exit', (code) => {
            console.log(`[GDB] Process exited with code ${code}`);
            // Reject all pending commands so promises don't hang
            for (const [, pending] of this.pendingCommands) {
                pending.reject(new Error(`GDB process exited with code ${code}`));
            }
            this.pendingCommands.clear();
            this.commandQueue = [];
            this.gdbProcess = undefined;

            this.sendEvent(new TerminatedEvent());
        });
    }

    // -----------------------------------------------------------------------
    // MI command sending
    // -----------------------------------------------------------------------

    private sendMICommand(command: string): Promise<MIRecord> {
        return new Promise((resolve, reject) => {
            if (!this.gdbProcess || !this.gdbProcess.stdin) {
                reject(new Error('GDB process not available'));
                return;
            }

            const token = this.nextToken++;
            this.pendingCommands.set(token, { resolve, reject, consoleOutput: [] });
            this.commandQueue.push(token);

            const fullCommand = `${token}${command}\n`;
            console.log(`[Adapter -> GDB] ${fullCommand.trim()}`);
            this.gdbProcess.stdin.write(fullCommand);
        });
    }

    // -----------------------------------------------------------------------
    // GDB output processing
    // -----------------------------------------------------------------------

    private handleGDBOutput(data: Buffer): void {
        this.gdbOutputBuffer += data.toString('utf8');

        let newlineIdx: number;
        while ((newlineIdx = this.gdbOutputBuffer.indexOf('\n')) !== -1) {
            const line = this.gdbOutputBuffer.substring(0, newlineIdx).replace(/\r$/, '');
            this.gdbOutputBuffer = this.gdbOutputBuffer.substring(newlineIdx + 1);

            if (!line) continue;

            const record = parseMILine(line);
            if (!record) {
                console.log(`[GDB ?] ${line}`);
                continue;
            }

            console.log(`[GDB ${record.type}] ${line}`);
            this.dispatchMIRecord(record);
        }
    }

    private dispatchMIRecord(record: MIRecord): void {
        switch (record.type) {
            case 'result':
                this.handleResultRecord(record);
                break;

            case 'exec-async':
                this.handleExecAsync(record);
                break;

            case 'notify-async':
                this.handleNotifyAsync(record);
                break;

            case 'console-stream':
                // Route console output to the oldest in-flight command (FIFO)
                if (record.data?.msg && this.commandQueue.length > 0) {
                    const headToken = this.commandQueue[0];
                    const pending = this.pendingCommands.get(headToken);
                    if (pending) {
                        pending.consoleOutput.push(record.data.msg);
                    }
                }
                break;

            case 'target-stream':
            case 'log-stream':
            case 'status-async':
            case 'prompt':
                break;
        }
    }

    private handleResultRecord(record: MIRecord): void {
        if (record.token !== undefined) {
            const pending = this.pendingCommands.get(record.token);
            if (pending) {
                this.pendingCommands.delete(record.token);

                const queueIdx = this.commandQueue.indexOf(record.token);
                if (queueIdx !== -1) {
                    this.commandQueue.splice(queueIdx, 1);
                }

                // Attach accumulated console stream output
                if (pending.consoleOutput.length > 0) {
                    record.data.msg = pending.consoleOutput.join('');
                }

                if (record.cls === 'error') {
                    pending.reject(new Error(record.data?.msg || 'GDB error'));
                } else {
                    pending.resolve(record);
                }
            }
        }
    }

    private handleExecAsync(record: MIRecord): void {
        console.log(`[GDB exec-async] class=${record.cls} data=${JSON.stringify(record.data)}`);

        if (record.cls === 'stopped') {
            const gdbReason = record.data?.reason || '';
            let dapReason = 'pause';
            let description = '';

            switch (gdbReason) {
                case 'breakpoint-hit':
                    dapReason = 'breakpoint';
                    description = `Breakpoint ${record.data?.bkptno || ''} hit`;
                    break;
                case 'end-stepping-range':
                    dapReason = 'step';
                    description = 'Step completed';
                    break;
                case 'function-finished':
                    dapReason = 'step';
                    description = 'Function finished';
                    break;
                case 'signal-received':
                    dapReason = 'exception';
                    description = `Signal: ${record.data?.['signal-name'] || 'unknown'}`;
                    break;
                case 'exited':
                case 'exited-normally':
                case 'exited-signalled':
                    this.sendEvent(new TerminatedEvent());
                    return;
                default:
                    dapReason = 'pause';
                    description = gdbReason || 'Paused';
                    break;
            }

            const threadId = parseInt(record.data?.['thread-id'] || '1', 10);
            const event = new StoppedEvent(dapReason, threadId);
            (event.body as any).description = description;
            (event.body as any).allThreadsStopped = record.data?.['stopped-threads'] === 'all' || true;
            this.sendEvent(event);
        } else if (record.cls === 'running') {
            const threadId = parseInt(record.data?.['thread-id'] || '1', 10);
            this.sendEvent(new ContinuedEvent(threadId, true));
        }
    }

    private handleNotifyAsync(record: MIRecord): void {
        console.log(`[GDB notify] ${record.cls}: ${JSON.stringify(record.data)}`);

        if (record.cls === 'breakpoint-modified') {
            const bkpt = record.data?.bkpt;
            if (!bkpt) return;

            const gdbNumber = parseInt(bkpt.number || '0', 10);
            const entry = this.gdbBkptToDap.get(gdbNumber);
            if (!entry) return;

            const nowVerified = bkpt.pending === undefined;
            const actualLine = parseInt(bkpt.line || `${entry.line}`, 10);
            entry.verified = nowVerified;
            entry.line = actualLine;

            const dbp = new Breakpoint(nowVerified, actualLine);
            dbp.setId(entry.id);
            if (bkpt.fullname) {
                (dbp as any).source = new Source(bkpt.file || '', bkpt.fullname);
            }

            this.sendEvent(new BreakpointEvent('changed', dbp));
        }
    }

    // -----------------------------------------------------------------------
    // Helper methods
    // -----------------------------------------------------------------------

    private parseSnapshot(output: string): SnapshotData | undefined {
        return this.parseJsonFromOutput(output) as SnapshotData | undefined;
    }

    private parseJsonFromOutput(output: string): any | undefined {
        if (!output) return undefined;

        const jsonStart = output.indexOf('{');
        const jsonEnd = output.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
            return undefined;
        }

        try {
            const jsonStr = output.substring(jsonStart, jsonEnd + 1);
            return JSON.parse(jsonStr);
        } catch {
            return undefined;
        }
    }

    private async fallbackPhysicalStackTrace(
        response: DebugProtocol.StackTraceResponse,
        threadId: number,
    ): Promise<void> {
        const record = await this.sendMICommand('-stack-list-frames');
        const stackFrames: DebugProtocol.StackFrame[] = [];
        const miStack = record.data?.stack;

        if (Array.isArray(miStack)) {
            for (const entry of miStack) {
                const f = entry.level !== undefined ? entry : (entry.frame || entry);
                const level = parseInt(f.level || '0', 10);
                const frameId = threadId * 10000 + level;

                const sf = new StackFrame(
                    frameId,
                    f.func || '<unknown>',
                    (f.fullname || f.file) ? new Source(f.file || '', f.fullname || f.file || '') : undefined,
                    parseInt(f.line || '0', 10),
                    0,
                );

                if (f.addr) {
                    sf.instructionPointerReference = f.addr;
                }

                stackFrames.push(sf);
            }
        }

        response.body = { stackFrames, totalFrames: stackFrames.length };
        this.sendResponse(response);
    }

    private async handleScopeVariables(
        response: DebugProtocol.VariablesResponse,
        threadId: number,
        frameLevel: number,
        scopeKind: 'args' | 'locals',
    ): Promise<void> {
        await this.sendMICommand(`-thread-select ${threadId}`);
        await this.sendMICommand(`-stack-select-frame ${frameLevel}`);

        let miVars: any[] | undefined;

        if (scopeKind === 'args') {
            const record = await this.sendMICommand(`-stack-list-arguments --all-values 0 0`);
            const stackArgs = record.data?.['stack-args'];
            if (Array.isArray(stackArgs) && stackArgs.length > 0) {
                const frameEntry = stackArgs[0]?.frame || stackArgs[0];
                miVars = frameEntry?.args;
            }
        } else {
            const record = await this.sendMICommand('-stack-list-locals --all-values');
            miVars = record.data?.locals;
        }

        const variables: DebugProtocol.Variable[] = [];

        if (Array.isArray(miVars)) {
            for (const v of miVars) {
                const name = v.name || '';
                const value = v.value || '';
                const type = v.type || '';
                let variablesReference = 0;

                if (this.looksExpandable(type, value)) {
                    try {
                        const varObj = await this.sendMICommand(`-var-create - * ${name}`);
                        const varName = varObj.data?.name;
                        const numchild = parseInt(varObj.data?.numchild || '0', 10);

                        if (varName) {
                            this.createdVarObjects.push(varName);
                            if (numchild > 0) {
                                const childRef = this.nextVarRef++;
                                this.varRefMap.set(childRef, { type: 'var', varName });
                                variablesReference = childRef;
                            }
                        }
                    } catch {
                        // var-create failed
                    }
                }

                const variable = new Variable(name, value, variablesReference);
                (variable as any).type = type;
                variables.push(variable);
            }
        }

        response.body = { variables };
        this.sendResponse(response);
    }

    private async handleVarChildren(
        response: DebugProtocol.VariablesResponse,
        parentVarName: string,
    ): Promise<void> {
        const record = await this.sendMICommand(`-var-list-children --all-values ${parentVarName}`);
        const children = record.data?.children;
        const variables: DebugProtocol.Variable[] = [];

        if (Array.isArray(children)) {
            for (const entry of children) {
                const child = entry.child || entry;
                const name = child.exp || child.name || '';
                const value = child.value || '';
                const type = child.type || '';
                const numchild = parseInt(child.numchild || '0', 10);
                const childVarName = child.name || '';

                let variablesReference = 0;
                if (numchild > 0 && childVarName) {
                    const childRef = this.nextVarRef++;
                    this.varRefMap.set(childRef, { type: 'var', varName: childVarName });
                    variablesReference = childRef;
                }

                const variable = new Variable(name, value, variablesReference);
                (variable as any).type = type;
                variables.push(variable);
            }
        }

        response.body = { variables };
        this.sendResponse(response);
    }

    private looksExpandable(type: string, value: string): boolean {
        if (value.startsWith('{')) return true;
        if (type.startsWith('[') || type.startsWith('&[')) return true;
        if (type.startsWith('(') && type.includes(',')) return true;
        if (/^(alloc::|std::)/.test(type)) return true;
        if (type.includes('::') && !type.includes('*')) return true;
        return false;
    }

    private async cleanupVariables(): Promise<void> {
        for (const name of this.createdVarObjects) {
            await this.sendMICommand(`-var-delete ${name}`).catch(() => {});
        }
        this.createdVarObjects.length = 0;
        this.varRefMap.clear();
        this.nextVarRef = 1;
    }

    private readGroupedWhitelistFromDisk(): GroupedWhitelist | undefined {
        try {
            if (fs.existsSync(this.groupedWhitelistPath)) {
                const content = fs.readFileSync(this.groupedWhitelistPath, 'utf-8');
                const grouped = JSON.parse(content) as GroupedWhitelist;
                if (grouped.version !== undefined && grouped.crates) {
                    return grouped;
                }
            }
        } catch {
            // ignore
        }
        return undefined;
    }

    private readWhitelistCandidatesFromDisk(): string[] {
        try {
            if (fs.existsSync(this.whitelistPath)) {
                const content = fs.readFileSync(this.whitelistPath, 'utf-8');
                const candidates: string[] = [];
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
        } catch {
            // ignore
        }
        return [];
    }
}
