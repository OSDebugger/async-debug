import os
import re
import struct
import gdb
import json

# -------------------------
# User-facing knobs
# -------------------------

MAX_CALLSITES_PER_FN = 200

# True => 打印所有内部 future / poll 的实时输出（更完整，但更吵）
PRINT_INTERNAL_POLL_HITS = True

# True => 第一次进入用户可见 poll 时，打印 whitelist 地址解析统计
PRINT_WHITELIST_ADDR_STATS = True


# Regex to parse GDB's "info line" output:
# e.g. 'Line 42 of "src/main.rs" starts at address ...'
_re_info_line = re.compile(r'Line\s+(\d+)\s+of\s+"([^"]+)"')

# -------------------------
# Coroutine instance tracking (runtime)
# -------------------------
# 目标：
# - 每个 (poll_symbol, env_ptr) 视作一个“协程实例”
# - 每次 poll 打印 poll#seq（第几轮 poll）
# - 实时打印 call / awa（不做输出去重）
# - 通过栈维护缩进，让父子 future 关系可读

_CO_NEXT_ID = 1
_CO_BY_KEY = {}        # (poll_sym, this_ptr) -> coro_id
_CO_META = {}          # coro_id -> (poll_sym, this_ptr)
_CO_POLL_SEQ = {}      # coro_id -> poll_count
_TLS_STACK = {}        # thread_num -> [coro_id, ...]

def _thread_id() -> int:
    t = gdb.selected_thread()
    return t.num if t is not None else 0

def _get_or_make_coro_id(poll_sym: str, this_ptr: int):
    """
    Returns: (cid, is_new)
    """
    global _CO_NEXT_ID
    key = (poll_sym, int(this_ptr))
    cid = _CO_BY_KEY.get(key)
    if cid is None:
        cid = _CO_NEXT_ID
        _CO_NEXT_ID += 1
        _CO_BY_KEY[key] = cid
        _CO_META[cid] = key
        _CO_POLL_SEQ[cid] = 0
        return cid, True
    return cid, False

def _push_coro(cid: int) -> int:
    tid = _thread_id()
    st = _TLS_STACK.setdefault(tid, [])
    st.append(cid)
    return len(st) - 1  # depth

def _current_coro():
    tid = _thread_id()
    st = _TLS_STACK.get(tid, [])
    return (st[-1], len(st) - 1) if st else (0, -1)

class _PopOnReturnBP(gdb.FinishBreakpoint):
    """Pop coroutine stack when current function returns."""
    def __init__(self, tid: int, cid: int):
        super().__init__(gdb.selected_frame(), internal=True)
        self.silent = True
        self.tid = tid
        self.cid = cid
        _RUN_SCOPED_BPS.append(self)

    def stop(self):
        st = _TLS_STACK.get(self.tid, [])
        if not st:
            return False

        if st[-1] == self.cid:
            st.pop()
            return False

        # fallback: remove from back if mismatch
        for i in range(len(st) - 1, -1, -1):
            if st[i] == self.cid:
                del st[i]
                break
        return False


# -------------------------
# State (breakpoints / whitelist)
# -------------------------

_CREATED_BPS = []
_RUN_SCOPED_BPS = []

_CALLSITE_INSTALLED_FOR_FN = set()   # per-run: avoid re-installing callsite BPs
_ACTIVE_ROOTS = set()                # poll symbols we installed PollEntryBP for

# whitelist: exact + prefix(*)
_WHITELIST_EXACT = None   # set[str] | None
_WHITELIST_PREFIX = None  # list[str] | None
_WHITELIST_PATH = None

# addr map only for exact symbols (PIE/ASLR-safe per-run)
_WHITELIST_ADDR_MAP = {}             # addr -> exact symbol
_WHITELIST_ADDR_READY = False

_EVENTS_INSTALLED = False


# -------------------------
# Low-level helpers
# -------------------------

CALL_MNEMONIC_RE = re.compile(r"^\s*call\w*\b", re.IGNORECASE)
HEX_ADDR_RE = re.compile(r"(0x[0-9a-fA-F]+)")

def _ptr_size() -> int:
    return gdb.lookup_type("void").pointer().sizeof

def _read_ptr(addr: int) -> int:
    inf = gdb.selected_inferior()
    ps = _ptr_size()
    mem = inf.read_memory(addr, ps).tobytes()
    if ps == 8:
        return struct.unpack("<Q", mem)[0]
    return struct.unpack("<I", mem)[0]

def _reg_u64(name: str) -> int:
    return int(gdb.parse_and_eval(f"${name}"))

def _current_pc() -> int:
    return int(gdb.parse_and_eval("$pc"))

def _current_function_name() -> str:
    f = gdb.selected_frame()
    return f.name() or "<unknown>"

def _info_symbol_raw(addr: int) -> str:
    return gdb.execute(f"info symbol {addr:#x}", to_string=True).strip()

def _info_symbol_name(addr: int) -> str:
    s = _info_symbol_raw(addr)
    s = s.split(" in section")[0].strip()
    s = s.split(" + ")[0].strip()
    return s

def _find_pc_function_name(addr: int) -> str | None:
    try:
        sym = gdb.find_pc_function(addr)
        if sym is None:
            return None
        n = getattr(sym, "print_name", None)
        if n:
            return str(n)
        n2 = getattr(sym, "name", None)
        if n2:
            return str(n2)
        return str(sym)
    except Exception:
        return None

def _function_range() -> tuple[int, int] | None:
    blk = gdb.selected_frame().block()
    while blk is not None and blk.function is None:
        blk = blk.superblock
    if blk is None or blk.start is None or blk.end is None:
        return None
    return (int(blk.start), int(blk.end))

def _collect_call_sites() -> list[int]:
    r = _function_range()
    if r is None:
        raise gdb.error("cannot get function range")
    start, end = r
    arch = gdb.selected_frame().architecture()
    insns = arch.disassemble(start, end)

    out = []
    seen = set()
    for ins in insns:
        asm = ins.get("asm", "").strip()
        if CALL_MNEMONIC_RE.match(asm):
            a = int(ins["addr"])
            if a not in seen:
                out.append(a)
                seen.add(a)

    return out[:MAX_CALLSITES_PER_FN]

def _current_asm() -> str:
    pc = _current_pc()
    arch = gdb.selected_frame().architecture()
    insns = arch.disassemble(pc, pc + 16)
    for ins in insns:
        if int(ins["addr"]) == pc:
            return ins.get("asm", "")
    return gdb.execute("x/i $pc", to_string=True).strip()

def _resolve_call_target_from_asm(asm: str) -> int | None:
    s = asm.strip()

    # direct call (has immediate 0xADDR)
    if "call" in s and "0x" in s and "*0x" not in s:
        m = HEX_ADDR_RE.search(s)
        if m:
            return int(m.group(1), 16)

    # call *%reg
    m = re.search(r"call\w*\s+\*\%([a-z0-9]+)\b", s)
    if m:
        return _reg_u64(m.group(1))

    # call *disp(%reg)
    m = re.search(r"call\w*\s+\*([\-0-9a-fx]+)\(\%([a-z0-9]+)\)", s)
    if m:
        disp_s, base = m.group(1), m.group(2)
        disp = int(disp_s, 16) if disp_s.startswith(("0x", "-0x")) else int(disp_s, 10)
        slot = _reg_u64(base) + disp
        return _read_ptr(slot)

    # call *disp(%rip)  (x86_64: ff 15 disp32 ; instruction length is 6 bytes)
    m = re.search(r"call\w*\s+\*([\-0-9a-fx]+)\(\%rip\)", s)
    if m:
        disp_s = m.group(1)
        disp = int(disp_s, 16) if disp_s.startswith(("0x", "-0x")) else int(disp_s, 10)
        pc = _current_pc()
        slot = pc + 6 + disp  # RIP-relative base = next instruction
        return _read_ptr(slot)

    return None


# -------------------------
# __awaitee extraction (best-effort)
# -------------------------

def _pollsym_to_envtype(poll_sym: str) -> str | None:
    s = poll_sym
    s = s.replace("{async_fn#", "{async_fn_env#")
    s = s.replace("{async_block#", "{async_block_env#")
    return s if s != poll_sym else None

def _try_read_awaitee_from_current_poll(poll_sym: str):
    env_type_name = _pollsym_to_envtype(poll_sym)
    if not env_type_name:
        return None

    try:
        env_t = gdb.lookup_type(env_type_name)
    except gdb.error:
        return None

    # x86_64 SysV: rdi = env ptr
    try:
        env_ptr = _reg_u64("rdi")
    except Exception:
        return None

    if env_ptr == 0:
        return None

    try:
        env_val = gdb.Value(env_ptr).cast(env_t.pointer()).dereference()
        state = int(env_val["__state"])
    except gdb.error:
        return None

    variant_map = {}
    for f in env_t.fields():
        if f.name is not None and re.fullmatch(r"\d+", str(f.name)):
            variant_map[int(f.name)] = f.type

    vt = variant_map.get(state)
    if vt is None:
        return None

    try:
        payload = env_val.address.cast(vt.pointer()).dereference()
        awaitee = payload["__awaitee"]
        return (str(awaitee.type), str(awaitee))
    except gdb.error:
        return None

def _child_poll_symbol_from_awaitee_type(awa_ty: str) -> str | None:
    if "{async_fn_env#" in awa_ty:
        return awa_ty.replace("{async_fn_env#", "{async_fn#")
    if "{async_block_env#" in awa_ty:
        return awa_ty.replace("{async_block_env#", "{async_block#")
    return None


# -------------------------
# Whitelist (PIE/ASLR-safe via per-run addr map)
# -------------------------

def _default_whitelist_path() -> str | None:
    cwd = os.getcwd()
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        return None
    return os.path.join(cwd, temp_dir, "poll_functions.txt")

def _load_whitelist_file(path: str):
    """
    Supports:
      - exact:  minimal::sync_a
      - prefix: minimal::block_on*   (matches any symbol starting with that prefix)
    Also supports existing "idx sym" format.
    Returns: (exact_set, prefix_list)
    """
    exact: set[str] = set()
    prefix: list[str] = []
    with open(path, "r", encoding="utf-8") as fp:
        for raw in fp:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            sym = parts[1] if (len(parts) >= 2 and parts[0].isdigit()) else line

            if sym.endswith("*"):
                prefix.append(sym[:-1])
            else:
                exact.add(sym)

    return exact, prefix

def _invalidate_whitelist_addrs():
    global _WHITELIST_ADDR_MAP, _WHITELIST_ADDR_READY
    _WHITELIST_ADDR_MAP = {}
    _WHITELIST_ADDR_READY = False

def _try_addr_by_lookup_global_symbol(name: str) -> int | None:
    try:
        sym = gdb.lookup_global_symbol(name)
        if sym is None:
            return None
        v = sym.value()
        voidp = gdb.lookup_type("void").pointer()
        return int(v.cast(voidp))
    except Exception:
        return None

def _try_addr_by_info_address(name: str) -> int | None:
    for expr in (name, f"'{name}'"):
        try:
            out = gdb.execute(f"info address {expr}", to_string=True)
        except gdb.error:
            continue
        m = HEX_ADDR_RE.search(out)
        if m:
            return int(m.group(1), 16)
    return None

def _whitelist_enabled() -> bool:
    return (_WHITELIST_EXACT is not None) or (_WHITELIST_PREFIX is not None)

def _normalize_sym_name(sym: str) -> str:
    # strip PLT suffix if present
    if sym.endswith("@plt"):
        return sym[:-4]
    return sym

def _whitelist_allows_by_name(sym: str) -> str | None:
    if not _whitelist_enabled():
        return sym  # no whitelist => allow

    if _WHITELIST_EXACT is not None and sym in _WHITELIST_EXACT:
        return sym

    if _WHITELIST_PREFIX:
        for p in _WHITELIST_PREFIX:
            if sym.startswith(p):
                return sym

    return None

def _build_whitelist_addr_map_if_needed(caller_is_user_visible: bool):
    global _WHITELIST_ADDR_READY, _WHITELIST_ADDR_MAP

    # addr-map only for exact symbols
    if _WHITELIST_EXACT is None or _WHITELIST_ADDR_READY:
        return

    resolved = 0
    total = len(_WHITELIST_EXACT)
    addr_map = {}

    for name in _WHITELIST_EXACT:
        addr = _try_addr_by_lookup_global_symbol(name)
        if addr is None:
            addr = _try_addr_by_info_address(name)
        if addr is None:
            continue
        addr_map[int(addr)] = name
        resolved += 1

    _WHITELIST_ADDR_MAP = addr_map
    _WHITELIST_ADDR_READY = True

    if caller_is_user_visible and PRINT_WHITELIST_ADDR_STATS:
        prefix_n = len(_WHITELIST_PREFIX) if _WHITELIST_PREFIX else 0
        _log_ard(f"[ARD] whitelist addrs: {resolved}/{total} resolved (exact), prefix={prefix_n}")

def _whitelist_allows_by_addr(target_addr: int) -> str | None:
    if _WHITELIST_EXACT is None or not _WHITELIST_ADDR_READY:
        return None
    return _WHITELIST_ADDR_MAP.get(int(target_addr))

# -------------------------
# Logging helpers (runtime)
# -------------------------

def _default_log_path() -> str | None:
    cwd = os.getcwd()
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        return None
    return os.path.join(cwd, temp_dir, "ardb.log")

def _log_ard(message: str, to_console: bool = False):
    """
    双轨日志记录：
    - 始终尝试写入磁盘文件 (ardb.log) 以供开发者检查。
    - 根据 to_console 参数决定是否实时打印到 GDB 终端。
    """
    path = _default_log_path()
    if path:
        try:
            # 确保 temp 目录存在（如果之前没生成白名单的话）
            log_dir = os.path.dirname(path)
            if not os.path.exists(log_dir):
                os.makedirs(log_dir, exist_ok=True)
                
            with open(path, "a", encoding="utf-8") as fp:
                fp.write(message + "\n")
        except Exception:
            pass

    if to_console:
        gdb.write(message + "\n")

# -------------------------
# Callee selection
# -------------------------

def _is_pollish_name(sym_name: str) -> bool:
    return ("::poll" in sym_name) or ("{async_fn#" in sym_name) or ("{async_block#" in sym_name)

def _is_async_symbol(sym_name: str) -> bool:
    """判断一个符号是否是异步函数（async fn 或 async block 的 poll）"""
    return ("{async_fn#" in sym_name) or ("{async_block#" in sym_name)

def _callee_candidates(addr: int) -> list[str]:
    cands = []
    n1 = _find_pc_function_name(addr)
    if n1:
        cands.append(n1.strip())
    n2 = _info_symbol_name(addr)
    if n2:
        cands.append(n2.strip())

    seen = set()
    out = []
    for s in cands:
        s2 = s.strip()
        if s2 and s2 not in seen:
            out.append(s2)
            seen.add(s2)
    return out

def _pick_interesting_callee(target_addr: int) -> str | None:
    # whitelist enabled + addr-map ready: prefer addr hit, else fallback to name
    if _whitelist_enabled() and _WHITELIST_ADDR_READY:
        hit = _whitelist_allows_by_addr(target_addr)
        if hit:
            return hit
        # address miss: fallback to name-based match (prefix/plt/monomorph)
        for n in _callee_candidates(target_addr):
            n2 = _normalize_sym_name(n)
            if _whitelist_allows_by_name(n2):
                return n2
        return None

    # whitelist enabled but addr-map not ready: name-based match
    if _whitelist_enabled():
        for n in _callee_candidates(target_addr):
            n2 = _normalize_sym_name(n)
            if _whitelist_allows_by_name(n2):
                return n2
        return None

    # no whitelist: heuristic (only poll-ish)
    for n in _callee_candidates(target_addr):
        if _is_pollish_name(n):
            return n
    return None


# -------------------------
# Run-scoped cleanup (PIE/ASLR safe)
# -------------------------

def _cleanup_run_scoped():
    for bp in list(_RUN_SCOPED_BPS):
        try:
            bp.delete()
        except Exception:
            pass
    _RUN_SCOPED_BPS.clear()

    _CALLSITE_INSTALLED_FOR_FN.clear()
    _invalidate_whitelist_addrs()

    _TLS_STACK.clear()
    _CO_BY_KEY.clear()
    _CO_META.clear()
    _CO_POLL_SEQ.clear()
    global _CO_NEXT_ID
    _CO_NEXT_ID = 1

def _on_exited(event):
    _cleanup_run_scoped()

def _on_new_objfile(event):
    _cleanup_run_scoped()

# -------------------------
# Breakpoints
# -------------------------

class PollEntryBP(gdb.Breakpoint):
    def __init__(self, location: str, poll_sym: str | None, internal: bool, temporary: bool = False):
        super().__init__(location, type=gdb.BP_BREAKPOINT, internal=internal, temporary=temporary)
        self.silent = True
        self.poll_sym = poll_sym or ""
        self.internal = internal
        _CREATED_BPS.append(self)

        # addr breakpoints / finish breakpoints are run-scoped
        if isinstance(location, str) and location.strip().startswith("*"):
            _RUN_SCOPED_BPS.append(self)

    def stop(self) -> bool:
        fn = _current_function_name()

        # ---- coro context enter (best-effort) ----
        tid = _thread_id()
        try:
            this_ptr = _reg_u64("rdi")   # x86_64 SysV: first arg (env ptr)
        except Exception:
            this_ptr = 0

        poll_sym = self.poll_sym or fn
        cid = 0
        is_new = False
        depth = -1

        if poll_sym and this_ptr:
            cid, is_new = _get_or_make_coro_id(poll_sym, this_ptr)
            depth = _push_coro(cid)
            _PopOnReturnBP(tid, cid)

        indent = "  " * max(depth, 0)

        # poll sequence per coro instance
        seq = 0
        if cid:
            seq = _CO_POLL_SEQ.get(cid, 0) + 1
            _CO_POLL_SEQ[cid] = seq

        _build_whitelist_addr_map_if_needed(caller_is_user_visible=(not self.internal))

        # new coro line
        if cid and is_new:
            _log_ard(f"[ARD]{indent} coro#{cid} new: {poll_sym} @ {this_ptr:#x}") # 使用默认的 False

        # poll line
        if (not self.internal) or PRINT_INTERNAL_POLL_HITS:
            _log_ard(f"[ARD]{indent} poll[coro#{cid} poll#{seq}] {fn}") # 使用默认的 False

        # awaitee line (no output dedup)
        if self.poll_sym:
            awa = _try_read_awaitee_from_current_poll(self.poll_sym)
            if awa is not None:
                awa_ty, _awa_val = awa
                _log_ard(f"[ARD]{indent} awa[coro#{cid} poll#{seq}] {fn} -> {awa_ty}") # 使用默认的 False

                # auto-trace child async fn/block by symbol (install once)
                child_poll = _child_poll_symbol_from_awaitee_type(awa_ty)
                if child_poll and (child_poll not in _ACTIVE_ROOTS):
                    # whitelist enabled => only install if allowed
                    if (not _whitelist_enabled()) or _whitelist_allows_by_name(child_poll):
                        _ACTIVE_ROOTS.add(child_poll)
                        PollEntryBP(child_poll, poll_sym=child_poll, internal=True, temporary=False)

        # Install call-site breakpoints once per function (per run)
        if fn not in _CALLSITE_INSTALLED_FOR_FN:
            try:
                call_sites = _collect_call_sites()
            except gdb.error as e:
                if (not self.internal) or PRINT_INTERNAL_POLL_HITS:
                    _log_ard(f"[ARD]{indent} call-site scan failed: {e}")
                return False

            for a in call_sites:
                CallSiteBP(a)

            _CALLSITE_INSTALLED_FOR_FN.add(fn)
            if (not self.internal) or PRINT_INTERNAL_POLL_HITS:
                _log_ard(f"[ARD]{indent} call-sites: {len(call_sites)}")

        return False


class CallSiteBP(gdb.Breakpoint):
    def __init__(self, addr: int):
        super().__init__(f"*{addr:#x}", type=gdb.BP_BREAKPOINT, internal=True)
        self.silent = True
        self.addr = addr
        _CREATED_BPS.append(self)
        _RUN_SCOPED_BPS.append(self)

    def stop(self) -> bool:
        target = _resolve_call_target_from_asm(_current_asm())
        if not target:
            return False

        callee = _pick_interesting_callee(target)
        if not callee:
            return False

        caller = _current_function_name()
        cid, depth = _current_coro()
        indent = "  " * max(depth, 0)
        seq = _CO_POLL_SEQ.get(cid, 0) if cid else 0

        # call line (no output dedup)
        _log_ard(f"[ARD]{indent} call[coro#{cid} poll#{seq}] {caller} -> {callee}") # 使用默认的 False

        if _is_pollish_name(callee) and callee not in _ACTIVE_ROOTS:
            _ACTIVE_ROOTS.add(callee)
            PollEntryBP(callee, poll_sym=callee, internal=True, temporary=False)

        return False
    
# -------------------------
# Commands
# -------------------------

class ARDTraceCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-trace", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        sym = arg.strip()
        if not sym:
            gdb.write("Usage: ardb-trace <poll-symbol>\n")
            return

        gdb.execute("set pagination off", to_string=True)
        gdb.execute("set debuginfod enabled off", to_string=True)

        if sym in _ACTIVE_ROOTS:
            gdb.write(f"[ARD] root already traced: {sym}\n")
            return

        if _whitelist_enabled() and (not _whitelist_allows_by_name(sym)):
            gdb.write(f"[ARD] warning: root not in whitelist: {sym}\n")

        _ACTIVE_ROOTS.add(sym)
        PollEntryBP(sym, poll_sym=sym, internal=False, temporary=False)
        gdb.write(f"[ARD] trace root: {sym}\n")


class ARDResetCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-reset", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        for bp in list(_CREATED_BPS):
            try:
                bp.delete()
            except Exception:
                pass
        _CREATED_BPS.clear()
        _RUN_SCOPED_BPS.clear()

        _CALLSITE_INSTALLED_FOR_FN.clear()
        _ACTIVE_ROOTS.clear()

        _invalidate_whitelist_addrs()

        _TLS_STACK.clear()
        _CO_BY_KEY.clear()
        _CO_META.clear()
        _CO_POLL_SEQ.clear()
        global _CO_NEXT_ID
        _CO_NEXT_ID = 1

        # Clear log file if exists
        path = _default_log_path()
        if path and os.path.exists(path):
            try:
                with open(path, "w") as f:
                    pass
            except Exception:
                pass

        gdb.write("[ARD] reset done.\n")

class ARDLoadWhitelistCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-load-whitelist", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        global _WHITELIST_EXACT, _WHITELIST_PREFIX, _WHITELIST_PATH
        path = arg.strip() or _default_whitelist_path()
        if not path:
            gdb.write("[ARD] whitelist path not provided and ASYNC_RUST_DEBUGGER_TEMP_DIR is not set.\n")
            return

        try:
            wl_exact, wl_prefix = _load_whitelist_file(path)
        except Exception as e:
            gdb.write(f"[ARD] failed to load whitelist: {e}\n")
            return

        _WHITELIST_EXACT = wl_exact
        _WHITELIST_PREFIX = wl_prefix
        _WHITELIST_PATH = path
        _invalidate_whitelist_addrs()

        gdb.write(f"[ARD] whitelist loaded: exact={len(wl_exact)} prefix={len(wl_prefix)} from {path}\n")


class ARDGenWhitelistCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-gen-whitelist", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        try:
            from async_rust_debugger.static_analysis.gen_whitelist import gen_default_whitelist
        except Exception as e:
            gdb.write(f"[ARD] cannot import gen_whitelist: {e}\n")
            return
        try:
            gen_default_whitelist()
        except Exception as e:
            gdb.write(f"[ARD] gen_default_whitelist failed: {e}\n")

class ARDGetSnapshotCommand(gdb.Command):
    """
    Get a mixed-mode snapshot of the current call stack, including 
    asynchronous coroutines and synchronous function calls.
    Usage: ardb-get-snapshot
    """
    def __init__(self):
        super().__init__("ardb-get-snapshot", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        tid = _thread_id()
        stack = _TLS_STACK.get(tid, [])
        
        snapshot = {
            "thread_id": tid,
            "path": []
        }
        
        # 1. Extract the shadow stack (traced coroutines and functions)
        top_async_func = ""
        for cid in stack:
            poll_sym, this_ptr = _CO_META.get(cid, ("<unknown>", 0))
            seq = _CO_POLL_SEQ.get(cid, 0)
            top_async_func = poll_sym

            # 根据函数名判断真实类型：async fn/block → async，其他 → sync
            node_type = "async" if _is_async_symbol(poll_sym) else "sync"

            state_val = "N/A"
            env_type_name = _pollsym_to_envtype(poll_sym)
            if env_type_name and this_ptr:
                try:
                    env_t = gdb.lookup_type(env_type_name)
                    env_val = gdb.Value(this_ptr).cast(env_t.pointer()).dereference()
                    state_val = int(env_val["__state"])
                except Exception:
                    pass

            # Try to get source location for this async function
            async_file = ""
            async_fullname = ""
            async_line = 0
            try:
                info = gdb.execute(f"info line '{poll_sym}'", to_string=True)
                m = _re_info_line.match(info)
                if m:
                    async_line = int(m.group(1))
                    async_file = m.group(2)
                    # Try to resolve absolute path
                    async_fullname = os.path.abspath(async_file) if async_file else ""
            except Exception:
                pass

            snapshot["path"].append({
                "type": node_type,
                "cid": cid,
                "func": poll_sym,
                "addr": hex(this_ptr),
                "poll": seq,
                "state": state_val,
                "file": async_file,
                "fullname": async_fullname,
                "line": async_line
            })
            
        # 2. Extract the physical stack tail (frames above the top traced function)
        sync_tail = []
        try:
            # Start from the currently selected frame (deepest)
            frame = gdb.selected_frame()
            while frame:
                fname = frame.name()

                # Stop if we reach the entry of the top traced function
                # to avoid duplication with the shadow stack
                if fname == top_async_func:
                    break

                if fname:
                    # 根据函数名判断真实类型
                    frame_type = "async" if _is_async_symbol(fname) else "sync"

                    # Get source location from the frame
                    sync_file = ""
                    sync_fullname = ""
                    sync_line = 0
                    try:
                        sal = frame.find_sal()
                        if sal and sal.symtab:
                            sync_file = sal.symtab.filename or ""
                            sync_fullname = sal.symtab.fullname() if hasattr(sal.symtab, 'fullname') else sync_file
                            sync_line = sal.line or 0
                    except Exception:
                        pass

                    sync_tail.append({
                        "type": frame_type,
                        "cid": None,
                        "func": fname,
                        "addr": hex(frame.pc()),
                        "poll": 0,
                        "state": "N/A" if frame_type == "async" else "NON-ASYNC",
                        "file": sync_file,
                        "fullname": sync_fullname,
                        "line": sync_line
                    })
                frame = frame.older()
        except Exception:
            pass
            
        # Physical frames are captured in reverse order (deepest first), 
        # so we reverse them before appending to the path.
        snapshot["path"].extend(reversed(sync_tail))
            
        # Output pure JSON for the Debug Adapter
        json_output = json.dumps(snapshot) + "\n"
        gdb.write(json_output)
        
        # Also write to file if ASYNC_RUST_DEBUGGER_TEMP_DIR is set (for DA integration)
        temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
        if temp_dir:
            snapshot_path = os.path.join(os.getcwd(), temp_dir, "ardb_snapshot.json")
            try:
                with open(snapshot_path, "w", encoding="utf-8") as f:
                    f.write(json_output)
            except Exception:
                pass  # Best-effort file write, don't fail if it doesn't work

class ARDGetGroupedWhitelistCommand(gdb.Command):
    """
    Return the grouped whitelist JSON (crate-level grouping with user-crate detection).
    Reads poll_functions_grouped.json from the temp directory.
    Usage: ardb-get-whitelist-grouped
    """
    def __init__(self):
        super().__init__("ardb-get-whitelist-grouped", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
        if not temp_dir:
            gdb.write('[ARD] ASYNC_RUST_DEBUGGER_TEMP_DIR is not set.\n')
            return

        grouped_path = os.path.join(os.getcwd(), temp_dir, "poll_functions_grouped.json")
        if not os.path.exists(grouped_path):
            gdb.write('[ARD] grouped whitelist not found. Run ardb-gen-whitelist first.\n')
            return

        try:
            with open(grouped_path, "r", encoding="utf-8") as fp:
                content = fp.read()
            gdb.write(content + "\n")
        except Exception as e:
            gdb.write(f'[ARD] failed to read grouped whitelist: {e}\n')


class ARDUpdateWhitelistCommand(gdb.Command):
    """
    Update the runtime whitelist based on enabled crates.
    Reads the grouped JSON, filters to enabled crates, writes flat poll_functions.txt,
    and reloads the whitelist.
    Usage: ardb-update-whitelist {"enabled_crates": ["my_app", "my_lib"]}
    """
    def __init__(self):
        super().__init__("ardb-update-whitelist", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        global _WHITELIST_EXACT, _WHITELIST_PREFIX, _WHITELIST_PATH

        temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
        if not temp_dir:
            gdb.write('[ARD] ASYNC_RUST_DEBUGGER_TEMP_DIR is not set.\n')
            return

        cwd = os.getcwd()
        grouped_path = os.path.join(cwd, temp_dir, "poll_functions_grouped.json")
        flat_path = os.path.join(cwd, temp_dir, "poll_functions.txt")

        if not os.path.exists(grouped_path):
            gdb.write('[ARD] grouped whitelist not found. Run ardb-gen-whitelist first.\n')
            return

        # Parse the enabled crates from the argument
        arg = arg.strip()
        if not arg:
            gdb.write('Usage: ardb-update-whitelist {"enabled_crates": ["crate1", ...]}\n')
            return

        try:
            payload = json.loads(arg)
            enabled_crates = set(payload.get("enabled_crates", []))
        except Exception as e:
            gdb.write(f'[ARD] failed to parse argument: {e}\n')
            return

        # Read grouped JSON
        try:
            with open(grouped_path, "r", encoding="utf-8") as fp:
                grouped_data = json.load(fp)
        except Exception as e:
            gdb.write(f'[ARD] failed to read grouped whitelist: {e}\n')
            return

        # Write filtered flat whitelist
        idx = 0
        try:
            with open(flat_path, "w", encoding="utf-8") as fp:
                for crate_name, crate_info in grouped_data.get("crates", {}).items():
                    if crate_name not in enabled_crates:
                        continue
                    for sym_info in crate_info.get("symbols", []):
                        fp.write(f"{idx} {sym_info['name']}\n")
                        idx += 1
        except Exception as e:
            gdb.write(f'[ARD] failed to write filtered whitelist: {e}\n')
            return

        # Reload the whitelist
        try:
            wl_exact, wl_prefix = _load_whitelist_file(flat_path)
            _WHITELIST_EXACT = wl_exact
            _WHITELIST_PREFIX = wl_prefix
            _WHITELIST_PATH = flat_path
            _invalidate_whitelist_addrs()
        except Exception as e:
            gdb.write(f'[ARD] failed to reload whitelist: {e}\n')
            return

        gdb.write(f'[ARD] whitelist updated: {len(enabled_crates)} crates enabled, {idx} symbols -> {flat_path}\n')


class ARDInferTraceRootCommand(gdb.Command):
    """
    Infer the trace root by walking the GDB stack from the current breakpoint position.
    Finds the outermost user-crate async function in the call stack.
    Usage: ardb-infer-trace-root
    """
    def __init__(self):
        super().__init__("ardb-infer-trace-root", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        from async_rust_debugger.static_analysis.gen_whitelist import (
            _extract_crate_name, KNOWN_FRAMEWORK_CRATES
        )

        all_async_frames = []
        outermost_user_async = None
        max_frames = 100

        try:
            frame = gdb.selected_frame()
            count = 0
            while frame and count < max_frames:
                fname = frame.name()
                if fname and ("{async_fn#" in fname or "{async_block#" in fname):
                    all_async_frames.append(fname)
                    # Check if this is a user-crate async function
                    crate_name = _extract_crate_name(fname)
                    if crate_name not in KNOWN_FRAMEWORK_CRATES:
                        outermost_user_async = fname  # keep overwriting → outermost wins
                frame = frame.older()
                count += 1
        except Exception:
            pass

        result = {
            "trace_root": outermost_user_async,
            "all_async_frames": all_async_frames,
        }

        gdb.write(json.dumps(result) + "\n")


# -------------------------
# Entry
# -------------------------

def install():
    global _EVENTS_INSTALLED

    gdb.execute("set pagination off", to_string=True)
    gdb.execute("set debuginfod enabled off", to_string=True)

    ARDTraceCommand()
    ARDResetCommand()
    ARDLoadWhitelistCommand()
    ARDGenWhitelistCommand()
    ARDGetSnapshotCommand()
    ARDGetGroupedWhitelistCommand()
    ARDUpdateWhitelistCommand()
    ARDInferTraceRootCommand()

    if not _EVENTS_INSTALLED:
        try:
            gdb.events.exited.connect(_on_exited)
        except Exception:
            pass
        try:
            gdb.events.new_objfile.connect(_on_new_objfile)
        except Exception:
            pass
        _EVENTS_INSTALLED = True

    gdb.write("[ARD] installed. Commands: ardb-gen-whitelist, ardb-load-whitelist, ardb-trace, ardb-get-snapshot, ardb-reset, ardb-get-whitelist-grouped, ardb-update-whitelist, ardb-infer-trace-root\n")