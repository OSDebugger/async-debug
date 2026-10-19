"""白名单生成：扫描 GDB 符号表，按 crate 分组生成 poll_functions_grouped.json。"""
import os
import re
import json
import gdb
import hashlib

# -------------------------
# 已知的框架 / 运行时 crate（不属于用户代码）
# -------------------------
# 仅作为 _detect_user_crate 的兜底：符号缺少文件路径信息时按名字判断。
# 生态名单不可能穷尽，只收录常见项；有文件路径信息时以路径判断为准。

KNOWN_FRAMEWORK_CRATES = {
    # async 运行时
    "tokio", "tokio_util", "tokio_stream",
    "async_std",
    "smol",
    # futures 家族
    "futures", "futures_lite", "futures_core", "futures_util", "futures_io",
    "futures_sink", "futures_channel", "futures_executor", "futures_macro",
    # 异步原语与工具
    "async_io", "async_task", "async_executor", "async_channel", "async_lock",
    "event_listener", "concurrent_queue", "blocking",
    "waker_fn", "atomic_waker", "futures_intrusive",
    # HTTP 服务层
    "hyper", "hyper_util", "tower", "tower_service", "tower_layer", "tower_http",
    # Web / gRPC 框架
    "tonic", "tonic_health", "prost",
    "axum", "axum_core", "axum_extra",
    "actix", "actix_web", "actix_rt",
    "reqwest", "warp", "rocket", "tide", "surf", "salvo", "poem",
    # 底层 IO 与 HTTP 原语
    "mio", "bytes", "http", "http_body", "http_body_util",
    # 异步数据库客户端
    "sqlx", "redis",
    # Pin 投影辅助
    "pin_project", "pin_project_lite", "pin_utils",
    # 可观测性 / 日志
    "tracing", "tracing_core", "tracing_futures",
    "tracing_subscriber", "tracing_appender", "tracing_log",
    # async 宏工具
    "async_trait", "async_stream",
    # 标准库
    "core", "std", "alloc",
}

# -------------------------
# 解析辅助函数
# -------------------------

def parse_info_functions(output: str):
    """解析 `info functions` 的输出，返回函数信息列表。"""
    functions = []
    current_file = None
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue

        if line.startswith("File "):
            current_file = line[len("File "):].rstrip(":")
            continue

        # 行格式："<行号>: <签名>;"
        if current_file and ":" in line:
            parts = line.split(":", 1)
            try:
                line_num = int(parts[0].strip())
            except ValueError:
                continue
            signature = parts[1].strip()

            # 返回类型
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
    从函数签名中提取符号名。

    GDB 中 Rust 签名的示例：
      static fn minimal::nonleaf::{async_fn#0}() -> core::task::poll::Poll<i32>;
      static fn minimal::{impl#0}::poll(core::pin::Pin<&mut minimal::Manual>, *mut core::task::wake::Context) -> core::task::poll::Poll<i32>;
    提取结果：
      minimal::nonleaf::{async_fn#0}
      minimal::{impl#0}::poll
    """
    s = signature.strip().rstrip(";")
    # 去掉开头的 "static fn " 或 "fn "
    s = re.sub(r"^(static\s+)?fn\s+", "", s)
    # 截取第一个 "(" 之前的部分
    i = s.find("(")
    if i < 0:
        return None
    return s[:i].strip()


def _extract_crate_name(symbol: str) -> str:
    """
    从 Rust 符号中提取 crate 名（路径的第一段）。

    示例：
      "my_app::foo::bar::{async_fn#0}" -> "my_app"
      "tokio::runtime::task::harness::poll" -> "tokio"
      "<my_app::MyStruct as core::future::Future>::poll" -> "my_app"
      "core::future::poll_with_context" -> "core"
    """
    s = symbol.strip()

    # 尖括号 impl 块：<crate::Type as Trait>::method
    if s.startswith("<"):
        # 取 < ... as ... > 内的类型路径
        inner = s[1:]
        # 从类型路径中找第一个 "::"，其前即为 crate 名
        idx = inner.find("::")
        if idx > 0:
            return inner[:idx]
        # 兜底：找 ">"，取之前的部分
        idx = inner.find(">")
        if idx > 0:
            return inner[:idx]

    # 普通路径：crate::module::item
    idx = s.find("::")
    if idx > 0:
        return s[:idx]

    # 没有 "::"，整个符号就是 crate 名
    return s


def _detect_user_crate(crate_name: str, file_path: str | None) -> bool:
    """
    判断一个 crate 是用户代码还是框架 / 库代码。
    判断规则（按优先级）：
    1. 文件路径含 ".cargo/registry" 或 "rustup/toolchains" → 框架
    2. 文件路径以 "src/" 开头，或是不含 .cargo 的相对路径 → 用户 crate
    3. crate 名在 KNOWN_FRAMEWORK_CRATES 中 → 框架
    4. 其余情况 → 用户 crate（未知 crate 默认按用户代码处理）
    """
    if file_path:
        fp = file_path.replace("\\", "/")
        if ".cargo/registry" in fp or "rustup/toolchains" in fp:
            return False
        # 以 src/ 开头的相对路径几乎肯定是用户代码
        if fp.startswith("src/") or fp.startswith("./src/"):
            return True
        # 非绝对路径且不含 .cargo —— 视为用户代码
        if not fp.startswith("/") and ".cargo" not in fp:
            return True

    return crate_name not in KNOWN_FRAMEWORK_CRATES


# -------------------------
# 分组白名单生成（JSON 格式）
# -------------------------

def _classify_symbol(sym: str, return_type: str | None) -> str:
    """对符号进行分类：async（异步 poll 函数）或 sync（同步函数）。"""
    rt = return_type or ""
    if "core::task::poll::Poll<" in rt:
        return "async"
    if "{async_fn#" in sym or "{async_block#" in sym:
        return "async"
    return "sync"


def gen_grouped_whitelist(out_path: str) -> dict:
    """
    生成按 crate 分组的白名单 JSON 文件。

    扫描全部符号并按 crate 分组：用户 crate 收录全部函数（同步 + 异步），
    框架 crate 只收录异步函数以减少噪音。返回分组后的数据字典。
    """
    # 钩子断点的行为可能把 GDB 语言留在 C（为读字符串参数执行过 "set language c"）。
    # C 渲染下 `info functions` 会输出 "static void hello_world::main()" 而非 Rust
    # 渲染，导致 crate 名提取错误（把 "static void hello_world" 当成 crate 名）。
    # 恢复自动语言，让符号按原生形式渲染。
    try:
        gdb.execute("set language auto", to_string=True)
    except Exception:
        pass
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
    crate_files: dict[str, set] = {}  # crate 名 -> 文件路径集合
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


# -------------------------
# 分组白名单缓存（按符号文件组合）
# -------------------------

def _current_objfile_key() -> tuple[tuple[str, int], ...]:
    """当前加载的全部 objfile 的 (文件名, mtime) 元组，按文件名排序。"""
    entries = set()
    for objfile in gdb.objfiles():
        path = objfile.filename
        try:
            mtime = int(os.stat(path).st_mtime)
        except Exception:
            mtime = 0
        entries.add((path, mtime))
    return tuple(sorted(entries))


def _cache_file_for_key(key: tuple[tuple[str, int], ...]) -> str:
    """给定符号组合键，返回对应的缓存文件路径。"""
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        raise RuntimeError("ASYNC_RUST_DEBUGGER_TEMP_DIR is not set")
    out_dir = os.path.join(os.getcwd(), temp_dir)
    digest = hashlib.sha1(repr(key).encode()).hexdigest()[:16]
    return os.path.join(out_dir, "whitelist_cache", f"{digest}.json")


def _try_load_cached_grouped(key, grouped_path: str) -> bool:
    """缓存命中则把缓存内容写入 grouped_path 并返回 True。"""
    cache_file = _cache_file_for_key(key)
    if not os.path.exists(cache_file):
        return False
    with open(cache_file, "r", encoding="utf-8") as fp:
        content = fp.read()
    with open(grouped_path, "w", encoding="utf-8") as fp:
        fp.write(content)
    return True


def _cache_grouped(key, grouped_data: dict, grouped_path: str):
    """把 grouped 数据写入缓存副本（grouped_path 供 UI/固定路径读取）。"""
    cache_file = _cache_file_for_key(key)
    os.makedirs(os.path.dirname(cache_file), exist_ok=True)
    with open(cache_file, "w", encoding="utf-8") as fp:
        json.dump(grouped_data, fp, indent=2, ensure_ascii=False)


def gen_default_whitelist():
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        raise RuntimeError("ASYNC_RUST_DEBUGGER_TEMP_DIR is not set")
    cwd = os.getcwd()
    out_dir = os.path.join(cwd, temp_dir)

    # 1. 生成分组 JSON（供 UI 展示全部函数）；同符号组合已缓存则跳过全量扫描
    grouped_path = os.path.join(out_dir, "poll_functions_grouped.json")
    key = _current_objfile_key()
    if _try_load_cached_grouped(key, grouped_path):
        gdb.write(f"[ARD] whitelist cache hit -> {grouped_path}\n")
    else:
        grouped_data = gen_grouped_whitelist(grouped_path)
        _cache_grouped(key, grouped_data, grouped_path)

    # 2. 生成空的扁平白名单（默认不启用任何 crate，由用户在 UI 中手动选择）
    flat_path = os.path.join(out_dir, "poll_functions.txt")
    os.makedirs(os.path.dirname(flat_path), exist_ok=True)
    with open(flat_path, "w", encoding="utf-8") as fp:
        fp.write("# Empty default whitelist. Use 'Apply Whitelist' in Async Inspector to enable crates.\n")
    gdb.write(f"[ARD] wrote empty default whitelist -> {flat_path}\n")
