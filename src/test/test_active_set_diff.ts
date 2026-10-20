/**
 * Unit tests for active-set diff and program-to-group mapping.
 * Run with:  node out/test/test_active_set_diff.js
 */

import { computeActiveSetDiff, BreakpointGroups, IBreakpointGroupsSession, IDebuggerBackend } from '../breakpointGroups';
import { Breakpoint } from '../backend/backend';

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

function testComputeActiveSetDiff(): void {
    try {
        const d1 = computeActiveSetDiff(new Set(['a', 'b']), new Set(['b', 'c']));
        assertEq(d1.insert.sort(), ['c'], 'diff insert = newly active');
        assertEq(d1.remove.sort(), ['a'], 'diff remove = newly inactive');

        const d2 = computeActiveSetDiff(new Set(), new Set());
        assertEq(d2, { insert: [], remove: [] }, 'empty diff');
    } catch (e: any) {
        console.error(`FAIL: computeActiveSetDiff missing: ${e.message}`);
        failed++;
    }
}

function testProgramToGroupDefaultIdentity(): void {
    const backend: IDebuggerBackend = {
        clearBreakPoints: (_s?: string) => Promise.resolve(),
        addBreakPoint: (_b: Breakpoint) => Promise.resolve([true, { ..._b, id: 1 }]),
        addSymbolFile: (_f: string, _a?: string) => Promise.resolve(true),
        removeSymbolFile: (_f: string) => Promise.resolve(true),
        continue: () => Promise.resolve(true),
        sendCliCommand: (_c: string) => Promise.resolve(),
        sendCommand: (_c: string) => Promise.resolve(),
    };
    const session: IBreakpointGroupsSession = {
        miDebugger: backend,
        filePathToBreakpointGroupNames: '(function(fp) { return ["kernel"]; })',
        breakpointGroupNameToDebugFilePaths: '(function(gn) { return []; })',
        showInformationMessage: (_m: string) => {},
        onBreakpointsRestored: (_r: Array<[boolean, Breakpoint]>) => {},
    };
    const groups = new BreakpointGroups('kernel', session, 'user');
    assert(groups.programToGroupName('pipetest') === 'pipetest', 'program→group defaults to identity');
    assert(groups.programToGroupName('kernel') === 'kernel', 'kernel maps to itself');
}

async function main(): Promise<void> {
    console.log('[test] active set diff');
    testComputeActiveSetDiff();
    testProgramToGroupDefaultIdentity();
    console.log(`[test] active_set_diff: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    if (failed > 0) { process.exit(1); }
}

main();
