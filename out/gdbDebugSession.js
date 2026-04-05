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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const debugadapter_1 = require("@vscode/debugadapter");
const mi2_1 = require("./backend/mi2");
const mi_parse_1 = require("./backend/mi_parse");
const breakpointGroups_1 = require("./breakpointGroups");
const OSStateMachine_1 = require("./OSStateMachine");
const addrSpace_1 = require("./addrSpace");
// ---------------------------------------------------------------------------
// GDBDebugSession
// ---------------------------------------------------------------------------
class GDBDebugSession extends debugadapter_1.DebugSession {
    constructor(opts) {
        super();
        // Inferior state
        this.inferiorStarted = false;
        this.gdbReady = false; // GDB process has connected and is ready to accept commands
        this.isAttachMode = false; // true when using attach (QEMU) mode
        this.program = '';
        this.programArgs = [];
        this.cwd = '';
        // Breakpoint state
        this.fileBreakpoints = new Map();
        this.gdbBkptToDap = new Map();
        this.nextDapBreakpointId = 1;
        this.functionBreakpointNumbers = [];
        // Variable / scope state
        this.nextVarRef = 1;
        this.varRefMap = new Map();
        this.createdVarObjects = [];
        // OS debug state
        this.osDebugReady = false;
        this.osState = new OSStateMachine_1.OSState(OSStateMachine_1.OSStateMachine.initial);
        this.recentStopThreadId = 1;
        this.kernelMemoryRanges = [];
        this.userMemoryRanges = [];
        this.programCounterId = 32; // RISC-V PC register id
        this.pythonPath = opts.pythonPath;
        this.tempDir = opts.tempDir;
        this.logPath = path.join(opts.tempDir, 'ardb.log');
        this.whitelistPath = path.join(opts.tempDir, 'poll_functions.txt');
        this.groupedWhitelistPath = path.join(opts.tempDir, 'poll_functions_grouped.json');
    }
    // -----------------------------------------------------------------------
    // DAP: initialize
    // -----------------------------------------------------------------------
    initializeRequest(response, args) {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsEvaluateForHovers = false;
        response.body.supportsFunctionBreakpoints = true;
        response.body.supportsVariableType = true;
        this.sendResponse(response);
        this.sendEvent(new debugadapter_1.InitializedEvent());
    }
    // -----------------------------------------------------------------------
    // DAP: launch
    // -----------------------------------------------------------------------
    launchRequest(response, args) {
        const config = args;
        this.program = config.program || '';
        this.programArgs = config.args || [];
        this.cwd = config.cwd || process.cwd();
        if (!this.program) {
            this.sendErrorResponse(response, 1, 'No program specified in launch configuration');
            return;
        }
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
        this.launchGDB();
        this.inferiorStarted = false;
        this.gdbReady = false;
        this.isAttachMode = false;
        this.sendResponse(response);
    }
    // -----------------------------------------------------------------------
    // DAP: attach
    // -----------------------------------------------------------------------
    attachRequest(response, args) {
        const config = args;
        this.cwd = config.cwd || process.cwd();
        if (!config.qemuPath || !config.qemuArgs?.length) {
            this.sendErrorResponse(response, 103, '`qemuPath` and `qemuArgs` must be set in launch.json');
            return;
        }
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
        // Initialize OS debug state from launch.json config
        this.programCounterId = config.program_counter_id ?? 32;
        this.kernelMemoryRanges = config.kernel_memory_ranges ?? [];
        this.userMemoryRanges = config.user_memory_ranges ?? [];
        this.osState = new OSStateMachine_1.OSState(OSStateMachine_1.OSStateMachine.initial);
        this.osDebugReady = false;
        // Build IBreakpointGroupsSession adapter
        const firstGroup = config.first_breakpoint_group ?? 'kernel';
        const secondGroup = config.second_breakpoint_group ?? 'user';
        const filePathToGroupNames = config.filePathToBreakpointGroupNames
            ? (0, breakpointGroups_1.toFunctionString)({ body: config.filePathToBreakpointGroupNames.functionBody, args: [config.filePathToBreakpointGroupNames.functionArguments] })
            : '(function(filepath) { return ["kernel"]; })';
        const groupNameToFilePaths = config.breakpointGroupNameToDebugFilePaths
            ? (0, breakpointGroups_1.toFunctionString)({ body: config.breakpointGroupNameToDebugFilePaths.functionBody, args: [config.breakpointGroupNameToDebugFilePaths.functionArguments] })
            : '(function(groupName) { return []; })';
        const self = this;
        const bpgSession = {
            get miDebugger() {
                return self.miDebugger;
            },
            filePathToBreakpointGroupNames: filePathToGroupNames,
            breakpointGroupNameToDebugFilePaths: groupNameToFilePaths,
            showInformationMessage(msg) {
                self.sendEvent({ event: 'showInformationMessage', type: 'event', body: msg, seq: 0 });
            },
        };
        this.breakpointGroups = new breakpointGroups_1.BreakpointGroups(firstGroup, bpgSession, secondGroup);
        // Register initial borders from launch.json
        if (config.border_breakpoints) {
            for (const b of config.border_breakpoints) {
                this.breakpointGroups.updateBorder(new breakpointGroups_1.Border(b.filepath, b.line));
            }
        }
        // Register initial hook breakpoints from launch.json
        if (config.hook_breakpoints) {
            for (const h of config.hook_breakpoints) {
                this.breakpointGroups.updateHookBreakpoint(h);
            }
        }
        // Launch QEMU in the integrated terminal, then start GDB after a short delay
        // to give QEMU time to open the GDB stub on :1234.
        const qemuCmd = [config.qemuPath, ...config.qemuArgs];
        this.runInTerminalRequest({ kind: 'integrated', title: 'QEMU', cwd: this.cwd, args: qemuCmd }, 15000, (termResponse) => {
            if (termResponse.success === false) {
                console.error('[ardb] Failed to launch QEMU in terminal');
                this.sendEvent(new debugadapter_1.TerminatedEvent());
                return;
            }
            // Give QEMU ~1s to open the GDB stub before GDB tries to connect
            setTimeout(() => {
                this.launchGDB(config);
            }, 1000);
        });
        this.inferiorStarted = false;
        this.gdbReady = false;
        this.isAttachMode = true;
        this.sendResponse(response);
    }
    // -----------------------------------------------------------------------
    // DAP: configurationDone
    // -----------------------------------------------------------------------
    configurationDoneRequest(response, args) {
        this.sendResponse(response);
        // In attach mode, GDB hasn't connected yet — the real stop will come from GDB
        // after connecting to QEMU (via stopAtConnect). Don't send a fake StoppedEvent.
        // In launch mode, send an entry stop so the UI shows "paused" while the user configures.
        if (!this.isAttachMode) {
            const event = new debugadapter_1.StoppedEvent('entry', 1);
            event.body.description = 'Program loaded. Configure ARD, then press Continue to run.';
            event.body.allThreadsStopped = true;
            this.sendEvent(event);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: setBreakpoints
    // -----------------------------------------------------------------------
    async setBreakPointsRequest(response, args) {
        if (!this.miDebugger) {
            response.body = { breakpoints: [] };
            this.sendResponse(response);
            return;
        }
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
                await this.miDebugger.sendCommand(`break-delete ${num}`).catch(() => { });
                this.gdbBkptToDap.delete(num);
            }
            this.fileBreakpoints.delete(filePath);
            const newNumbers = [];
            const dapBreakpoints = [];
            for (const bp of requestedLines) {
                const location = `"${(0, mi2_1.escape)(filePath)}:${bp.line}"`;
                try {
                    const record = await this.miDebugger.sendCommand(`break-insert -f ${location}`);
                    const bkpt = mi_parse_1.MINode.valueOf(record.resultRecords?.results, "bkpt");
                    const gdbNumber = parseInt(mi_parse_1.MINode.valueOf(bkpt, "number") || '0');
                    const actualLine = parseInt(mi_parse_1.MINode.valueOf(bkpt, "line") || `${bp.line}`);
                    const verified = mi_parse_1.MINode.valueOf(bkpt, "pending") === undefined;
                    if (bp.condition && gdbNumber > 0) {
                        await this.miDebugger.sendCommand(`break-condition ${gdbNumber} ${bp.condition}`).catch(() => { });
                    }
                    const dapId = this.nextDapBreakpointId++;
                    newNumbers.push(gdbNumber);
                    this.gdbBkptToDap.set(gdbNumber, { id: dapId, line: actualLine, verified });
                    const dbp = new debugadapter_1.Breakpoint(verified, actualLine);
                    dbp.setId(dapId);
                    dbp.source = new debugadapter_1.Source(source.name || '', filePath);
                    dapBreakpoints.push(dbp);
                }
                catch (err) {
                    const dapId = this.nextDapBreakpointId++;
                    const dbp = new debugadapter_1.Breakpoint(false, bp.line);
                    dbp.setId(dapId);
                    dbp.message = err.message || 'Failed to set breakpoint';
                    dbp.source = new debugadapter_1.Source(source.name || '', filePath);
                    dapBreakpoints.push(dbp);
                }
            }
            this.fileBreakpoints.set(filePath, newNumbers);
            response.body = { breakpoints: dapBreakpoints };
            this.sendResponse(response);
        }
        catch (err) {
            this.sendErrorResponse(response, 2, err.message);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: setFunctionBreakpoints
    // -----------------------------------------------------------------------
    async setFunctionBreakPointsRequest(response, args) {
        if (!this.miDebugger) {
            response.body = { breakpoints: [] };
            this.sendResponse(response);
            return;
        }
        const requestedFunctions = args.breakpoints || [];
        try {
            for (const num of this.functionBreakpointNumbers) {
                await this.miDebugger.sendCommand(`break-delete ${num}`).catch(() => { });
                this.gdbBkptToDap.delete(num);
            }
            this.functionBreakpointNumbers = [];
            const dapBreakpoints = [];
            for (const fbp of requestedFunctions) {
                try {
                    const record = await this.miDebugger.sendCommand(`break-insert -f ${fbp.name}`);
                    const bkpt = mi_parse_1.MINode.valueOf(record.resultRecords?.results, "bkpt");
                    const gdbNumber = parseInt(mi_parse_1.MINode.valueOf(bkpt, "number") || '0');
                    const actualLine = parseInt(mi_parse_1.MINode.valueOf(bkpt, "line") || '0');
                    const verified = mi_parse_1.MINode.valueOf(bkpt, "pending") === undefined;
                    if (fbp.condition && gdbNumber > 0) {
                        await this.miDebugger.sendCommand(`break-condition ${gdbNumber} ${fbp.condition}`).catch(() => { });
                    }
                    const dapId = this.nextDapBreakpointId++;
                    this.functionBreakpointNumbers.push(gdbNumber);
                    this.gdbBkptToDap.set(gdbNumber, { id: dapId, line: actualLine, verified });
                    const dbp = new debugadapter_1.Breakpoint(verified, actualLine);
                    dbp.setId(dapId);
                    const fullname = mi_parse_1.MINode.valueOf(bkpt, "fullname");
                    if (fullname) {
                        dbp.source = new debugadapter_1.Source(mi_parse_1.MINode.valueOf(bkpt, "file") || '', fullname);
                    }
                    dapBreakpoints.push(dbp);
                }
                catch (err) {
                    const dapId = this.nextDapBreakpointId++;
                    const dbp = new debugadapter_1.Breakpoint(false);
                    dbp.setId(dapId);
                    dbp.message = err.message || 'Failed to set function breakpoint';
                    dapBreakpoints.push(dbp);
                }
            }
            response.body = { breakpoints: dapBreakpoints };
            this.sendResponse(response);
        }
        catch (err) {
            this.sendErrorResponse(response, 3, err.message);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: continue
    // -----------------------------------------------------------------------
    async continueRequest(response, args) {
        if (!this.miDebugger || !this.gdbReady) {
            this.sendErrorResponse(response, 4, 'GDB is not ready yet. Please wait for the debugger to connect.');
            return;
        }
        try {
            await this.cleanupVariables();
            if (!this.inferiorStarted && !this.isAttachMode) {
                // Launch mode: first Continue starts the program
                this.inferiorStarted = true;
                await this.miDebugger.sendCommand('exec-run');
            }
            else {
                await this.miDebugger.continue();
            }
            response.body = { allThreadsContinued: true };
            this.sendResponse(response);
        }
        catch (err) {
            console.log(`[Adapter] continue failed: ${err.message}`);
            this.sendErrorResponse(response, 4, err.message);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: next / stepIn / stepOut / pause
    // -----------------------------------------------------------------------
    async nextRequest(response, args) {
        if (!this.inferiorStarted) {
            this.sendErrorResponse(response, 5, 'Program has not started yet. Press Continue first.');
            return;
        }
        if (!this.miDebugger) {
            this.sendErrorResponse(response, 5, 'No debug session');
            return;
        }
        try {
            await this.cleanupVariables();
            await this.miDebugger.next();
            this.sendResponse(response);
        }
        catch (err) {
            this.sendErrorResponse(response, 5, err.message);
        }
    }
    async stepInRequest(response, args) {
        if (!this.inferiorStarted) {
            this.sendErrorResponse(response, 6, 'Program has not started yet. Press Continue first.');
            return;
        }
        if (!this.miDebugger) {
            this.sendErrorResponse(response, 6, 'No debug session');
            return;
        }
        try {
            await this.cleanupVariables();
            await this.miDebugger.step();
            this.sendResponse(response);
        }
        catch (err) {
            this.sendErrorResponse(response, 6, err.message);
        }
    }
    async stepOutRequest(response, args) {
        if (!this.inferiorStarted) {
            this.sendErrorResponse(response, 7, 'Program has not started yet. Press Continue first.');
            return;
        }
        if (!this.miDebugger) {
            this.sendErrorResponse(response, 7, 'No debug session');
            return;
        }
        try {
            await this.cleanupVariables();
            await this.miDebugger.stepOut();
            this.sendResponse(response);
        }
        catch (err) {
            this.sendErrorResponse(response, 7, err.message);
        }
    }
    async pauseRequest(response, args) {
        if (!this.inferiorStarted) {
            this.sendErrorResponse(response, 8, 'Program has not started yet.');
            return;
        }
        if (!this.miDebugger) {
            this.sendErrorResponse(response, 8, 'No debug session');
            return;
        }
        try {
            await this.miDebugger.interrupt();
            this.sendResponse(response);
        }
        catch (err) {
            this.sendErrorResponse(response, 8, err.message);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: threads
    // -----------------------------------------------------------------------
    async threadsRequest(response) {
        if (!this.inferiorStarted || !this.miDebugger) {
            response.body = { threads: [new debugadapter_1.Thread(1, 'main (not started)')] };
            this.sendResponse(response);
            return;
        }
        try {
            const threads = await this.miDebugger.getThreads();
            response.body = {
                threads: threads.map(t => new debugadapter_1.Thread(t.id, t.name || t.targetId || `Thread ${t.id}`))
            };
            if (response.body.threads.length === 0) {
                response.body.threads.push(new debugadapter_1.Thread(1, 'main'));
            }
            this.sendResponse(response);
        }
        catch {
            response.body = { threads: [new debugadapter_1.Thread(1, 'main')] };
            this.sendResponse(response);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: stackTrace
    // -----------------------------------------------------------------------
    async stackTraceRequest(response, args) {
        const threadId = args.threadId || 1;
        if (!this.inferiorStarted || !this.miDebugger) {
            response.body = { stackFrames: [], totalFrames: 0 };
            this.sendResponse(response);
            return;
        }
        try {
            await this.miDebugger.sendCommand(`thread-select ${threadId}`);
            const record = await this.miDebugger.sendCliCommand('ardb-get-snapshot');
            const output = this.getConsoleOutput(record);
            const snapshot = this.parseSnapshot(output);
            if (snapshot && snapshot.path.length > 0) {
                const reversedPath = [...snapshot.path].reverse();
                const stackFrames = [];
                for (let i = 0; i < reversedPath.length; i++) {
                    const node = reversedPath[i];
                    const frameId = threadId * 10000 + i;
                    let name;
                    if (node.type === 'async') {
                        name = `[async CID:${node.cid}] ${node.func}`;
                    }
                    else {
                        name = node.func || '<unknown>';
                    }
                    const sf = new debugadapter_1.StackFrame(frameId, name, (node.fullname || node.file) ? new debugadapter_1.Source(node.file || '', node.fullname || node.file || '') : undefined, node.line || 0, 0);
                    if (node.addr) {
                        sf.instructionPointerReference = node.addr;
                    }
                    stackFrames.push(sf);
                }
                response.body = { stackFrames, totalFrames: stackFrames.length };
                this.sendResponse(response);
            }
            else {
                await this.fallbackPhysicalStackTrace(response, threadId);
            }
        }
        catch (err) {
            console.log(`[Adapter] snapshot stackTrace failed, falling back: ${err.message}`);
            try {
                await this.fallbackPhysicalStackTrace(response, threadId);
            }
            catch (err2) {
                console.log(`[Adapter] stackTrace fallback also failed: ${err2.message}`);
                response.body = { stackFrames: [], totalFrames: 0 };
                this.sendResponse(response);
            }
        }
    }
    // -----------------------------------------------------------------------
    // DAP: scopes
    // -----------------------------------------------------------------------
    scopesRequest(response, args) {
        const frameId = args.frameId ?? 0;
        const threadId = Math.floor(frameId / 10000);
        const frameLevel = frameId % 10000;
        const argsRef = this.nextVarRef++;
        const localsRef = this.nextVarRef++;
        this.varRefMap.set(argsRef, { type: 'scope', scopeKind: 'args', threadId, frameLevel });
        this.varRefMap.set(localsRef, { type: 'scope', scopeKind: 'locals', threadId, frameLevel });
        response.body = {
            scopes: [
                new debugadapter_1.Scope('Arguments', argsRef, false),
                new debugadapter_1.Scope('Locals', localsRef, false),
            ],
        };
        this.sendResponse(response);
    }
    // -----------------------------------------------------------------------
    // DAP: variables
    // -----------------------------------------------------------------------
    async variablesRequest(response, args) {
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
            }
            else {
                await this.handleVarChildren(response, entry.varName);
            }
        }
        catch (err) {
            console.log(`[Adapter] variables failed: ${err.message}`);
            response.body = { variables: [] };
            this.sendResponse(response);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: evaluate
    // -----------------------------------------------------------------------
    async evaluateRequest(response, args) {
        if (!this.miDebugger || !args.expression) {
            response.body = { result: '', variablesReference: 0 };
            this.sendResponse(response);
            return;
        }
        const expr = args.expression;
        const context = args.context || 'repl';
        try {
            const record = await this.miDebugger.sendCliCommand(expr);
            const result = this.getConsoleOutput(record);
            if (context === 'repl' && result) {
                this.sendEvent(new debugadapter_1.OutputEvent(result.endsWith('\n') ? result : result + '\n', 'console'));
            }
            response.body = { result: result || 'OK', variablesReference: 0 };
            this.sendResponse(response);
        }
        catch (err) {
            const msg = err.message || 'Command failed';
            if (context === 'repl') {
                this.sendEvent(new debugadapter_1.OutputEvent(msg.endsWith('\n') ? msg : msg + '\n', 'stderr'));
            }
            response.body = { result: msg, variablesReference: 0 };
            this.sendResponse(response);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: disconnect
    // -----------------------------------------------------------------------
    disconnectRequest(response, args) {
        if (this.miDebugger) {
            this.miDebugger.stop();
            this.miDebugger = undefined;
        }
        this.inferiorStarted = false;
        this.fileBreakpoints.clear();
        this.gdbBkptToDap.clear();
        this.functionBreakpointNumbers = [];
        this.varRefMap.clear();
        this.createdVarObjects = [];
        this.sendResponse(response);
    }
    // -----------------------------------------------------------------------
    // DAP: customRequest — dispatch ardb-* commands
    // -----------------------------------------------------------------------
    customRequest(command, response, args) {
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
            // OS debug commands
            case 'setBorder':
                if (this.breakpointGroups && args) {
                    this.breakpointGroups.updateBorder(new breakpointGroups_1.Border(args.filepath, args.line));
                }
                this.sendResponse(response);
                break;
            case 'disableBorder':
                if (this.breakpointGroups && args) {
                    this.breakpointGroups.disableBorder(new breakpointGroups_1.Border(args.filepath, args.line));
                }
                this.sendResponse(response);
                break;
            case 'setHookBreakpoint':
                if (this.breakpointGroups && args) {
                    this.breakpointGroups.updateHookBreakpoint(args);
                }
                this.sendResponse(response);
                break;
            case 'disableHookBreakpoint':
                if (this.breakpointGroups && args) {
                    this.breakpointGroups.disableHookBreakpoint(args);
                }
                this.sendResponse(response);
                break;
            case 'removeAllCliBreakpoints':
                if (this.breakpointGroups) {
                    this.breakpointGroups.disableCurrentBreakpointGroupBreakpoints();
                    this.breakpointGroups.removeAllBreakpoints();
                }
                if (this.miDebugger) {
                    this.miDebugger.sendCommand('break-delete').catch(() => { });
                }
                this.fileBreakpoints.clear();
                this.gdbBkptToDap.clear();
                this.functionBreakpointNumbers = [];
                this.sendResponse(response);
                break;
            case 'disableCurrentBreakpointGroupBreakpoints':
                if (this.breakpointGroups) {
                    this.breakpointGroups.disableCurrentBreakpointGroupBreakpoints();
                }
                this.sendResponse(response);
                break;
            default:
                super.customRequest(command, response, args);
                break;
        }
    }
    // -----------------------------------------------------------------------
    // Custom request handlers
    // -----------------------------------------------------------------------
    async handleArdGetSnapshot(response) {
        if (!this.miDebugger) {
            response.body = { snapshot: null };
            this.sendResponse(response);
            return;
        }
        const record = await this.miDebugger.sendCliCommand('ardb-get-snapshot');
        const output = this.getConsoleOutput(record);
        const snapshot = this.parseSnapshot(output);
        response.body = { snapshot: snapshot || null };
        this.sendResponse(response);
    }
    async handleArdReset(response) {
        if (!this.miDebugger) {
            response.body = {};
            this.sendResponse(response);
            return;
        }
        await this.miDebugger.sendCliCommand('ardb-reset');
        if (fs.existsSync(this.logPath)) {
            fs.writeFileSync(this.logPath, '');
        }
        response.body = {};
        this.sendResponse(response);
    }
    async handleArdGenWhitelist(response) {
        if (!this.miDebugger) {
            response.body = { groupedWhitelist: null };
            this.sendResponse(response);
            return;
        }
        await this.miDebugger.sendCliCommand('ardb-gen-whitelist');
        const grouped = this.readGroupedWhitelistFromDisk();
        response.body = { groupedWhitelist: grouped || null };
        this.sendResponse(response);
    }
    async handleArdTrace(response, args) {
        if (!this.miDebugger) {
            response.body = {};
            this.sendResponse(response);
            return;
        }
        const symbol = args?.symbol || '';
        await this.miDebugger.sendCliCommand(`ardb-trace ${symbol}`);
        response.body = {};
        this.sendResponse(response);
    }
    async handleArdGetWhitelistGrouped(response) {
        const grouped = this.readGroupedWhitelistFromDisk();
        if (grouped) {
            response.body = { groupedWhitelist: grouped };
            this.sendResponse(response);
            return;
        }
        if (!this.miDebugger) {
            response.body = { groupedWhitelist: null };
            this.sendResponse(response);
            return;
        }
        const record = await this.miDebugger.sendCliCommand('ardb-get-whitelist-grouped');
        const output = this.getConsoleOutput(record);
        const parsed = this.parseJsonFromOutput(output);
        response.body = { groupedWhitelist: parsed || null };
        this.sendResponse(response);
    }
    async handleArdGetWhitelistCandidates(response) {
        const candidates = this.readWhitelistCandidatesFromDisk();
        response.body = { candidates };
        this.sendResponse(response);
    }
    async handleArdUpdateWhitelist(response, args) {
        if (!this.miDebugger) {
            response.body = {};
            this.sendResponse(response);
            return;
        }
        const enabledCrates = args?.enabledCrates || [];
        const payload = JSON.stringify({ enabled_crates: enabledCrates });
        await this.miDebugger.sendCliCommand(`ardb-update-whitelist ${payload}`);
        response.body = {};
        this.sendResponse(response);
    }
    async handleArdInferTraceRoot(response) {
        if (!this.miDebugger) {
            response.body = { inferredTraceRoot: null };
            this.sendResponse(response);
            return;
        }
        const record = await this.miDebugger.sendCliCommand('ardb-infer-trace-root');
        const output = this.getConsoleOutput(record);
        const result = this.parseJsonFromOutput(output);
        response.body = { inferredTraceRoot: result || null };
        this.sendResponse(response);
    }
    async handleArdGetLogEntries(response, args) {
        const cid = args?.cid;
        let entries = [];
        if (cid !== undefined && fs.existsSync(this.logPath)) {
            try {
                const content = fs.readFileSync(this.logPath, 'utf-8');
                const lines = content.split('\n');
                const cidPattern = new RegExp(`coro#${cid}`);
                entries = lines.filter(line => cidPattern.test(line)).slice(-10);
            }
            catch {
                // ignore read errors
            }
        }
        response.body = { entries };
        this.sendResponse(response);
    }
    async handleArdExecuteCommand(response, args) {
        if (!this.miDebugger) {
            response.body = { result: '' };
            this.sendResponse(response);
            return;
        }
        const command = args?.command || '';
        const record = await this.miDebugger.sendCliCommand(command);
        const result = this.getConsoleOutput(record);
        response.body = { result };
        this.sendResponse(response);
    }
    // -----------------------------------------------------------------------
    // GDB subprocess management (via MI2)
    // -----------------------------------------------------------------------
    launchGDB(attachConfig) {
        const gdbPath = attachConfig?.gdbpath || 'gdb';
        const gdbArgs = [
            '--interpreter=mi2',
            '-ex', `python import sys; sys.path.insert(0, '${this.pythonPath}'); import async_rust_debugger`,
            '-ex', 'set pagination off',
        ];
        const env = { ...process.env, ASYNC_RUST_DEBUGGER_TEMP_DIR: this.tempDir };
        this.miDebugger = new mi2_1.MI2(gdbPath, gdbArgs, attachConfig?.debugger_args || [], env);
        // Wire up events
        this.miDebugger.on('msg', (type, msg) => {
            if (type === 'console' || type === 'stdout') {
                this.sendEvent(new debugadapter_1.OutputEvent(msg, 'console'));
            }
            else if (type === 'stderr') {
                this.sendEvent(new debugadapter_1.OutputEvent(msg, 'stderr'));
            }
        });
        this.miDebugger.on('quit', () => {
            this.sendEvent(new debugadapter_1.TerminatedEvent());
        });
        this.miDebugger.on('launcherror', (err) => {
            console.error('[Adapter] GDB launch error:', err);
            this.sendEvent(new debugadapter_1.TerminatedEvent());
        });
        this.miDebugger.on('debug-ready', () => {
            this.gdbReady = true;
            if (attachConfig) {
                // Attach mode: GDB connected to remote — OS debug is now active
                this.osDebugReady = true;
                this.inferiorStarted = true;
            }
        });
        this.miDebugger.on('breakpoint', (node) => {
            const threadId = this.getThreadId(node);
            this.recentStopThreadId = threadId;
            if (this.osDebugReady) {
                // In OS debug mode, the state machine decides whether to stop or continue.
                // Don't send StoppedEvent here — osStateTransition may call continue() instead.
                this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.STOPPED));
            }
            else {
                this.handleBreakpointHit(node);
            }
        });
        this.miDebugger.on('step-end', (node) => {
            const threadId = this.getThreadId(node);
            this.recentStopThreadId = threadId;
            if (this.osDebugReady) {
                this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.STOPPED));
            }
            else {
                const event = new debugadapter_1.StoppedEvent('step', threadId);
                event.body.allThreadsStopped = true;
                this.sendEvent(event);
            }
        });
        this.miDebugger.on('step-other', (node) => {
            const threadId = this.getThreadId(node);
            this.recentStopThreadId = threadId;
            if (this.osDebugReady) {
                this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.STOPPED));
            }
            else {
                const event = new debugadapter_1.StoppedEvent('pause', threadId);
                event.body.allThreadsStopped = true;
                this.sendEvent(event);
            }
        });
        this.miDebugger.on('signal-stop', (node) => {
            const threadId = this.getThreadId(node);
            this.recentStopThreadId = threadId;
            if (this.osDebugReady) {
                this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.STOPPED));
            }
            else {
                const sigName = node.record('signal-name') || 'unknown';
                const event = new debugadapter_1.StoppedEvent('exception', threadId);
                event.body.description = `Signal: ${sigName}`;
                event.body.allThreadsStopped = true;
                this.sendEvent(event);
            }
        });
        this.miDebugger.on('stopped', (node) => {
            const threadId = this.getThreadId(node);
            this.recentStopThreadId = threadId;
            if (this.osDebugReady) {
                this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.STOPPED));
            }
            else {
                const event = new debugadapter_1.StoppedEvent('pause', threadId);
                event.body.allThreadsStopped = true;
                this.sendEvent(event);
            }
        });
        this.miDebugger.on('running', (node) => {
            const threadId = this.getThreadId(node);
            this.sendEvent(new debugadapter_1.ContinuedEvent(threadId, true));
        });
        this.miDebugger.on('exited-normally', (_node) => {
            this.sendEvent(new debugadapter_1.TerminatedEvent());
        });
        // Wire breakpoint-modified notify
        this.miDebugger.on('exec-async-output', (node) => {
            if (node.outOfBandRecord) {
                for (const record of node.outOfBandRecord) {
                    if (!record.isStream && record.type === 'notify' && record.asyncClass === 'breakpoint-modified') {
                        this.handleBreakpointModified(node);
                    }
                }
            }
        });
        // Start GDB: attach mode connects to remote gdbserver, launch mode loads the program
        if (attachConfig) {
            this.miDebugger.connect(this.cwd, attachConfig.executable || '', attachConfig.target, attachConfig.autorun || []).catch(err => {
                console.error('[Adapter] MI2 connect error:', err);
            });
        }
        else {
            const fullProgram = this.program;
            const procArgsStr = this.programArgs.join(' ');
            this.miDebugger.load(this.cwd, fullProgram, procArgsStr).catch(err => {
                console.error('[Adapter] MI2 load error:', err);
            });
        }
    }
    // -----------------------------------------------------------------------
    // OS debug: state machine + doAction
    // -----------------------------------------------------------------------
    /**
     * Feed an OS event into the state machine and execute all resulting actions.
     * Called from stop event handlers when osDebugReady is true.
     */
    osStateTransition(event) {
        const [nextState, actions] = (0, OSStateMachine_1.stateTransition)(OSStateMachine_1.OSStateMachine, this.osState, event);
        this.osState = nextState;
        // Actions that cause automatic continuation — don't send StoppedEvent in these cases
        const autorunActions = new Set([
            OSStateMachine_1.DebuggerActions.start_consecutive_single_steps,
            OSStateMachine_1.DebuggerActions.low_level_switch_breakpoint_group_to_high_level,
            OSStateMachine_1.DebuggerActions.high_level_switch_breakpoint_group_to_low_level,
        ]);
        const willAutorun = actions.some(a => autorunActions.has(a.type));
        for (const action of actions) {
            this.doAction(action);
        }
        // If the state machine doesn't intend to auto-continue, surface the stop to the UI
        if (!willAutorun) {
            const event2 = new debugadapter_1.StoppedEvent('breakpoint', this.recentStopThreadId);
            event2.body.allThreadsStopped = true;
            this.sendEvent(event2);
        }
    }
    /**
     * Execute a single DebuggerAction.  All async paths are fire-and-forget
     * (they schedule follow-up events back through osStateTransition).
     */
    doAction(action) {
        if (!this.miDebugger)
            return;
        switch (action.type) {
            // ------------------------------------------------------------------
            // check_if_kernel_yet: read PC; if in kernel range → AT_KERNEL
            // ------------------------------------------------------------------
            case OSStateMachine_1.DebuggerActions.check_if_kernel_yet: {
                this.miDebugger.getSomeRegisterValues([this.programCounterId]).then(regs => {
                    const pc = (0, addrSpace_1.parseAddr)(regs[0]?.value ?? '');
                    if (pc !== undefined && (0, addrSpace_1.isKernelAddr)(pc, this.kernelMemoryRanges)) {
                        this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.AT_KERNEL));
                    }
                    else {
                        // still in user space — keep stepping
                        this.miDebugger.stepInstruction();
                    }
                }).catch(err => {
                    console.error('[ardb] check_if_kernel_yet failed:', err);
                });
                break;
            }
            // ------------------------------------------------------------------
            // check_if_user_yet: read PC; if in user range → AT_USER
            // ------------------------------------------------------------------
            case OSStateMachine_1.DebuggerActions.check_if_user_yet: {
                this.miDebugger.getSomeRegisterValues([this.programCounterId]).then(regs => {
                    const pc = (0, addrSpace_1.parseAddr)(regs[0]?.value ?? '');
                    if (pc !== undefined && (0, addrSpace_1.isUserAddr)(pc, this.userMemoryRanges)) {
                        this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.AT_USER));
                    }
                    else {
                        // still in kernel — keep stepping
                        this.miDebugger.stepInstruction();
                    }
                }).catch(err => {
                    console.error('[ardb] check_if_user_yet failed:', err);
                });
                break;
            }
            // ------------------------------------------------------------------
            // check_if_kernel_to_user_border_yet: are we at a border BP in kernel→user direction?
            // ------------------------------------------------------------------
            case OSStateMachine_1.DebuggerActions.check_if_kernel_to_user_border_yet: {
                this.miDebugger.getStack(0, 1, this.recentStopThreadId).then(stack => {
                    if (stack.length === 0)
                        return;
                    const topFrame = stack[0];
                    const currentGroup = this.breakpointGroups?.getCurrentBreakpointGroup();
                    if (!currentGroup?.borders)
                        return;
                    for (const border of currentGroup.borders) {
                        if (topFrame.file && path.normalize(topFrame.file) === path.normalize(border.filepath)
                            && topFrame.line === border.line) {
                            this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.AT_KERNEL_TO_USER_BORDER));
                            return;
                        }
                    }
                }).catch(err => {
                    console.error('[ardb] check_if_kernel_to_user_border_yet failed:', err);
                });
                break;
            }
            // ------------------------------------------------------------------
            // check_if_user_to_kernel_border_yet: are we at a border BP in user→kernel direction?
            // ------------------------------------------------------------------
            case OSStateMachine_1.DebuggerActions.check_if_user_to_kernel_border_yet: {
                this.miDebugger.getStack(0, 1, this.recentStopThreadId).then(stack => {
                    if (stack.length === 0)
                        return;
                    const topFrame = stack[0];
                    const currentGroup = this.breakpointGroups?.getCurrentBreakpointGroup();
                    if (!currentGroup?.borders)
                        return;
                    for (const border of currentGroup.borders) {
                        if (topFrame.file && path.normalize(topFrame.file) === path.normalize(border.filepath)
                            && topFrame.line === border.line) {
                            this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.AT_USER_TO_KERNEL_BORDER));
                            return;
                        }
                    }
                }).catch(err => {
                    console.error('[ardb] check_if_user_to_kernel_border_yet failed:', err);
                });
                break;
            }
            // ------------------------------------------------------------------
            // start_consecutive_single_steps: step one instruction (more will follow via STOPPED)
            // ------------------------------------------------------------------
            case OSStateMachine_1.DebuggerActions.start_consecutive_single_steps: {
                this.miDebugger.stepInstruction().catch(err => {
                    console.error('[ardb] stepInstruction failed:', err);
                });
                break;
            }
            // ------------------------------------------------------------------
            // try_get_next_breakpoint_group_name: check current frame against hook BPs;
            // if matched, run the hook behavior function to get the next process name.
            // ------------------------------------------------------------------
            case OSStateMachine_1.DebuggerActions.try_get_next_breakpoint_group_name: {
                this.miDebugger.getStack(0, 1, this.recentStopThreadId).then(async (stack) => {
                    if (stack.length === 0 || !this.breakpointGroups)
                        return;
                    const topFrame = stack[0];
                    const currentGroup = this.breakpointGroups.getCurrentBreakpointGroup();
                    if (!currentGroup)
                        return;
                    for (const hook of currentGroup.hooks) {
                        if (topFrame.file && path.normalize(topFrame.file) === path.normalize(hook.breakpoint.file ?? '')
                            && topFrame.line === hook.breakpoint.line) {
                            this.currentHook = hook;
                            try {
                                // Get variables to pass to hook function
                                const vars = await this.miDebugger.getStackVariables(this.recentStopThreadId, 0);
                                const varMap = {};
                                for (const v of vars) {
                                    varMap[v.name] = v.valueStr ?? '';
                                }
                                // Execute hook behavior to get next breakpoint group name
                                const fn = eval(hook.behavior);
                                const nextGroupName = fn(varMap);
                                if (nextGroupName) {
                                    this.breakpointGroups.setNextBreakpointGroup(nextGroupName);
                                }
                            }
                            catch (err) {
                                console.error('[ardb] hook behavior execution failed:', err);
                            }
                            return;
                        }
                    }
                }).catch(err => {
                    console.error('[ardb] try_get_next_breakpoint_group_name failed:', err);
                });
                break;
            }
            // ------------------------------------------------------------------
            // low_level_switch_breakpoint_group_to_high_level:
            //   kernel → user: switch to the previously determined user process group
            // ------------------------------------------------------------------
            case OSStateMachine_1.DebuggerActions.low_level_switch_breakpoint_group_to_high_level: {
                if (!this.breakpointGroups)
                    break;
                const nextGroup = this.breakpointGroups.getNextBreakpointGroup();
                // After switching to user, the "next" group becomes kernel (default fallback)
                const kernelGroup = this.breakpointGroups.getCurrentBreakpointGroupName();
                this.breakpointGroups.updateCurrentBreakpointGroup(nextGroup, /* continueAfterUpdate */ true);
                this.breakpointGroups.setNextBreakpointGroup(kernelGroup);
                break;
            }
            // ------------------------------------------------------------------
            // high_level_switch_breakpoint_group_to_low_level:
            //   user → kernel: switch back to kernel breakpoint group
            // ------------------------------------------------------------------
            case OSStateMachine_1.DebuggerActions.high_level_switch_breakpoint_group_to_low_level: {
                if (!this.breakpointGroups)
                    break;
                const nextGroup = this.breakpointGroups.getNextBreakpointGroup();
                // After switching to kernel, default next group is the user process we just left
                const userGroup = this.breakpointGroups.getCurrentBreakpointGroupName();
                this.breakpointGroups.updateCurrentBreakpointGroup(nextGroup, /* continueAfterUpdate */ true);
                this.breakpointGroups.setNextBreakpointGroup(userGroup);
                break;
            }
            default:
                console.warn('[ardb] unknown action type:', action.type);
        }
    }
    // -----------------------------------------------------------------------
    // Event helpers
    // -----------------------------------------------------------------------
    getThreadId(node) {
        const tid = node.record('thread-id');
        return tid ? parseInt(tid) : 1;
    }
    handleBreakpointHit(node) {
        const bkptno = parseInt(node.record('bkptno') || '0');
        const threadId = this.getThreadId(node);
        const entry = this.gdbBkptToDap.get(bkptno);
        const dapId = entry?.id;
        const event = new debugadapter_1.StoppedEvent('breakpoint', threadId);
        event.body.hitBreakpointIds = dapId ? [dapId] : [];
        event.body.allThreadsStopped = true;
        this.sendEvent(event);
    }
    handleBreakpointModified(node) {
        const bkpt = node.record('bkpt');
        if (!bkpt)
            return;
        const gdbNumber = parseInt(mi_parse_1.MINode.valueOf(bkpt, "number") || '0');
        const entry = this.gdbBkptToDap.get(gdbNumber);
        if (!entry)
            return;
        const nowVerified = mi_parse_1.MINode.valueOf(bkpt, "pending") === undefined;
        const actualLine = parseInt(mi_parse_1.MINode.valueOf(bkpt, "line") || `${entry.line}`);
        entry.verified = nowVerified;
        entry.line = actualLine;
        const dbp = new debugadapter_1.Breakpoint(nowVerified, actualLine);
        dbp.setId(entry.id);
        const fullname = mi_parse_1.MINode.valueOf(bkpt, "fullname");
        if (fullname) {
            dbp.source = new debugadapter_1.Source(mi_parse_1.MINode.valueOf(bkpt, "file") || '', fullname);
        }
        this.sendEvent(new debugadapter_1.BreakpointEvent('changed', dbp));
    }
    // -----------------------------------------------------------------------
    // Helper methods
    // -----------------------------------------------------------------------
    /** Extract console stream output accumulated by MI2 sendCliCommand result */
    getConsoleOutput(node) {
        // MI2's sendCliCommand collects console stream lines into resultRecords?.results
        // via the consoleOutput mechanism — but our MI2 port doesn't expose that directly.
        // The 'msg' field is set by the pending.consoleOutput join in handleResultRecord.
        // Actually MINode.result('') won't work here because MINode uses a different structure.
        // We need to get the raw console output that was collected.
        // MI2.sendCommand accumulates consoleOutput and sets record.data.msg — but wait,
        // we ported MI2 which does NOT use MIRecord — it uses MINode from mi_parse.
        // The consoleOutput accumulation in code-debug's MI2 is done in handleResultRecord
        // which we did NOT port (we use onOutput instead).
        //
        // We need to retrieve it differently. The CLI command output goes as console-stream
        // records ('~"..."') which are emitted as 'msg' events with type 'console'.
        // But we need to capture them synchronously per-command.
        //
        // Solution: use sendCommand with interpreter-exec directly and collect the console
        // lines that arrive before the result record. We implement this via a buffered
        // approach in sendCliCommandBuffered below.
        if (!node)
            return '';
        // The consoleOutput is stored in node via our patched sendCommand
        return node._consoleOutput || '';
    }
    parseSnapshot(output) {
        return this.parseJsonFromOutput(output);
    }
    parseJsonFromOutput(output) {
        if (!output)
            return undefined;
        const jsonStart = output.indexOf('{');
        const jsonEnd = output.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
            return undefined;
        }
        try {
            const jsonStr = output.substring(jsonStart, jsonEnd + 1);
            return JSON.parse(jsonStr);
        }
        catch {
            return undefined;
        }
    }
    async fallbackPhysicalStackTrace(response, threadId) {
        const stack = await this.miDebugger.getStack(0, 200, threadId);
        const stackFrames = stack.map((f, i) => {
            const frameId = threadId * 10000 + parseInt(f.level || i);
            const sf = new debugadapter_1.StackFrame(frameId, f.function || '<unknown>', (f.file) ? new debugadapter_1.Source(f.fileName || '', f.file) : undefined, f.line || 0, 0);
            if (f.address) {
                sf.instructionPointerReference = f.address;
            }
            return sf;
        });
        response.body = { stackFrames, totalFrames: stackFrames.length };
        this.sendResponse(response);
    }
    async handleScopeVariables(response, threadId, frameLevel, scopeKind) {
        await this.miDebugger.sendCommand(`thread-select ${threadId}`);
        await this.miDebugger.sendCommand(`stack-select-frame ${frameLevel}`);
        let miVars;
        if (scopeKind === 'args') {
            const record = await this.miDebugger.sendCommand(`stack-list-arguments --all-values 0 0`);
            const stackArgs = record.result('stack-args');
            if (Array.isArray(stackArgs) && stackArgs.length > 0) {
                const frameEntry = mi_parse_1.MINode.valueOf(stackArgs[0], "@frame") || mi_parse_1.MINode.valueOf(stackArgs[0], "frame") || stackArgs[0];
                miVars = mi_parse_1.MINode.valueOf(frameEntry, "args") || frameEntry?.args;
            }
        }
        else {
            const record = await this.miDebugger.sendCommand('stack-list-locals --all-values');
            miVars = record.result('locals');
        }
        const variables = [];
        if (Array.isArray(miVars)) {
            for (const v of miVars) {
                const name = mi_parse_1.MINode.valueOf(v, "name") || '';
                const value = mi_parse_1.MINode.valueOf(v, "value") || '';
                const type = mi_parse_1.MINode.valueOf(v, "type") || '';
                let variablesReference = 0;
                if (this.looksExpandable(type, value)) {
                    try {
                        const varObj = await this.miDebugger.varCreate(threadId, frameLevel, name);
                        if (varObj.name) {
                            this.createdVarObjects.push(varObj.name);
                            if (varObj.isCompound()) {
                                const childRef = this.nextVarRef++;
                                this.varRefMap.set(childRef, { type: 'var', varName: varObj.name });
                                variablesReference = childRef;
                            }
                        }
                    }
                    catch {
                        // var-create failed
                    }
                }
                const variable = new debugadapter_1.Variable(name, value, variablesReference);
                variable.type = type;
                variables.push(variable);
            }
        }
        response.body = { variables };
        this.sendResponse(response);
    }
    async handleVarChildren(response, parentVarName) {
        const children = await this.miDebugger.varListChildren(parentVarName);
        const variables = children.map(child => {
            let variablesReference = 0;
            if (child.isCompound()) {
                const childRef = this.nextVarRef++;
                this.varRefMap.set(childRef, { type: 'var', varName: child.name });
                variablesReference = childRef;
            }
            const v = new debugadapter_1.Variable(child.exp || child.name, child.value ?? '', variablesReference);
            v.type = child.type;
            return v;
        });
        response.body = { variables };
        this.sendResponse(response);
    }
    looksExpandable(type, value) {
        if (value.startsWith('{'))
            return true;
        if (type.startsWith('[') || type.startsWith('&['))
            return true;
        if (type.startsWith('(') && type.includes(','))
            return true;
        if (/^(alloc::|std::)/.test(type))
            return true;
        if (type.includes('::') && !type.includes('*'))
            return true;
        return false;
    }
    async cleanupVariables() {
        for (const name of this.createdVarObjects) {
            await this.miDebugger.sendCommand(`var-delete ${name}`).catch(() => { });
        }
        this.createdVarObjects.length = 0;
        this.varRefMap.clear();
        this.nextVarRef = 1;
    }
    readGroupedWhitelistFromDisk() {
        try {
            if (fs.existsSync(this.groupedWhitelistPath)) {
                const content = fs.readFileSync(this.groupedWhitelistPath, 'utf-8');
                const grouped = JSON.parse(content);
                if (grouped.version !== undefined && grouped.crates) {
                    return grouped;
                }
            }
        }
        catch {
            // ignore
        }
        return undefined;
    }
    readWhitelistCandidatesFromDisk() {
        try {
            if (fs.existsSync(this.whitelistPath)) {
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
        }
        catch {
            // ignore
        }
        return [];
    }
}
exports.GDBDebugSession = GDBDebugSession;
//# sourceMappingURL=gdbDebugSession.js.map