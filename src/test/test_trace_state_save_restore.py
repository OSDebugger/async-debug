"""
Test ardb-save-trace-state / ardb-restore-trace-state / ardb-reset-trace-state.
Run inside GDB:
  gdb -batch -ex "source async_rust_debugger/__init__.py" \
          -ex "source src/test/test_trace_state_save_restore.py"
Or, if the extension is already loaded:
  (gdb) source src/test/test_trace_state_save_restore.py

Requires: async_rust_debugger already imported (gdb.execute with python import).
"""

import gdb
import sys


def _find_module_globals():
    """Locate the runtime_trace module globals in sys.modules."""
    for name in list(sys.modules.keys()):
        if "runtime_trace" in name or "async_rust_debugger" in name:
            mod = sys.modules[name]
            if hasattr(mod, "_SAVED_STATES"):
                return mod
    return None


def test_save_restore_whitelist():
    """Test that whitelist state survives save/restore cycle."""
    mod = _find_module_globals()
    if mod is None:
        gdb.write("SKIP: runtime_trace module not found in sys.modules\n")
        return False

    label = "__test_save_restore__"

    # Seed whitelist with known values.
    mod._WHITELIST_EXACT = {"test::fn_a", "test::fn_b"}
    mod._WHITELIST_PREFIX = ["test::pre_"]
    mod._WHITELIST_ADDR_READY = True
    mod._WHITELIST_ADDR_MAP = {0x1000: "test::fn_a", 0x2000: "test::fn_b"}
    mod._ASYNC_SYMBOL_SET = {"test::fn_a", "test::fn_b"}
    mod._ACTIVE_ROOTS.add("test::fn_a")

    # Save.
    gdb.execute(f"ardb-save-trace-state {label}")

    # Verify saved state exists.
    if label not in mod._SAVED_STATES:
        gdb.write(f"FAIL: state '{label}' not saved\n")
        return False

    saved = mod._SAVED_STATES[label]
    checks = [
        ("active_roots", saved.get("active_roots") == {"test::fn_a"}),
        ("whitelist_exact", saved.get("whitelist_exact") == {"test::fn_a", "test::fn_b"}),
        ("whitelist_prefix", saved.get("whitelist_prefix") == ["test::pre_"]),
        ("whitelist_addr_map", saved.get("whitelist_addr_map") == {0x1000: "test::fn_a", 0x2000: "test::fn_b"}),
        ("async_symbol_set", saved.get("async_symbol_set") == {"test::fn_a", "test::fn_b"}),
        ("whitelist_addr_ready", saved.get("whitelist_addr_ready") == True),
    ]
    all_ok = True
    for name, ok in checks:
        if not ok:
            gdb.write(f"  FAIL: saved.{name} mismatch (got {saved.get(name)})\n")
            all_ok = False
    if all_ok:
        gdb.write("  OK: save captures all whitelist fields\n")

    # Mutate live state so we can prove restore works.
    mod._WHITELIST_EXACT = None
    mod._WHITELIST_PREFIX = None
    mod._WHITELIST_ADDR_READY = False
    mod._WHITELIST_ADDR_MAP = {}
    mod._ASYNC_SYMBOL_SET = None
    mod._ACTIVE_ROOTS.clear()

    # Restore.
    gdb.execute(f"ardb-restore-trace-state {label}")

    restore_checks = [
        ("whitelist_exact", mod._WHITELIST_EXACT == {"test::fn_a", "test::fn_b"}),
        ("whitelist_prefix", mod._WHITELIST_PREFIX == ["test::pre_"]),
        ("active_roots", mod._ACTIVE_ROOTS == {"test::fn_a"}),
        ("async_symbol_set", mod._ASYNC_SYMBOL_SET == {"test::fn_a", "test::fn_b"}),
        # addr_map is cleared on restore (needs rebuild under new symbols)
        ("whitelist_addr_map_cleared", mod._WHITELIST_ADDR_MAP == {}),
        ("whitelist_addr_ready_cleared", mod._WHITELIST_ADDR_READY == False),
    ]
    for name, ok in restore_checks:
        if not ok:
            gdb.write(f"  FAIL: restore.{name} mismatch\n")
            all_ok = False
    if all(
        ok for _, ok in restore_checks
    ):
        gdb.write("  OK: restore recovers whitelist state\n")

    # saved state is consumed (popped) on restore.
    if label in mod._SAVED_STATES:
        gdb.write("  FAIL: state not consumed on restore\n")
        all_ok = False
    else:
        gdb.write("  OK: state consumed (popped) on restore\n")

    return all_ok


def test_reset_clears_state():
    """Test that ardb-reset-trace-state removes saved state."""
    mod = _find_module_globals()
    if mod is None:
        return False

    label = "__test_reset__"
    mod._WHITELIST_EXACT = set()
    mod._WHITELIST_PREFIX = []
    mod._ACTIVE_ROOTS.clear()
    gdb.execute(f"ardb-save-trace-state {label}")
    assert label in mod._SAVED_STATES, "save should work"

    gdb.execute(f"ardb-reset-trace-state {label}")
    if label in mod._SAVED_STATES:
        gdb.write("  FAIL: reset did not clear state\n")
        return False
    gdb.write("  OK: reset clears saved state\n")
    return True


def test_save_nonexistent_restore():
    """Restore of unknown label prints a message, does not crash."""
    mod = _find_module_globals()
    if mod is None:
        return False
    before_exact = mod._WHITELIST_EXACT
    gdb.execute("ardb-restore-trace-state __nonexistent_label__")
    if mod._WHITELIST_EXACT is not before_exact:
        gdb.write("  FAIL: restore of unknown label mutated state\n")
        return False
    gdb.write("  OK: restore of unknown label is a no-op\n")
    return True


def test_unknown_state_labels():
    """Save then restore to confirm state is consumed at restore time."""
    mod = _find_module_globals()
    if mod is None:
        return False
    label = "__test_pop_behavior__"
    # 新语义（桶快照）：先激活 label 桶再写入状态，save 序列化的才是该桶
    mod._activate_program(label)
    mod._WHITELIST_EXACT = {"pop_test"}
    mod._WHITELIST_PREFIX = None
    mod._ACTIVE_ROOTS.clear()
    gdb.execute(f"ardb-save-trace-state {label}")

    # Restore once — should succeed.
    gdb.execute(f"ardb-restore-trace-state {label}")
    ok1 = mod._WHITELIST_EXACT == {"pop_test"}

    # Restore again — should be a no-op (state was popped).
    mod._WHITELIST_EXACT = {"should_not_change"}
    gdb.execute(f"ardb-restore-trace-state {label}")
    ok2 = mod._WHITELIST_EXACT == {"should_not_change"}

    if ok1 and ok2:
        gdb.write("  OK: restore consumes state, second restore is no-op\n")
        return True
    else:
        gdb.write(f"  FAIL: pop behavior wrong (ok1={ok1}, ok2={ok2})\n")
        return False


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
def main():
    gdb.write("[test] trace state save/restore\n")
    results = [
        ("save_restore_whitelist", test_save_restore_whitelist()),
        ("reset_clears_state", test_reset_clears_state()),
        ("save_nonexistent_restore", test_save_nonexistent_restore()),
        ("restore_consumes_state", test_unknown_state_labels()),
    ]
    passed = sum(1 for _, ok in results if ok)
    failed = sum(1 for _, ok in results if not ok)
    gdb.write(
        f"\n[test] trace_state: {passed} passed, {failed} failed,"
        f" {len(results)} total\n"
    )


main()
