"""
Test call-site mnemonic coverage (x86 + RISC-V + AArch64) and install-time
filtering of direct calls.
Run inside GDB with a program that has symbols loaded:
  gdb -batch -ex "python import sys; sys.path.insert(0, '<repo>')" \
          -ex "source async_rust_debugger/__init__.py" \
          <binary> \
          -ex "source src/test/test_callsite_filter.py"
"""

import gdb
import async_rust_debugger.runtime_trace as rt


def test_mnemonic_regex_coverage():
    matches = (
        "call 0x1234", "callq *%rax", "callplt 0x100",
        "jal ra, 0x8020", "jalr ra, 16(a0)", "c.jalr a0",
        "bl 0x4000", "blr x30",
    )
    non_matches = ("ret", "c.jr ra", "jalr zero, 0(ra)")
    ok = True
    for s in matches:
        if not rt.CALL_MNEMONIC_RE.match(s):
            gdb.write(f"  FAIL: should match: {s!r}\n")
            ok = False
    for s in non_matches:
        if rt.CALL_MNEMONIC_RE.match(s):
            gdb.write(f"  FAIL: should NOT match: {s!r}\n")
            ok = False
    if ok:
        gdb.write("  OK: mnemonic regex coverage\n")
    return ok


def test_direct_call_target():
    try:
        f = rt._direct_call_target_from_asm
    except AttributeError as e:
        gdb.write(f"  FAIL: _direct_call_target_from_asm missing: {e}\n")
        return False
    ok = (
        f("call 0x402030") == 0x402030
        and f("jal ra, 0x10514") == 0x10514
        and f("call *%rax") is None
        and f("jalr ra, 16(a0)") is None
    )
    if ok:
        gdb.write("  OK: direct call target extraction\n")
    else:
        gdb.write("  FAIL: direct call target extraction\n")
    return ok


def test_should_install_callsite_paths():
    try:
        f = rt._should_install_callsite
    except AttributeError as e:
        gdb.write(f"  FAIL: _should_install_callsite missing: {e}\n")
        return False

    addr = None
    sym = None
    for candidate in ("minimal::main", "main"):
        a = rt._try_addr_by_info_address(candidate)
        if a is not None:
            addr, sym = a, candidate
            break
    if addr is None:
        gdb.write("  SKIP: no resolvable symbol in this inferior\n")
        return True

    # 白名单启用 + 地址表就绪：地址命中 → True
    rt._WHITELIST_EXACT = {sym}
    rt._WHITELIST_PREFIX = []
    rt._WHITELIST_ADDR_READY = True
    rt._WHITELIST_ADDR_MAP = {addr: sym}
    ok1 = f(addr) is True

    # 地址未命中 + 名字兜底命中（map 里没有，EXACT 里有）→ True
    rt._WHITELIST_ADDR_MAP = {0x100000: "other::fn"}
    ok2 = f(addr) is True

    # 地址与名字都未命中 → False
    rt._WHITELIST_ADDR_MAP = {}
    ok3 = f(0x1) is False

    # 无白名单：普通名字 → False
    rt._WHITELIST_EXACT = None
    rt._WHITELIST_PREFIX = None
    rt._WHITELIST_ADDR_READY = False
    rt._WHITELIST_ADDR_MAP = {}
    ok4 = f(addr) is False

    # 无白名单：poll-ish 名字 → True（找 ::poll 符号；注意 async_fn 的地址
    # 在 info symbol 里显示为 {{closure}}，不是 poll-ish，勿用它做例证）
    ok5 = True
    poll_addr = rt._try_addr_by_info_address("minimal::{impl#0}::poll")
    if poll_addr is not None:
        ok5 = f(poll_addr) is True
    else:
        gdb.write("  (note: no poll-ish symbol found, ok5 skipped)\n")

    ok = ok1 and ok2 and ok3 and ok4 and ok5
    if ok:
        gdb.write("  OK: should-install paths (addr hit / name fallback / no-whitelist poll-ish)\n")
    else:
        gdb.write(f"  FAIL: ok1={ok1} ok2={ok2} ok3={ok3} ok4={ok4} ok5={ok5}\n")
    return ok


def _ensure_running():
    """让程序跑到 main（PIE 重定位应用后，地址→名字查询才可用）。
    真实场景中安装时过滤发生在 poll 命中时，程序必然在运行。"""
    try:
        if gdb.selected_inferior().pid != 0:
            return True
    except Exception:
        pass
    try:
        gdb.execute("break minimal::main")
        gdb.execute("run")
        return True
    except Exception as e:
        gdb.write(f"  (cannot start inferior: {e}; address lookups may fail)\n")
        return False


def main():
    gdb.write("[test] callsite filter\n")
    _ensure_running()
    results = [
        ("mnemonic_regex_coverage", test_mnemonic_regex_coverage()),
        ("direct_call_target", test_direct_call_target()),
        ("should_install_callsite_paths", test_should_install_callsite_paths()),
    ]
    passed = sum(1 for _, ok in results if ok)
    failed = sum(1 for _, ok in results if not ok)
    gdb.write(
        f"\n[test] callsite_filter: {passed} passed, {failed} failed,"
        f" {len(results)} total\n"
    )


main()
