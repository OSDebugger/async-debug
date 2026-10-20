"""
Test per-program state buckets and O(1) context switch (_activate_program).
Run inside GDB with a program loaded:
  gdb -batch -ex "python import sys; sys.path.insert(0, '<repo>')" \
          -ex "source async_rust_debugger/__init__.py" \
          <binary> \
          -ex "source src/test/test_program_state_buckets.py"
"""

import gdb
import async_rust_debugger.runtime_trace as rt


def test_activate_swaps_state_between_programs():
    try:
        rt._PROGRAM_STATES.clear()
        rt._active_program = None
        rt._activate_program("prog_a")
    except AttributeError as e:
        gdb.write(f"  FAIL: _activate_program missing: {e}\n")
        return False

    rt._WHITELIST_EXACT = {"a::f"}
    rt._CO_BY_KEY[("a::f", 0x1000)] = 1
    rt._TLS_STACK[7] = [1]

    rt._activate_program("prog_b")
    ok1 = (rt._WHITELIST_EXACT is None) and (not rt._CO_BY_KEY) and (not rt._TLS_STACK)
    ok2 = ("prog_a" in rt._PROGRAM_STATES
           and rt._PROGRAM_STATES["prog_a"]["whitelist_exact"] == {"a::f"})

    rt._activate_program("prog_a")
    ok3 = (rt._WHITELIST_EXACT == {"a::f"}
           and rt._CO_BY_KEY == {("a::f", 0x1000): 1}
           and rt._TLS_STACK == {7: [1]})
    ok4 = len(rt._PROGRAM_STATES) == 2

    if ok1 and ok2 and ok3 and ok4:
        gdb.write("  OK: activate swaps state between program buckets\n")
        return True
    gdb.write(f"  FAIL: ok1={ok1} ok2={ok2} ok3={ok3} ok4={ok4}\n")
    return False


def test_activate_fresh_program_gets_empty_bucket():
    rt._activate_program("fresh_prog")
    ok = (rt._WHITELIST_EXACT is None
          and rt._WHITELIST_ADDR_MAP == {}
          and rt._WHITELIST_ADDR_READY is False
          and rt._CO_NEXT_ID == 1
          and not rt._ACTIVE_ROOTS)
    if ok:
        gdb.write("  OK: fresh program gets empty bucket\n")
        return True
    gdb.write("  FAIL: fresh bucket not empty\n")
    return False


def test_legacy_saved_state_migrates_or_rebuilds():
    rt._SAVED_STATES["__legacy__"] = {
        "active_roots": set(),
        "callsite_installed": set(),
        "whitelist_exact": {"legacy::f"},
        "whitelist_prefix": None,
        "whitelist_addr_map": {},
        "whitelist_addr_ready": False,
        "whitelist_objfile_names": [],
        "async_symbol_set": None,
        "poll_entries": [],
        "co_by_key": [],
        "co_meta": {},
        "co_poll_seq": {},
        "tls_stack": {},
        "co_next_id": 1,
    }
    gdb.execute("ardb-restore-trace-state __legacy__")
    ok = (rt._WHITELIST_EXACT == {"legacy::f"}
          and "__legacy__" in rt._PROGRAM_STATES)
    if ok:
        gdb.write("  OK: legacy saved state migrates into bucket\n")
        return True
    gdb.write(f"  FAIL: exact={rt._WHITELIST_EXACT}, buckets={list(rt._PROGRAM_STATES.keys())}\n")
    return False


def test_program_name_normalization():
    ok = (rt._normalize_program_name("/pipetest") == "pipetest"
          and rt._normalize_program_name("kernel") == "kernel"
          and rt._normalize_program_name(" /hello ") == "hello")
    if ok:
        gdb.write("  OK: program name normalization\n")
        return True
    gdb.write("  FAIL: normalization wrong\n")
    return False


def test_in_addr_ranges():
    kr = [(0xFFFFFFC000000000, 0xFFFFFFFFFFFFFFFF)]
    ur = [(0x0, 0x4000000000)]
    ok = (rt._in_addr_ranges(0xFFFFFFC080200000, kr) is True
          and rt._in_addr_ranges(0x10400, kr) is False
          and rt._in_addr_ranges(0x10400, ur) is True
          and rt._in_addr_ranges(0x4000000001, ur) is False)
    if ok:
        gdb.write("  OK: addr range classification\n")
        return True
    gdb.write("  FAIL: range classification wrong\n")
    return False


def test_first_activation_preserves_pre_activation_state():
    """首次激活不得丢弃激活前建立的全局状态（launch 模式白名单在首次停止前就绪）。"""
    rt._PROGRAM_STATES.clear()
    rt._active_program = None
    rt._WHITELIST_EXACT = {"pre::fn"}
    rt._ASYNC_SYMBOL_SET = {"pre::fn"}
    rt._ACTIVE_ROOTS.add("pre::root")

    rt._activate_program("launch_user")

    ok = (rt._WHITELIST_EXACT == {"pre::fn"}
          and rt._ASYNC_SYMBOL_SET == {"pre::fn"}
          and "pre::root" in rt._ACTIVE_ROOTS)
    if ok:
        gdb.write("  OK: first activation preserves pre-activation state\n")
        return True
    gdb.write(f"  FAIL: state wiped — exact={rt._WHITELIST_EXACT}, async={rt._ASYNC_SYMBOL_SET}\n")
    return False


def test_save_snapshots_label_bucket():
    """save 必须序列化 label 桶的状态，而非当前全局（当前全局可能属于另一程序）。"""
    rt._PROGRAM_STATES.clear()
    rt._active_program = None
    rt._activate_program("prog_a")
    rt._WHITELIST_EXACT = {"a::fn"}
    rt._activate_program("prog_b")
    rt._WHITELIST_EXACT = {"b::fn"}

    gdb.execute("ardb-save-trace-state prog_a")

    saved = rt._SAVED_STATES.get("prog_a")
    ok = saved is not None and saved.get("whitelist_exact") == {"a::fn"}
    if ok:
        gdb.write("  OK: save snapshots label bucket (not current globals)\n")
        return True
    gdb.write(f"  FAIL: saved={saved.get('whitelist_exact') if saved else None}\n")
    return False


def test_classify_pc():
    """PC 分类：内核区间→kernel；复位向量区（停靠 hart）→unknown；用户区间→当前用户程序。"""
    try:
        f = rt._classify_pc
    except AttributeError as e:
        gdb.write(f"  FAIL: _classify_pc missing: {e}\n")
        return False
    rt._CURRENT_USER_PROGRAM = "hello_world"
    ok = (f(0xFFFFFFC080200000) == "kernel"
          and f(0x1000) == "unknown"
          and f(0x10000) == "hello_world"
          and f(0x0000004000000001) == "hello_world")  # 用户区间上界之外仍按用户（配置区间为准）
    if ok:
        gdb.write("  OK: pc classification (reset vector -> unknown)\n")
        return True
    gdb.write("  FAIL: pc classification wrong\n")
    return False


def main():
    gdb.write("[test] program state buckets\n")
    results = [
        ("activate_swaps_state_between_programs", test_activate_swaps_state_between_programs()),
        ("activate_fresh_program_gets_empty_bucket", test_activate_fresh_program_gets_empty_bucket()),
        ("legacy_saved_state_migrates_or_rebuilds", test_legacy_saved_state_migrates_or_rebuilds()),
        ("first_activation_preserves_pre_activation_state", test_first_activation_preserves_pre_activation_state()),
        ("save_snapshots_label_bucket", test_save_snapshots_label_bucket()),
        ("program_name_normalization", test_program_name_normalization()),
        ("in_addr_ranges", test_in_addr_ranges()),
        ("classify_pc", test_classify_pc()),
    ]
    passed = sum(1 for _, ok in results if ok)
    failed = sum(1 for _, ok in results if not ok)
    gdb.write(
        f"\n[test] program_state_buckets: {passed} passed, {failed} failed,"
        f" {len(results)} total\n"
    )


main()
