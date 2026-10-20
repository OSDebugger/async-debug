"""
Test breakpoint program attribution and stop-side gating.
Run inside GDB with a program loaded (stopped at main so PC is in user range):
  gdb -batch -ex "python import sys; sys.path.insert(0, '<repo>')" \
          -ex "source async_rust_debugger/__init__.py" \
          <binary> -ex "break minimal::main" -ex run \
          -ex "source src/test/test_breakpoint_gating.py"
"""

import gdb
import async_rust_debugger.runtime_trace as rt


def test_breakpoint_allowed_pure():
    """纯逻辑：空归属（内核）= 放行；非空必须等于当前激活程序。"""
    try:
        f = rt._breakpoint_allowed
    except AttributeError as e:
        gdb.write(f"  FAIL: _breakpoint_allowed missing: {e}\n")
        return False
    rt._active_program = "prog_a"
    ok = (f("") is True
          and f("prog_a") is True
          and f("prog_b") is False)
    if ok:
        gdb.write("  OK: breakpoint allowed pure logic\n")
        return True
    gdb.write("  FAIL: allowed logic wrong\n")
    return False


def test_gate_blocks_cross_program_hit():
    """交叉命中：stop() 在门控处早退，零记录副作用。"""
    rt._PROGRAM_STATES.clear()
    rt._active_program = None
    rt._activate_program("user")          # 命中 vCPU 的 PC 在用户区间 → "user"
    co_before = dict(rt._CO_BY_KEY)
    tls_before = dict(rt._TLS_STACK)

    bp = rt.PollEntryBP("minimal::main", poll_sym="minimal::main",
                        internal=True, temporary=False, program="other_prog")
    result = bp.stop()

    ok = (result is False
          and rt._CO_BY_KEY == co_before
          and rt._TLS_STACK == tls_before)
    bp.delete()
    if ok:
        gdb.write("  OK: cross-program hit gated (early return, no recording)\n")
        return True
    gdb.write(f"  FAIL: result={result}, co={rt._CO_BY_KEY}, tls={rt._TLS_STACK}\n")
    return False


def test_breakpoint_stores_program():
    """PollEntryBP/CallSiteBP 构造时保存 program 归属。"""
    bp = rt.PollEntryBP("minimal::main", poll_sym="minimal::main",
                        internal=True, temporary=False, program="prog_x")
    ok1 = getattr(bp, "program", None) == "prog_x"
    bp.delete()
    cb = rt.CallSiteBP(0x1000, program="prog_x")
    ok2 = getattr(cb, "program", None) == "prog_x"
    cb.delete()
    if ok1 and ok2:
        gdb.write("  OK: breakpoints store program attribution\n")
        return True
    gdb.write(f"  FAIL: ok1={ok1} ok2={ok2}\n")
    return False


def main():
    gdb.write("[test] breakpoint gating\n")
    results = [
        ("breakpoint_allowed_pure", test_breakpoint_allowed_pure()),
        ("gate_blocks_cross_program_hit", test_gate_blocks_cross_program_hit()),
        ("breakpoint_stores_program", test_breakpoint_stores_program()),
    ]
    passed = sum(1 for _, ok in results if ok)
    failed = sum(1 for _, ok in results if not ok)
    gdb.write(
        f"\n[test] breakpoint_gating: {passed} passed, {failed} failed,"
        f" {len(results)} total\n"
    )


main()
