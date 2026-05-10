/**
 * Integration test for OS debug flow (doAction + osStateTransition).
 * Mocks the MI2 backend to verify that breakpoint hits in OS debug mode
 * produce the correct side effects (StoppedEvent, continue, stepInstruction, etc.)
 *
 * Run with:  node out/test/testOSDebugFlow.js
 */

import {
    OSStateMachine,
    OSState,
    OSEvent,
    OSStates,
    OSEvents,
    DebuggerActions,
    stateTransition,
    Action,
} from '../OSStateMachine';
import {
    BreakpointGroups,
    Border,
    HookBreakpointJSONFriendly,
    IBreakpointGroupsSession,
    IDebuggerBackend,
    toFunctionString,
} from '../breakpointGroups';
import { Breakpoint, Stack, RegisterValue } from '../backend/backend';
import { parseAddr, isKernelAddr, isUserAddr } from '../addrSpace';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { passed++; }
    else { failed++; console.error(`FAIL: ${message}`); }
}

function assertEq(actual: any, expected: any, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; }
    else { failed++; console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`); }
}

// ---------------------------------------------------------------------------
// Mock MI2 backend — records all calls for later assertion
// ---------------------------------------------------------------------------

type SideEffect =
    | { type: 'continue' }
    | { type: 'stepInstruction' }
    | { type: 'stoppedEvent'; reason: string }
    | { type: 'clearBreakPoints'; source: string }
    | { type: 'addBreakPoint'; file: string; line: number }
    | { type: 'addSymbolFile'; path: string }
    | { type: 'removeSymbolFile'; path: string };

class MockMI2 implements IDebuggerBackend {
    public calls: SideEffect[] = [];
    public stackResponse: Stack[] = [];
    public registerResponse: RegisterValue[] = [];

    async getStack(_start: number, _max: number, _thread: number): Promise<Stack[]> {
        return this.stackResponse;
    }
    async getSomeRegisterValues(_ids: number[]): Promise<RegisterValue[]> {
        return this.registerResponse;
    }
    continue(): Promise<boolean> {
        this.calls.push({ type: 'continue' });
        return Promise.resolve(true);
    }
    stepInstruction(): Promise<boolean> {
        this.calls.push({ type: 'stepInstruction' });
        return Promise.resolve(true);
    }
    clearBreakPoints(source?: string): Promise<any> {
        this.calls.push({ type: 'clearBreakPoints', source: source ?? '' });
        return Promise.resolve();
    }
    addBreakPoint(bp: Breakpoint): Promise<[boolean, Breakpoint]> {
        this.calls.push({ type: 'addBreakPoint', file: bp.file ?? '', line: bp.line ?? 0 });
        return Promise.resolve([true, { ...bp, id: 1 }]);
    }
    addSymbolFile(filepath: string, _textAddr?: string): Promise<any> {
        this.calls.push({ type: 'addSymbolFile', path: filepath });
        return Promise.resolve();
    }
    removeSymbolFile(filepath: string): Promise<any> {
        this.calls.push({ type: 'removeSymbolFile', path: filepath });
        return Promise.resolve();
    }
}

// ---------------------------------------------------------------------------
// Test harness — reproduces the doAction + osStateTransition logic from
// gdbDebugSession.ts so we can test it without VS Code runtime dependencies.
// ---------------------------------------------------------------------------

class OSDebugHarness {
    public osState: OSState;
    public mockMI2: MockMI2;
    public breakpointGroups: BreakpointGroups;
    public events: SideEffect[] = [];
    public kernelMemoryRanges: string[][] = [['0xffffffc000000000', '0xffffffffffffffff']];
    public userMemoryRanges: string[][] = [['0x0000000000000000', '0x0000004000000000']];
    public programCounterId = 32;
    public recentStopThreadId = 1;

    constructor() {
        this.osState = new OSState(OSStateMachine.initial);
        this.mockMI2 = new MockMI2();

        const self = this;
        const bpgSession: IBreakpointGroupsSession = {
            get miDebugger(): IDebuggerBackend { return self.mockMI2; },
            filePathToBreakpointGroupNames: '(function(filepath) { if (filepath.indexOf("/app/") !== -1) return ["user"]; return ["kernel"]; })',
            breakpointGroupNameToDebugFilePaths: '(function(groupName) { return []; })',
            showInformationMessage(_msg: string) {},
            onBreakpointsRestored(_results: Array<[boolean, Breakpoint]>) {},
        };
        this.breakpointGroups = new BreakpointGroups('kernel', bpgSession, 'user');
    }

    osStateTransition(event: OSEvent): void {
        let actions: Action[];
        [this.osState, actions] = stateTransition(OSStateMachine, this.osState, event);
        for (const action of actions) {
            this.doAction(action);
        }
    }

    // Mirrors gdbDebugSession.doAction — the code under test
    doAction(action: Action): void {
        if (action.type === DebuggerActions.check_stop_in_kernel) {
            this.mockMI2.getStack(0, 1, this.recentStopThreadId).then(async v => {
                if (!v || v.length === 0 || !v[0]) {
                    this.emitStoppedEvent('breakpoint');
                    return;
                }
                const filepath = v[0].file;
                const lineNumber = v[0].line;
                const currentGroup = this.breakpointGroups.getCurrentBreakpointGroup();
                if (!currentGroup) { this.emitStoppedEvent('breakpoint'); return; }

                for (const hook of currentGroup.hooks) {
                    if (filepath === hook.breakpoint.file && lineNumber === hook.breakpoint.line) {
                        try {
                            const hookResult = await eval(hook.behavior)();
                            this.breakpointGroups.setNextBreakpointGroup(hookResult);
                        } catch (e) { /* ignore in test */ }
                        this.mockMI2.continue();
                        return;
                    }
                }

                if (currentGroup.borders) {
                    for (const border of currentGroup.borders) {
                        if (filepath === border.filepath && lineNumber === border.line) {
                            this.osStateTransition(new OSEvent(OSEvents.AT_KERNEL_TO_USER_BORDER));
                            return;
                        }
                    }
                }

                this.emitStoppedEvent('breakpoint');
            });
        }
        else if (action.type === DebuggerActions.check_if_user_to_kernel_border_yet) {
            const borders = this.breakpointGroups.getCurrentBreakpointGroup()?.borders;
            this.mockMI2.getStack(0, 1, this.recentStopThreadId).then(v => {
                if (!v || v.length === 0 || !v[0]) {
                    this.emitStoppedEvent('breakpoint');
                    return;
                }
                const filepath = v[0].file;
                const lineNumber = v[0].line;
                if (borders) {
                    for (const border of borders) {
                        if (filepath === border.filepath && lineNumber === border.line) {
                            this.osStateTransition(new OSEvent(OSEvents.AT_USER_TO_KERNEL_BORDER));
                            return;
                        }
                    }
                }
                this.emitStoppedEvent('breakpoint');
            });
        }
        else if (action.type === DebuggerActions.check_if_user_yet) {
            this.mockMI2.getSomeRegisterValues([this.programCounterId]).then(regs => {
                if (!regs || regs.length === 0 || !regs[0]) return;
                const pc = parseAddr(regs[0].value ?? '');
                if (pc !== undefined && isUserAddr(pc, this.userMemoryRanges)) {
                    this.osStateTransition(new OSEvent(OSEvents.AT_USER));
                } else {
                    this.mockMI2.stepInstruction();
                }
            });
        }
        else if (action.type === DebuggerActions.check_if_kernel_yet) {
            this.mockMI2.getSomeRegisterValues([this.programCounterId]).then(regs => {
                if (!regs || regs.length === 0 || !regs[0]) return;
                const pc = parseAddr(regs[0].value ?? '');
                if (pc !== undefined && isKernelAddr(pc, this.kernelMemoryRanges)) {
                    this.osStateTransition(new OSEvent(OSEvents.AT_KERNEL));
                } else {
                    this.mockMI2.stepInstruction();
                }
            });
        }
        else if (action.type === DebuggerActions.start_consecutive_single_steps) {
            this.mockMI2.stepInstruction();
        }
        else if (action.type === DebuggerActions.low_level_switch_breakpoint_group_to_high_level) {
            const lowLevelName = this.breakpointGroups.getCurrentBreakpointGroupName();
            const highLevelName = this.breakpointGroups.getNextBreakpointGroup();
            this.breakpointGroups.updateCurrentBreakpointGroup(highLevelName, false);
            this.breakpointGroups.setNextBreakpointGroup(lowLevelName);
        }
        else if (action.type === DebuggerActions.high_level_switch_breakpoint_group_to_low_level) {
            const highLevelName = this.breakpointGroups.getCurrentBreakpointGroupName();
            this.breakpointGroups.updateCurrentBreakpointGroup(this.breakpointGroups.getNextBreakpointGroup(), false);
            this.breakpointGroups.setNextBreakpointGroup(highLevelName);
        }
    }

    emitStoppedEvent(reason: string): void {
        this.events.push({ type: 'stoppedEvent', reason });
    }

    reset(): void {
        this.mockMI2.calls = [];
        this.events = [];
    }
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

async function runTests() {

// --- Scenario 1: kernel state, user breakpoint hit (not border, not hook) ---
{
    const h = new OSDebugHarness();
    h.mockMI2.stackResponse = [{ level: 0, address: '0xffffffc000080000', function: 'some_kernel_fn', fileName: 'kernel.rs', file: '/src/kernel.rs', line: 42 }];
    // No borders or hooks registered → should be treated as user breakpoint
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assert(h.events.length === 1, 'S1: should emit one StoppedEvent');
    assertEq(h.events[0]?.type, 'stoppedEvent', 'S1: event type is stoppedEvent');
    assertEq(h.mockMI2.calls.length, 0, 'S1: no continue/step calls');
    assertEq(h.osState.status, OSStates.kernel, 'S1: stays in kernel state');
}

// --- Scenario 2: kernel state, hook breakpoint hit ---
{
    const h = new OSDebugHarness();
    // Register a hook at /src/trap.rs:100
    const hookBp: HookBreakpointJSONFriendly = {
        breakpoint: { file: '/src/trap.rs', line: 100, condition: '' },
        behavior: { body: 'return Promise.resolve("initproc")', args: [] },
    };
    h.breakpointGroups.updateHookBreakpoint(hookBp);

    h.mockMI2.stackResponse = [{ level: 0, address: '0xffffffc000090000', function: 'trap_handler', fileName: 'trap.rs', file: '/src/trap.rs', line: 100 }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assert(h.events.length === 0, 'S2: no StoppedEvent for hook breakpoint');
    assert(h.mockMI2.calls.some(c => c.type === 'continue'), 'S2: continue() called after hook');
    assertEq(h.breakpointGroups.getNextBreakpointGroup(), 'initproc', 'S2: nextBreakpointGroup set by hook');
    assertEq(h.osState.status, OSStates.kernel, 'S2: stays in kernel state');
}

// --- Scenario 3: kernel state, border breakpoint hit ---
{
    const h = new OSDebugHarness();
    // Register a border at /src/trap.rs:200
    h.breakpointGroups.updateBorder(new Border('/src/trap.rs', 200));

    h.mockMI2.stackResponse = [{ level: 0, address: '0xffffffc0000a0000', function: 'trap_return', fileName: 'trap.rs', file: '/src/trap.rs', line: 200 }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assert(h.events.length === 0, 'S3: no StoppedEvent for border breakpoint');
    assert(h.mockMI2.calls.some(c => c.type === 'stepInstruction'), 'S3: stepInstruction() called');
    assertEq(h.osState.status, OSStates.kernel_single_step_to_user, 'S3: state → kernel_single_step_to_user');
}

// --- Scenario 4: single-stepping, PC still in kernel ---
{
    const h = new OSDebugHarness();
    h.osState = new OSState(OSStates.kernel_single_step_to_user);
    // PC is still in kernel range
    h.mockMI2.registerResponse = [{ index: 32, value: '0xffffffc0000b0000' }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assert(h.mockMI2.calls.some(c => c.type === 'stepInstruction'), 'S4: stepInstruction() called again');
    assertEq(h.osState.status, OSStates.kernel_single_step_to_user, 'S4: stays in kernel_single_step_to_user');
    assert(h.events.length === 0, 'S4: no StoppedEvent during single-stepping');
}

// --- Scenario 5: single-stepping, PC arrives at user space ---
{
    const h = new OSDebugHarness();
    h.osState = new OSState(OSStates.kernel_single_step_to_user);
    // PC is now in user range
    h.mockMI2.registerResponse = [{ index: 32, value: '0x0000000010000000' }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assertEq(h.osState.status, OSStates.user, 'S5: state → user');
    assertEq(h.breakpointGroups.getCurrentBreakpointGroupName(), 'user', 'S5: breakpoint group switched to user');
}

// --- Scenario 6: user state, user breakpoint hit ---
{
    const h = new OSDebugHarness();
    h.osState = new OSState(OSStates.user);
    // Manually switch to user group so getCurrentBreakpointGroup works
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);

    h.mockMI2.stackResponse = [{ level: 0, address: '0x0000000010001000', function: 'user_main', fileName: 'main.rs', file: '/app/src/main.rs', line: 10 }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assert(h.events.length === 1, 'S6: should emit StoppedEvent for user breakpoint');
    assertEq(h.events[0]?.type, 'stoppedEvent', 'S6: event type is stoppedEvent');
    assertEq(h.osState.status, OSStates.user, 'S6: stays in user state');
}

// --- Scenario 7: user state, border breakpoint hit (user→kernel) ---
{
    const h = new OSDebugHarness();
    h.osState = new OSState(OSStates.user);
    h.breakpointGroups.updateCurrentBreakpointGroup('user', false);
    // Register a border in the user group
    h.breakpointGroups.updateBorder(new Border('/app/src/syscall.rs', 50));

    h.mockMI2.stackResponse = [{ level: 0, address: '0x0000000010002000', function: 'ecall', fileName: 'syscall.rs', file: '/app/src/syscall.rs', line: 50 }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));

    assert(h.events.length === 0, 'S7: no StoppedEvent for user→kernel border');
    assert(h.mockMI2.calls.some(c => c.type === 'stepInstruction'), 'S7: stepInstruction() called');
    assertEq(h.osState.status, OSStates.user_single_step_to_kernel, 'S7: state → user_single_step_to_kernel');
}

// --- Scenario 8: full cycle kernel → user → kernel ---
{
    const h = new OSDebugHarness();
    h.breakpointGroups.updateBorder(new Border('/src/trap.rs', 200));

    // Step 1: kernel STOPPED at border
    h.mockMI2.stackResponse = [{ level: 0, address: '0xffffffc0000a0000', function: 'trap_return', fileName: 'trap.rs', file: '/src/trap.rs', line: 200 }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));
    assertEq(h.osState.status, OSStates.kernel_single_step_to_user, 'S8a: entered single-step to user');

    // Step 2: single-step, still in kernel
    h.mockMI2.registerResponse = [{ index: 32, value: '0xffffffc0000a0004' }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));
    assertEq(h.osState.status, OSStates.kernel_single_step_to_user, 'S8b: still stepping');

    // Step 3: single-step, arrived at user
    h.mockMI2.registerResponse = [{ index: 32, value: '0x0000000010000000' }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));
    assertEq(h.osState.status, OSStates.user, 'S8c: arrived at user');

    // Step 4: user state, register a user→kernel border
    h.breakpointGroups.updateBorder(new Border('/app/src/syscall.rs', 50));
    h.mockMI2.stackResponse = [{ level: 0, address: '0x0000000010002000', function: 'ecall', fileName: 'syscall.rs', file: '/app/src/syscall.rs', line: 50 }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));
    assertEq(h.osState.status, OSStates.user_single_step_to_kernel, 'S8d: entered single-step to kernel');

    // Step 5: single-step, arrived at kernel
    h.mockMI2.registerResponse = [{ index: 32, value: '0xffffffc000080000' }];
    h.osStateTransition(new OSEvent(OSEvents.STOPPED));
    await new Promise(r => setTimeout(r, 10));
    assertEq(h.osState.status, OSStates.kernel, 'S8e: back to kernel');

    assert(h.events.length === 0, 'S8: no StoppedEvent during entire cycle (all transparent)');
}

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) { process.exit(1); }

}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
