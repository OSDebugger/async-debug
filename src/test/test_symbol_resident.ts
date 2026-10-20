/**
 * Unit tests for symbol-file residency: removeSymbolFile never called,
 * addSymbolFile at most once per file.
 * Run with:  node out/test/test_symbol_resident.js
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

class MockBackend implements IDebuggerBackend {
    public cliCalls: string[] = [];
    public addedSymbolFiles: string[] = [];
    public removedSymbolFiles: string[] = [];
    public nextBpId = 100;

    clearBreakPoints(_source?: string): Promise<any> { return Promise.resolve(); }
    addBreakPoint(bp: Breakpoint): Promise<[boolean, Breakpoint]> {
        const id = this.nextBpId++;
        return Promise.resolve([true, { ...bp, id }]);
    }
    addSymbolFile(filepath: string, _textAddr?: string): Promise<any> {
        this.addedSymbolFiles.push(filepath);
        return Promise.resolve(true);
    }
    removeSymbolFile(filepath: string): Promise<any> {
        this.removedSymbolFiles.push(filepath);
        return Promise.resolve(true);
    }
    continue(_reverse?: boolean): Promise<boolean> { return Promise.resolve(true); }
    sendCliCommand(command: string): Promise<any> { this.cliCalls.push(command); return Promise.resolve(); }
    sendCommand(command: string): Promise<any> { this.cliCalls.push(command); return Promise.resolve(); }
}

class ScriptedSession {
    public initialized: Set<string> = new Set(['kernel', 'user']);
    public session: IBreakpointGroupsSession;
    constructor(private backend: MockBackend) {
        const self = this;
        this.session = {
            miDebugger: backend,
            filePathToBreakpointGroupNames: '(function(fp) { return ["kernel"]; })',
            breakpointGroupNameToDebugFilePaths: '(function(gn) { if (gn === "kernel") return []; return ["user.elf"]; })',
            showInformationMessage: (_msg: string) => {},
            onBreakpointsRestored: (_results: Array<[boolean, Breakpoint]>) => {},
            getWhitelistEnabledCrates: () => [],
            getWhitelistInitializedGroups: () => self.initialized,
            markWhitelistGroupInitialized: (_g: string) => {},
            isWhitelistDirty: () => false,
            clearWhitelistDirty: () => {},
            sendCliCommandAndGetOutput: (cmd: string): Promise<string> => {
                backend.cliCalls.push(cmd);
                return Promise.resolve('[ARD] restored trace state');
            },
        };
    }
}

async function switchAndWait(groups: BreakpointGroups, to: string): Promise<void> {
    groups.updateCurrentBreakpointGroup(to, false);
    await new Promise(r => setTimeout(r, 50));
}

async function testNoSymbolRemoveEver(): Promise<void> {
    const backend = new MockBackend();
    const s = new ScriptedSession(backend);
    const groups = new BreakpointGroups('kernel', s.session, 'user');

    await switchAndWait(groups, 'user');   // kernel → user
    await switchAndWait(groups, 'kernel'); // user → kernel
    await switchAndWait(groups, 'user');   // kernel → user（第二次）

    assertEq(backend.removedSymbolFiles, [], 'removeSymbolFile never called');
}

async function testAddSymbolFileAtMostOnce(): Promise<void> {
    const backend = new MockBackend();
    const s = new ScriptedSession(backend);
    const groups = new BreakpointGroups('kernel', s.session, 'user');

    await switchAndWait(groups, 'user');
    await switchAndWait(groups, 'kernel');
    await switchAndWait(groups, 'user');   // 第二次切回 user

    const userAdds = backend.addedSymbolFiles.filter(f => f === 'user.elf');
    assertEq(userAdds.length, 1, 'user.elf added exactly once (first load only)');
}

async function main(): Promise<void> {
    console.log('[test] symbol resident');
    await testNoSymbolRemoveEver();
    await testAddSymbolFileAtMostOnce();
    console.log(`[test] symbol_resident: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    if (failed > 0) { process.exit(1); }
}

main();
