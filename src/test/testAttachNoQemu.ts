/**
 * Task 2: attach 时 QEMU 启动可选化。
 *
 * 断言①:config 不含 qemuPath/qemuArgs → attachRequest 不报错、不拉 QEMU 终端、
 *        直接 launchGDB(config)(连外部远程桩,如 OpenOCD localhost:3333)。
 * 断言②:config 含 qemuPath+qemuArgs → 行为与改动前一致:拉 QEMU 终端,
 *        不直接 launchGDB(由终端回调延迟 1s 后再调)。
 *
 * Run with:  node out/test/testAttachNoQemu.js
 */

import { GDBDebugSession, AttachRequestArguments } from '../gdbDebugSession';
import { DebugProtocol } from '@vscode/debugprotocol';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { passed++; }
    else { failed++; console.error(`FAIL: ${message}`); }
}

// ---------------------------------------------------------------------------
// Recording subclass — records DAP side effects, never spawns anything
// ---------------------------------------------------------------------------

class RecordingSession extends GDBDebugSession {
    public errorCodes: number[] = [];
    public successResponses = 0;
    public terminalRequests: Array<{ title: string; args: string[] }> = [];
    public launchGdbCalls = 0;
    public launchGdbConfig: AttachRequestArguments | undefined;

    /** 公开入口:protected attachRequest 的测试缝 */
    public attach(args: DebugProtocol.AttachRequestArguments): void {
        this.attachRequest({} as DebugProtocol.AttachResponse, args);
    }

    protected sendErrorResponse(response: DebugProtocol.Response, codeOrMessage?: number | DebugProtocol.Message, _format?: string, _variables?: any, _dest?: any): void {
        this.errorCodes.push(typeof codeOrMessage === 'number' ? codeOrMessage : -1);
    }
    public sendResponse(_response: DebugProtocol.Response): void {
        this.successResponses++;
    }
    public runInTerminalRequest(request: any, _timeout: number, _cb: any): void {
        this.terminalRequests.push({ title: request.title, args: request.args as string[] });
        // 故意不调用回调:断言②要观察"launchGDB 不是同步直接调用"
    }
    protected launchGDB(attachConfig?: AttachRequestArguments): void {
        this.launchGdbCalls++;
        this.launchGdbConfig = attachConfig;
    }
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

async function runTests() {

// --- 断言①:无 qemuPath/qemuArgs → 直接连远程桩 ---
{
    const s = new RecordingSession({
        pythonPath: '/nonexistent-python-path',
        tempDir: '/tmp/ardb-test-attach-noqemu',
    });
    const args: any = { target: 'localhost:3333', cwd: '/tmp' };
    s.attach(args);
    await new Promise(r => setTimeout(r, 10));

    assert(s.errorCodes.length === 0, '①: 不应调用 sendErrorResponse(当前代码会报 103)');
    assert(s.terminalRequests.length === 0, '①: 不应启动 QEMU 终端');
    assert(s.launchGdbCalls === 1, '①: 应直接调用 launchGDB 一次');
    assert(s.launchGdbConfig?.target === 'localhost:3333', '①: launchGDB 收到 attach 配置(target 透传)');
    assert(s.successResponses >= 1, '①: attach 成功响应已发送');
}

// --- 断言②:含 qemuPath+qemuArgs → 行为不变(拉终端,不直接 launchGDB)---
{
    const s = new RecordingSession({
        pythonPath: '/nonexistent-python-path',
        tempDir: '/tmp/ardb-test-attach-noqemu',
    });
    const args: any = {
        target: ':1234',
        cwd: '/tmp',
        qemuPath: '/usr/bin/qemu-system-riscv64',
        qemuArgs: ['-M', 'virt', '-s', '-S'],
    };
    s.attach(args);
    await new Promise(r => setTimeout(r, 10));

    assert(s.errorCodes.length === 0, '②: 不应报错');
    assert(s.terminalRequests.length === 1, '②: 应启动 QEMU 终端一次');
    assert(s.terminalRequests[0]?.args[0] === '/usr/bin/qemu-system-riscv64', '②: 终端参数含 QEMU 路径');
    assert(s.launchGdbCalls === 0, '②: 不应直接调用 launchGDB(由终端回调延迟触发)');
    assert(s.successResponses >= 1, '②: attach 成功响应已发送');
}

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) { process.exit(1); }

}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
