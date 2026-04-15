#!/usr/bin/env node
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
const child_process_1 = require("child_process");
const miParser_1 = require("./miParser");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function logToFile(message) {
    const logFile = path.join(cwd, 'temp', 'adapter-debug.log');
    try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.appendFileSync(logFile, message + '\n', 'utf8');
    }
    catch { }
}
function normalizeTargetRemote(remote) {
    if (remote === '127.0.0.1:1234' || remote === 'localhost:1234') {
        return ':1234';
    }
    return remote;
}
// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const program = process.env.ARDB_PROGRAM;
const argsStr = process.env.ARDB_ARGS || '[]';
const cwd = process.env.ARDB_CWD || process.cwd();
const pythonPath = process.env.PYTHONPATH || '';
const gdbPath = process.env.ARDB_GDB_PATH || 'gdb';
const targetRemote = process.env.ARDB_TARGET_REMOTE || '';
const gdbArch = process.env.ARDB_GDB_ARCH || '';
let remoteAttached = false;
if (!program) {
    console.error('Error: ARDB_PROGRAM environment variable not set');
    process.exit(1);
}
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let gdbProcess;
let rawData = Buffer.alloc(0);
/** Auto-incrementing token for MI commands. */
let nextToken = 1;
/** Pending MI command callbacks keyed by token. */
const pendingCommands = new Map();
/** Buffer for accumulating partial GDB output lines. */
let gdbOutputBuffer = '';
/**
 * Whether the inferior (target program) has been started with -exec-run.
 * Before this is true, the first "continue" must use -exec-run instead.
 */
let inferiorStarted = false;
// ---------------------------------------------------------------------------
// Breakpoint state
// ---------------------------------------------------------------------------
/**
 * Map from source file path → array of GDB breakpoint numbers set in that file.
 * Used to clear old breakpoints when VS Code sends a new setBreakpoints request.
 */
const fileBreakpoints = new Map();
/**
 * Map from GDB breakpoint number → DAP breakpoint info.
 * Used to translate GDB breakpoint events back to DAP breakpoint IDs.
 */
const gdbBkptToDap = new Map();
/** Next DAP breakpoint ID to assign. */
let nextDapBreakpointId = 1;
/**
 * GDB breakpoint numbers for function breakpoints.
 * Cleared and re-created on each setFunctionBreakpoints request.
 */
let functionBreakpointNumbers = [];
// ---------------------------------------------------------------------------
// Variable / scope state
// ---------------------------------------------------------------------------
/** Next variablesReference to assign for expandable variables. */
let nextVarRef = 1;
/**
 * Map from variablesReference → info needed to fetch its contents.
 * - 'scope': a top-level scope (Args or Locals) — needs threadId + frameLevel to query GDB.
 * - 'var': an expandable GDB var-object — needs the var-object name to list children.
 */
const varRefMap = new Map();
/** Names of GDB var-objects created during the current stop. Deleted on resume. */
const createdVarObjects = [];
function isLilosProgram() {
    return !!program && program.includes('/testcases/lilos/');
}
function getLilosRoot() {
    return '/home/user/RustDebug/rust-debugger-DA/testcases/lilos';
}
function toGdbSourceLocation(filePath, line) {
    // 只有 lilos 才做特殊路径转换
    if (isLilosProgram()) {
        const lilosRoot = getLilosRoot();
        const rel = path.relative(lilosRoot, filePath).replace(/\\/g, '/');
        return `${rel}:${line}`;
    }
    // 其他例子保持原始绝对路径
    return `${filePath}:${line}`;
}
function remapGdbSourcePath(gdbPath) {
    if (!gdbPath)
        return gdbPath;
    const normalized = gdbPath.replace(/\\/g, '/');
    // 非 lilos：不要做任何 lilos 专用映射
    if (!isLilosProgram()) {
        return normalized;
    }
    // lilos：如果已经是当前工作区里的路径，直接返回
    if (normalized.startsWith('/home/user/RustDebug/rust-debugger-DA/testcases/lilos/')) {
        return normalized;
    }
    // lilos：把旧的 /home/user/lilos/... 映射到当前工作区
    if (normalized.startsWith('/home/user/lilos/')) {
        return normalized.replace('/home/user/lilos/', '/home/user/RustDebug/rust-debugger-DA/testcases/lilos/');
    }
    // lilos：如果只是相对路径 testsuite/...，拼到当前 lilos 根目录
    if (normalized.startsWith('testsuite/')) {
        return path.join(getLilosRoot(), normalized).replace(/\\/g, '/');
    }
    return normalized;
}
// ---------------------------------------------------------------------------
// DAP message parsing (stdin)
// ---------------------------------------------------------------------------
process.stdin.on('data', (data) => {
    rawData = Buffer.concat([rawData, data]);
    while (true) {
        const contentStartIndex = rawData.indexOf('\r\n\r\n');
        if (contentStartIndex === -1)
            break;
        const header = rawData.toString('utf8', 0, contentStartIndex);
        const match = header.match(/Content-Length: (\d+)/);
        if (!match)
            break;
        const contentLength = parseInt(match[1], 10);
        const totalLength = contentStartIndex + 4 + contentLength;
        if (rawData.length < totalLength)
            break;
        const messageStr = rawData.toString('utf8', contentStartIndex + 4, totalLength);
        rawData = rawData.slice(totalLength);
        try {
            const request = JSON.parse(messageStr);
            handleRequest(request);
        }
        catch (e) {
            console.error("DAP Parse Error:", e);
        }
    }
});
// ---------------------------------------------------------------------------
// DAP request handler
// ---------------------------------------------------------------------------
function handleRequest(request) {
    process.stderr.write(`[Adapter] Received: ${request.command}\n`);
    switch (request.command) {
        case 'initialize':
            sendResponse(request, {
                supportsConfigurationDoneRequest: true,
                supportsEvaluateForHovers: false,
                supportsFunctionBreakpoints: true,
                supportsVariableType: true,
            });
            sendEvent('initialized');
            break;
        case 'launch':
            handleLaunch(request);
            break;
        case 'configurationDone':
            handleConfigurationDone(request);
            break;
        case 'setBreakpoints':
            handleSetBreakpoints(request);
            break;
        case 'setFunctionBreakpoints':
            handleSetFunctionBreakpoints(request);
            break;
        case 'continue':
            handleContinue(request);
            break;
        case 'next':
            handleNext(request);
            break;
        case 'stepIn':
            handleStepIn(request);
            break;
        case 'stepOut':
            handleStepOut(request);
            break;
        case 'pause':
            handlePause(request);
            break;
        case 'threads':
            handleThreads(request);
            break;
        case 'stackTrace':
            handleStackTrace(request);
            break;
        case 'scopes':
            handleScopes(request);
            break;
        case 'variables':
            handleVariables(request);
            break;
        case 'evaluate':
            handleEvaluate(request);
            break;
        case 'disconnect':
            if (gdbProcess)
                gdbProcess.kill();
            sendResponse(request);
            process.exit(0);
            break;
        default:
            // Acknowledge unknown requests so VS Code doesn't hang
            sendResponse(request);
    }
}
// ---------------------------------------------------------------------------
// DAP request handlers
// ---------------------------------------------------------------------------
/**
 * Handle "launch" request.
 * Starts GDB and loads the program symbols, but does NOT run the inferior.
 * The user is expected to configure ARD (whitelist, trace points) before
 * pressing Continue to actually start execution.
 */
function handleLaunch(request) {
    try {
        launchGDB();
        inferiorStarted = false;
        remoteAttached = false;
        sendResponse(request);
    }
    catch (err) {
        sendErrorResponse(request, err.message || String(err));
    }
}
/**
 * Handle "configurationDone" request.
 * VS Code sends this after all initial breakpoints / config are set.
 * We emit a synthetic "stopped" event so VS Code enters paused state,
 * giving the user time to configure ARD before running the program.
 */
function handleConfigurationDone(request) {
    sendResponse(request);
    // Emit a synthetic stopped event with reason "entry".
    // This puts VS Code into paused UI so the user can use the
    // Async Inspector panel to set up whitelist and trace points.
    // threadId 1 is a placeholder — GDB has not started threads yet.
    sendEvent('stopped', {
        reason: 'entry',
        description: 'Program loaded. Configure ARD, then press Continue to run.',
        threadId: 1,
        allThreadsStopped: true,
    });
}
/**
 * Handle "threads" request.
 * Queries GDB for thread list and returns DAP Thread objects.
 * Before the inferior starts, returns a synthetic placeholder thread.
 */
function handleThreads(request) {
    if (!inferiorStarted) {
        // Before -exec-run, there are no real threads yet.
        // Return a placeholder so VS Code doesn't error out.
        sendResponse(request, {
            threads: [{ id: 1, name: 'main (not started)' }],
        });
        return;
    }
    sendMICommand('-thread-info')
        .then((record) => {
        const threads = [];
        const miThreads = record.data?.threads;
        if (Array.isArray(miThreads)) {
            for (const t of miThreads) {
                const id = parseInt(t.id || '1', 10);
                const targetId = t['target-id'] || '';
                const name = t.name || targetId || `Thread ${id}`;
                threads.push({ id, name });
            }
        }
        if (threads.length === 0) {
            threads.push({ id: 1, name: 'main' });
        }
        sendResponse(request, { threads });
    })
        .catch(() => {
        sendResponse(request, {
            threads: [{ id: 1, name: 'main' }],
        });
    });
}
/**
 * Handle "stackTrace" request.
 * First attempts to get the async logical call stack via ardb-get-snapshot.
 * If a valid snapshot exists, returns logical stack frames (async + sync).
 * Otherwise, falls back to GDB's physical stack frames (-stack-list-frames).
 */
function handleStackTrace(request) {
    const threadId = request.arguments?.threadId || 1;
    if (!inferiorStarted) {
        // Before -exec-run, no real stack exists.
        sendResponse(request, { stackFrames: [], totalFrames: 0 });
        return;
    }
    // Switch to the requested thread, then try to get a logical snapshot
    sendMICommand(`-thread-select ${threadId}`)
        .then(() => {
        // Try to get async snapshot for logical call stack
        const escaped = 'ardb-get-snapshot';
        return sendMICommand(`-interpreter-exec console "${escaped}"`);
    })
        .then((record) => {
        const output = record.data?.msg || '';
        const snapshot = parseSnapshot(output);
        if (snapshot && snapshot.path.length > 0) {
            // Build logical stack frames from snapshot
            // Snapshot path is root→leaf (caller→callee), but VS Code
            // expects leaf→root (top of stack first), so reverse it.
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
                const frame = {
                    id: frameId,
                    name,
                    line: node.line || 0,
                    column: 0,
                };
                if (node.fullname || node.file) {
                    const mappedPath = remapGdbSourcePath(node.fullname || node.file);
                    frame.source = {
                        name: node.file || '',
                        path: mappedPath || node.fullname || node.file || '',
                    };
                }
                if (node.addr) {
                    frame.instructionPointerReference = node.addr;
                }
                stackFrames.push(frame);
            }
            sendResponse(request, {
                stackFrames,
                totalFrames: stackFrames.length,
            });
        }
        else {
            // Fallback to physical GDB stack frames
            return fallbackPhysicalStackTrace(request, threadId);
        }
    })
        .catch((err) => {
        process.stderr.write(`[Adapter] snapshot stackTrace failed, falling back: ${err.message}\n`);
        // Fallback on error
        fallbackPhysicalStackTrace(request, threadId).catch((err2) => {
            process.stderr.write(`[Adapter] stackTrace fallback also failed: ${err2.message}\n`);
            sendResponse(request, { stackFrames: [], totalFrames: 0 });
        });
    });
}
/**
 * Parse a snapshot JSON from GDB console output.
 * Returns the parsed snapshot or undefined if parsing fails.
 */
function parseSnapshot(output) {
    if (!output)
        return undefined;
    const jsonStart = output.indexOf('{');
    const jsonEnd = output.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
        return undefined;
    }
    try {
        const jsonStr = output.substring(jsonStart, jsonEnd + 1);
        const snapshot = JSON.parse(jsonStr);
        if (snapshot.thread_id !== undefined && Array.isArray(snapshot.path)) {
            return snapshot;
        }
    }
    catch {
        // JSON parse failed
    }
    return undefined;
}
/**
 * Fallback: query GDB for physical stack frames via -stack-list-frames.
 */
function fallbackPhysicalStackTrace(request, threadId) {
    return sendMICommand('-stack-list-frames')
        .then((record) => {
        const stackFrames = [];
        const miStack = record.data?.stack;
        if (Array.isArray(miStack)) {
            for (const entry of miStack) {
                // MI returns: frame={level="0",addr="0x...",func="main",file="main.rs",fullname="/path/main.rs",line="10"}
                // In result-list form, each element is the frame object directly
                const f = entry.level !== undefined ? entry : (entry.frame || entry);
                const level = parseInt(f.level || '0', 10);
                const frameId = threadId * 10000 + level; // Unique ID encoding
                const frame = {
                    id: frameId,
                    name: f.func || '<unknown>',
                    line: parseInt(f.line || '0', 10),
                    column: 0,
                };
                if (f.fullname || f.file) {
                    const mappedPath = remapGdbSourcePath(f.fullname || f.file);
                    frame.source = {
                        name: f.file || '',
                        path: mappedPath || f.fullname || f.file || '',
                    };
                }
                if (f.addr) {
                    frame.instructionPointerReference = f.addr;
                }
                stackFrames.push(frame);
            }
        }
        sendResponse(request, {
            stackFrames,
            totalFrames: stackFrames.length,
        });
    })
        .catch((err) => {
        process.stderr.write(`[Adapter] stackTrace failed: ${err.message}\n`);
        sendResponse(request, { stackFrames: [], totalFrames: 0 });
    });
}
/**
 * Handle "continue" request.
 * First continue: execute -exec-run to start the inferior.
 * Subsequent continues: execute -exec-continue to resume.
 */
let continueInProgress = false;
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function connectRemoteWithRetry() {
    let lastErr;
    for (let i = 0; i < 10; i++) {
        try {
            logToFile(`[Adapter] remote connect attempt ${i + 1}: ${targetRemote}`);
            const remote = normalizeTargetRemote(targetRemote);
            await sendMICommand(`-target-select remote ${remote}`);
            remoteAttached = true;
            logToFile(`[Adapter] remote connect success`);
            return;
        }
        catch (err) {
            lastErr = err;
            logToFile(`[Adapter] remote connect failed attempt ${i + 1}: ${err.message}`);
            await sleep(200);
        }
    }
    throw lastErr || new Error('remote connect failed');
}
function handleContinue(request) {
    if (continueInProgress) {
        logToFile(`[Adapter] continue ignored: already in progress`);
        sendResponse(request, { allThreadsContinued: true });
        return;
    }
    continueInProgress = true;
    const done = () => {
        continueInProgress = false;
    };
    if (!inferiorStarted) {
        cleanupVariables()
            .then(async () => {
            logToFile(`[Adapter] first continue: targetRemote=${targetRemote}, remoteAttached=${remoteAttached}`);
            if (targetRemote) {
                if (!remoteAttached) {
                    await connectRemoteWithRetry();
                }
                logToFile(`[Adapter] remote session, sending console continue`);
                return sendMICommand(`-interpreter-exec console "continue"`);
            }
            else {
                logToFile(`[Adapter] local session, sending -exec-run`);
                return sendMICommand('-exec-run');
            }
        })
            .then((record) => {
            logToFile(`[Adapter] first continue success: ${JSON.stringify(record.data)}`);
            inferiorStarted = true;
            sendResponse(request, { allThreadsContinued: true });
            done();
        })
            .catch((err) => {
            logToFile(`[Adapter] first continue failed: ${err.message}`);
            sendErrorResponse(request, err.message);
            done();
        });
    }
    else {
        cleanupVariables()
            .then(() => {
            if (targetRemote) {
                logToFile(`[Adapter] subsequent continue: remote console continue`);
                return sendMICommand(`-interpreter-exec console "continue"`);
            }
            else {
                logToFile(`[Adapter] subsequent continue: -exec-continue`);
                return sendMICommand('-exec-continue');
            }
        })
            .then((record) => {
            logToFile(`[Adapter] subsequent continue success: ${JSON.stringify(record.data)}`);
            sendResponse(request, { allThreadsContinued: true });
            done();
        })
            .catch((err) => {
            logToFile(`[Adapter] subsequent continue failed: ${err.message}`);
            sendErrorResponse(request, err.message);
            done();
        });
    }
}
/**
 * Handle "next" request (step over).
 * Executes -exec-next to step to the next source line, stepping over calls.
 */
function handleNext(request) {
    if (!inferiorStarted) {
        sendErrorResponse(request, 'Program has not started yet. Press Continue first.');
        return;
    }
    cleanupVariables()
        .then(() => sendMICommand('-exec-next'))
        .then(() => {
        sendResponse(request);
    })
        .catch((err) => {
        process.stderr.write(`[Adapter] -exec-next failed: ${err.message}\n`);
        sendErrorResponse(request, err.message);
    });
}
/**
 * Handle "stepIn" request.
 * Executes -exec-step to step into the next function call.
 */
function handleStepIn(request) {
    if (!inferiorStarted) {
        sendErrorResponse(request, 'Program has not started yet. Press Continue first.');
        return;
    }
    cleanupVariables()
        .then(() => sendMICommand('-exec-step'))
        .then(() => {
        sendResponse(request);
    })
        .catch((err) => {
        process.stderr.write(`[Adapter] -exec-step failed: ${err.message}\n`);
        sendErrorResponse(request, err.message);
    });
}
/**
 * Handle "stepOut" request.
 * Executes -exec-finish to run until the current function returns.
 */
function handleStepOut(request) {
    if (!inferiorStarted) {
        sendErrorResponse(request, 'Program has not started yet. Press Continue first.');
        return;
    }
    cleanupVariables()
        .then(() => sendMICommand('-exec-finish'))
        .then(() => {
        sendResponse(request);
    })
        .catch((err) => {
        process.stderr.write(`[Adapter] -exec-finish failed: ${err.message}\n`);
        sendErrorResponse(request, err.message);
    });
}
/**
 * Handle "pause" request.
 * Executes -exec-interrupt to suspend the running inferior.
 */
function handlePause(request) {
    if (!inferiorStarted) {
        sendErrorResponse(request, 'Program has not started yet.');
        return;
    }
    sendMICommand('-exec-interrupt')
        .then(() => {
        sendResponse(request);
    })
        .catch((err) => {
        process.stderr.write(`[Adapter] -exec-interrupt failed: ${err.message}\n`);
        sendErrorResponse(request, err.message);
    });
}
// ---------------------------------------------------------------------------
// Breakpoint handlers
// ---------------------------------------------------------------------------
/**
 * Handle "setBreakpoints" request.
 * VS Code sends this for each source file that has breakpoints.
 * The request contains the FULL set of desired breakpoints for a file —
 * we must delete any previous breakpoints for that file and re-create them.
 */
async function handleSetBreakpoints(request) {
    const source = request.arguments?.source;
    const filePath = source?.path || '';
    const requestedLines = (request.arguments?.breakpoints || []);
    if (!filePath) {
        sendResponse(request, { breakpoints: [] });
        return;
    }
    try {
        // 1. Delete old breakpoints for this file
        const oldNumbers = fileBreakpoints.get(filePath) || [];
        for (const num of oldNumbers) {
            await sendMICommand(`-break-delete ${num}`).catch(() => { });
            gdbBkptToDap.delete(num);
        }
        fileBreakpoints.delete(filePath);
        // 2. Insert new breakpoints
        const newNumbers = [];
        const dapBreakpoints = [];
        for (const bp of requestedLines) {
            const location = toGdbSourceLocation(filePath, bp.line);
            logToFile(`[Adapter] try source bp: ${location}`);
            try {
                const record = await sendMICommand(`-break-insert -f ${location}`);
                const bkpt = record.data?.bkpt;
                logToFile(`[Adapter] source bp raw record: ${JSON.stringify(record.data)}`);
                logToFile(`[Adapter] source bp bkpt: ${JSON.stringify(bkpt)}`);
                const gdbNumber = parseInt(bkpt?.number || '0', 10);
                const actualLine = parseInt(bkpt?.line || `${bp.line}`, 10);
                const verified = bkpt?.pending === undefined; // pending means not yet resolved
                logToFile(`[Adapter] source bp verified=${verified}, gdbNumber=${gdbNumber}, actualLine=${actualLine}`);
                // Set condition if provided
                if (bp.condition && gdbNumber > 0) {
                    await sendMICommand(`-break-condition ${gdbNumber} ${bp.condition}`).catch(() => { });
                }
                const dapId = nextDapBreakpointId++;
                newNumbers.push(gdbNumber);
                gdbBkptToDap.set(gdbNumber, { id: dapId, line: actualLine, verified });
                dapBreakpoints.push({
                    id: dapId,
                    verified,
                    line: actualLine,
                    source: { name: source?.name || '', path: filePath },
                });
            }
            catch (err) {
                logToFile(`[Adapter] source breakpoint failed: file=${filePath}, line=${bp.line}, err=${err.message}`);
                const dapId = nextDapBreakpointId++;
                dapBreakpoints.push({
                    id: dapId,
                    verified: false,
                    line: bp.line,
                    message: err.message || 'Failed to set breakpoint',
                    source: { name: source?.name || '', path: filePath },
                });
            }
        }
        fileBreakpoints.set(filePath, newNumbers);
        logToFile(`[Adapter] source dapBreakpoints: ${JSON.stringify(dapBreakpoints)}`);
        sendResponse(request, { breakpoints: dapBreakpoints });
    }
    catch (err) {
        process.stderr.write(`[Adapter] setBreakpoints failed: ${err.message}\n`);
        sendErrorResponse(request, err.message);
    }
}
/**
 * Handle "setFunctionBreakpoints" request.
 * Clears all previous function breakpoints, then sets new ones by function name.
 */
async function handleSetFunctionBreakpoints(request) {
    const requestedFunctions = (request.arguments?.breakpoints || []);
    try {
        // 1. Delete old function breakpoints
        for (const num of functionBreakpointNumbers) {
            await sendMICommand(`-break-delete ${num}`).catch(() => { });
            gdbBkptToDap.delete(num);
        }
        functionBreakpointNumbers = [];
        // 2. Insert new function breakpoints
        const dapBreakpoints = [];
        for (const fbp of requestedFunctions) {
            logToFile(`[Adapter] try function bp: ${fbp.name}`);
            try {
                const record = await sendMICommand(`-break-insert -f ${fbp.name}`);
                const bkpt = record.data?.bkpt;
                logToFile(`[Adapter] function bp raw record: ${JSON.stringify(record.data)}`);
                logToFile(`[Adapter] function bp bkpt: ${JSON.stringify(bkpt)}`);
                const gdbNumber = parseInt(bkpt?.number || '0', 10);
                const actualLine = parseInt(bkpt?.line || '0', 10);
                const verified = bkpt?.pending === undefined;
                logToFile(`[Adapter] function bp verified=${verified}, gdbNumber=${gdbNumber}, actualLine=${actualLine}`);
                if (fbp.condition && gdbNumber > 0) {
                    await sendMICommand(`-break-condition ${gdbNumber} ${fbp.condition}`).catch(() => { });
                }
                const dapId = nextDapBreakpointId++;
                functionBreakpointNumbers.push(gdbNumber);
                gdbBkptToDap.set(gdbNumber, { id: dapId, line: actualLine, verified });
                const mappedFullname = remapGdbSourcePath(bkpt?.fullname);
                dapBreakpoints.push({
                    id: dapId,
                    verified,
                    line: actualLine,
                    source: mappedFullname ? { path: mappedFullname, name: bkpt.file || '' } : undefined,
                });
            }
            catch (err) {
                logToFile(`[Adapter] function breakpoint failed: name=${fbp.name}, err=${err.message}`);
                const dapId = nextDapBreakpointId++;
                dapBreakpoints.push({
                    id: dapId,
                    verified: false,
                    message: err.message || 'Failed to set function breakpoint',
                });
            }
        }
        logToFile(`[Adapter] function dapBreakpoints: ${JSON.stringify(dapBreakpoints)}`);
        sendResponse(request, { breakpoints: dapBreakpoints });
    }
    catch (err) {
        process.stderr.write(`[Adapter] setFunctionBreakpoints failed: ${err.message}\n`);
        sendErrorResponse(request, err.message);
    }
}
// ---------------------------------------------------------------------------
// Scopes & Variables handlers
// ---------------------------------------------------------------------------
/**
 * Handle "scopes" request.
 * Returns two scopes for the given stack frame:
 * - "Arguments" — function parameters
 * - "Locals" — local variables
 * This avoids duplicate entries that occur when using -stack-list-variables.
 */
function handleScopes(request) {
    const frameId = request.arguments?.frameId ?? 0;
    const threadId = Math.floor(frameId / 10000);
    const frameLevel = frameId % 10000;
    const argsRef = nextVarRef++;
    const localsRef = nextVarRef++;
    varRefMap.set(argsRef, { type: 'scope', scopeKind: 'args', threadId, frameLevel });
    varRefMap.set(localsRef, { type: 'scope', scopeKind: 'locals', threadId, frameLevel });
    sendResponse(request, {
        scopes: [
            {
                name: 'Arguments',
                variablesReference: argsRef,
                expensive: false,
            },
            {
                name: 'Locals',
                variablesReference: localsRef,
                expensive: false,
            },
        ],
    });
}
/**
 * Handle "variables" request.
 * Resolves the variablesReference to either a scope (top-level variable
 * listing) or a var-object (expanding a complex type's children).
 */
async function handleVariables(request) {
    const ref = request.arguments?.variablesReference ?? 0;
    const entry = varRefMap.get(ref);
    if (!entry) {
        sendResponse(request, { variables: [] });
        return;
    }
    try {
        if (entry.type === 'scope') {
            await handleScopeVariables(request, entry.threadId, entry.frameLevel, entry.scopeKind);
        }
        else {
            await handleVarChildren(request, entry.varName);
        }
    }
    catch (err) {
        process.stderr.write(`[Adapter] variables failed: ${err.message}\n`);
        sendResponse(request, { variables: [] });
    }
}
/**
 * Fetch variables for a scope from GDB.
 * - 'args' scope uses -stack-list-arguments to get function parameters.
 * - 'locals' scope uses -stack-list-locals to get local variables.
 */
async function handleScopeVariables(request, threadId, frameLevel, scopeKind) {
    // Switch to the correct thread and frame
    await sendMICommand(`-thread-select ${threadId}`);
    await sendMICommand(`-stack-select-frame ${frameLevel}`);
    let miVars;
    if (scopeKind === 'args') {
        // Get function arguments for the current frame
        const record = await sendMICommand(`-stack-list-arguments --all-values 0 0`);
        // Response: stack-args=[frame={level="0",args=[{name="x",type="i32",value="1"},..]}]
        const stackArgs = record.data?.['stack-args'];
        if (Array.isArray(stackArgs) && stackArgs.length > 0) {
            const frameEntry = stackArgs[0]?.frame || stackArgs[0];
            miVars = frameEntry?.args;
        }
    }
    else {
        // Get local variables (excluding arguments)
        const record = await sendMICommand('-stack-list-locals --all-values');
        miVars = record.data?.locals;
    }
    const variables = [];
    if (Array.isArray(miVars)) {
        for (const v of miVars) {
            const name = v.name || '';
            const value = v.value || '';
            const type = v.type || '';
            // Determine if this variable is expandable (complex type).
            // Simple heuristic: if the value starts with '{' or the type
            // looks like a struct/enum/tuple, try to create a var-object.
            let variablesReference = 0;
            if (looksExpandable(type, value)) {
                try {
                    const varObj = await sendMICommand(`-var-create - * ${name}`);
                    const varName = varObj.data?.name;
                    const numchild = parseInt(varObj.data?.numchild || '0', 10);
                    if (varName) {
                        createdVarObjects.push(varName);
                        if (numchild > 0) {
                            const childRef = nextVarRef++;
                            varRefMap.set(childRef, { type: 'var', varName });
                            variablesReference = childRef;
                        }
                    }
                }
                catch {
                    // var-create failed — treat as non-expandable
                }
            }
            variables.push({
                name,
                value,
                type,
                variablesReference,
            });
        }
    }
    sendResponse(request, { variables });
}
/**
 * Fetch children of an expandable GDB var-object.
 */
async function handleVarChildren(request, parentVarName) {
    const record = await sendMICommand(`-var-list-children --all-values ${parentVarName}`);
    const children = record.data?.children;
    const variables = [];
    if (Array.isArray(children)) {
        for (const entry of children) {
            // MI returns: child={name="var1.field",exp="field",numchild="0",value="42",type="i32"}
            const child = entry.child || entry;
            const name = child.exp || child.name || '';
            const value = child.value || '';
            const type = child.type || '';
            const numchild = parseInt(child.numchild || '0', 10);
            const childVarName = child.name || '';
            let variablesReference = 0;
            if (numchild > 0 && childVarName) {
                const childRef = nextVarRef++;
                varRefMap.set(childRef, { type: 'var', varName: childVarName });
                variablesReference = childRef;
            }
            variables.push({
                name,
                value,
                type,
                variablesReference,
            });
        }
    }
    sendResponse(request, { variables });
}
/**
 * Heuristic: does this variable look like it might be expandable?
 * Returns true for structs, enums, tuples, arrays, etc.
 */
function looksExpandable(type, value) {
    // If value starts with '{', it's likely a struct/tuple
    if (value.startsWith('{'))
        return true;
    // Rust slice / array types
    if (type.startsWith('[') || type.startsWith('&['))
        return true;
    // Tuple types
    if (type.startsWith('(') && type.includes(','))
        return true;
    // Common Rust smart pointer / collection types
    if (/^(alloc::|std::)/.test(type))
        return true;
    // Named struct types (contains ::)
    if (type.includes('::') && !type.includes('*'))
        return true;
    return false;
}
/**
 * Clean up all GDB var-objects and reset variable state.
 * Called when the inferior resumes execution.
 */
async function cleanupVariables() {
    // Delete all var-objects from GDB
    for (const name of createdVarObjects) {
        await sendMICommand(`-var-delete ${name}`).catch(() => { });
    }
    createdVarObjects.length = 0;
    varRefMap.clear();
    nextVarRef = 1;
}
// ---------------------------------------------------------------------------
// Evaluate handler
// ---------------------------------------------------------------------------
/**
 * Handle "evaluate" request.
 * Sends the expression to GDB via `-interpreter-exec console` and returns
 * the captured console-stream output as the result.
 *
 * For "repl" context (Debug Console input), the output is also emitted as
 * an "output" event so it appears in the Debug Console.
 */
async function handleEvaluate(request) {
    if (!gdbProcess || !request.arguments?.expression) {
        sendResponse(request, { result: '', variablesReference: 0 });
        return;
    }
    const expr = request.arguments.expression;
    const context = request.arguments?.context || 'repl';
    // Escape the expression for MI C-string: backslash and double-quote
    const escaped = expr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try {
        const record = await sendMICommand(`-interpreter-exec console "${escaped}"`);
        const result = record.data?.msg || '';
        // For repl context, also emit output event so the result shows
        // in the Debug Console output area (not just the inline response)
        if (context === 'repl' && result) {
            sendEvent('output', {
                category: 'console',
                output: result.endsWith('\n') ? result : result + '\n',
            });
        }
        sendResponse(request, { result: result || 'OK', variablesReference: 0 });
    }
    catch (err) {
        const msg = err.message || 'Command failed';
        if (context === 'repl') {
            sendEvent('output', {
                category: 'stderr',
                output: msg.endsWith('\n') ? msg : msg + '\n',
            });
        }
        sendResponse(request, { result: msg, variablesReference: 0 });
    }
}
// ---------------------------------------------------------------------------
// Send MI command to GDB with token-based response tracking
// ---------------------------------------------------------------------------
/**
 * Send an MI command to GDB and return a promise that resolves with the
 * result record (^done / ^error / ^running).
 */
function sendMICommand(command) {
    return new Promise((resolve, reject) => {
        if (!gdbProcess || !gdbProcess.stdin) {
            reject(new Error('GDB process not available'));
            return;
        }
        const token = nextToken++;
        pendingCommands.set(token, { resolve, reject, consoleOutput: [] });
        commandQueue.push(token);
        const fullCommand = `${token}${command}\n`;
        process.stderr.write(`[Adapter -> GDB] ${fullCommand.trim()}\n`);
        gdbProcess.stdin.write(fullCommand);
    });
}
/**
 * Send a raw string to GDB stdin without token tracking.
 * Use this only for commands where you don't need the response.
 */
function sendGDBRaw(command) {
    if (gdbProcess && gdbProcess.stdin) {
        process.stderr.write(`[Adapter -> GDB (raw)] ${command.trim()}\n`);
        gdbProcess.stdin.write(command);
    }
}
// ---------------------------------------------------------------------------
// DAP message helpers
// ---------------------------------------------------------------------------
function sendResponse(request, body = {}) {
    const response = {
        type: 'response',
        request_seq: request.seq,
        success: true,
        command: request.command,
        body: body,
    };
    const json = JSON.stringify(response);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}
function sendErrorResponse(request, message) {
    const response = {
        type: 'response',
        request_seq: request.seq,
        success: false,
        command: request.command,
        message: message,
        body: {},
    };
    const json = JSON.stringify(response);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}
function sendEvent(event, body = {}) {
    const message = JSON.stringify({
        type: 'event',
        event: event,
        body: body,
    });
    process.stdout.write(`Content-Length: ${Buffer.byteLength(message, 'utf8')}\r\n\r\n${message}`);
}
// ---------------------------------------------------------------------------
// GDB MI2 output processing
// ---------------------------------------------------------------------------
/**
 * Feed raw bytes from GDB stdout into the line buffer, then parse
 * each complete line through the MI2 parser.
 */
function handleGDBOutput(data) {
    gdbOutputBuffer += data.toString('utf8');
    // Process complete lines
    let newlineIdx;
    while ((newlineIdx = gdbOutputBuffer.indexOf('\n')) !== -1) {
        const line = gdbOutputBuffer.substring(0, newlineIdx).replace(/\r$/, '');
        gdbOutputBuffer = gdbOutputBuffer.substring(newlineIdx + 1);
        if (!line)
            continue;
        const record = (0, miParser_1.parseMILine)(line);
        if (!record) {
            process.stderr.write(`[GDB ?] ${line}\n`);
            continue;
        }
        process.stderr.write(`[GDB ${record.type}] ${line}\n`);
        dispatchMIRecord(record);
    }
}
/**
 * FIFO queue of tokens for in-flight MI commands.
 * GDB processes MI commands sequentially, so console-stream output (~"...")
 * always belongs to the oldest (first) pending command in the queue.
 * This replaces the old `lastSentToken` approach which was racy when
 * multiple commands were in flight concurrently.
 */
const commandQueue = [];
/**
 * Route a parsed MI record to the appropriate handler.
 */
function dispatchMIRecord(record) {
    switch (record.type) {
        case 'result':
            handleResultRecord(record);
            break;
        case 'exec-async':
            handleExecAsync(record);
            break;
        case 'notify-async':
            handleNotifyAsync(record);
            break;
        case 'console-stream':
            // Route console output to the oldest in-flight command (FIFO).
            // GDB processes MI commands sequentially, so stream output
            // always belongs to the command at the head of the queue.
            if (record.data?.msg && commandQueue.length > 0) {
                const headToken = commandQueue[0];
                const pending = pendingCommands.get(headToken);
                if (pending) {
                    pending.consoleOutput.push(record.data.msg);
                }
            }
            break;
        case 'target-stream':
        case 'log-stream':
            // Log for debugging, no action needed
            break;
        case 'status-async':
            // Rarely used, log only
            break;
        case 'prompt':
            // (gdb) prompt — MI is ready for next command
            break;
    }
}
/**
 * Handle result records (^done, ^error, ^running).
 * Resolves the pending command promise if a matching token exists.
 */
function handleResultRecord(record) {
    if (record.token !== undefined) {
        const pending = pendingCommands.get(record.token);
        if (pending) {
            pendingCommands.delete(record.token);
            // Remove this token from the FIFO command queue
            const queueIdx = commandQueue.indexOf(record.token);
            if (queueIdx !== -1) {
                commandQueue.splice(queueIdx, 1);
            }
            // Attach accumulated console stream output to the result
            if (pending.consoleOutput.length > 0) {
                record.data.msg = pending.consoleOutput.join('');
            }
            if (record.cls === 'error') {
                pending.reject(new Error(record.data?.msg || 'GDB error'));
            }
            else {
                pending.resolve(record);
            }
            return;
        }
    }
}
/**
 * Handle exec-async records (*stopped, *running).
 * Translates GDB async notifications into DAP events.
 */
function handleExecAsync(record) {
    process.stderr.write(`[GDB exec-async] class=${record.cls} data=${JSON.stringify(record.data)}\n`);
    if (record.cls === 'stopped') {
        // Map GDB stop reason to DAP stop reason
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
                sendEvent('terminated');
                return;
            default:
                dapReason = 'pause';
                description = gdbReason || 'Paused';
                break;
        }
        // Extract thread ID from GDB data
        const threadId = parseInt(record.data?.['thread-id'] || '1', 10);
        sendEvent('stopped', {
            reason: dapReason,
            description,
            threadId,
            allThreadsStopped: record.data?.['stopped-threads'] === 'all' || true,
        });
    }
    else if (record.cls === 'running') {
        const threadId = parseInt(record.data?.['thread-id'] || '1', 10);
        sendEvent('continued', {
            threadId,
            allThreadsContinued: true,
        });
    }
}
/**
 * Handle notify-async records (=thread-created, =breakpoint-modified, etc.).
 */
function handleNotifyAsync(record) {
    process.stderr.write(`[GDB notify] ${record.cls}: ${JSON.stringify(record.data)}\n`);
    if (record.cls === 'breakpoint-modified') {
        const bkpt = record.data?.bkpt;
        if (!bkpt)
            return;
        const gdbNumber = parseInt(bkpt.number || '0', 10);
        const entry = gdbBkptToDap.get(gdbNumber);
        if (!entry)
            return;
        // Update verified status — a pending breakpoint may become resolved
        const nowVerified = bkpt.pending === undefined;
        const actualLine = parseInt(bkpt.line || `${entry.line}`, 10);
        entry.verified = nowVerified;
        entry.line = actualLine;
        const mappedFullname = remapGdbSourcePath(bkpt.fullname);
        sendEvent('breakpoint', {
            reason: 'changed',
            breakpoint: {
                id: entry.id,
                verified: nowVerified,
                line: actualLine,
                source: mappedFullname ? { path: mappedFullname, name: bkpt.file || '' } : undefined,
            },
        });
    }
}
// ---------------------------------------------------------------------------
// Launch GDB
// ---------------------------------------------------------------------------
function launchGDB() {
    const args = JSON.parse(argsStr);
    const gdbArgs = [
        '--interpreter=mi2',
        '-ex', 'set pagination off',
    ];
    if (gdbArch) {
        gdbArgs.push('-ex', `set architecture ${gdbArch}`);
    }
    if (program) {
        gdbArgs.push(program);
    }
    gdbArgs.push('-ex', `python import sys; sys.path.insert(0, '${pythonPath}'); import async_rust_debugger`);
    gdbArgs.push(...args);
    gdbProcess = (0, child_process_1.spawn)(gdbPath, gdbArgs, { cwd });
    gdbProcess.stdout?.on('data', (data) => {
        handleGDBOutput(data);
    });
    gdbProcess.stderr?.on('data', (data) => {
        process.stderr.write(`[GDB Error]: ${data.toString()}`);
    });
    gdbProcess.on('exit', (code) => {
        process.stderr.write(`[GDB] Process exited with code ${code}\n`);
        sendEvent('terminated');
    });
}
//# sourceMappingURL=gdbAdapter.js.map