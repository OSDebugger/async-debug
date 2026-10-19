"""
Test callsite (CallSiteBP) save/restore across group switches, and
ardb-update-whitelist clearing of stale callsites.
Run inside GDB with a program that has symbols loaded:
  gdb -batch -ex "python import sys; sys.path.insert(0, '<repo>')" \
          -ex "source async_rust_debugger/__init__.py" \
          <binary> \
          -ex "source src/test/test_callsite_restore.py"
"""

import gdb
import os
import json
import async_rust_debugger.runtime_trace as rt


def _find_resolvable_symbol():
    for candidate in ("minimal::main", "main"):
        a = rt._try_addr_by_info_address(candidate)
        if a is not None:
            return a, candidate
    return None, None


def _callbps():
    return [bp for bp in rt._CREATED_BPS if isinstance(bp, rt.CallSiteBP)]


def test_callsite_addrs_recorded_and_restored():
    """save 记录 callsite 地址 → restore 按地址重装 CallSiteBP。"""
    addr, sym = _find_resolvable_symbol()
    if addr is None:
        gdb.write("  SKIP: no resolvable symbol in this inferior\n")
        return True

    rt._CALLSITE_ADDRS_BY_FN.clear()
    rt._CALLSITE_ADDRS_BY_FN["fake_fn"] = [0x1000, 0x2000]
    rt._CALLSITE_INSTALLED_FOR_FN.clear()
    rt._CALLSITE_INSTALLED_FOR_FN.add("fake_fn")
    rt._WHITELIST_EXACT = {sym}
    rt._WHITELIST_ADDR_MAP = {addr: sym}
    rt._WHITELIST_ADDR_READY = True
    rt._WHITELIST_ADDR_OBJFILES = {"single.elf"}
    rt._ACTIVE_ROOTS.clear()

    gdb.execute("ardb-save-trace-state __t4__")
    # 模拟组切换中段：删光断点
    for bp in list(_callbps()):
        bp.delete()
    for bp in [b for b in list(rt._CREATED_BPS) if isinstance(b, rt.CallSiteBP)]:
        rt._CREATED_BPS.remove(bp)
        if bp in rt._RUN_SCOPED_BPS:
            rt._RUN_SCOPED_BPS.remove(bp)
    gdb.execute("ardb-restore-trace-state __t4__")

    callbps = _callbps()
    ok = (len(callbps) == 2) and ({bp.addr for bp in callbps} == {0x1000, 0x2000})
    if ok:
        gdb.write("  OK: callsite bps restored from saved addresses\n")
        return True
    gdb.write(f"  FAIL: {len(callbps)} callsite bps, addrs={[bp.addr for bp in callbps]}\n")
    return False


def test_update_whitelist_clears_callsites():
    """update-whitelist 后旧 CallSiteBP 删除、集合清空（防重复插桩）。"""
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        gdb.write("  SKIP: ASYNC_RUST_DEBUGGER_TEMP_DIR not set\n")
        return True
    fixed = os.path.join(os.getcwd(), temp_dir, "poll_functions_grouped.json")
    os.makedirs(os.path.dirname(fixed), exist_ok=True)
    with open(fixed, "w", encoding="utf-8") as fp:
        json.dump({"version": 2, "crates": {}}, fp)

    rt.CallSiteBP(0x3000)
    rt._CALLSITE_INSTALLED_FOR_FN.clear()
    rt._CALLSITE_INSTALLED_FOR_FN.add("fake_fn2")
    rt._CALLSITE_ADDRS_BY_FN["fake_fn2"] = [0x3000]

    gdb.execute('ardb-update-whitelist {"enabled_crates": []}')

    callbps = _callbps()
    ok = (len(callbps) == 0) and (len(rt._CALLSITE_INSTALLED_FOR_FN) == 0) \
        and ("fake_fn2" not in rt._CALLSITE_ADDRS_BY_FN)
    if ok:
        gdb.write("  OK: update-whitelist clears stale callsites\n")
        return True
    gdb.write(f"  FAIL: bps={len(callbps)}, installed={rt._CALLSITE_INSTALLED_FOR_FN},"
              f" by_fn={rt._CALLSITE_ADDRS_BY_FN}\n")
    return False


def main():
    gdb.write("[test] callsite restore\n")
    results = [
        ("callsite_addrs_recorded_and_restored", test_callsite_addrs_recorded_and_restored()),
        ("update_whitelist_clears_callsites", test_update_whitelist_clears_callsites()),
    ]
    passed = sum(1 for _, ok in results if ok)
    failed = sum(1 for _, ok in results if not ok)
    gdb.write(
        f"\n[test] callsite_restore: {passed} passed, {failed} failed,"
        f" {len(results)} total\n"
    )


main()
