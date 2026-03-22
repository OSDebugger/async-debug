import os
import re
import json
import gdb

# -------------------------
# Known framework / runtime crates (not user code)
# -------------------------

KNOWN_FRAMEWORK_CRATES = {
    "tokio", "futures", "futures_core", "futures_util", "futures_io",
    "futures_sink", "futures_channel", "futures_executor", "futures_macro",
    "hyper", "hyper_util", "tower", "tower_service", "tower_layer",
    "tonic", "axum", "axum_core", "actix", "actix_web", "actix_rt",
    "mio", "bytes", "http", "http_body", "http_body_util",
    "pin_project", "pin_project_lite", "pin_utils",
    "tracing", "tracing_core", "tracing_futures",
    "async_trait", "async_stream",
    "core", "std", "alloc",
}

# -------------------------
# Parsing helpers
# -------------------------

def parse_info_functions(output: str):
    functions = []
    current_file = None
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue

        if line.startswith("File "):
            current_file = line[len("File "):].rstrip(":")
            continue

        # Expect: "<lineno>: <signature>;"
        if current_file and ":" in line:
            parts = line.split(":", 1)
            try:
                line_num = int(parts[0].strip())
            except ValueError:
                continue
            signature = parts[1].strip()

            # Return type
            return_type = None
            if " -> " in signature:
                return_type = signature.split(" -> ", 1)[1].rstrip(";")

            functions.append({
                "file": current_file,
                "line": line_num,
                "signature": signature,
                "return_type": return_type,
            })
    return functions

def _extract_symbol_name(signature: str) -> str | None:
    """
    Signature examples (Rust in GDB):
      static fn minimal::nonleaf::{async_fn#0}() -> core::task::poll::Poll<i32>;
      static fn minimal::{impl#0}::poll(core::pin::Pin<&mut minimal::Manual>, *mut core::task::wake::Context) -> core::task::poll::Poll<i32>;
    We want:
      minimal::nonleaf::{async_fn#0}
      minimal::{impl#0}::poll
    """
    s = signature.strip().rstrip(";")
    # remove leading "static fn " or "fn "
    s = re.sub(r"^(static\s+)?fn\s+", "", s)
    # take up to first "("
    i = s.find("(")
    if i < 0:
        return None
    return s[:i].strip()


def _extract_crate_name(symbol: str) -> str:
    """
    Extract the crate name (first path segment) from a Rust symbol.

    Examples:
      "my_app::foo::bar::{async_fn#0}" -> "my_app"
      "tokio::runtime::task::harness::poll" -> "tokio"
      "<my_app::MyStruct as core::future::Future>::poll" -> "my_app"
      "core::future::poll_with_context" -> "core"
    """
    s = symbol.strip()

    # Handle angle-bracket impl blocks: <crate::Type as Trait>::method
    if s.startswith("<"):
        # Extract the type path inside < ... as ... >
        inner = s[1:]
        # Find the first "::" to get crate name from the type path
        idx = inner.find("::")
        if idx > 0:
            return inner[:idx]
        # Fallback: find ">" and take what's before
        idx = inner.find(">")
        if idx > 0:
            return inner[:idx]

    # Normal path: crate::module::item
    idx = s.find("::")
    if idx > 0:
        return s[:idx]

    # No :: found, the whole symbol is the "crate name"
    return s


def _detect_user_crate(crate_name: str, file_path: str | None) -> bool:
    """
    Determine whether a crate is user code or framework/library code.

    Heuristics (in priority order):
    1. If file_path contains ".cargo/registry" or "rustup/toolchains" → framework
    2. If file_path starts with "src/" or is a relative path without .cargo → user crate
    3. If crate_name is in KNOWN_FRAMEWORK_CRATES → framework
    4. Otherwise → user crate (assume unknown crates are user code)
    """
    if file_path:
        fp = file_path.replace("\\", "/")
        if ".cargo/registry" in fp or "rustup/toolchains" in fp:
            return False
        # Relative paths starting with src/ are almost certainly user code
        if fp.startswith("src/") or fp.startswith("./src/"):
            return True
        # Absolute path but not in .cargo or rustup — could be user code
        if not fp.startswith("/") and ".cargo" not in fp:
            return True

    return crate_name not in KNOWN_FRAMEWORK_CRATES


# -------------------------
# Flat whitelist generation (existing format)
# -------------------------

def gen_poll_whitelist(out_path: str):
    output = gdb.execute("info functions", to_string=True)
    funcs = parse_info_functions(output)

    syms = []
    for f in funcs:
        rt = f.get("return_type") or ""
        if "core::task::poll::Poll<" not in rt:
            continue
        sym = _extract_symbol_name(f["signature"])
        if sym:
            syms.append(sym)

    # de-dup & stable order
    seen = set()
    uniq = []
    for s in syms:
        if s not in seen:
            uniq.append(s)
            seen.add(s)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fp:
        for i, s in enumerate(uniq):
            fp.write(f"{i} {s}\n")

    gdb.write(f"[ARD] wrote whitelist: {len(uniq)} symbols -> {out_path}\n")


def _write_filtered_whitelist(grouped_data: dict, out_path: str):
    """
    Write a flat poll_functions.txt containing only symbols from user crates.
    This is used as the default runtime whitelist.
    """
    idx = 0
    with open(out_path, "w", encoding="utf-8") as fp:
        for crate_name, crate_info in grouped_data["crates"].items():
            if not crate_info["is_user_crate"]:
                continue
            for sym_info in crate_info["symbols"]:
                fp.write(f"{idx} {sym_info['name']}\n")
                idx += 1
    return idx


# -------------------------
# Grouped whitelist generation (new JSON format)
# -------------------------

def _is_interesting_function(signature: str, return_type: str | None) -> bool:
    """
    判断一个函数是否应该被收录到白名单中。
    收录标准：
    1. 返回 Poll<T> 的函数（异步函数的 poll 实现）
    2. 用户 crate 中的所有函数（同步 + 异步）
    我们在这里不做 crate 过滤，而是收录所有函数，后续按 crate 分组时再区分。
    """
    return True  # 收录所有函数，由 crate 分组和 UI 来控制可见性


def _classify_symbol(sym: str, return_type: str | None) -> str:
    """
    对符号进行分类：async（异步 poll 函数）或 sync（同步函数）
    """
    rt = return_type or ""
    if "core::task::poll::Poll<" in rt:
        return "async"
    if "{async_fn#" in sym or "{async_block#" in sym:
        return "async"
    return "sync"


def gen_grouped_whitelist(out_path: str) -> dict:
    """
    Generate a grouped whitelist JSON file organized by crate.
    包含所有函数（同步 + 异步），按 crate 分组。
    Returns the grouped data dict.
    """
    output = gdb.execute("info functions", to_string=True)
    funcs = parse_info_functions(output)

    # 收集所有函数及其元信息
    all_funcs = []
    seen_syms = set()
    for f in funcs:
        sym = _extract_symbol_name(f["signature"])
        if not sym or sym in seen_syms:
            continue
        seen_syms.add(sym)
        all_funcs.append({
            "name": sym,
            "file": f.get("file"),
            "line": f.get("line"),
            "return_type": f.get("return_type"),
        })

    # 第一遍：按 crate 分组，确定哪些是用户 crate
    crate_files: dict[str, set] = {}  # crate_name -> set of file paths
    for af in all_funcs:
        crate_name = _extract_crate_name(af["name"])
        if crate_name not in crate_files:
            crate_files[crate_name] = set()
        if af["file"]:
            crate_files[crate_name].add(af["file"])

    # 确定每个 crate 是否为用户 crate
    crate_is_user: dict[str, bool] = {}
    for crate_name, files in crate_files.items():
        sample_file = next(iter(files), None)
        crate_is_user[crate_name] = _detect_user_crate(crate_name, sample_file)

    # 第二遍：构建分组数据
    # 对于用户 crate：收录所有函数（同步 + 异步）
    # 对于框架 crate：只收录异步函数（返回 Poll<T> 的），减少噪音
    crates: dict[str, dict] = {}
    for af in all_funcs:
        crate_name = _extract_crate_name(af["name"])
        is_user = crate_is_user.get(crate_name, False)
        kind = _classify_symbol(af["name"], af["return_type"])

        # 框架 crate 只收录异步函数
        if not is_user and kind != "async":
            continue

        if crate_name not in crates:
            crates[crate_name] = {
                "is_user_crate": is_user,
                "symbols": [],
            }
        crates[crate_name]["symbols"].append({
            "name": af["name"],
            "file": af["file"],
            "line": af["line"],
            "kind": kind,  # "async" 或 "sync"
        })

    grouped_data = {
        "version": 2,
        "crates": crates,
    }

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fp:
        json.dump(grouped_data, fp, indent=2, ensure_ascii=False)

    user_count = sum(1 for c in crates.values() if c["is_user_crate"])
    total_syms = sum(len(c["symbols"]) for c in crates.values())
    async_syms = sum(1 for c in crates.values() for s in c["symbols"] if s.get("kind") == "async")
    sync_syms = total_syms - async_syms
    gdb.write(f"[ARD] wrote grouped whitelist: {len(crates)} crates ({user_count} user), "
              f"{total_syms} symbols ({async_syms} async, {sync_syms} sync) -> {out_path}\n")

    return grouped_data


def gen_default_whitelist():
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        raise RuntimeError("ASYNC_RUST_DEBUGGER_TEMP_DIR is not set")
    cwd = os.getcwd()
    out_dir = os.path.join(cwd, temp_dir)

    # 1. Generate grouped JSON (new format, contains all functions for UI display)
    grouped_path = os.path.join(out_dir, "poll_functions_grouped.json")
    gen_grouped_whitelist(grouped_path)

    # 2. Generate empty flat whitelist (default: no crates enabled, user manually selects)
    flat_path = os.path.join(out_dir, "poll_functions.txt")
    os.makedirs(os.path.dirname(flat_path), exist_ok=True)
    with open(flat_path, "w", encoding="utf-8") as fp:
        fp.write("# Empty default whitelist. Use 'Apply Whitelist' in Async Inspector to enable crates.\n")
    gdb.write(f"[ARD] wrote empty default whitelist -> {flat_path}\n")
