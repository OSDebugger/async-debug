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


def main():
    gdb.write("[test] program state buckets\n")
    results = [
        ("activate_swaps_state_between_programs", test_activate_swaps_state_between_programs()),
        ("activate_fresh_program_gets_empty_bucket", test_activate_fresh_program_gets_empty_bucket()),
        ("legacy_saved_state_migrates_or_rebuilds", test_legacy_saved_state_migrates_or_rebuilds()),
    ]
    passed = sum(1 for _, ok in results if ok)
    failed = sum(1 for _, ok in results if not ok)
    gdb.write(
        f"\n[test] program_state_buckets: {passed} passed, {failed} failed,"
        f" {len(results)} total\n"
    )


main()
