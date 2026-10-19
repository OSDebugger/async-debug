"""
Test address-map reuse with anchor validation (ardb-restore-trace-state).
Run inside GDB with a program that has symbols loaded:
  gdb -batch -ex "python import sys; sys.path.insert(0, '<repo>')" \
          -ex "source async_rust_debugger/__init__.py" \
          <binary> \
          -ex "source src/test/test_addr_map_reuse.py"
"""

import gdb
import async_rust_debugger.runtime_trace as rt


def _make_state(**overrides):
    state = {
        "active_roots": set(),
        "callsite_installed": set(),
        "whitelist_exact": None,
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
    state.update(overrides)
    return state


def test_shift_addr_map():
    try:
        shifted = rt._shift_addr_map({0x1000: "a", 0x2000: "b"}, 0x100)
    except AttributeError as e:
        gdb.write(f"  FAIL: _shift_addr_map missing: {e}\n")
        return False
    if shifted == {0x1100: "a", 0x2100: "b"}:
        gdb.write("  OK: shift_addr_map\n")
        return True
    gdb.write(f"  FAIL: shifted={shifted}\n")
    return False


def test_anchor_delta_none_when_unresolvable():
    try:
        d = rt._resolve_anchor_delta({0x1: "no_such_symbol_xyz_ardb_test"})
    except AttributeError as e:
        gdb.write(f"  FAIL: _resolve_anchor_delta missing: {e}\n")
        return False
    if d is None:
        gdb.write("  OK: anchor unresolvable -> None\n")
        return True
    gdb.write(f"  FAIL: delta={d}\n")
    return False


def test_restore_reuses_map_on_delta_zero():
    """单 objfile + 锚点 delta==0 → 地址表原样复用。"""
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

    rt._SAVED_STATES["__t3__"] = _make_state(
        whitelist_exact={sym},
        whitelist_addr_map={addr: sym},
        whitelist_objfile_names=["single.elf"],
    )
    gdb.execute("ardb-restore-trace-state __t3__")
    ok = (rt._WHITELIST_ADDR_READY is True) and (rt._WHITELIST_ADDR_MAP == {addr: sym})
    if ok:
        gdb.write("  OK: addr map reused on delta 0\n")
        return True
    gdb.write(f"  FAIL: ready={rt._WHITELIST_ADDR_READY}, map={rt._WHITELIST_ADDR_MAP}\n")
    return False


def test_restore_drops_reuse_for_multi_objfile():
    """多 objfile → 放弃复用，回退懒重建。"""
    rt._SAVED_STATES["__t3m__"] = _make_state(
        whitelist_exact={"minimal::main"},
        whitelist_addr_map={0x1000: "minimal::main"},
        whitelist_objfile_names=["a.elf", "b.elf"],
    )
    gdb.execute("ardb-restore-trace-state __t3m__")
    ok = (rt._WHITELIST_ADDR_READY is False) and (rt._WHITELIST_ADDR_MAP == {})
    if ok:
        gdb.write("  OK: multi-objfile drops reuse, lazy rebuild\n")
        return True
    gdb.write(f"  FAIL: ready={rt._WHITELIST_ADDR_READY}, map={rt._WHITELIST_ADDR_MAP}\n")
    return False


def main():
    gdb.write("[test] addr map reuse\n")
    results = [
        ("shift_addr_map", test_shift_addr_map()),
        ("anchor_delta_none_when_unresolvable", test_anchor_delta_none_when_unresolvable()),
        ("restore_reuses_map_on_delta_zero", test_restore_reuses_map_on_delta_zero()),
        ("restore_drops_reuse_for_multi_objfile", test_restore_drops_reuse_for_multi_objfile()),
    ]
    passed = sum(1 for _, ok in results if ok)
    failed = sum(1 for _, ok in results if not ok)
    gdb.write(
        f"\n[test] addr_map_reuse: {passed} passed, {failed} failed,"
        f" {len(results)} total\n"
    )


main()
