/**
 * Unit tests for OSStateMachine.
 * Run with:  node out/test/testOSStateMachine.js
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

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${message}`);
    }
}

function assertEq(actual: any, expected: any, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
    }
}

function assertActions(actions: Action[], expectedTypes: DebuggerActions[], label: string): void {
    const actualTypes = actions.map(a => a.type);
    assertEq(actualTypes, expectedTypes, label);
}

// Helper: run a single transition and return [newState, actions]
function transition(state: OSStates, event: OSEvents): [OSState, Action[]] {
    return stateTransition(OSStateMachine, new OSState(state), new OSEvent(event));
}

// ---------------------------------------------------------------------------
// stateTransition always returns an array (never undefined) — fix #5
// ---------------------------------------------------------------------------
{
    // AT_USER_TO_KERNEL_BORDER is not defined for kernel state → should return []
    const [, actions] = transition(OSStates.kernel, OSEvents.AT_USER_TO_KERNEL_BORDER);
    assert(Array.isArray(actions), 'actions is always an array (never undefined)');
    assertEq(actions.length, 0, 'undefined transition yields empty actions array');
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------
{
    assertEq(OSStateMachine.initial, OSStates.kernel, 'initial state is kernel');
}

// ---------------------------------------------------------------------------
// kernel state
// ---------------------------------------------------------------------------
{
    // STOPPED in kernel → stays in kernel, runs check_stop_in_kernel (unified action)
    const [next, actions] = transition(OSStates.kernel, OSEvents.STOPPED);
    assertEq(next.status, OSStates.kernel, 'kernel + STOPPED → stays kernel');
    assertActions(actions, [
        DebuggerActions.check_stop_in_kernel,
    ], 'kernel + STOPPED actions');
}
{
    // AT_KERNEL_TO_USER_BORDER → moves to kernel_single_step_to_user, starts single stepping
    const [next, actions] = transition(OSStates.kernel, OSEvents.AT_KERNEL_TO_USER_BORDER);
    assertEq(next.status, OSStates.kernel_single_step_to_user, 'kernel + AT_KERNEL_TO_USER_BORDER → kernel_single_step_to_user');
    assertActions(actions, [
        DebuggerActions.start_consecutive_single_steps,
    ], 'kernel + AT_KERNEL_TO_USER_BORDER actions');
}
{
    // AT_USER not defined for kernel → stays kernel, empty actions
    const [next, actions] = transition(OSStates.kernel, OSEvents.AT_USER);
    assertEq(next.status, OSStates.kernel, 'kernel + undefined event → stays kernel');
    assertEq(actions.length, 0, 'kernel + undefined event → empty actions');
}

// ---------------------------------------------------------------------------
// kernel_single_step_to_user state
// ---------------------------------------------------------------------------
{
    // STOPPED → stays, checks if arrived at user
    const [next, actions] = transition(OSStates.kernel_single_step_to_user, OSEvents.STOPPED);
    assertEq(next.status, OSStates.kernel_single_step_to_user, 'kernel_single_step_to_user + STOPPED → stays');
    assertActions(actions, [
        DebuggerActions.check_if_user_yet,
    ], 'kernel_single_step_to_user + STOPPED actions');
}
{
    // AT_USER → moves to user, switches breakpoint group to high level
    const [next, actions] = transition(OSStates.kernel_single_step_to_user, OSEvents.AT_USER);
    assertEq(next.status, OSStates.user, 'kernel_single_step_to_user + AT_USER → user');
    assertActions(actions, [
        DebuggerActions.low_level_switch_breakpoint_group_to_high_level,
    ], 'kernel_single_step_to_user + AT_USER actions');
}
{
    // AT_KERNEL not defined here → stays, empty actions
    const [next, actions] = transition(OSStates.kernel_single_step_to_user, OSEvents.AT_KERNEL);
    assertEq(next.status, OSStates.kernel_single_step_to_user, 'kernel_single_step_to_user + undefined event → stays');
    assertEq(actions.length, 0, 'kernel_single_step_to_user + undefined event → empty actions');
}

// ---------------------------------------------------------------------------
// user state
// ---------------------------------------------------------------------------
{
    // STOPPED → stays, checks if arrived at kernel border
    const [next, actions] = transition(OSStates.user, OSEvents.STOPPED);
    assertEq(next.status, OSStates.user, 'user + STOPPED → stays user');
    assertActions(actions, [
        DebuggerActions.check_if_user_to_kernel_border_yet,
    ], 'user + STOPPED actions');
}
{
    // AT_USER_TO_KERNEL_BORDER → moves to user_single_step_to_kernel, starts single stepping
    const [next, actions] = transition(OSStates.user, OSEvents.AT_USER_TO_KERNEL_BORDER);
    assertEq(next.status, OSStates.user_single_step_to_kernel, 'user + AT_USER_TO_KERNEL_BORDER → user_single_step_to_kernel');
    assertActions(actions, [
        DebuggerActions.start_consecutive_single_steps,
    ], 'user + AT_USER_TO_KERNEL_BORDER actions');
}
{
    // AT_KERNEL not defined for user → stays, empty actions
    const [next, actions] = transition(OSStates.user, OSEvents.AT_KERNEL);
    assertEq(next.status, OSStates.user, 'user + undefined event → stays user');
    assertEq(actions.length, 0, 'user + undefined event → empty actions');
}

// ---------------------------------------------------------------------------
// user_single_step_to_kernel state
// ---------------------------------------------------------------------------
{
    // STOPPED → stays, checks if arrived at kernel
    const [next, actions] = transition(OSStates.user_single_step_to_kernel, OSEvents.STOPPED);
    assertEq(next.status, OSStates.user_single_step_to_kernel, 'user_single_step_to_kernel + STOPPED → stays');
    assertActions(actions, [
        DebuggerActions.check_if_kernel_yet,
    ], 'user_single_step_to_kernel + STOPPED actions');
}
{
    // AT_KERNEL → moves back to kernel, switches breakpoint group to low level
    const [next, actions] = transition(OSStates.user_single_step_to_kernel, OSEvents.AT_KERNEL);
    assertEq(next.status, OSStates.kernel, 'user_single_step_to_kernel + AT_KERNEL → kernel');
    assertActions(actions, [
        DebuggerActions.high_level_switch_breakpoint_group_to_low_level,
    ], 'user_single_step_to_kernel + AT_KERNEL actions');
}
{
    // AT_USER not defined here → stays, empty actions
    const [next, actions] = transition(OSStates.user_single_step_to_kernel, OSEvents.AT_USER);
    assertEq(next.status, OSStates.user_single_step_to_kernel, 'user_single_step_to_kernel + undefined event → stays');
    assertEq(actions.length, 0, 'user_single_step_to_kernel + undefined event → empty actions');
}

// ---------------------------------------------------------------------------
// Full cycle: kernel → user → kernel
// ---------------------------------------------------------------------------
{
    let state = new OSState(OSStates.kernel);

    // kernel receives STOPPED → check border
    [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.STOPPED));
    assertEq(state.status, OSStates.kernel, 'cycle: kernel after STOPPED');

    // border detected → start single stepping
    [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.AT_KERNEL_TO_USER_BORDER));
    assertEq(state.status, OSStates.kernel_single_step_to_user, 'cycle: entered single-step to user');

    // a few STOPPED events while single-stepping (still not at user yet)
    for (let i = 0; i < 3; i++) {
        [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.STOPPED));
        assertEq(state.status, OSStates.kernel_single_step_to_user, `cycle: still single-stepping step ${i + 1}`);
    }

    // finally arrived at user space
    [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.AT_USER));
    assertEq(state.status, OSStates.user, 'cycle: arrived at user');

    // user receives STOPPED → check border
    [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.STOPPED));
    assertEq(state.status, OSStates.user, 'cycle: user after STOPPED');

    // border detected → single step back to kernel
    [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.AT_USER_TO_KERNEL_BORDER));
    assertEq(state.status, OSStates.user_single_step_to_kernel, 'cycle: entered single-step to kernel');

    // arrived at kernel
    [state] = stateTransition(OSStateMachine, state, new OSEvent(OSEvents.AT_KERNEL));
    assertEq(state.status, OSStates.kernel, 'cycle: back to kernel');
}

// ---------------------------------------------------------------------------
// stateTransition does not mutate the original state object
// ---------------------------------------------------------------------------
{
    const original = new OSState(OSStates.kernel);
    stateTransition(OSStateMachine, original, new OSEvent(OSEvents.AT_KERNEL_TO_USER_BORDER));
    assertEq(original.status, OSStates.kernel, 'original state is not mutated by transition');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
    process.exit(1);
}
