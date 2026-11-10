/**
 * 审查修复(Important 2):stopAtConnect 此前是死字段——接口/schema/模板都有它,
 * 但没有任何消费点,connect 序列从不发 stop/interrupt。真板 attach 时内核正在
 * 运行,安装断点前必须先停住;用户 qemu 配置里"干净停靠"其实来自 qemuArgs 的
 * -S,与 stopAtConnect 无关。
 *
 * 修复 = attach 配置 stopAtConnect:true 时,GDB connect 完成后发 -exec-interrupt
 * 暂停远程目标;目标本就停止(如 QEMU -S)时报错被吞掉(容错,不改 qemu 路径行为)。
 *
 * 断言A(helper 行为):
 *   A1 stopAtConnect:true  → interrupt 恰一次
 *   A2 stopAtConnect 缺省  → interrupt 零次
 *   A3 interrupt 拒绝(目标已停止)→ helper 正常 resolve,不抛异常
 * 断言B(接线):走真实 attachRequest → launchGDB 路径(注入 FakeMI2):
 *   B1 attach({stopAtConnect:true})  → connect 后 interrupt 恰一次
 *   B2 attach(无 stopAtConnect)      → interrupt 零次
 *
 * Run with:  node out/test/testStopAtConnect.js
 */

import { GDBDebugSession, AttachRequestArguments } from '../gdbDebugSession';
import { DebugProtocol } from '@vscode/debugprotocol';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { passed++; }
    else { failed++; console.error(`FAIL: ${message}`); }
}

// ---------------------------------------------------------------------------
// Fake MI2 — 记录命令副作用,绝不 spawn 任何进程
// ---------------------------------------------------------------------------

class FakeMI2 {
    constructor(private owner: StopAtConnectSession) {}

    private handlers: { [ev: string]: (...a: any[]) => void } = {};

    on(ev: string, cb: (...a: any[]) => void): void { this.handlers[ev] = cb; }

    connect(..._args: any[]): Promise<void> {
        // 模拟 MI2.connect:连接成功后先 emit debug-ready 再 resolve
        const ready = this.handlers['debug-ready'];
        if (ready) { Promise.resolve().then(() => ready()); }
        return Promise.resolve();
    }

    sendCliCommand(..._args: any[]): Promise<any> { return Promise.resolve(); }
    addBreakPoint(..._args: any[]): Promise<[boolean, any]> { return Promise.resolve([false, undefined]); }

    interrupt(): Promise<boolean> {
        this.owner.interrupts++;
        if (this.owner.interruptReject) {
            return Promise.reject(new Error('The program is not being run.'));
        }
        return Promise.resolve(true);
    }
}

// ---------------------------------------------------------------------------
// Recording subclass — 注入 FakeMI2,记录 DAP 副作用
// ---------------------------------------------------------------------------

class StopAtConnectSession extends GDBDebugSession {
    public interrupts = 0;
    public interruptReject = false;
    public successResponses = 0;
    public events: any[] = [];

    public attach(args: AttachRequestArguments): void {
        this.attachRequest({} as DebugProtocol.AttachResponse, args);
    }

    protected sendErrorResponse(_response: DebugProtocol.Response, _codeOrMessage?: number | DebugProtocol.Message): void {
        // 记录但静默
    }
    public sendResponse(_response: DebugProtocol.Response): void { this.successResponses++; }
    public sendEvent(event: any): void { this.events.push(event); }

    /** 注入缝:launchGDB 用 createMI2 构造 GDB 前端,测试换成 FakeMI2。 */
    protected createMI2(_gdbPath: string, _gdbArgs: string[], _debuggerArgs: string[], _env: any): any {
        return new FakeMI2(this);
    }

    /** helper 的测试缝(protected → 可测;方法未实现时静默跳过,让断言失败而非报错)。 */
    public haltForTest(mi: { interrupt(): Promise<boolean> }, cfg?: AttachRequestArguments): Promise<void> {
        const fn = (this as any).haltRemoteTargetOnConnect;
        return fn ? fn.call(this, mi, cfg) : Promise.resolve();
    }
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

async function runTests() {

// --- 断言A:helper 行为 ---
{
    const s = new StopAtConnectSession({ pythonPath: '/nonexistent', tempDir: '/tmp/ardb-test-stopconnect' });
    assert(typeof (s as any).haltRemoteTargetOnConnect === 'function',
        'A0: haltRemoteTargetOnConnect 已实现(未实现则后续调用被跳过)');

    // A1: stopAtConnect:true → interrupt 一次
    let calls = 0;
    await s.haltForTest({ interrupt: async () => { calls++; return true; } },
        { target: 't', cwd: '/', stopAtConnect: true });
    assert(calls === 1, `A1: stopAtConnect:true 应 interrupt 一次(实际 ${calls})`);

    // A2: 缺省 → 零次
    calls = 0;
    await s.haltForTest({ interrupt: async () => { calls++; return true; } },
        { target: 't', cwd: '/' });
    assert(calls === 0, `A2: 无 stopAtConnect 不应 interrupt(实际 ${calls})`);

    // A3: interrupt 拒绝 → 不抛异常
    let resolved = false;
    try {
        await s.haltForTest({ interrupt: async () => { throw new Error('not running'); } },
            { target: 't', cwd: '/', stopAtConnect: true });
        resolved = true;
    } catch { resolved = false; }
    assert(resolved, 'A3: interrupt 报错(目标已停止)时 helper 应吞掉并正常 resolve');
}

// --- 断言B:接线(attach → launchGDB → connect → halt)---
{
    const s = new StopAtConnectSession({ pythonPath: '/nonexistent', tempDir: '/tmp/ardb-test-stopconnect' });
    s.attach({ target: 'localhost:3333', cwd: '/tmp', stopAtConnect: true });
    await new Promise(r => setTimeout(r, 50));

    assert(s.interrupts === 1, `B1: attach(stopAtConnect:true) 应经 launchGDB 在 connect 后 interrupt 一次(实际 ${s.interrupts})`);
    assert(s.successResponses >= 1, 'B1: attach 成功响应已发送');
}
{
    const s = new StopAtConnectSession({ pythonPath: '/nonexistent', tempDir: '/tmp/ardb-test-stopconnect' });
    s.attach({ target: 'localhost:3333', cwd: '/tmp' });
    await new Promise(r => setTimeout(r, 50));

    assert(s.interrupts === 0, `B2: attach 无 stopAtConnect 不应 interrupt(实际 ${s.interrupts})`);
}

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) { process.exit(1); }

}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
