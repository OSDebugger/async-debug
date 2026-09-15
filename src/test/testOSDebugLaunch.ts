/** Real launch/attach handlers and event wiring, mocked MI transport; no GDB/QEMU. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GDBDebugSession } from '../gdbDebugSession';
import { MI2 } from '../backend/mi2';
import { OSStates } from '../OSStateMachine';

async function main(): Promise<void> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ard-oslaunch-'));
    const connections: any[][] = [];
    const loads: any[][] = [];
    const proto: any = MI2.prototype;
    const oldConnect = proto.connect;
    const oldLoad = proto.load;
    proto.connect = async function (...args: any[]) { connections.push(args); return true; };
    proto.load = async function (...args: any[]) { loads.push(args); return true; };
    let checks = 0;
    const tick = () => new Promise(resolve => setImmediate(resolve));
    function makeSession() {
        const s: any = new GDBDebugSession({ pythonPath: '', tempDir });
        s.events = [];
        s.errors = [];
        s.terminals = [];
        s.sendEvent = (e: any) => s.events.push(e);
        s.sendResponse = () => {};
        s.sendErrorResponse = (...args: any[]) => s.errors.push(args);
        s.runInTerminalRequest = (args: any, _timeout: any, done: any) => {
            s.terminals.push(args);
            done({ success: true });
        };
        return s;
    }
    const base = { program: '/frozen/starryos.elf', cwd: '/target/workspace',
        remote: 'localhost:3333', gdbPath: '/usr/bin/gdb-multiarch' };
    const config = {
        program_counter_id: 32,
        kernel_memory_ranges: [['0xffffffff80000000', '0xffffffff8041106e']],
        user_memory_ranges: [['0x1000', '0x4000000000']],
        first_breakpoint_group: 'kernel', second_breakpoint_group: 'user',
        border_breakpoints: [{ filepath: '/src/uspace.rs', line: 100 },
                             { filepath: '/src/syscall/mod.rs', line: 45 }],
        filePathToBreakpointGroupNames: { functionArguments: 'filepath',
            functionBody: 'return filepath.endsWith("/syscall/mod.rs") ? ["user"] : ["kernel"];', isAsync: false },
        breakpointGroupNameToDebugFilePaths: { functionArguments: 'groupName', functionBody: 'return [];', isAsync: false },
    };
    function assertConfig(s: any) {
        assert.equal(s.osState.status, OSStates.kernel);
        assert.equal(s.programCounterId, 32);
        assert.deepStrictEqual(s.kernelMemoryRanges, config.kernel_memory_ranges);
        assert.deepStrictEqual(s.userMemoryRanges, config.user_memory_ranges);
        assert.equal(s.breakpointGroups.getCurrentBreakpointGroupName(), 'kernel');
        assert.equal(s.breakpointGroups.getNextBreakpointGroup(), 'user');
        const kernelBorders = s.breakpointGroups.getBreakpointGroupByName('kernel').borders;
        assert.equal(kernelBorders.length, 1);
        assert.equal(kernelBorders[0].filepath, '/src/uspace.rs');
        assert.equal(kernelBorders[0].line, 100);
        assert.equal(s.breakpointGroups.getBreakpointGroupByName('user').borders[0].filepath, '/src/syscall/mod.rs');
        assert.equal(s.cachedFilePathToGroupNames('/src/syscall/mod.rs')[0], 'user');
    }
    try {
        for (const flag of [undefined, false, true]) {
            const s = makeSession();
            s.launchRequest({}, { ...base, ...config, ...(flag === undefined ? {} : { enableOsDebug: flag }) });
            assert.equal(s.errors.length, 0);
            assert.equal(s.terminals.length, 0);
            assert.equal(s.miDebugger.application, base.gdbPath);
            assert.deepStrictEqual(connections.pop(), [base.cwd, base.program, base.remote, []]);
            assert.equal(s.osDebugReady, false, 'wait for debug-ready');
            if (flag === true) assertConfig(s);
            else assert.equal(s.breakpointGroups, undefined);
            s.miDebugger.emit('debug-ready');
            await tick();
            assert.equal(s.osDebugReady, flag === true);
            assert.equal(s.inferiorStarted, true);
            checks++;
        }
        const local = makeSession();
        local.launchRequest({}, { program: '/local/app', cwd: '/local', args: ['hello'] });
        assert.equal(local.terminals.length, 0);
        assert.deepStrictEqual(loads.pop(), ['/local', '/local/app', 'hello']);
        local.miDebugger.emit('debug-ready');
        await tick();
        assert.equal(local.osDebugReady, false);
        checks++;

        const invalid = makeSession();
        invalid.launchRequest({}, { program: '/local/app', enableOsDebug: true });
        assert.equal(invalid.errors.length, 1);
        assert.equal(invalid.miDebugger, undefined);
        checks++;

        const attach = makeSession();
        attach.attachRequest({}, { ...config, cwd: base.cwd, target: base.remote,
            executable: base.program, gdbpath: base.gdbPath,
            qemuPath: '/mock/qemu', qemuArgs: ['-S'], autorun: ['echo ready'] });
        assertConfig(attach);
        assert.deepStrictEqual(attach.terminals[0].args, ['/mock/qemu', '-S']);
        await new Promise(resolve => setTimeout(resolve, 1100));
        assert.deepStrictEqual(connections.pop(), [base.cwd, base.program, base.remote, ['echo ready']]);
        assert.equal(attach.miDebugger.application, base.gdbPath);
        attach.miDebugger.emit('debug-ready');
        await tick();
        assert.equal(attach.osDebugReady, true);
        checks++;

        const badAttach = makeSession();
        badAttach.attachRequest({}, { cwd: base.cwd, target: base.remote, qemuPath: '/mock/qemu', qemuArgs: [] });
        assert.equal(badAttach.errors.length, 1);
        assert.equal(badAttach.terminals.length, 0);
        checks++;
        console.log(`OS-debug launch/attach: ${checks} scenarios PASS`);
    } finally {
        proto.connect = oldConnect;
        proto.load = oldLoad;
        fs.rmdirSync(tempDir);
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
