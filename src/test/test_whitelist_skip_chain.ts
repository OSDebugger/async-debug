/**
 * Unit tests for the whitelist-rebuild skip logic (breakpointGroups 5.5 step).
 * Tests: firstEnter/dirty/restoreOk branching, success-flag gating of
 *        markWhitelistGroupInitialized / clearWhitelistDirty.
 * Run with:  node out/test/test_whitelist_skip_chain.js
 */

import {
    BreakpointGroups,
    IBreakpointGroupsSession,
    IDebuggerBackend,
} from '../breakpointGroups';
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

// ---------------------------------------------------------------------------
// Mock backend（与 test_breakpointGroups_comprehensive.ts 相同的最小实现）
// ---------------------------------------------------------------------------
class MockBackend implements IDebuggerBackend {
    public cliCalls: string[] = [];
    public nextBpId = 100;

    clearBreakPoints(_source?: string): Promise<any> { return Promise.resolve(); }
    addBreakPoint(bp: Breakpoint): Promise<[boolean, Breakpoint]> {
        const id = this.nextBpId++;
        return Promise.resolve([true, { ...bp, id }]);
    }
    addSymbolFile(_filepath: string, _textAddr?: string): Promise<any> { return Promise.resolve(true); }
    removeSymbolFile(_filepath: string): Promise<any> { return Promise.resolve(true); }
    continue(_reverse?: boolean): Promise<boolean> { return Promise.resolve(true); }
    sendCliCommand(command: string): Promise<any> { this.cliCalls.push(command); return Promise.resolve(); }
    sendCommand(command: string): Promise<any> { this.cliCalls.push(command); return Promise.resolve(); }
}

// 可脚本化的 sendCliCommandAndGetOutput：按命令前缀返回预设输出
class ScriptedSession {
    public outputs: Array<[string, string]> = [];  // [命令前缀, 输出]
    public marked: string[] = [];
    public clearedDirty = 0;
    public initialized: Set<string> = new Set();
    public dirty = false;
    public session: IBreakpointGroupsSession;
    constructor(private backend: MockBackend) {
        const self = this;
        this.session = {
            miDebugger: backend,
            filePathToBreakpointGroupNames: '(function(fp) { return ["kernel"]; })',
            breakpointGroupNameToDebugFilePaths: '(function(gn) { if (gn === "kernel") return ["kernel.elf"]; return ["user.elf"]; })',
            showInformationMessage: (_msg: string) => {},
            onBreakpointsRestored: (_results: Array<[boolean, Breakpoint]>) => {},
            getWhitelistEnabledCrates: () => [],
            getWhitelistInitializedGroups: () => self.initialized,
            markWhitelistGroupInitialized: (g: string) => { self.marked.push(g); self.initialized.add(g); },
            isWhitelistDirty: () => self.dirty,
            clearWhitelistDirty: () => { self.clearedDirty++; self.dirty = false; },
            sendCliCommandAndGetOutput: (cmd: string): Promise<string> => {
                backend.cliCalls.push(cmd);
                for (const [prefix, out] of self.outputs) {
                    if (cmd.startsWith(prefix)) { return Promise.resolve(out); }
                }
                return Promise.resolve('');
            },
        };
    }
}

function defaultOutputs(): Array<[string, string]> {
    return [
        ['ardb-restore-trace-state', '[ARD] restored trace state'],
        ['ardb-gen-whitelist', '[ARD] wrote grouped whitelist:'],
        ['ardb-update-whitelist', '[ARD] whitelist updated:'],
        ['ardb-load-whitelist', '[ARD] whitelist loaded:'],
        ['ardb-trace-user-crate', '[ARD] trace-user-crate x: 1 async symbols traced'],
    ];
}

async function switchAndWait(groups: BreakpointGroups, to: string): Promise<void> {
    groups.updateCurrentBreakpointGroup(to, false);
    await new Promise(r => setTimeout(r, 50));
}

async function testSkipChainWhenInitializedCleanAndRestored(): Promise<void> {
    const backend = new MockBackend();
    const s = new ScriptedSession(backend);
    s.initialized.add('user');
    s.outputs = defaultOutputs();
    const groups = new BreakpointGroups('kernel', s.session, 'user');
    await switchAndWait(groups, 'user');

    assert(!backend.cliCalls.some(c => c.startsWith('ardb-gen-whitelist')), 'skip: no gen on clean switch');
    assert(!backend.cliCalls.some(c => c.startsWith('ardb-update-whitelist')), 'skip: no update on clean switch');
    assert(!backend.cliCalls.some(c => c.startsWith('ardb-trace-user-crate')), 'skip: no trace-user-crate on clean switch');
}

async function testChainRunsAndMarksOnFirstEnter(): Promise<void> {
    const backend = new MockBackend();
    const s = new ScriptedSession(backend);
    s.outputs = defaultOutputs();
    const groups = new BreakpointGroups('kernel', s.session, 'user');
    await switchAndWait(groups, 'user');

    assert(backend.cliCalls.some(c => c.startsWith('ardb-gen-whitelist')), 'first enter: gen runs');
    assert(backend.cliCalls.some(c => c.startsWith('ardb-update-whitelist')), 'first enter: update runs');
    assert(backend.cliCalls.some(c => c.startsWith('ardb-trace-user-crate')), 'first enter: trace-user-crate runs');
    assertEq(s.marked, ['user'], 'first enter: group marked initialized');
}

async function testNoMarkWhenFlagsMissing(): Promise<void> {
    const backend = new MockBackend();
    const s = new ScriptedSession(backend);
    s.outputs = [];  // 全部输出为空 → 无任何成功标志
    const groups = new BreakpointGroups('kernel', s.session, 'user');
    await switchAndWait(groups, 'user');

    assertEq(s.marked, [], 'flags missing: group NOT marked');
}

async function testDirtyRunsUpdateWithoutGenAndClearsDirty(): Promise<void> {
    const backend = new MockBackend();
    const s = new ScriptedSession(backend);
    s.initialized.add('user');
    s.dirty = true;
    s.outputs = defaultOutputs();
    const groups = new BreakpointGroups('kernel', s.session, 'user');
    await switchAndWait(groups, 'user');

    assert(!backend.cliCalls.some(c => c.startsWith('ardb-gen-whitelist')), 'dirty: no gen');
    assert(backend.cliCalls.some(c => c.startsWith('ardb-update-whitelist')), 'dirty: update runs');
    assert(backend.cliCalls.some(c => c.startsWith('ardb-trace-user-crate')), 'dirty: trace-user-crate runs');
    assertEq(s.clearedDirty, 1, 'dirty cleared after successful chain');
    assertEq(s.dirty, false, 'dirty flag false after clear');
}

async function testRestoreFailureSelfHealsByRunningChain(): Promise<void> {
    const backend = new MockBackend();
    const s = new ScriptedSession(backend);
    s.initialized.add('user');
    s.outputs = defaultOutputs().filter(([p]) => !p.startsWith('ardb-restore-trace-state'));
    s.outputs.push(['ardb-restore-trace-state', '[ARD] no saved trace state']);
    const groups = new BreakpointGroups('kernel', s.session, 'user');
    await switchAndWait(groups, 'user');

    // 自愈不依赖 gen（grouped JSON 缓存仍在盘上），update/load/trace 即可
    assert(!backend.cliCalls.some(c => c.startsWith('ardb-gen-whitelist')), 'restore failed: no gen (firstEnter=false)');
    assert(backend.cliCalls.some(c => c.startsWith('ardb-update-whitelist')), 'restore failed: update self-heals');
    assert(backend.cliCalls.some(c => c.startsWith('ardb-trace-user-crate')), 'restore failed: trace-user-crate self-heals');
}

async function main(): Promise<void> {
    console.log('[test] whitelist skip chain');
    await testSkipChainWhenInitializedCleanAndRestored();
    await testChainRunsAndMarksOnFirstEnter();
    await testNoMarkWhenFlagsMissing();
    await testDirtyRunsUpdateWithoutGenAndClearsDirty();
    await testRestoreFailureSelfHealsByRunningChain();
    console.log(`[test] whitelist_skip_chain: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    if (failed > 0) { process.exit(1); }
}

main();
