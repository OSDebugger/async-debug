"""
Test grouped-whitelist caching (per symbol-file-combination cache).
Run inside GDB:
  gdb -batch -ex "source async_rust_debugger/__init__.py" \
          -ex "source src/test/test_whitelist_cache.py"
"""

import gdb
import os
import json
import tempfile
from async_rust_debugger.static_analysis import gen_whitelist


def test_objfile_key_stable_and_sorted():
    """连续两次调用返回相同键；键为 (path, mtime) 元组且按 path 排序。"""
    try:
        k1 = gen_whitelist._current_objfile_key()
        k2 = gen_whitelist._current_objfile_key()
        ok = (k1 == k2) and (list(k1) == sorted(k1))
        if ok:
            gdb.write(f"  OK: key stable and sorted (n={len(k1)})\n")
            return True
        gdb.write(f"  FAIL: key mismatch: {k1!r} vs {k2!r}\n")
        return False
    except AttributeError as e:
        gdb.write(f"  FAIL: {e}\n")
        return False


def test_cache_roundtrip():
    """写缓存 → 清空 grouped_path → try_load 恢复内容。"""
    tmp = tempfile.mkdtemp(prefix="ardb_test_cache_")
    grouped_path = os.path.join(tmp, "poll_functions_grouped.json")
    try:
        key = (("/fake/a.elf", 1), ("/fake/b.elf", 2))
        data = {
            "version": 2,
            "crates": {"test_crate": {"is_user_crate": True, "symbols": []}},
        }
        try:
            gen_whitelist._cache_grouped(key, data, grouped_path)
        except AttributeError as e:
            gdb.write(f"  FAIL: _cache_grouped missing: {e}\n")
            return False

        # 清空 grouped_path，模拟多组切换时的互相覆盖
        with open(grouped_path, "w", encoding="utf-8") as fp:
            fp.write("# overwritten\n")

        try:
            hit = gen_whitelist._try_load_cached_grouped(key, grouped_path)
        except AttributeError as e:
            gdb.write(f"  FAIL: _try_load_cached_grouped missing: {e}\n")
            return False

        with open(grouped_path, "r", encoding="utf-8") as fp:
            restored = json.load(fp)

        ok = (hit is True) and (restored == data)
        if ok:
            gdb.write("  OK: cache roundtrip restores grouped JSON\n")
            return True
        gdb.write(f"  FAIL: hit={hit}, restored={restored!r}\n")
        return False
    finally:
        for f in os.listdir(tmp):
            os.remove(os.path.join(tmp, f))
        os.rmdir(tmp)


def test_grouped_json_path_prefers_cache():
    """无缓存文件 → 固定路径；有缓存文件 → 缓存路径。"""
    import async_rust_debugger.runtime_trace as runtime_trace

    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        gdb.write("  SKIP: ASYNC_RUST_DEBUGGER_TEMP_DIR not set\n")
        return True
    fixed = os.path.join(os.getcwd(), temp_dir, "poll_functions_grouped.json")

    # 清掉当前键的缓存文件
    key = gen_whitelist._current_objfile_key()
    cache_file = gen_whitelist._cache_file_for_key(key)
    if os.path.exists(cache_file):
        os.remove(cache_file)

    try:
        p1 = runtime_trace._grouped_json_path()
    except AttributeError as e:
        gdb.write(f"  FAIL: _grouped_json_path missing: {e}\n")
        return False

    if p1 != fixed:
        gdb.write(f"  FAIL: no-cache path {p1!r} != fixed {fixed!r}\n")
        return False

    # 制造缓存文件后应优先返回缓存路径
    gen_whitelist._cache_grouped(key, {"version": 2, "crates": {}}, fixed)
    p2 = runtime_trace._grouped_json_path()
    os.remove(cache_file)  # 清理
    if p2 != cache_file:
        gdb.write(f"  FAIL: cached path {p2!r} != cache file {cache_file!r}\n")
        return False

    gdb.write("  OK: grouped JSON path prefers cache, falls back to fixed\n")
    return True


def main():
    gdb.write("[test] whitelist cache\n")
    results = [
        ("objfile_key_stable_and_sorted", test_objfile_key_stable_and_sorted()),
        ("cache_roundtrip", test_cache_roundtrip()),
        ("grouped_json_path_prefers_cache", test_grouped_json_path_prefers_cache()),
    ]
    passed = sum(1 for _, ok in results if ok)
    failed = sum(1 for _, ok in results if not ok)
    gdb.write(
        f"\n[test] whitelist_cache: {passed} passed, {failed} failed,"
        f" {len(results)} total\n"
    )


main()
