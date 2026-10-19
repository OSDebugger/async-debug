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
import { MI2, escape } from './backend/mi2';
import { MINode } from './backend/mi_parse';
import {
    BreakpointGroups,
    Border,
    HookBreakpoint,
    HookBreakpointJSONFriendly,
    IBreakpointGroupsSession,
    IDebuggerBackend,
    toFunctionString,
} from './breakpointGroups';
import {
    OSStateMachine,
    OSState,
    OSStates,
    OSEvent,
    OSEvents,
    DebuggerActions,
    Action,
    stateTransition,
} from './OSStateMachine';
import { isKernelAddr, isUserAddr, parseAddr } from './addrSpace';
import { OsProfiler, SingleStepCtx } from './osProfiler';

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
        space?: 'kernel' | 'user' | 'unknown';
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
// Attach request arguments
// ---------------------------------------------------------------------------

export interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
    cwd: string;
    target: string;           // GDB remote target, e.g. ":1234"
    gdbpath?: string;
    env?: any;
    debugger_args?: string[];
    executable?: string;      // path to ELF for debug symbols
    autorun?: string[];
    stopAtConnect?: boolean;
    qemuPath: string;
    qemuArgs: string[];
    program_counter_id?: number;
    first_breakpoint_group?: string;
    second_breakpoint_group?: string;
    kernel_memory_ranges?: string[][];
    user_memory_ranges?: string[][];
    border_breakpoints?: Array<{ filepath?: string; line?: number; function?: string; direction?: 'kernel_to_user' | 'user_to_kernel' }>;
    hook_breakpoints?: Array<{
        breakpoint: { file?: string; line?: number; function?: string };
        behavior: { functionArguments?: string; functionBody?: string; body?: string; args?: string[]; isAsync?: boolean };
    }>;
    filePathToBreakpointGroupNames?: { functionArguments: string; functionBody: string; isAsync: boolean };
    breakpointGroupNameToDebugFilePaths?: { functionArguments: string; functionBody: string; isAsync: boolean };
    profileTs?: boolean;       // experiment B: enable TS-side OS profiling
    profileTsLog?: string;     // experiment B: also append [ARD-PROFILE-TS] lines to this file
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

    // MI2 backend
    private miDebugger: MI2 | undefined;

    // Inferior state
    private inferiorStarted = false;
    private gdbReady = false;       // GDB process has connected and is ready to accept commands
    private isAttachMode = false;   // true when using attach (QEMU) mode
    private program = '';
    private programArgs: string[] = [];
    private cwd = '';

    // Breakpoint state
    private fileBreakpoints: Map<string, number[]> = new Map();
    private gdbBkptToDap: Map<number, { id: number; line: number; verified: boolean }> = new Map();
    private nextDapBreakpointId = 1;
    private functionBreakpointNumbers: number[] = [];
    // Maps "filePath:line" → DAP breakpoint id for breakpoints that are pending
    // (not set in GDB yet because they belong to an inactive breakpoint group).
    // Used by onBreakpointsRestored to send BreakpointEvent with the original id.
    private pendingDapIds: Map<string, number> = new Map();
    // Compiled version of filePathToBreakpointGroupNames — cached once at attach time
    // so setBreakPointsRequest doesn't re-eval the function string on every call.
    private cachedFilePathToGroupNames: ((filePath: string) => string[]) | undefined;
    // Set by try_get_next_breakpoint_group_name's async body to signal whether the
    // current stop matched a hook. If true, .finally() auto-continues instead of
    // sending StoppedEvent — hook breakpoints should be transparent to the user.
    // Variable / scope state
    private nextVarRef = 1;
    private varRefMap: Map<
        number,
        | { type: 'scope'; scopeKind: 'args' | 'locals'; threadId: number; frameLevel: number }
        | { type: 'var'; varName: string }
    > = new Map();
    private createdVarObjects: string[] = [];

    // OS debug state
    private osDebugReady = false;
    private osState: OSState = new OSState(OSStateMachine.initial);
    private breakpointGroups: BreakpointGroups | undefined;
    public osProfiler: OsProfiler | null = null;   // experiment B: null when disabled
    private singleStepProfileCtx: SingleStepCtx | null = null;   // active consecutive-single-step run
    private recentStopThreadId = 1;
    private kernelMemoryRanges: string[][] = [];
    private userMemoryRanges: string[][] = [];
    private programCounterId = 32; // RISC-V PC register id
    private currentHook: HookBreakpoint | undefined;
    private pendingBreakpointNode: MINode | undefined;
    private functionBorderNames: string[] = [];  // function-name border BPs to auto-insert on debug-ready
    private functionBorderNamesUtoK: string[] = []; // subset: user_to_kernel direction
    private functionHookNames: string[] = [];    // function-name hook BPs to auto-insert on debug-ready
    // Crates the user enabled via ardb-update-whitelist — re-applied after
    // group switches regenerate the whitelist (user symbols enter scope).
    private whitelistEnabledCrates: string[] = [];
    // 已完成白名单首次初始化的用户组——组切换时据此跳过冗余的
    // gen→update→load→trace-user-crate 四连（依赖 restore 恢复白名单与入口断点）。
    private whitelistInitializedGroups: Set<string> = new Set();
    // 用户在 UI 改过 enabled crates → 下一次组切换需重跑 update+load。
    private whitelistDirty: boolean = false;

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

    protected attachRequest(
        response: DebugProtocol.AttachResponse,
        args: DebugProtocol.AttachRequestArguments,
    ): void {
        const config = args as AttachRequestArguments;
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
        this.osState = new OSState(OSStateMachine.initial);
        this.osDebugReady = false;

        // Build IBreakpointGroupsSession adapter
        const firstGroup = config.first_breakpoint_group ?? 'kernel';
        const secondGroup = config.second_breakpoint_group ?? 'user';
        const filePathToGroupNames = config.filePathToBreakpointGroupNames
            ? toFunctionString({ body: config.filePathToBreakpointGroupNames.functionBody, args: [config.filePathToBreakpointGroupNames.functionArguments] })
            : '(function(filepath) { return ["kernel"]; })';
        const groupNameToFilePaths = config.breakpointGroupNameToDebugFilePaths
            ? toFunctionString({ body: config.breakpointGroupNameToDebugFilePaths.functionBody, args: [config.breakpointGroupNameToDebugFilePaths.functionArguments] })
            : '(function(groupName) { return []; })';

        // Compile once — setBreakPointsRequest is called on every user breakpoint action
        // and re-evaling the function string each time is unnecessary overhead.
        this.cachedFilePathToGroupNames = eval(filePathToGroupNames) as (filePath: string) => string[];

        // Experiment B: TS-side OS profiling, enabled per launch config.
        // Must be created BEFORE bpgSession so the session can see it.
        this.osProfiler = new OsProfiler({ enabled: !!config.profileTs, logPath: config.profileTsLog });

        const self = this;
        const bpgSession: IBreakpointGroupsSession = {
            get miDebugger(): IDebuggerBackend {
                return self.miDebugger as unknown as IDebuggerBackend;
            },
            get osProfiler(): OsProfiler | null {
                return self.osProfiler;
            },
            filePathToBreakpointGroupNames: filePathToGroupNames,
            breakpointGroupNameToDebugFilePaths: groupNameToFilePaths,
            showInformationMessage(msg: string) {
                self.sendEvent({ event: 'showInformationMessage', type: 'event', body: msg, seq: 0 } as any);
            },
            onBreakpointsRestored(results: Array<[boolean, import('./backend/backend').Breakpoint]>) {
                // After a breakpoint group switch, GDB has re-inserted the new group's
                // breakpoints under new GDB numbers.  We need to:
                //   1. Register each new GDB number in gdbBkptToDap
                //   2. Send BreakpointEvent('changed', verified=true) with the ORIGINAL DAP id
                //      that VS Code assigned when the breakpoint was first set (stored in
                //      pendingDapIds). Using the original id is what makes VS Code turn the
                //      dot from grey/unverified to green.
                for (const [ok, brk] of results) {
                    if (!ok || !brk) continue;
                    const gdbNumber = brk.id ?? 0;
                    const line = brk.line ?? 0;
                    const file = brk.file ?? '';

                    // Look up the original DAP id assigned when this breakpoint was pending.
                    const pendingKey = `${file}:${line}`;
                    const existingDapId = self.pendingDapIds.get(pendingKey);
                    const dapId = existingDapId ?? self.nextDapBreakpointId++;
                    if (existingDapId !== undefined) {
                        self.pendingDapIds.delete(pendingKey);
                    }

                    self.gdbBkptToDap.set(gdbNumber, { id: dapId, line, verified: true });

                    const dbp = new Breakpoint(true, line);
                    dbp.setId(dapId);
                    if (file) {
                        (dbp as any).source = new Source(path.basename(file), file);
                    }
                    self.sendEvent(new BreakpointEvent('changed', dbp));
                }
            },
            getWhitelistEnabledCrates(): string[] {
                return self.whitelistEnabledCrates;
            },
            getWhitelistInitializedGroups(): Set<string> {
                return self.whitelistInitializedGroups;
            },
            markWhitelistGroupInitialized(group: string): void {
                self.whitelistInitializedGroups.add(group);
            },
            isWhitelistDirty(): boolean {
                return self.whitelistDirty;
            },
            clearWhitelistDirty(): void {
                self.whitelistDirty = false;
            },
            sendCliCommandAndGetOutput(command: string): Promise<string> {
                // 用 captureConsoleOutput 收集 console 流输出（getConsoleOutput 依赖的
                // _consoleOutput 字段没有写入点，恒为空——审查发现 C1）。
                if (!self.miDebugger) { return Promise.resolve(''); }
                return self.miDebugger.captureConsoleOutput(command).catch(() => '');
            },
        };

        this.breakpointGroups = new BreakpointGroups(firstGroup, bpgSession, secondGroup);

        // Register initial borders from launch.json
        if (config.border_breakpoints) {
            for (const b of config.border_breakpoints) {
                const direction = b.direction ?? 'kernel_to_user';
                if (b.function) {
                    this.breakpointGroups.updateBorder(new Border(b.filepath, b.line, b.function, direction));
                    this.functionBorderNames.push(b.function);
                    if (direction === 'user_to_kernel') {
                        this.functionBorderNamesUtoK.push(b.function);
                    }
                } else {
                    this.breakpointGroups.updateBorder(new Border(b.filepath, b.line, undefined, direction));
                }
            }
        }

        // Register initial hook breakpoints from launch.json
        // launch.json uses { functionArguments, functionBody } but HookBreakpointJSONFriendly
        // uses ObjectAsFunction { body, args[] } — convert here.
        if (config.hook_breakpoints) {
            for (const h of config.hook_breakpoints) {
                const behavior = {
                    body: h.behavior?.functionBody ?? h.behavior?.body ?? '',
                    args: h.behavior?.functionArguments !== undefined
                        ? [h.behavior.functionArguments]
                        : (h.behavior?.args ?? []),
                    isAsync: h.behavior?.isAsync ?? false,
                };

                // Function-based hooks (e.g. { function: "syscall_exec" }) need to be
                // auto-inserted into GDB as raw function-name breakpoints, just like borders.
                if (h.breakpoint.function) {
                    this.functionHookNames.push(h.breakpoint.function);
                    const normalized: HookBreakpointJSONFriendly = {
                        breakpoint: { function: h.breakpoint.function, condition: '' } as any,
                        behavior,
                    };
                    this.breakpointGroups.updateHookBreakpoint(normalized);
                } else if (h.breakpoint.file) {
                    const normalized: HookBreakpointJSONFriendly = {
                        breakpoint: { file: h.breakpoint.file, line: h.breakpoint.line ?? 0, condition: '' } as any,
                        behavior,
                    };
                    this.breakpointGroups.updateHookBreakpoint(normalized);
                }
            }
        }

        // Launch QEMU in the integrated terminal, then start GDB after a short delay
        // to give QEMU time to open the GDB stub on :1234.
        const qemuCmd = [config.qemuPath, ...config.qemuArgs];
        this.runInTerminalRequest(
            { kind: 'integrated', title: 'QEMU', cwd: this.cwd, args: qemuCmd },
            15000,
            (termResponse) => {
                if (termResponse.success === false) {
                    console.error('[ardb] Failed to launch QEMU in terminal');
                    this.sendEvent(new TerminatedEvent());
                    return;
                }
                // Give QEMU ~1s to open the GDB stub before GDB tries to connect
                setTimeout(() => {
                    this.launchGDB(config);
                }, 1000);
            }
        );

        this.inferiorStarted = false;
        this.gdbReady = false;
        this.isAttachMode = true;
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

        // In attach mode, GDB hasn't connected yet — the real stop will come from GDB
        // after connecting to QEMU (via stopAtConnect). Don't send a fake StoppedEvent.
        // In launch mode, send an entry stop so the UI shows "paused" while the user configures.
        if (!this.isAttachMode) {
            const event = new StoppedEvent('entry', 1);
            (event.body as any).description = 'Program loaded. Configure ARD, then press Continue to run.';
            (event.body as any).allThreadsStopped = true;
            this.sendEvent(event);
        }
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

        // In OS debug mode: cache breakpoints into the appropriate breakpoint group.
        // Only actually set them in GDB if this file belongs to the current active group.
        if (this.breakpointGroups) {
            // Determine which group(s) this file belongs to
            let groupNames: string[] = [];
            try {
                groupNames = this.cachedFilePathToGroupNames!(filePath);
            } catch {
                groupNames = [this.breakpointGroups.getCurrentBreakpointGroupName()];
            }

            // Save into each matching group (for future group switches)
            for (const groupName of groupNames) {
                this.breakpointGroups.saveBreakpointsToBreakpointGroup(args, groupName);
            }

            const currentGroup = this.breakpointGroups.getCurrentBreakpointGroupName();
            const belongsToCurrent = groupNames.includes(currentGroup);

            // If this file doesn't belong to the current group, return pending placeholders.
            // The breakpoints will be set for real when the group switches.
            if (!belongsToCurrent) {
                // Purge stale entries for this file before inserting new ones.
                // VS Code always sends the full current list for a file, so any key we
                // had from a previous request is now obsolete and must be removed to
                // prevent pendingDapIds from growing unboundedly across group switches.
                for (const key of this.pendingDapIds.keys()) {
                    if (key.startsWith(`${filePath}:`)) {
                        this.pendingDapIds.delete(key);
                    }
                }
                const dapBreakpoints = requestedLines.map(bp => {
                    const dapId = this.nextDapBreakpointId++;
                    // Remember this id so onBreakpointsRestored can use it to send
                    // BreakpointEvent('changed') with the same id, making VS Code turn it green.
                    this.pendingDapIds.set(`${filePath}:${bp.line}`, dapId);
                    const dbp = new Breakpoint(false, bp.line);
                    dbp.setId(dapId);
                    (dbp as any).source = new Source(source.name || '', filePath);
                    (dbp as any).message = 'Pending: will be set when this breakpoint group becomes active';
                    return dbp;
                });
                response.body = { breakpoints: dapBreakpoints };
                this.sendResponse(response);
                return;
            }
            // else: belongs to current group — fall through to set in GDB immediately
        }

        if (!this.miDebugger) {
            // GDB not ready yet — return pending placeholders, they'll be set after connect
            const dapBreakpoints = requestedLines.map(bp => {
                const dbp = new Breakpoint(false, bp.line);
                dbp.setId(this.nextDapBreakpointId++);
                (dbp as any).source = new Source(source.name || '', filePath);
                (dbp as any).message = 'Pending: GDB not connected yet';
                return dbp;
            });
            response.body = { breakpoints: dapBreakpoints };
            this.sendResponse(response);
            return;
        }

        try {
            // Delete old breakpoints for this file
            const oldNumbers = this.fileBreakpoints.get(filePath) || [];
            for (const num of oldNumbers) {
                await this.miDebugger!.sendCommand(`break-delete ${num}`).catch(() => { });
                this.gdbBkptToDap.delete(num);
            }
            this.fileBreakpoints.delete(filePath);

            const newNumbers: number[] = [];
            const dapBreakpoints: DebugProtocol.Breakpoint[] = [];

            for (const bp of requestedLines) {
                const location = `"${escape(filePath)}:${bp.line}"`;
                try {
                    const record = await this.miDebugger!.sendCommand(`break-insert -f ${location}`);
                    const bkpt = MINode.valueOf(record.resultRecords?.results, "bkpt");
                    const gdbNumber = parseInt(MINode.valueOf(bkpt, "number") || '0');
                    const actualLine = parseInt(MINode.valueOf(bkpt, "line") || `${bp.line}`);
                    const verified = MINode.valueOf(bkpt, "pending") === undefined;

                    if (bp.condition && gdbNumber > 0) {
                        await this.miDebugger!.sendCommand(`break-condition ${gdbNumber} ${bp.condition}`).catch(() => { });
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
        if (!this.miDebugger) {
            response.body = { breakpoints: [] };
            this.sendResponse(response);
            return;
        }
        const requestedFunctions = args.breakpoints || [];

        try {
            for (const num of this.functionBreakpointNumbers) {
                await this.miDebugger!.sendCommand(`break-delete ${num}`).catch(() => { });
                this.gdbBkptToDap.delete(num);
            }
            this.functionBreakpointNumbers = [];

            const dapBreakpoints: DebugProtocol.Breakpoint[] = [];

            for (const fbp of requestedFunctions) {
                try {
                    const record = await this.miDebugger!.sendCommand(`break-insert -f ${fbp.name}`);
                    const bkpt = MINode.valueOf(record.resultRecords?.results, "bkpt");
                    const gdbNumber = parseInt(MINode.valueOf(bkpt, "number") || '0');
                    const actualLine = parseInt(MINode.valueOf(bkpt, "line") || '0');
                    const verified = MINode.valueOf(bkpt, "pending") === undefined;

                    if (fbp.condition && gdbNumber > 0) {
                        await this.miDebugger!.sendCommand(`break-condition ${gdbNumber} ${fbp.condition}`).catch(() => { });
                    }

                    const dapId = this.nextDapBreakpointId++;
                    this.functionBreakpointNumbers.push(gdbNumber);
                    this.gdbBkptToDap.set(gdbNumber, { id: dapId, line: actualLine, verified });

                    const dbp = new Breakpoint(verified, actualLine);
                    dbp.setId(dapId);
                    const fullname = MINode.valueOf(bkpt, "fullname");
                    if (fullname) {
                        (dbp as any).source = new Source(MINode.valueOf(bkpt, "file") || '', fullname);
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
        if (!this.miDebugger || !this.gdbReady) {
            this.sendErrorResponse(response, 4, 'GDB is not ready yet. Please wait for the debugger to connect.');
            return;
        }
        try {
            await this.cleanupVariables();

            if (!this.inferiorStarted && !this.isAttachMode) {
                // Launch mode: first Continue starts the program
                this.inferiorStarted = true;
                await this.miDebugger!.sendCommand('exec-run');
            } else {
                await this.miDebugger!.continue();
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
        if (!this.miDebugger) { this.sendErrorResponse(response, 5, 'No debug session'); return; }
        try {
            await this.cleanupVariables();
            await this.miDebugger!.next();
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
        if (!this.miDebugger) { this.sendErrorResponse(response, 6, 'No debug session'); return; }
        try {
            await this.cleanupVariables();
            await this.miDebugger!.step();
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
        if (!this.miDebugger) { this.sendErrorResponse(response, 7, 'No debug session'); return; }
        try {
            await this.cleanupVariables();
            await this.miDebugger!.stepOut();
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
        if (!this.miDebugger) { this.sendErrorResponse(response, 8, 'No debug session'); return; }
        try {
            await this.miDebugger!.interrupt();
            this.sendResponse(response);
        } catch (err: any) {
            this.sendErrorResponse(response, 8, err.message);
        }
    }

    // -----------------------------------------------------------------------
    // DAP: threads
    // -----------------------------------------------------------------------

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        if (!this.inferiorStarted || !this.miDebugger) {
            response.body = { threads: [new Thread(1, 'main (not started)')] };
            this.sendResponse(response);
            return;
        }

        try {
            const threads = await this.miDebugger!.getThreads();
            response.body = {
                threads: threads.map(t => new Thread(t.id, t.name || t.targetId || `Thread ${t.id}`))
            };
            if (response.body.threads.length === 0) {
                response.body.threads.push(new Thread(1, 'main'));
            }
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

        if (!this.inferiorStarted || !this.miDebugger) {
            response.body = { stackFrames: [], totalFrames: 0 };
            this.sendResponse(response);
            return;
        }

        try {
            await this.miDebugger!.sendCommand(`thread-select ${threadId}`);

            // The VS Code call-stack panel shows the PHYSICAL stack as provided
            // by GDB. The async logical call chain (coroutine tree) is only
            // rendered in the Async Inspector panel — it is not injected into
            // the call-stack view anymore.
            await this.fallbackPhysicalStackTrace(response, threadId);
        } catch (err: any) {
            console.log(`[Adapter] stackTrace failed: ${err.message}`);
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
        if (!this.miDebugger || !args.expression) {
            response.body = { result: '', variablesReference: 0 };
            this.sendResponse(response);
            return;
        }

        const expr = args.expression;
        const context = args.context || 'repl';

        try {
            const record = await this.miDebugger!.sendCliCommand(expr);
            const result = this.getConsoleOutput(record);

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
        if (this.miDebugger) {
            this.miDebugger!.stop();
            this.miDebugger = undefined;
        }

        this.inferiorStarted = false;
        this.fileBreakpoints.clear();
        this.gdbBkptToDap.clear();
        this.functionBreakpointNumbers = [];
        this.varRefMap.clear();
        this.createdVarObjects = [];

        // Experiment B: print the cumulative OS profiling report.
        this.osProfiler?.report();

        this.sendResponse(response);
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

            // OS debug commands
            case 'setBorder':
                if (this.breakpointGroups && args) {
                    const direction = args.direction ?? 'kernel_to_user';
                    if (args.function) {
                        this.breakpointGroups.updateBorder(new Border(args.filepath, args.line, args.function, direction));
                        if (!this.functionBorderNames.includes(args.function)) {
                            this.functionBorderNames.push(args.function);
                        }
                        if (direction === 'user_to_kernel' && !this.functionBorderNamesUtoK.includes(args.function)) {
                            this.functionBorderNamesUtoK.push(args.function);
                        }
                        // Insert into GDB immediately if connected.
                        // Also track for debug-ready in case GDB hasn't connected yet.
                        if (this.miDebugger && this.gdbReady) {
                            this.miDebugger.addBreakPoint({ raw: args.function, condition: '' }).then(([ok, brk]) => {
                                if (ok && brk?.id) {
                                    const group = this.breakpointGroups?.getCurrentBreakpointGroup();
                                    const border = group?.borders?.find(b => b.function === args.function);
                                    if (border) border.gdbNumber = brk.id;
                                    console.log(`[ardb] border BP inserted: "${args.function}" → GDB #${brk.id}`);
                                }
                            }).catch((e) => {
                                console.error(`[ardb] failed to insert border BP "${args.function}":`, e);
                            });
                        }
                    } else {
                        this.breakpointGroups.updateBorder(new Border(args.filepath, args.line, undefined, direction));
                    }
                }
                this.sendResponse(response);
                break;

            case 'disableBorder':
                if (this.breakpointGroups && args) {
                    this.breakpointGroups.disableBorder(new Border(args.filepath, args.line));
                }
                this.sendResponse(response);
                break;

            case 'setHookBreakpoint':
                if (this.breakpointGroups && args) {
                    const behavior = {
                        body: args.behavior?.functionBody ?? args.behavior?.body ?? '',
                        args: args.behavior?.functionArguments !== undefined
                            ? [args.behavior.functionArguments]
                            : (args.behavior?.args ?? []),
                        isAsync: args.behavior?.isAsync ?? false,
                    };
                    if (args.breakpoint?.function) {
                        // Function-based hook: insert into GDB immediately.
                        const normalized: HookBreakpointJSONFriendly = {
                            breakpoint: { function: args.breakpoint.function, condition: '' } as any,
                            behavior,
                        };
                        this.breakpointGroups.updateHookBreakpoint(normalized);
                        if (!this.functionHookNames.includes(args.breakpoint.function)) {
                            this.functionHookNames.push(args.breakpoint.function);
                        }
                        if (this.miDebugger && this.gdbReady) {
                            this.miDebugger.addBreakPoint({ raw: args.breakpoint.function, condition: '' }).then(([ok, brk]) => {
                                console.log(`[ardb] hook BP inserted: "${args.breakpoint.function}" → GDB #${brk?.id ?? '?'}`);
                            }).catch((e) => {
                                console.error(`[ardb] failed to insert hook BP "${args.breakpoint.function}":`, e);
                            });
                        }
                        this.showInfo(`hook breakpoint set: ${args.breakpoint.function}`);
                    } else {
                        // File-based hook: stored as metadata on an existing source breakpoint.
                        const normalized: HookBreakpointJSONFriendly = {
                            breakpoint: args.breakpoint,
                            behavior,
                        };
                        this.breakpointGroups.updateHookBreakpoint(normalized);
                        const f = args.breakpoint?.file ? path.basename(args.breakpoint.file) : '?';
                        const l = args.breakpoint?.line ?? '?';
                        this.showInfo(`hook breakpoint set: ${f}:${l}`);
                    }
                }
                this.sendResponse(response);
                break;

            case 'disableHookBreakpoint':
                if (this.breakpointGroups && args) {
                    const normalized: HookBreakpointJSONFriendly = {
                        breakpoint: args.breakpoint,
                        behavior: {
                            body: args.behavior?.functionBody ?? args.behavior?.body ?? '',
                            args: args.behavior?.functionArguments !== undefined
                                ? [args.behavior.functionArguments]
                                : (args.behavior?.args ?? []),
                            isAsync: args.behavior?.isAsync ?? false,
                        },
                    };
                    this.breakpointGroups.disableHookBreakpoint(normalized);
                }
                this.sendResponse(response);
                break;

            case 'removeAllCliBreakpoints':
                if (this.breakpointGroups) {
                    this.breakpointGroups.disableCurrentBreakpointGroupBreakpoints();
                    this.breakpointGroups.removeAllBreakpoints();
                }
                if (this.miDebugger) {
                    // Delete only tracked breakpoints individually — break-delete without args
                    // would also wipe border/hook breakpoints inserted via sendCommand (which
                    // bypass fileBreakpoints), permanently breaking border detection.
                    const toDelete: number[] = [...this.functionBreakpointNumbers];
                    for (const nums of this.fileBreakpoints.values()) {
                        toDelete.push(...nums);
                    }
                    for (const num of toDelete) {
                        this.miDebugger.sendCommand(`break-delete ${num}`).catch(() => { });
                    }
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

    private async handleArdGetSnapshot(response: DebugProtocol.Response): Promise<void> {
        if (!this.miDebugger) { response.body = { snapshot: null }; this.sendResponse(response); return; }
        const snapshot = await this.getSnapshotFromGDB();
        response.body = { snapshot: snapshot || null };
        this.sendResponse(response);
    }

    private async handleArdReset(response: DebugProtocol.Response): Promise<void> {
        if (!this.miDebugger) { response.body = {}; this.sendResponse(response); return; }
        await this.miDebugger.sendCliCommand('ardb-reset');
        // Python 侧的 saved state 已被 ardb-reset 清空，TS 侧的白名单瘦身
        // 状态（已初始化组、dirty）必须同步清空，否则下次切换会错误跳过重建。
        this.whitelistInitializedGroups.clear();
        this.whitelistDirty = false;
        // Clean up debug artifacts produced during the session:
        // trace logs, snapshot, whitelist files. They are regenerated lazily
        // by the GDB Python side / whitelist commands on next use.
        const artifactFiles = [
            'ardb.log',
            'ardb_diag.log',
            'ardb_snapshot.json',
            'poll_functions.txt',
            'poll_functions_grouped.json',
        ];
        for (const f of artifactFiles) {
            const p = path.join(this.tempDir, f);
            try {
                if (fs.existsSync(p)) {
                    fs.rmSync(p);
                }
            } catch (e) {
                console.warn(`[ardb] failed to remove artifact ${p}:`, e);
            }
        }
        response.body = {};
        this.sendResponse(response);
    }

    private async handleArdGenWhitelist(response: DebugProtocol.Response): Promise<void> {
        if (!this.miDebugger) { response.body = { groupedWhitelist: null }; this.sendResponse(response); return; }
        await this.miDebugger.sendCliCommand('ardb-gen-whitelist');
        const grouped = this.readGroupedWhitelistFromDisk();
        response.body = { groupedWhitelist: grouped || null };
        this.sendResponse(response);
    }

    private async handleArdTrace(response: DebugProtocol.Response, args: any): Promise<void> {
        if (!this.miDebugger) { response.body = {}; this.sendResponse(response); return; }
        const symbol = args?.symbol || '';
        await this.miDebugger.sendCliCommand(`ardb-trace ${symbol}`);
        response.body = {};
        this.sendResponse(response);
    }

    private async handleArdGetWhitelistGrouped(response: DebugProtocol.Response): Promise<void> {
        const grouped = this.readGroupedWhitelistFromDisk();
        if (grouped) {
            response.body = { groupedWhitelist: grouped };
            this.sendResponse(response);
            return;
        }
        if (!this.miDebugger) { response.body = { groupedWhitelist: null }; this.sendResponse(response); return; }
        const record = await this.miDebugger.sendCliCommand('ardb-get-whitelist-grouped');
        const output = this.getConsoleOutput(record);
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
        if (!this.miDebugger) { response.body = {}; this.sendResponse(response); return; }
        const enabledCrates = args?.enabledCrates || [];
        this.whitelistEnabledCrates = enabledCrates;
        // 白名单内容将变化：已装的 callsite 断点与已初始化组的白名单都过期，
        // 置 dirty 让下一次组切换重跑 update+load（Python 侧会清空 callsite 集合）。
        this.whitelistDirty = true;
        const payload = JSON.stringify({ enabled_crates: enabledCrates });
        await this.miDebugger.sendCliCommand(`ardb-update-whitelist ${payload}`);
        response.body = {};
        this.sendResponse(response);
    }

    private async handleArdInferTraceRoot(response: DebugProtocol.Response): Promise<void> {
        if (!this.miDebugger) { response.body = { inferredTraceRoot: null }; this.sendResponse(response); return; }
        const record = await this.miDebugger.sendCliCommand('ardb-infer-trace-root');
        const output = this.getConsoleOutput(record);
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
        if (!this.miDebugger) { response.body = { result: '' }; this.sendResponse(response); return; }
        const command = args?.command || '';
        const record = await this.miDebugger.sendCliCommand(command);
        const result = this.getConsoleOutput(record);
        response.body = { result };
        this.sendResponse(response);
    }

    // -----------------------------------------------------------------------
    // GDB subprocess management (via MI2)
    // -----------------------------------------------------------------------

    private launchGDB(attachConfig?: AttachRequestArguments): void {
        const gdbPath = attachConfig?.gdbpath || 'gdb';
        const gdbArgs = [
            '--interpreter=mi2',
            '-ex', `python import sys; sys.path.insert(0, '${this.pythonPath}'); import async_rust_debugger`,
            '-ex', 'set pagination off',
        ];

        const env = { ...process.env, ASYNC_RUST_DEBUGGER_TEMP_DIR: this.tempDir };

        this.miDebugger = new MI2(gdbPath, gdbArgs, attachConfig?.debugger_args || [], env);

        // Wire up events
        this.miDebugger!.on('msg', (type: string, msg: string) => {
            if (type === 'console' || type === 'stdout') {
                this.sendEvent(new OutputEvent(msg, 'console'));
            } else if (type === 'stderr') {
                this.sendEvent(new OutputEvent(msg, 'stderr'));
            }
        });

        this.miDebugger!.on('quit', () => {
            this.sendEvent(new TerminatedEvent());
        });

        this.miDebugger!.on('launcherror', (err: Error) => {
            console.error('[Adapter] GDB launch error:', err);
            this.sendEvent(new TerminatedEvent());
        });

        this.miDebugger!.on('debug-ready', async () => {
            this.gdbReady = true;
            if (attachConfig) {
                this.osDebugReady = true;
                this.inferiorStarted = true;

                // Auto-insert function-name border breakpoints into GDB.
                // These are the borders that drive the OS state machine (e.g. into_user, handle_syscall).
                // They are inserted as raw function-name breakpoints and are transparent to the user.
                for (const funcName of this.functionBorderNames) {
                    try {
                        const [ok, brk] = await this.miDebugger!.addBreakPoint({ raw: funcName, condition: '' });
                        if (ok && brk?.id) {
                            // Store the GDB breakpoint number back on the Border object
                            // so updateCurrentBreakpointGroup can delete by number on group switch.
                            const group = this.breakpointGroups?.getCurrentBreakpointGroup();
                            const border = group?.borders?.find(b => b.function === funcName);
                            if (border) border.gdbNumber = brk.id;
                            console.log(`[ardb] auto-inserted border BP: "${funcName}" → GDB #${brk.id}`);
                        }
                    } catch (e) {
                        console.error(`[ardb] failed to auto-insert border BP "${funcName}":`, e);
                    }
                }

                // Auto-insert function-name hook breakpoints into GDB.
                // These drive dynamic breakpoint group selection (e.g. syscall_exec
                // determines which user process to switch to). Like borders, they are
                // transparent to the user — the behavior runs and execution continues.
                for (const funcName of this.functionHookNames) {
                    try {
                        const [ok, brk] = await this.miDebugger!.addBreakPoint({ raw: funcName, condition: '' });
                        if (ok && brk?.id) {
                            // Store GDB breakpoint number on the hook object so
                            // group switches can delete it by number instead of
                            // by function name (which GDB's break-delete doesn't support).
                            const group = this.breakpointGroups?.getCurrentBreakpointGroup();
                            for (const h of (group?.hooks ?? []) as any) {
                                if (h.breakpoint?.function === funcName) {
                                    h.gdbNumber = brk.id;
                                    break;
                                }
                            }
                        }
                        console.log(`[ardb] auto-inserted hook BP: "${funcName}" → GDB #${brk?.id ?? '?'}`);
                    } catch (e) {
                        console.error(`[ardb] failed to auto-insert hook BP "${funcName}":`, e);
                    }
                }
            }
            this.sendEvent(new InitializedEvent());
        });

        this.miDebugger!.on('breakpoint', (node: MINode) => {
            const threadId = this.getThreadId(node);
            this.recentStopThreadId = threadId;
            if (this.osDebugReady) {
                const bkptno = node.record('bkptno') || '?';
                console.log(`[ardb] breakpoint hit: bkptno=${bkptno}, state=${OSStates[this.osState.status]}`);
                this.pendingBreakpointNode = node;
                this.osStateTransition(new OSEvent(OSEvents.STOPPED));
            } else {
                this.handleBreakpointHit(node);
            }
        });

        this.miDebugger!.on('step-end', (node: MINode) => {
            const threadId = this.getThreadId(node);
            this.recentStopThreadId = threadId;
            if (this.osDebugReady) {
                this.osStateTransition(new OSEvent(OSEvents.STOPPED));
            } else {
                const event = new StoppedEvent('step', threadId);
                (event.body as any).allThreadsStopped = true;
                this.sendEvent(event);
            }
        });

        this.miDebugger!.on('step-other', (node: MINode) => {
            const threadId = this.getThreadId(node);
            this.recentStopThreadId = threadId;
            if (this.osDebugReady) {
                this.osStateTransition(new OSEvent(OSEvents.STOPPED));
            } else {
                const event = new StoppedEvent('pause', threadId);
                (event.body as any).allThreadsStopped = true;
                this.sendEvent(event);
            }
        });

        this.miDebugger!.on('signal-stop', (node: MINode) => {
            const threadId = this.getThreadId(node);
            this.recentStopThreadId = threadId;
            if (this.osDebugReady) {
                this.osStateTransition(new OSEvent(OSEvents.STOPPED));
            } else {
                const sigName = node.record('signal-name') || 'unknown';
                const event = new StoppedEvent('exception', threadId);
                (event.body as any).description = `Signal: ${sigName}`;
                (event.body as any).allThreadsStopped = true;
                this.sendEvent(event);
            }
        });

        this.miDebugger!.on('stopped', (node: MINode) => {
            const threadId = this.getThreadId(node);
            this.recentStopThreadId = threadId;
            if (this.osDebugReady) {
                this.osStateTransition(new OSEvent(OSEvents.STOPPED));
            } else {
                const event = new StoppedEvent('pause', threadId);
                (event.body as any).allThreadsStopped = true;
                this.sendEvent(event);
            }
        });

        this.miDebugger!.on('running', (node: MINode) => {
            const threadId = this.getThreadId(node);
            this.sendEvent(new ContinuedEvent(threadId, true));
        });

        this.miDebugger!.on('exited-normally', (_node: MINode) => {
            this.sendEvent(new TerminatedEvent());
        });

        // Wire breakpoint-modified notify
        this.miDebugger!.on('exec-async-output', (node: MINode) => {
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
            this.miDebugger!.connect(
                this.cwd,
                attachConfig.executable || '',
                attachConfig.target,
                attachConfig.autorun || [],
            ).catch(err => {
                console.error('[Adapter] MI2 connect error:', err);
            });
        } else {
            const fullProgram = this.program;
            const procArgsStr = this.programArgs.join(' ');
            this.miDebugger!.load(this.cwd, fullProgram, procArgsStr).catch(err => {
                console.error('[Adapter] MI2 load error:', err);
            });
        }
    }

    // -----------------------------------------------------------------------
    // OS debug: state machine + doAction
    // -----------------------------------------------------------------------

    private osStateTransition(event: OSEvent): void {
        let actions: Action[];
        [this.osState, actions] = stateTransition(OSStateMachine, this.osState, event);
        actions.forEach(action => { this.doAction(action); });
    }

    /** Send an information notification visible in VS Code's notification area. */
    private showInfo(msg: string): void {
        this.sendEvent({ event: 'showInformationMessage', type: 'event', body: msg, seq: 0 } as any);
    }

    /**
     * Read a C-string variable from GDB. Used by hook breakpoint behaviors
     * (which capture `this` via arrow functions) to fetch e.g. the `path`
     * argument of `sys_exec` and decide which user breakpoint group to switch to.
     *
     * Uses GDB's "p" (print) command and parses the console output with regex,
     * which works across Rust versions without depending on Vec<String> internals.
     */
    public async getStringVariable(name: string): Promise<string> {
        if (!this.miDebugger) return '';
        try {
            const printed = await this.miDebugger.captureConsoleOutput(`p ${name}`);

            const ptrMatch = /pointer:\s*(0x[0-9a-fA-F]+)/.exec(printed);
            const lenMatch = /len:\s*(\d+)/.exec(printed);
            if (!ptrMatch || !lenMatch) {
                this.showInfo(`getStringVariable('${name}'): could not parse pointer/len from: ${printed.slice(0, 200)}`);
                return '';
            }
            const addr = ptrMatch[1];
            const len = parseInt(lenMatch[1], 10);
            if (!Number.isFinite(len) || len <= 0 || len > 4096) {
                this.showInfo(`getStringVariable('${name}'): bad len ${len}`);
                return '';
            }

            const memRes = await this.miDebugger.sendCommand(
                `data-read-memory-bytes ${addr} ${len}`
            );
            const contents: string = memRes.result('memory[0].contents') || '';
            if (!contents) {
                this.showInfo(`getStringVariable('${name}'): empty memory`);
                return '';
            }

            let out = '';
            for (let i = 0; i + 1 < contents.length; i += 2) {
                out += String.fromCharCode(parseInt(contents.substr(i, 2), 16));
            }
            this.showInfo(`getStringVariable got: ${out}`);
            return out;
        } catch (e: any) {
            this.showInfo(`getStringVariable('${name}') failed: ${e?.message ?? e}`);
            return '';
        }
    }

    // Returns true when a stack frame matches a border definition.
    // Supports both function-name matching (substring) and file:line matching.
    // For function-based borders, uses substring match so short names like
    // "user_return" can match mangled symbols like "<TrapFrame>::user_return".
    private matchesBorder(frame: {file: string; line: number; function?: string}, border: import('./breakpointGroups').Border, expectedDirection?: 'kernel_to_user' | 'user_to_kernel'): boolean {
        // Direction filter: only match if the border is for the expected direction
        if (expectedDirection && border.direction !== expectedDirection) return false;
        if (border.function && frame.function && frame.function.includes(border.function)) return true;
        if (border.filepath && border.line !== undefined &&
            frame.file === border.filepath && frame.line === border.line) return true;
        return false;
    }

    // ---- experiment B: single-step profiling helpers -----------------------

    private beginSingleStepProfile(): void {
        if (!this.osProfiler) { return; }
        if (this.singleStepProfileCtx) {
            this.osProfiler.endSingleStep(this.singleStepProfileCtx);
        }
        const direction = this.osState.status === OSStates.kernel_single_step_to_user
            ? 'kernel_to_user' : 'user_to_kernel';
        this.singleStepProfileCtx = this.osProfiler.beginSingleStep(direction);
    }

    private countSingleStepProfile(): void {
        this.osProfiler?.countStep(this.singleStepProfileCtx);
    }

    private endSingleStepProfile(): void {
        if (this.osProfiler && this.singleStepProfileCtx) {
            this.osProfiler.endSingleStep(this.singleStepProfileCtx);
            this.singleStepProfileCtx = null;
        }
    }

    private doAction(action: Action): void {
        if (!this.miDebugger) return;

        if (action.type === DebuggerActions.check_if_kernel_yet) {
            this.showInfo('doing action: check_if_kernel_yet');
            this.miDebugger.getSomeRegisterValues([this.programCounterId]).then(regs => {
                if (!regs || regs.length === 0 || !regs[0]) {
                    console.warn('[ardb] check_if_kernel_yet: no register data, retrying step');
                    this.countSingleStepProfile();
                    this.miDebugger!.stepInstruction();
                    return;
                }
                const pc = parseAddr(regs[0].value ?? '');
                if (pc !== undefined && isKernelAddr(pc, this.kernelMemoryRanges)) {
                    this.showInfo('arrived at kernel. current addr: ' + pc.toString(16));
                    this.endSingleStepProfile();
                    this.osStateTransition(new OSEvent(OSEvents.AT_KERNEL));
                } else {
                    this.countSingleStepProfile();
                    this.miDebugger!.stepInstruction();
                }
            });
        }
        else if (action.type === DebuggerActions.check_if_user_yet) {
            this.showInfo('doing action: check_if_user_yet');
            // Read the sepc CSR instead of PC. On RISC-V GDB, stepi may not follow sret
            // into user space (it steps to the next instruction in memory). By reading sepc
            // we can determine the sret target address BEFORE sret actually executes.
            this.miDebugger.sendCommand('data-evaluate-expression "$sepc"').then(res => {
                const sepcStr = res.result('value') || '';
                const sepc = parseAddr(sepcStr);
                const isUser = sepc !== undefined && isUserAddr(sepc, this.userMemoryRanges);
                console.log(`[ardb] check_if_user_yet: sepc=${sepcStr}, isUser=${isUser}`);
                if (isUser) {
                    this.showInfo('sepc points to user space, switching group');
                    this.endSingleStepProfile();
                    this.osStateTransition(new OSEvent(OSEvents.AT_USER));
                } else {
                    // sepc not in user space yet — keep single-stepping
                    this.countSingleStepProfile();
                    this.miDebugger!.stepInstruction();
                }
            }).catch(() => {
                this.countSingleStepProfile();
                this.miDebugger!.stepInstruction();
            });
        }
        else if (action.type === DebuggerActions.check_if_kernel_to_user_border_yet) {
            this.showInfo('doing action: check_if_kernel_to_user_border_yet');
            const borders = this.breakpointGroups?.getCurrentBreakpointGroup()?.borders;
            this.miDebugger.getStack(0, 1, this.recentStopThreadId).then(v => {
                if (!v || v.length === 0 || !v[0]) {
                    console.warn('[ardb] check_if_kernel_to_user_border_yet: empty stack');
                    this.showInfo('[DIAG] check_if_kernel_to_user_border_yet: empty stack - NO FALLBACK');
                    return;
                }
                const filepath = v[0].file;
                const lineNumber = v[0].line;
                let matched = false;
                if (borders) {
                    for (const border of borders) {
                        if (this.matchesBorder({file: filepath, line: lineNumber, function: v[0].function}, border, 'kernel_to_user')) {
                            matched = true;
                            this.osStateTransition(new OSEvent(OSEvents.AT_KERNEL_TO_USER_BORDER));
                            break;
                        }
                    }
                }
                if (!matched) {
                    this.showInfo(`[DIAG] check_if_kernel_to_user_border_yet: NO MATCH at ${filepath}:${lineNumber} (${v[0].function}) - HANGING!`);
                    console.warn(`[ardb] check_if_kernel_to_user_border_yet: no border matched at ${filepath}:${lineNumber}`);
                }
            });
        }
        else if (action.type === DebuggerActions.check_if_user_to_kernel_border_yet) {
            this.showInfo('doing action: check_if_user_to_kernel_border_yet');
            // Check if PC is already in kernel space (common in StarryOS where the border
            // is placed at a kernel function like handle_syscall). If so, check border
            // and emit AT_KERNEL directly instead of going through single-step.
            this.miDebugger.getSomeRegisterValues([this.programCounterId]).then(regs => {
                const pc = parseAddr(regs?.[0]?.value ?? '');
                if (pc !== undefined && isKernelAddr(pc, this.kernelMemoryRanges)) {
                    // PC is already in kernel: check for user_to_kernel border in stack frame
                    this.miDebugger!.getStack(0, 1, this.recentStopThreadId).then(v => {
                        if (!v || v.length === 0 || !v[0]) {
                            this.sendUserStoppedEvent();
                            return;
                        }
                        const filepath = v[0].file;
                        const lineNumber = v[0].line;
                        const borders = this.breakpointGroups?.getCurrentBreakpointGroup()?.borders;
                        if (borders) {
                            for (const border of borders) {
                                if (this.matchesBorder({file: filepath, line: lineNumber, function: v[0].function}, border, 'user_to_kernel')) {
                                    this.pendingBreakpointNode = undefined;
                                    // PC was already in kernel (no single-step run happened);
                                    // clear any stale single-step profile context just in case.
                                    this.endSingleStepProfile();
                                    this.osStateTransition(new OSEvent(OSEvents.AT_KERNEL));
                                    return;
                                }
                            }
                        }
                        this.sendUserStoppedEvent();
                    });
                    return;
                }
                // PC is still in user space: check border and go through single-step
                const borders = this.breakpointGroups?.getCurrentBreakpointGroup()?.borders;
                this.miDebugger!.getStack(0, 1, this.recentStopThreadId).then(v => {
                    if (!v || v.length === 0 || !v[0]) {
                        this.sendUserStoppedEvent();
                        return;
                    }
                    const filepath = v[0].file;
                    const lineNumber = v[0].line;
                    if (borders) {
                        for (const border of borders) {
                            if (this.matchesBorder({file: filepath, line: lineNumber, function: v[0].function}, border, 'user_to_kernel')) {
                                this.pendingBreakpointNode = undefined;
                                this.osStateTransition(new OSEvent(OSEvents.AT_USER_TO_KERNEL_BORDER));
                                return;
                            }
                        }
                    }
                    this.sendUserStoppedEvent();
                });
            });
        }
        else if (action.type === DebuggerActions.start_consecutive_single_steps) {
            this.showInfo('doing action: start_consecutive_single_steps');
            this.beginSingleStepProfile();
            this.countSingleStepProfile();
            this.miDebugger.stepInstruction();
        }
        else if (action.type === DebuggerActions.try_get_next_breakpoint_group_name) {
            this.showInfo('doing action: try_get_next_breakpoint_group_name');
            this.miDebugger.getStack(0, 1, this.recentStopThreadId).then(v => {
                if (!v || v.length === 0 || !v[0]) {
                    console.warn('[ardb] try_get_next_breakpoint_group_name: empty stack');
                    return;
                }
                const filepath = v[0].file;
                const lineNumber = v[0].line;
                const currentGroup = this.breakpointGroups?.getCurrentBreakpointGroup();
                if (!currentGroup) return;
                for (const hook of currentGroup.hooks) {
                    this.currentHook = hook;
                    const hookFn = hook.breakpoint.function;
                    const matchedByFile = hook.breakpoint.file && filepath === hook.breakpoint.file && lineNumber === hook.breakpoint.line;
                    const matchedByFn = hookFn && v[0].function && v[0].function.includes(hookFn);
                    if (matchedByFile || matchedByFn) {
                        eval(hook.behavior)().then((hookResult: string) => {
                            this.breakpointGroups!.setNextBreakpointGroup(hookResult);
                            this.currentHook = undefined;
                            this.showInfo('finished action: try_get_next_breakpoint_group_name. Next breakpoint group is ' + hookResult);
                        });
                    }
                }
            });
        }
        else if (action.type === DebuggerActions.high_level_switch_breakpoint_group_to_low_level) {
            const highLevelName = this.breakpointGroups!.getCurrentBreakpointGroupName();
            this.breakpointGroups!.updateCurrentBreakpointGroup(this.breakpointGroups!.getNextBreakpointGroup(), true);
            this.breakpointGroups!.setNextBreakpointGroup(highLevelName);
        }
        else if (action.type === DebuggerActions.low_level_switch_breakpoint_group_to_high_level) {
            const lowLevelName = this.breakpointGroups!.getCurrentBreakpointGroupName();
            const highLevelName = this.breakpointGroups!.getNextBreakpointGroup();
            this.breakpointGroups!.updateCurrentBreakpointGroup(highLevelName, true);
            this.breakpointGroups!.setNextBreakpointGroup(lowLevelName);
        }
        else if (action.type === DebuggerActions.check_stop_in_kernel) {
            this.miDebugger.getStack(0, 1, this.recentStopThreadId).then(async v => {
                if (!v || v.length === 0 || !v[0]) {
                    this.sendUserStoppedEvent();
                    return;
                }
                const filepath = v[0].file;
                const lineNumber = v[0].line;
                const currentGroup = this.breakpointGroups?.getCurrentBreakpointGroup();
                if (!currentGroup) { this.sendUserStoppedEvent(); return; }

                for (const hook of currentGroup.hooks) {
                    const hookFn = hook.breakpoint.function;
                    const hookFile = hook.breakpoint.file;
                    const hookLine = hook.breakpoint.line;
                    const stackFunc = v[0].function;
                    const matchedByFile = hookFile && filepath === hookFile && lineNumber === hookLine;
                    const matchedByFn = hookFn && stackFunc && stackFunc.includes(hookFn);
                    if (matchedByFile || matchedByFn) {
                        try {
                            const hookResult = await eval(hook.behavior)();
                            this.breakpointGroups!.setNextBreakpointGroup(hookResult);
                            this.showInfo('hook matched, next group: ' + hookResult);
                        } catch (e: any) {
                            this.showInfo('hook eval failed: ' + (e?.message ?? e));
                            console.error('[ardb] hook eval failed:', e);
                        }
                        this.pendingBreakpointNode = undefined;
                        this.miDebugger!.continue();
                        return;
                    }
                }

                if (currentGroup.borders) {
                    for (const border of currentGroup.borders) {
                        if (this.matchesBorder({file: filepath, line: lineNumber, function: v[0].function}, border, 'kernel_to_user')) {
                            this.pendingBreakpointNode = undefined;
                            this.osStateTransition(new OSEvent(OSEvents.AT_KERNEL_TO_USER_BORDER));
                            return;
                        }
                    }
                }

                // Also check U→K borders: if a user_to_kernel border is hit
                // while still in kernel state, it means the kernel internally
                // called this function (e.g. during init). This is NOT a real
                // privilege transition — silently continue.
                const fn = v[0].function;
                if (fn && this.functionBorderNamesUtoK.some(name => fn.includes(name))) {
                    console.log(`[ardb] U→K border hit in kernel state (fn="${fn}") — internal call, continuing silently`);
                    this.pendingBreakpointNode = undefined;
                    this.miDebugger!.continue();
                    return;
                }

                this.sendUserStoppedEvent();
            });
        }
    }

    // -----------------------------------------------------------------------
    // Event helpers
    // -----------------------------------------------------------------------

    private getThreadId(node: MINode): number {
        const tid = node.record('thread-id');
        return tid ? parseInt(tid) : 1;
    }

    private handleBreakpointHit(node: MINode): void {
        const bkptno = parseInt(node.record('bkptno') || '0');
        const threadId = this.getThreadId(node);

        const entry = this.gdbBkptToDap.get(bkptno);
        const dapId = entry?.id;

        const event = new StoppedEvent('breakpoint', threadId);
        (event.body as any).hitBreakpointIds = dapId ? [dapId] : [];
        (event.body as any).allThreadsStopped = true;
        this.sendEvent(event);
    }

    private sendUserStoppedEvent(): void {
        if (this.pendingBreakpointNode) {
            this.handleBreakpointHit(this.pendingBreakpointNode);
            this.pendingBreakpointNode = undefined;
        } else {
            const event = new StoppedEvent('pause', this.recentStopThreadId);
            (event.body as any).allThreadsStopped = true;
            this.sendEvent(event);
        }
    }

    private handleBreakpointModified(node: MINode): void {
        const bkpt = node.record('bkpt');
        if (!bkpt) return;

        const gdbNumber = parseInt(MINode.valueOf(bkpt, "number") || '0');
        const entry = this.gdbBkptToDap.get(gdbNumber);
        if (!entry) return;

        const nowVerified = MINode.valueOf(bkpt, "pending") === undefined;
        const actualLine = parseInt(MINode.valueOf(bkpt, "line") || `${entry.line}`);
        entry.verified = nowVerified;
        entry.line = actualLine;

        const dbp = new Breakpoint(nowVerified, actualLine);
        dbp.setId(entry.id);
        const fullname = MINode.valueOf(bkpt, "fullname");
        if (fullname) {
            (dbp as any).source = new Source(MINode.valueOf(bkpt, "file") || '', fullname);
        }

        this.sendEvent(new BreakpointEvent('changed', dbp));
    }

    // -----------------------------------------------------------------------
    // Helper methods
    // -----------------------------------------------------------------------

    /** Send ardb-get-snapshot to GDB, then read the JSON result from disk. */
    private async getSnapshotFromGDB(): Promise<SnapshotData | undefined> {
        if (!this.miDebugger) return undefined;
        await this.miDebugger.sendCliCommand('ardb-get-snapshot');
        const snapshotPath = path.join(this.tempDir, 'ardb_snapshot.json');
        try {
            if (fs.existsSync(snapshotPath)) {
                const content = fs.readFileSync(snapshotPath, 'utf-8');
                const data = JSON.parse(content);
                if (data && Array.isArray(data.path)) {
                    // Classify each node's address space for kernel/user visual distinction
                    for (const node of data.path) {
                        const addr = parseAddr(node.addr);
                        if (addr !== undefined) {
                            if (isKernelAddr(addr, this.kernelMemoryRanges)) {
                                node.space = 'kernel';
                            } else if (isUserAddr(addr, this.userMemoryRanges)) {
                                node.space = 'user';
                            } else {
                                node.space = 'unknown';
                            }
                        } else {
                            node.space = 'unknown';
                        }
                    }
                    return data as SnapshotData;
                }
            }
        } catch {
            // ignore read/parse errors
        }
        return undefined;
    }

    /** Extract console stream output accumulated by MI2 sendCliCommand result */
    private getConsoleOutput(node: MINode): string {
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
        if (!node) return '';
        // The consoleOutput is stored in node via our patched sendCommand
        return (node as any)._consoleOutput || '';
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
        const stack = await this.miDebugger!.getStack(0, 200, threadId);
        const stackFrames: DebugProtocol.StackFrame[] = stack.map((f, i) => {
            const frameId = threadId * 10000 + parseInt(f.level as any || i);
            const sf = new StackFrame(
                frameId,
                f.function || '<unknown>',
                (f.file) ? new Source(f.fileName || '', f.file) : undefined,
                f.line || 0,
                0,
            );
            if (f.address) {
                sf.instructionPointerReference = f.address;
            }
            return sf;
        });

        response.body = { stackFrames, totalFrames: stackFrames.length };
        this.sendResponse(response);
    }

    private async handleScopeVariables(
        response: DebugProtocol.VariablesResponse,
        threadId: number,
        frameLevel: number,
        scopeKind: 'args' | 'locals',
    ): Promise<void> {
        await this.miDebugger!.sendCommand(`thread-select ${threadId}`);
        await this.miDebugger!.sendCommand(`stack-select-frame ${frameLevel}`);

        let miVars: any[] | undefined;

        if (scopeKind === 'args') {
            const record = await this.miDebugger!.sendCommand(`stack-list-arguments --all-values 0 0`);
            const stackArgs = record.result('stack-args');
            if (Array.isArray(stackArgs) && stackArgs.length > 0) {
                const frameEntry = MINode.valueOf(stackArgs[0], "@frame") || MINode.valueOf(stackArgs[0], "frame") || stackArgs[0];
                miVars = MINode.valueOf(frameEntry, "args") || frameEntry?.args;
            }
        } else {
            const record = await this.miDebugger!.sendCommand('stack-list-locals --all-values');
            miVars = record.result('locals');
        }

        const variables: DebugProtocol.Variable[] = [];

        if (Array.isArray(miVars)) {
            for (const v of miVars) {
                const name = MINode.valueOf(v, "name") || '';
                const value = MINode.valueOf(v, "value") || '';
                const type = MINode.valueOf(v, "type") || '';
                let variablesReference = 0;

                if (this.looksExpandable(type, value)) {
                    try {
                        const varObj = await this.miDebugger!.varCreate(threadId, frameLevel, name);
                        if (varObj.name) {
                            this.createdVarObjects.push(varObj.name);
                            if (varObj.isCompound()) {
                                const childRef = this.nextVarRef++;
                                this.varRefMap.set(childRef, { type: 'var', varName: varObj.name });
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
        const children = await this.miDebugger!.varListChildren(parentVarName);
        const variables: DebugProtocol.Variable[] = children.map(child => {
            let variablesReference = 0;
            if (child.isCompound()) {
                const childRef = this.nextVarRef++;
                this.varRefMap.set(childRef, { type: 'var', varName: child.name });
                variablesReference = childRef;
            }
            const v = new Variable(child.exp || child.name, child.value ?? '', variablesReference);
            (v as any).type = child.type;
            return v;
        });

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
            await this.miDebugger!.sendCommand(`var-delete ${name}`).catch(() => { });
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
