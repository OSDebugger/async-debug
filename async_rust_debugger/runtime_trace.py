import os
import re
import struct
import time
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

# -------------------------
# Profiling (performance measurement, off by default)
# -------------------------
# ARDB_PROFILE=1  => measure wall-clock time spent inside each breakpoint's
#                    Python stop() callback while the inferior is stopped.
#                    A report is printed on inferior exit and on the
#                    `ardb-profile-report` command, then counters reset.
# ARDB_PROFILE_DETAIL=1 (implies ARDB_PROFILE) => additionally time named
#                    sections inside poll_entry / call_site callbacks.

PROFILE_ENABLED = os.environ.get("ARDB_PROFILE") == "1"
PROFILE_DETAIL = PROFILE_ENABLED and os.environ.get("ARDB_PROFILE_DETAIL") == "1"

# bucket upper bounds in microseconds
_PROFILE_BUCKETS = (100, 1000, 10000, float("inf"))
_PROFILE_BUCKET_LABELS = ("<0.1ms", "0.1-1ms", "1-10ms", ">10ms")
_PROFILE_KINDS = ("poll_entry", "call_site", "pop_on_return")

_PROFILE_STATS = {
    k: {"count": 0, "total_us": 0.0, "max_us": 0.0, "buckets": [0, 0, 0, 0]}
    for k in _PROFILE_KINDS
}
# kind -> {section_name: [calls, total_us, max_us]}
_PROFILE_DETAILS = {}

def _profile_now():
    return time.perf_counter()

def _profiled(kind: str):
    """Decorator: time the whole stop() callback of a breakpoint class."""
    def deco(fn):
        def wrapper(self):
            t0 = _profile_now() if PROFILE_ENABLED else None
            try:
                return fn(self)
            finally:
                _profile_tick(kind, t0)
        return wrapper
    return deco

def _profile_tick(kind: str, t0):
    if not PROFILE_ENABLED or t0 is None:
        return
    us = (_profile_now() - t0) * 1e6
    st = _PROFILE_STATS[kind]
    st["count"] += 1
    st["total_us"] += us
    st["max_us"] = max(st["max_us"], us)
    for i, hi in enumerate(_PROFILE_BUCKETS):
        if us < hi:
            st["buckets"][i] += 1
            break

def _profile_section(kind: str, name: str, t0):
    """Record a named sub-section of a stop() callback (detail mode only)."""
    if not PROFILE_DETAIL or t0 is None:
        return
    us = (_profile_now() - t0) * 1e6
    d = _PROFILE_DETAILS.setdefault(kind, {}).setdefault(name, [0, 0.0, 0.0])
    d[0] += 1
    d[1] += us
    d[2] = max(d[2], us)

def _profile_report():
    global _PROFILE_STATS, _PROFILE_DETAILS
    if not PROFILE_ENABLED:
        gdb.write("[ARD-PROFILE] profiling is off (set ARDB_PROFILE=1).\n")
        return
    lines = ["[ARD-PROFILE] === stop() cost report ==="]
    total_hits = 0
    total_us = 0.0
    for kind in _PROFILE_KINDS:
        st = _PROFILE_STATS[kind]
        if st["count"] == 0:
            lines.append(f"[ARD-PROFILE] {kind}: no hits")
            continue
        avg = st["total_us"] / st["count"]
        total_hits += st["count"]
        total_us += st["total_us"]
        dist = " ".join(
            f"{_PROFILE_BUCKET_LABELS[i]}={st['buckets'][i]}"
            for i in range(len(_PROFILE_BUCKETS))
        )
        lines.append(
            f"[ARD-PROFILE] {kind}: {st['count']} hits, "
            f"avg={avg:.1f}us, max={st['max_us']:.1f}us, total={st['total_us'] / 1e6:.3f}s"
        )
        lines.append(f"[ARD-PROFILE]   dist: {dist}")
        details = _PROFILE_DETAILS.get(kind)
        if details:
            for name, (c, tot, mx) in sorted(details.items(), key=lambda kv: -kv[1][1]):
                lines.append(
                    f"[ARD-PROFILE]   | {name}: {c} calls, "
                    f"avg={tot / c:.1f}us, total={tot / 1e6:.3f}s"
                )
    if total_hits:
        lines.append(
            f"[ARD-PROFILE] ALL: {total_hits} stops, "
            f"total python stop() time={total_us / 1e6:.3f}s"
        )
    msg = "\n".join(lines)
    gdb.write(msg + "\n")
    path = _default_log_path()
    if path:
        try:
            profile_path = os.path.join(os.path.dirname(path), "ardb_profile.log")
            with open(profile_path, "a", encoding="utf-8") as fp:
                fp.write(msg + "\n")
        except Exception:
            pass
    # reset so the next run / manual report starts clean
    _PROFILE_STATS = {
        k: {"count": 0, "total_us": 0.0, "max_us": 0.0, "buckets": [0, 0, 0, 0]}
        for k in _PROFILE_KINDS
    }
    _PROFILE_DETAILS = {}


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


def _find_nearby_coro(poll_sym: str, this_ptr: int, max_offset: int = 128) -> int | None:
    """
    Search for an existing CID whose (poll_sym, stored_ptr) has the same
    poll_sym and a stored_ptr within ±max_offset of this_ptr.

    This handles the case where Pin/reference wrapping introduces a small
    pointer offset for the same underlying coroutine instance.

    Returns the matching CID, or None if no nearby match is found.
    """
    if not this_ptr:
        return None
    for (sym, stored_ptr), cid in _CO_BY_KEY.items():
        if sym == poll_sym and abs(int(stored_ptr) - int(this_ptr)) <= max_offset:
            return cid
    return None

def _push_coro(cid: int) -> int:
    tid = _thread_id()
    st = _TLS_STACK.setdefault(tid, [])
    # gdb.FinishBreakpoint may not fire on all architectures (e.g. RISC-V
    # with release + -g).  If the same CID is already on the stack from a
    # previous poll cycle, remove it (and everything after it) before pushing.
    if cid in st:
        idx = st.index(cid)
        del st[idx:]
    # On RISC-V (and potentially other architectures), FinishBreakpoint is
    # broken.  This means _PopOnReturnBP won't remove a coroutine from the
    # stack when its poll function returns.  When a different coroutine
    # starts, the stale top-of-stack entry must be detected and removed.
    # We check whether the old coroutine's poll function is still present on
    # the GDB physical call stack.  If not, it has already returned and
    # should be popped so the new coroutine appears at the correct (sibling)
    # depth rather than as a spurious child.
    elif st and st[-1] != cid:
        prev_cid = st[-1]
        prev_sym, _ = _CO_META.get(prev_cid, ("", 0))
        if prev_sym:
            try:
                active = False
                f = gdb.selected_frame()
                for _ in range(60):
                    if not f:
                        break
                    name = f.name()
                    if name and name == prev_sym:
                        active = True
                        break
                    f = f.older()
            except Exception:
                active = True   # conservative: assume still active
            if not active:
                st.pop()
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

    @_profiled("pop_on_return")
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
_CALLSITE_ADDRS_BY_FN: dict[str, list[int]] = {}  # 函数名 -> 已装 callsite 地址（save/restore 用）
_ACTIVE_ROOTS = set()                # poll symbols we installed PollEntryBP for

# whitelist: exact + prefix(*)
_WHITELIST_EXACT = None   # set[str] | None
_WHITELIST_PREFIX = None  # list[str] | None
_WHITELIST_PATH = None

# addr map only for exact symbols (PIE/ASLR-safe per-run)
_WHITELIST_ADDR_MAP = {}             # addr -> exact symbol
_WHITELIST_ADDR_READY = False
_WHITELIST_ADDR_OBJFILES = set()     # 地址表符号所属 objfile 的文件名集合（构建时记录）

# Async symbol set from grouped whitelist (symbols classified as "async")
_ASYNC_SYMBOL_SET = None   # set[str] | None

_EVENTS_INSTALLED = False

# Per-breakpoint-group saved trace state (async OS debugging).
# Key: group label ("kernel", "user").  Value: dict with serialized state.
_SAVED_STATES: dict[str, dict] = {}


# -------------------------
# Per-program state buckets (O(1) context switch)
# -------------------------

_PROGRAM_STATES: dict[str, dict] = {}   # 程序名 -> 状态桶（内存引用交换，不序列化）
_active_program: str | None = None      # 当前激活的程序名

# 桶字段名 -> 全局变量名
_BUCKET_GLOBALS = (
    ("whitelist_exact", "_WHITELIST_EXACT"),
    ("whitelist_prefix", "_WHITELIST_PREFIX"),
    ("whitelist_addr_map", "_WHITELIST_ADDR_MAP"),
    ("whitelist_addr_ready", "_WHITELIST_ADDR_READY"),
    ("whitelist_objfile_names", "_WHITELIST_ADDR_OBJFILES"),
    ("async_symbol_set", "_ASYNC_SYMBOL_SET"),
    ("callsite_installed", "_CALLSITE_INSTALLED_FOR_FN"),
    ("callsite_addrs_by_fn", "_CALLSITE_ADDRS_BY_FN"),
    ("active_roots", "_ACTIVE_ROOTS"),
    ("co_by_key", "_CO_BY_KEY"),
    ("co_meta", "_CO_META"),
    ("co_poll_seq", "_CO_POLL_SEQ"),
    ("tls_stack", "_TLS_STACK"),
    ("co_next_id", "_CO_NEXT_ID"),
)


def _new_bucket() -> dict:
    """新建空状态桶。"""
    return {
        "whitelist_exact": None,
        "whitelist_prefix": None,
        "whitelist_addr_map": {},
        "whitelist_addr_ready": False,
        "whitelist_objfile_names": set(),
        "async_symbol_set": None,
        "callsite_installed": set(),
        "callsite_addrs_by_fn": {},
        "active_roots": set(),
        "co_by_key": {},
        "co_meta": {},
        "co_poll_seq": {},
        "tls_stack": {},
        "co_next_id": 1,
    }


def _snapshot_bucket() -> dict:
    """把当前全局状态收集为一个桶（引用交换，无序列化）。"""
    return {k: globals()[g] for k, g in _BUCKET_GLOBALS}


def _activate_program(name: str) -> None:
    """O(1) 程序上下文切换：全局状态存回旧程序桶，装入目标程序桶。"""
    global _active_program
    if name == _active_program:
        return
    if _active_program is not None:
        _PROGRAM_STATES[_active_program] = _snapshot_bucket()
    _active_program = name
    bucket = _PROGRAM_STATES.get(name)
    if bucket is None:
        bucket = _new_bucket()
        _PROGRAM_STATES[name] = bucket
    for k, g in _BUCKET_GLOBALS:
        globals()[g] = bucket[k]


# -------------------------
# Program identity (event-driven + PC ranges)
# -------------------------

# 事件驱动：init_user hook 命中时由 TS 侧经 ardb-set-current-program 更新
_CURRENT_USER_PROGRAM = "user"

# 默认内存区间（与 launch.json 的 kernel_memory_ranges/user_memory_ranges 一致，
# 可经 ardb-set-memory-ranges 覆盖）
_KERNEL_RANGES = [(0xFFFFFFC000000000, 0xFFFFFFFFFFFFFFFF)]
_USER_RANGES = [(0x0000000000000000, 0x0000004000000000)]


def _normalize_program_name(name: str) -> str:
    """去掉程序名前导斜杠（task 名常为 "/pipetest" 形式）。"""
    s = name.strip()
    return s[1:] if s.startswith("/") else s


def _in_addr_ranges(pc: int, ranges) -> bool:
    for lo, hi in ranges:
        if lo <= pc <= hi:
            return True
    return False


def _current_program() -> str:
    """判定当前选中线程（命中 vCPU）所属程序：内核 or 事件驱动的当前用户程序。"""
    try:
        pc = _current_pc()
    except Exception:
        return "kernel"
    if _in_addr_ranges(pc, _KERNEL_RANGES):
        return "kernel"
    return _normalize_program_name(_CURRENT_USER_PROGRAM)


def _ensure_active_program() -> None:
    """判定当前命中 vCPU 的程序并激活其状态桶（幂等，O(1) 早退）。"""
    _activate_program(_current_program())


# -------------------------
# Low-level helpers
# -------------------------

CALL_MNEMONIC_RE = re.compile(
    # x86 call/callq/callplt；RISC-V call 伪指令由 "call" 覆盖、jal（直接）、
    # jalr（间接，rd=zero 是 tail call 不记录；调试机实测格式 "jalr 874(ra)" /
    # "jalr -774(ra)"，位移可为负故不能依赖尾部词边界）、压缩形式 c.jalr/c.j；
    # AArch64 bl（直接）/blr（间接）
    r"^\s*(?:call\w*|jalr\s+(?!zero\b)|jal\b|c\.jalr|c\.j\b|bl\b|blr\b)",
    re.IGNORECASE)
HEX_ADDR_RE = re.compile(r"(0x[0-9a-fA-F]+)")

def _ptr_size() -> int:
    try:
        return gdb.lookup_type("char").pointer().sizeof
    except gdb.error:
        try:
            return gdb.lookup_type("unsigned char").pointer().sizeof
        except gdb.error:
            return 8

def _read_ptr(addr: int) -> int:
    inf = gdb.selected_inferior()
    ps = _ptr_size()
    mem = inf.read_memory(addr, ps).tobytes()
    if ps == 8:
        return struct.unpack("<Q", mem)[0]
    return struct.unpack("<I", mem)[0]

def _reg_u64(name: str) -> int:
    val = int(gdb.parse_and_eval(f"${name}"))
    # Mask to unsigned — GDB may return negative Python ints for addresses
    # with the high bit set (e.g. RISC-V kernel pointers above 0x80000000...).
    # Without this, hex(this_ptr) produces negative hex strings like
    # "-0x3f7fcae370" which the TS-side parseAddr can't classify as kernel/user.
    ps = _ptr_size()
    mask = (1 << (ps * 8)) - 1
    return val & mask

def _arg_reg() -> str:
    """Return the register name for the first C argument on the current architecture."""
    try:
        arch = gdb.selected_frame().architecture().name()
    except Exception:
        return "rdi"
    if "riscv" in arch:
        return "a0"
    if "aarch64" in arch:
        return "x0"
    return "rdi"  # x86_64

def _arg_reg() -> str:
    """Return the register name for the first C argument on the current architecture."""
    try:
        arch = gdb.selected_frame().architecture().name()
    except Exception:
        return "rdi"
    if "riscv" in arch:
        return "a0"
    if "aarch64" in arch:
        return "x0"
    return "rdi"  # x86_64

def _current_pc() -> int:
    return int(gdb.parse_and_eval("$pc"))

def _current_function_name() -> str:
    f = gdb.selected_frame()
    return f.name() or "<unknown>"

def _normalize_addr(addr):
    try:
        a = int(addr)
    except Exception:
        try:
            a = int(str(addr), 0)
        except Exception:
            return None

    try:
        ptr_bits = _ptr_size() * 8
        mask = (1 << ptr_bits) - 1
        a &= mask
    except Exception:
        pass

    return a

def _info_symbol_raw(addr):
    a = _normalize_addr(addr)
    if a is None:
        return ""
    try:
        return gdb.execute(f"info symbol 0x{a:x}", to_string=True).strip()
    except gdb.error:
        return ""

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

def _direct_call_target_from_asm(asm: str) -> int | None:
    """仅对直接调用文本抠目标立即数；间接形式返回 None（安装时无法判定）。"""
    s = asm.strip()
    # 间接调用形式（寄存器/内存槽目标）不在此解析
    if "*" in s or s.startswith("jalr") or s.startswith("c.jalr") or s.startswith("blr"):
        return None
    if "0x" not in s:
        return None
    m = HEX_ADDR_RE.search(s)
    if m is None:
        return None
    return int(m.group(1), 16)

def _should_install_callsite(target_addr: int) -> bool:
    """安装时过滤：判定与命中时 _pick_interesting_callee 的三路径完全一致。
    True = 直接调用目标值得插桩。"""
    if _whitelist_enabled() and _WHITELIST_ADDR_READY:
        if _whitelist_allows_by_addr(target_addr):
            return True
        for n in _callee_candidates(target_addr):
            n2 = _normalize_sym_name(n)
            if _whitelist_allows_by_name(n2):
                return True
        return False

    if _whitelist_enabled():
        for n in _callee_candidates(target_addr):
            n2 = _normalize_sym_name(n)
            if _whitelist_allows_by_name(n2):
                return True
        return False

    # 无白名单：只看 poll-ish 名字
    for n in _callee_candidates(target_addr):
        if _is_pollish_name(n):
            return True
    return False

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
        if not CALL_MNEMONIC_RE.match(asm):
            continue
        a = int(ins["addr"])
        if a in seen:
            continue
        # 直接调用：安装时解析目标并按白名单/启发式过滤（与命中时判定一致）；
        # 间接调用：目标在寄存器/内存槽，运行时才知道，全部照插。
        target = _direct_call_target_from_asm(asm)
        if target is not None and not _should_install_callsite(target):
            continue
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

def _jalr_operands_from_asm(asm: str) -> tuple[str, int] | None:
    """解析 RISC-V jalr 反汇编形态，返回 (基址寄存器, 位移)。None = 非 jalr。

    调试机实测格式（riscv64-unknown-elf-gdb）："jalr 874(ra)" / "jalr -774(ra)"
    ——无逗号、位移+括号基址寄存器（Rust/RISC-V 的调用基本全走 auipc+jalr，
    反汇编器解析成该形态）；其余形态做防御性覆盖。"""
    s = asm.strip()

    # 实测主形态：jalr off(reg)
    m = re.search(r"jalr\s+([\-0-9a-fx]+)\((\w+)\)", s)
    if m:
        off_s, reg = m.group(1), m.group(2)
        off = int(off_s, 16) if off_s.startswith(("0x", "-0x")) else int(off_s, 10)
        return reg, off

    # 带逗号的变体：jalr rd, off(reg)
    m = re.search(r"jalr\s+\w+\s*,\s*([\-0-9a-fx]+)\((\w+)\)", s)
    if m:
        off_s, reg = m.group(1), m.group(2)
        off = int(off_s, 16) if off_s.startswith(("0x", "-0x")) else int(off_s, 10)
        return reg, off

    # 零偏移缩写：jalr reg
    m = re.match(r"jalr\s+(\w+)\s*$", s)
    if m:
        return m.group(1), 0

    # 压缩形式：c.jalr rs
    m = re.match(r"c\.jalr\s+(\w+)\s*$", s)
    if m:
        return m.group(1), 0

    return None

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

    # call *disp(%rip)  (x86_64: ff 15 disp32 ; instruction length is 6 bytes)
    m = re.search(r"call\w*\s+\*([\-0-9a-fx]+)\(\%rip\)", s)
    if m:
        disp_s = m.group(1)
        disp = int(disp_s, 16) if disp_s.startswith(("0x", "-0x")) else int(disp_s, 10)
        pc = _current_pc()
        slot = pc + 6 + disp  # RIP-relative base = next instruction
        return _read_ptr(slot)

    # call *disp(%reg)
    m = re.search(r"call\w*\s+\*([\-0-9a-fx]+)\(\%([a-z0-9]+)\)", s)
    if m:
        disp_s, base = m.group(1), m.group(2)
        disp = int(disp_s, 16) if disp_s.startswith(("0x", "-0x")) else int(disp_s, 10)
        slot = _reg_u64(base) + disp
        return _read_ptr(slot)

    # RISC-V: jal ra, 0xADDR —— 直接调用（jal 后面必须跟空白，排除 jalr）
    if re.match(r"jal\s", s) and "0x" in s:
        m = HEX_ADDR_RE.search(s)
        if m:
            return int(m.group(1), 16)
        return None

    # RISC-V: jalr 的多种反汇编形态 → 目标 = 基址寄存器 + 位移
    operands = _jalr_operands_from_asm(s)
    if operands is not None:
        reg, off = operands
        return _reg_u64(reg) + off

    return None


# -------------------------
# __awaitee extraction (best-effort)
# -------------------------

def _pollsym_to_envtype(poll_sym: str) -> str | None:
    s = poll_sym
    s = s.replace("{async_fn#", "{async_fn_env#")
    s = s.replace("{async_block#", "{async_block_env#")
    return s if s != poll_sym else None


def _read_env_state(poll_sym: str, this_ptr: int):
    """
    Read the state discriminant from an async env struct.

    Returns a value suitable for the snapshot 'state' field:
      - An integer (the raw __state discriminant) if readable
      - A string like "N/A" if the env type can't be resolved
      - Falls back to reading the first field of the env struct
        if __state is not present (e.g. manual Future impls)
    """
    if not this_ptr:
        return "N/A"

    env_type_name = _pollsym_to_envtype(poll_sym)
    if not env_type_name:
        return "N/A"

    try:
        env_t = gdb.lookup_type(env_type_name)
        env_val = gdb.Value(this_ptr).cast(env_t.pointer()).dereference()

        # Primary: try the well-known __state field
        try:
            return int(env_val["__state"])
        except Exception:
            pass

        # Fallback: read the first field as discriminant
        # (common for manually implemented futures where the first
        #  field is often a bool or enum indicating completion)
        try:
            fields = env_t.fields()
            if fields:
                first_val = env_val[fields[0].name]
                first_code = first_val.type.strip_typedefs().code
                if first_code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL,
                                  gdb.TYPE_CODE_ENUM):
                    return int(first_val)
        except Exception:
            pass

    except Exception:
        pass

    return "N/A"

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
        env_ptr = _reg_u64(_arg_reg())
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

def _grouped_json_path() -> str:
    """按当前 objfile 组合定位 grouped JSON：缓存文件优先，回退固定路径。"""
    from async_rust_debugger.static_analysis import gen_whitelist
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        raise RuntimeError("ASYNC_RUST_DEBUGGER_TEMP_DIR is not set")
    fixed = os.path.join(os.getcwd(), temp_dir, "poll_functions_grouped.json")
    try:
        cache_file = gen_whitelist._cache_file_for_key(gen_whitelist._current_objfile_key())
        if os.path.exists(cache_file):
            return cache_file
    except Exception:
        pass
    return fixed

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
    global _WHITELIST_ADDR_MAP, _WHITELIST_ADDR_READY, _WHITELIST_ADDR_OBJFILES
    _WHITELIST_ADDR_MAP = {}
    _WHITELIST_ADDR_READY = False
    _WHITELIST_ADDR_OBJFILES = set()

def _try_addr_by_lookup_global_symbol(name: str) -> int | None:
    try:
        sym = gdb.lookup_global_symbol(name)
        if sym is None:
            return None
        v = sym.value()
        voidp = gdb.lookup_type("char").pointer()
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
    global _WHITELIST_ADDR_READY, _WHITELIST_ADDR_MAP, _WHITELIST_ADDR_OBJFILES

    # addr-map only for exact symbols
    if _WHITELIST_EXACT is None or _WHITELIST_ADDR_READY:
        return

    resolved = 0
    total = len(_WHITELIST_EXACT)
    addr_map = {}
    objfiles: set[str] = set()

    for name in _WHITELIST_EXACT:
        # 一次 lookup 同时拿地址与所属 objfile（构建时记录 objfile，
        # 供 save/restore 的多 objfile 检测使用）
        addr = None
        try:
            sym = gdb.lookup_global_symbol(name)
            if sym is not None:
                addr = int(sym.value().cast(gdb.lookup_type("char").pointer()))
                try:
                    objfiles.add(sym.symtab.objfile.filename)
                except Exception:
                    pass
        except Exception:
            addr = None
        if addr is None:
            addr = _try_addr_by_info_address(name)
        if addr is None:
            continue
        addr_map[int(addr)] = name
        resolved += 1

    _WHITELIST_ADDR_MAP = addr_map
    _WHITELIST_ADDR_OBJFILES = objfiles
    _WHITELIST_ADDR_READY = True

    if caller_is_user_visible and PRINT_WHITELIST_ADDR_STATS:
        prefix_n = len(_WHITELIST_PREFIX) if _WHITELIST_PREFIX else 0
        _log_ard(f"[ARD] whitelist addrs: {resolved}/{total} resolved (exact), prefix={prefix_n}")

def _whitelist_allows_by_addr(target_addr: int) -> str | None:
    if _WHITELIST_EXACT is None or not _WHITELIST_ADDR_READY:
        return None
    return _WHITELIST_ADDR_MAP.get(int(target_addr))

def _shift_addr_map(addr_map: dict, delta: int) -> dict:
    """把地址表整体平移 delta（同一 ELF 换基址时使用）。"""
    if delta == 0:
        return dict(addr_map)
    return {a + delta: name for a, name in addr_map.items()}

def _resolve_anchor_delta(cached_map: dict) -> int | None:
    """锚点校验：解析缓存表中最小地址符号的当前地址，返回新址与旧址之差。
    None = 无法解析（放弃复用，回退懒重建）。"""
    if not cached_map:
        return None
    old_addr = min(cached_map.keys())
    name = cached_map[old_addr]
    new_addr = _try_addr_by_lookup_global_symbol(name)
    if new_addr is None:
        new_addr = _try_addr_by_info_address(name)
    if new_addr is None:
        return None
    return new_addr - old_addr

# -------------------------
# Logging helpers (runtime)
# -------------------------

def _default_log_path() -> str | None:
    cwd = os.getcwd()
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        return None
    return os.path.join(cwd, temp_dir, "ardb.log")

def _diag_log_path() -> str | None:
    cwd = os.getcwd()
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        return None
    return os.path.join(cwd, temp_dir, "ardb_diag.log")

def _DIAG_LOG(message: str):
    """Diagnostic log for debugging save/restore flow. Always writes to file and GDB console."""
    path = _diag_log_path()
    if path:
        try:
            log_dir = os.path.dirname(path)
            if not os.path.exists(log_dir):
                os.makedirs(log_dir, exist_ok=True)
            with open(path, "a", encoding="utf-8") as fp:
                fp.write(message + "\n")
        except Exception:
            pass
    gdb.write("[DIAG] " + message + "\n")

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
    """
    Check whether a symbol is an async function.
    Uses the same criteria as gen_whitelist._classify_symbol:
    1. Name contains {async_fn# or {async_block# (compiler-generated async)
    2. Symbol is in the async set from the grouped whitelist (e.g. manual Future::poll impls)
    """
    if ("{async_fn#" in sym_name) or ("{async_block#" in sym_name):
        return True
    if _ASYNC_SYMBOL_SET is not None and sym_name in _ASYNC_SYMBOL_SET:
        return True
    return False

def _load_async_symbol_set_from_grouped():
    """
    Load the async symbol set from poll_functions_grouped.json.
    Called after whitelist generation or when the grouped JSON is first read.
    """
    global _ASYNC_SYMBOL_SET
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        return
    grouped_path = os.path.join(os.getcwd(), temp_dir, "poll_functions_grouped.json")
    if not os.path.exists(grouped_path):
        return
    try:
        with open(grouped_path, "r", encoding="utf-8") as fp:
            data = json.load(fp)
        async_set = set()
        for crate_info in data.get("crates", {}).values():
            for sym in crate_info.get("symbols", []):
                if sym.get("kind") == "async":
                    async_set.add(sym["name"])
        _ASYNC_SYMBOL_SET = async_set
    except Exception:
        pass


def _extract_raw_ptr(val: gdb.Value, depth: int = 0) -> int:
    """
    Recursively unwrap a GDB value to extract the raw memory address.

    Handles common Rust wrapper types:
      - Pin<P>      → struct with '__pointer' or 'pointer' field
      - Box<T>      → struct with 'pointer' field (Unique) containing '*mut T'
      - &mut T / &T → TYPE_CODE_REF / TYPE_CODE_RVALUE_REF
      - *mut T / *const T → TYPE_CODE_PTR
      - Unique<T>   → struct with 'pointer' field (NonNull) → inner '*const T'
      - NonNull<T>  → struct with 'pointer' field → '*const T'

    Recursion depth is capped to avoid infinite loops on pathological types.
    """
    if depth > 8:
        return int(val) if val else 0

    try:
        ty = val.type.strip_typedefs()
        code = ty.code

        # Pointer or reference — this is what we want
        if code in (gdb.TYPE_CODE_PTR, gdb.TYPE_CODE_REF, gdb.TYPE_CODE_RVALUE_REF):
            return int(val)

        # Struct — drill into known wrapper fields
        if code == gdb.TYPE_CODE_STRUCT:
            # Try well-known inner-pointer field names in priority order
            for field_name in ('__pointer', 'pointer', 'data', 'inner', 'value'):
                try:
                    inner = val[field_name]
                    result = _extract_raw_ptr(inner, depth + 1)
                    if result > 0xffff:  # looks like a valid pointer
                        return result
                except Exception:
                    pass

            # Generic single-field struct (common in Rust newtypes)
            try:
                fields = ty.fields()
                if len(fields) == 1:
                    inner = val[fields[0].name]
                    result = _extract_raw_ptr(inner, depth + 1)
                    if result > 0xffff:
                        return result
            except Exception:
                pass

        # Fallback — direct integer conversion
        result = int(val)
        return result if result > 0xffff else 0
    except Exception:
        return 0


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
    _DIAG_LOG("[DIAG] _cleanup_run_scoped() called: "
              f"|_RUN_SCOPED_BPS|={len(_RUN_SCOPED_BPS)}, "
              f"|_CALLSITE_INSTALLED_FOR_FN|={len(_CALLSITE_INSTALLED_FOR_FN)}, "
              f"|_CO_BY_KEY|={len(_CO_BY_KEY)}, "
              f"|_ACTIVE_ROOTS|={len(_ACTIVE_ROOTS)}, "
              f"|_CREATED_BPS|={len(_CREATED_BPS)}")
    for bp in list(_RUN_SCOPED_BPS):
        try:
            bp.delete()
        except Exception:
            pass
    _RUN_SCOPED_BPS.clear()

    _CALLSITE_INSTALLED_FOR_FN.clear()
    _CALLSITE_ADDRS_BY_FN.clear()
    _invalidate_whitelist_addrs()

    _TLS_STACK.clear()
    _CO_BY_KEY.clear()
    _CO_META.clear()
    _CO_POLL_SEQ.clear()
    global _CO_NEXT_ID
    _CO_NEXT_ID = 1
    _DIAG_LOG("[DIAG] _cleanup_run_scoped() done: all run-scoped state cleared")

def _on_exited(event):
    _DIAG_LOG("[DIAG] _on_exited() fired")
    _profile_report()
    _cleanup_run_scoped()

def _on_new_objfile(event):
    objfile_name = getattr(event, 'new_objfile', None)
    if objfile_name is not None:
        try:
            _DIAG_LOG(f"[DIAG] _on_new_objfile() fired: {objfile_name.filename}")
        except Exception:
            _DIAG_LOG("[DIAG] _on_new_objfile() fired: (unable to get filename)")
    else:
        _DIAG_LOG("[DIAG] _on_new_objfile() fired")
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

    @_profiled("poll_entry")
    def stop(self) -> bool:
        t_s = _profile_now()
        fn = _current_function_name()

        # ---- coro context enter (best-effort) ----
        tid = _thread_id()
        try:
            this_ptr = _reg_u64(_arg_reg())   # x86_64 SysV: first arg (env ptr)
        except Exception:
            this_ptr = 0

        poll_sym = self.poll_sym or fn
        cid = 0
        is_new = False
        depth = -1

        if poll_sym and this_ptr and _is_async_symbol(poll_sym):
            cid, is_new = _get_or_make_coro_id(poll_sym, this_ptr)
            depth = _push_coro(cid)
            # gdb.FinishBreakpoint is broken on RISC-V (GDB 15): the C-level
            # bpfinishpy_pre_stop_hook may crash with an assertion failure even
            # when the Python constructor succeeds.  Skip entirely on riscv.
            try:
                _arch = gdb.selected_frame().architecture().name()
            except Exception:
                _arch = ""
            if "riscv" not in _arch:
                try:
                    _PopOnReturnBP(tid, cid)
                except Exception:
                    pass  # gdb.FinishBreakpoint may not work on all arch/optimizations

        indent = "  " * max(depth, 0)

        # poll sequence per coro instance
        seq = 0
        if cid:
            seq = _CO_POLL_SEQ.get(cid, 0) + 1
            _CO_POLL_SEQ[cid] = seq

        _profile_section("poll_entry", "coro_setup", t_s)
        t_s = _profile_now()

        _build_whitelist_addr_map_if_needed(caller_is_user_visible=(not self.internal))

        # new coro line
        if cid and is_new:
            _log_ard(f"[ARD]{indent} coro#{cid} new: {poll_sym} @ {this_ptr:#x}") # 使用默认的 False

        # poll line
        if (not self.internal) or PRINT_INTERNAL_POLL_HITS:
            _log_ard(f"[ARD]{indent} poll[coro#{cid} poll#{seq}] {fn}") # 使用默认的 False

        _profile_section("poll_entry", "log_poll", t_s)
        t_s = _profile_now()

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

        _profile_section("poll_entry", "awaitee", t_s)
        t_s = _profile_now()

        # Install call-site breakpoints once per function (per run)
        if fn not in _CALLSITE_INSTALLED_FOR_FN:
            try:
                call_sites = _collect_call_sites()
            except gdb.error as e:
                if (not self.internal) or PRINT_INTERNAL_POLL_HITS:
                    _log_ard(f"[ARD]{indent} call-site scan failed: {e}")
                _profile_section("poll_entry", "callsite_install", t_s)
                return False

            for a in call_sites:
                CallSiteBP(a)

            _CALLSITE_INSTALLED_FOR_FN.add(fn)
            _CALLSITE_ADDRS_BY_FN[fn] = list(call_sites)
            _DIAG_LOG(f"[DIAG] PollEntryBP.stop(): installed {len(call_sites)} CallSiteBPs for '{fn}'")
            if (not self.internal) or PRINT_INTERNAL_POLL_HITS:
                _log_ard(f"[ARD]{indent} call-sites: {len(call_sites)}")
        else:
            _DIAG_LOG(f"[DIAG] PollEntryBP.stop(): SKIPPED call-site scan for '{fn}' - already in _CALLSITE_INSTALLED_FOR_FN")

        _profile_section("poll_entry", "callsite_install", t_s)
        return False


class CallSiteBP(gdb.Breakpoint):
    def __init__(self, addr: int):
        super().__init__(f"*{addr:#x}", type=gdb.BP_BREAKPOINT, internal=True)
        self.silent = True
        self.addr = addr
        _CREATED_BPS.append(self)
        _RUN_SCOPED_BPS.append(self)

    @_profiled("call_site")
    def stop(self) -> bool:
        t_s = _profile_now()
        target = _resolve_call_target_from_asm(_current_asm())
        _profile_section("call_site", "asm+resolve", t_s)
        if not target:
            return False

        t_s = _profile_now()
        callee = _pick_interesting_callee(target)
        _profile_section("call_site", "callee_lookup", t_s)
        if not callee:
            return False

        caller = _current_function_name()
        cid, depth = _current_coro()
        indent = "  " * max(depth, 0)
        seq = _CO_POLL_SEQ.get(cid, 0) if cid else 0

        t_s = _profile_now()

        # call line (no output dedup)
        _log_ard(f"[ARD]{indent} call[coro#{cid} poll#{seq}] {caller} -> {callee}") # 使用默认的 False

        _profile_section("call_site", "log_call", t_s)

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


class ARDTraceUserCrateCommand(gdb.Command):
    """
    Trace all async symbols of a user crate. Called automatically after a
    breakpoint-group switch when the user-space ELF symbols are loaded, so
    user-space coroutines enter the shadow stack (the physical-stack tail in
    ardb-get-snapshot then appends the kernel frames for the full chain).
    Usage: ardb-trace-user-crate <crate_name>
    """
    def __init__(self):
        super().__init__("ardb-trace-user-crate", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        crate = arg.strip()
        if not crate:
            gdb.write("Usage: ardb-trace-user-crate <crate_name>\n")
            return

        temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
        if not temp_dir:
            gdb.write('[ARD] ASYNC_RUST_DEBUGGER_TEMP_DIR is not set.\n')
            return

        grouped_path = _grouped_json_path()
        if not os.path.exists(grouped_path):
            gdb.write('[ARD] grouped whitelist not found. Run ardb-gen-whitelist first.\n')
            return

        try:
            with open(grouped_path, "r", encoding="utf-8") as fp:
                grouped_data = json.load(fp)
        except Exception as e:
            gdb.write(f'[ARD] failed to read grouped whitelist: {e}\n')
            return

        crate_info = grouped_data.get("crates", {}).get(crate)
        if not crate_info:
            gdb.write(f'[ARD] crate not found in whitelist: {crate}\n')
            return

        syms = [s["name"] for s in crate_info.get("symbols", []) if s.get("kind") == "async"]
        traced = 0
        for sym in syms:
            if sym in _ACTIVE_ROOTS:
                continue
            _ACTIVE_ROOTS.add(sym)
            PollEntryBP(sym, poll_sym=sym, internal=False, temporary=False)
            traced += 1
        gdb.write(
            f'[ARD] trace-user-crate {crate}: {traced} async symbols traced '
            f'(total {len(syms)} async, {len(crate_info.get("symbols", []))} symbols)\n'
        )


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
        for bp in list(_RUN_SCOPED_BPS):
            try:
                bp.delete()
            except Exception:
                pass
        _RUN_SCOPED_BPS.clear()

        _CALLSITE_INSTALLED_FOR_FN.clear()
        _CALLSITE_ADDRS_BY_FN.clear()
        _ACTIVE_ROOTS.clear()
        _SAVED_STATES.clear()
        global _active_program
        _PROGRAM_STATES.clear()
        _active_program = None

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


class ARDProfileReportCommand(gdb.Command):
    """Print accumulated stop() timing statistics and reset them.
    Useful in OS mode where the inferior never exits.
    Usage: ardb-profile-report"""

    def __init__(self):
        super().__init__("ardb-profile-report", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        _profile_report()


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
            # Populate the async symbol set from the newly generated grouped JSON
            _load_async_symbol_set_from_grouped()
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

            node_type = "async" if _is_async_symbol(poll_sym) else "sync"

            state_val = _read_env_state(poll_sym, this_ptr)

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
            
        # 2. Extract the physical stack tail (frames above the top traced function).
        #    When the shadow stack is EMPTY (e.g. stopped in sync code, or before
        #    the first poll of an async fn), fall back to the full physical stack
        #    so the tree still shows the complete call chain — top_async_func is
        #    "" in that case, so every frame is appended (async/sync classified).
        phys_tail = []
        shadow_cids = set(stack)  # CIDs already on the shadow stack
        try:
            saved_frame = gdb.selected_frame()
            frame = saved_frame
            frame_count = 0
            MAX_PHYS_FRAMES = 40
            while frame and frame_count < MAX_PHYS_FRAMES:
                frame_count += 1
                fname = frame.name()

                # Stop if we reach the entry of the top traced function
                # to avoid duplication with the shadow stack
                if fname == top_async_func:
                    break

                if fname:
                    frame_type = "async" if _is_async_symbol(fname) else "sync"

                    # Get source location from the frame
                    phys_file = ""
                    phys_fullname = ""
                    phys_line = 0
                    try:
                        sal = frame.find_sal()
                        if sal and sal.symtab:
                            phys_file = sal.symtab.filename or ""
                            phys_fullname = sal.symtab.fullname() if hasattr(sal.symtab, 'fullname') else phys_file
                            phys_line = sal.line or 0
                    except Exception:
                        pass

                    node_cid = None
                    node_poll = 0
                    node_state = "NON-ASYNC"
                    node_addr = hex(frame.pc())

                    if frame_type == "async":
                        # For async frames, try to read the env ptr from the
                        # frame's debug info (first argument / self).
                        node_state = "N/A"
                        this_ptr = 0
                        try:
                            frame.select()
                            block = frame.block()
                            for sym in block:
                                if sym.is_argument:
                                    val = frame.read_var(sym)
                                    # The first arg is typically Pin<&mut Self>.
                                    # Pin { __pointer: &mut T } — we need the
                                    # raw pointer inside.  Try to drill through
                                    # Pin and reference layers.
                                    this_ptr = _extract_raw_ptr(val)
                                    break
                        except Exception:
                            pass
                        # Fallback: read the frame's OWN saved argument register
                        # (restored via CFA). Do NOT use the global $a0 — it
                        # belongs to the innermost frame and is meaningless for
                        # intermediate async frames on the physical stack.
                        if not this_ptr:
                            try:
                                frame.select()
                                reg_val = frame.read_register(_arg_reg())
                                if reg_val is not None:
                                    this_ptr = _extract_raw_ptr(reg_val)
                            except Exception:
                                pass
                        # Last resort: global arg register (only meaningful when
                        # this frame IS the innermost one, e.g. stopped at the
                        # poll entry itself).
                        if not this_ptr:
                            try:
                                this_ptr = _reg_u64(_arg_reg())
                            except Exception:
                                pass

                        # Defer CID assignment: store this_ptr temporarily;
                        # CIDs will be assigned in outermost-first order (after
                        # reversing phys_tail) so that CID numbers increase
                        # with nesting depth, matching the logical call order.
                        if this_ptr:
                            phys_tail.append({
                                "type": frame_type,
                                "cid": None,
                                "func": fname,
                                "addr": node_addr,
                                "poll": 0,
                                "state": node_state,
                                "file": phys_file,
                                "fullname": phys_fullname,
                                "line": phys_line,
                                "_this_ptr": this_ptr,
                                "_fname": fname,
                            })
                            frame = frame.older()
                            continue

                    phys_tail.append({
                        "type": frame_type,
                        "cid": node_cid,
                        "func": fname,
                        "addr": node_addr,
                        "poll": node_poll,
                        "state": node_state,
                        "file": phys_file,
                        "fullname": phys_fullname,
                        "line": phys_line
                    })
                frame = frame.older()

            # Restore the originally selected frame
            try:
                saved_frame.select()
            except Exception:
                pass
        except Exception:
            pass

        # Assign CIDs to deferred async frames in outermost-first order
        # (reversed phys_tail), so CID numbers increase monotonically with
        # call depth.  Without this deferred pass, the innermost-first
        # walk would assign smaller CIDs to deeper frames, reversing the
        # natural nesting order.
        for item in reversed(phys_tail):
            if item.get("_this_ptr"):
                this_ptr = item.pop("_this_ptr")
                fname = item.pop("_fname")
                try:
                    cid_phys, is_new = _get_or_make_coro_id(fname, this_ptr)
                    if is_new:
                        nearby = _find_nearby_coro(fname, this_ptr)
                        if nearby is not None and nearby != cid_phys:
                            key_new = (fname, int(this_ptr))
                            _CO_BY_KEY.pop(key_new, None)
                            _CO_META.pop(cid_phys, None)
                            _CO_POLL_SEQ.pop(cid_phys, None)
                            cid_phys = nearby
                    if cid_phys not in shadow_cids:
                        item["cid"] = cid_phys
                        item["poll"] = _CO_POLL_SEQ.get(cid_phys, 0)
                        item["addr"] = hex(this_ptr)
                        item["state"] = _read_env_state(fname, this_ptr)
                except Exception:
                    pass

        # Physical frames are captured in reverse order (deepest first),
        # so we reverse them before appending to the path.
        snapshot["path"].extend(reversed(phys_tail))
            
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
            # Ensure async symbol set is populated when grouped whitelist is read
            if _ASYNC_SYMBOL_SET is None:
                _load_async_symbol_set_from_grouped()
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
        grouped_path = _grouped_json_path()
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

        # 白名单变了，已装的 callsite 断点全部过期：删除并清空集合，
        # 下次 poll 命中时按新白名单重扫重装（防重复插桩）。
        for bp in list(_CREATED_BPS):
            if isinstance(bp, CallSiteBP):
                try:
                    bp.delete()
                except Exception:
                    pass
                if bp in _CREATED_BPS:
                    _CREATED_BPS.remove(bp)
                if bp in _RUN_SCOPED_BPS:
                    _RUN_SCOPED_BPS.remove(bp)
        _CALLSITE_INSTALLED_FOR_FN.clear()
        _CALLSITE_ADDRS_BY_FN.clear()

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


class ARDSaveTraceStateCommand(gdb.Command):
    """Save current trace state so it can be restored after a group switch.
    Usage: ardb-save-trace-state <label>"""

    def __init__(self):
        super().__init__("ardb-save-trace-state", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        label = arg.strip()
        if not label:
            gdb.write("[ARD] Usage: ardb-save-trace-state <label>\n")
            return

        _DIAG_LOG(f"[DIAG] ardb-save-trace-state '{label}': BEGIN")
        _DIAG_LOG(f"[DIAG]   _CALLSITE_INSTALLED_FOR_FN = {sorted(_CALLSITE_INSTALLED_FOR_FN)}")
        _DIAG_LOG(f"[DIAG]   _ACTIVE_ROOTS = {sorted(_ACTIVE_ROOTS)}")
        _DIAG_LOG(f"[DIAG]   |_CREATED_BPS| = {len(_CREATED_BPS)}, PollEntryBP count = {sum(1 for bp in _CREATED_BPS if isinstance(bp, PollEntryBP))}, CallSiteBP count = {sum(1 for bp in _CREATED_BPS if isinstance(bp, CallSiteBP))}")

        # Snapshot PollEntryBP metadata before group switch deletes them.
        poll_entries: list[tuple[str, str, bool]] = []
        for bp in list(_CREATED_BPS):
            if isinstance(bp, PollEntryBP):
                poll_entries.append(
                    (str(bp.location), bp.poll_sym, bp.internal)
                )

        _DIAG_LOG(f"[DIAG]   saving {len(poll_entries)} PollEntryBP entries")

        # Serialize coroutine tracking state so poll sequences, shadow stack,
        # and coro IDs survive new_objfile → _cleanup_run_scoped() across
        # breakpoint-group switches (kernel ↔ user).
        co_by_key_list = [
            [sym, int(ptr), int(cid)]
            for (sym, ptr), cid in _CO_BY_KEY.items()
        ]
        co_meta_dict = {
            str(cid): [sym, int(ptr)]
            for cid, (sym, ptr) in _CO_META.items()
        }
        co_poll_seq_dict = {
            str(cid): int(seq)
            for cid, seq in _CO_POLL_SEQ.items()
        }
        tls_stack_dict = {
            str(tid): [int(c) for c in stack]
            for tid, stack in _TLS_STACK.items()
        }

        state = {
            "active_roots": set(_ACTIVE_ROOTS),
            "callsite_installed": set(_CALLSITE_INSTALLED_FOR_FN),
            "callsite_addrs_by_fn": {
                fn: list(addrs) for fn, addrs in _CALLSITE_ADDRS_BY_FN.items()
            },
            "whitelist_exact": (
                set(_WHITELIST_EXACT) if _WHITELIST_EXACT is not None else None
            ),
            "whitelist_prefix": (
                list(_WHITELIST_PREFIX) if _WHITELIST_PREFIX is not None else None
            ),
            "whitelist_addr_map": dict(_WHITELIST_ADDR_MAP),
            "whitelist_addr_ready": _WHITELIST_ADDR_READY,
            "whitelist_objfile_names": sorted(_WHITELIST_ADDR_OBJFILES),
            "async_symbol_set": (
                set(_ASYNC_SYMBOL_SET) if _ASYNC_SYMBOL_SET is not None else None
            ),
            "poll_entries": poll_entries,
            # coroutine tracking (per-group)
            "co_by_key": co_by_key_list,
            "co_meta": co_meta_dict,
            "co_poll_seq": co_poll_seq_dict,
            "tls_stack": tls_stack_dict,
            "co_next_id": _CO_NEXT_ID,
        }
        _SAVED_STATES[label] = state
        # 桶同步：当前全局状态即该程序的状态（引用交换，无序列化）
        global _active_program
        _PROGRAM_STATES[label] = _snapshot_bucket()
        _active_program = label
        _DIAG_LOG(f"[DIAG] ardb-save-trace-state '{label}': DONE. "
                  f"callsite_installed saved = {sorted(state['callsite_installed'])}")
        gdb.write(
            f"[ARD] saved trace state '{label}': "
            f"{len(poll_entries)} poll entries, "
            f"{len(_ACTIVE_ROOTS)} active roots, "
            f"{len(_CALLSITE_INSTALLED_FOR_FN)} scanned fns, "
            f"{len(co_by_key_list)} coros, "
            f"{_CO_NEXT_ID - 1} max cid\n"
        )


class ARDRestoreTraceStateCommand(gdb.Command):
    """Restore trace state previously saved by ardb-save-trace-state.
    Re-installs PollEntryBP instances under the current symbol table.
    Usage: ardb-restore-trace-state <label>"""

    def __init__(self):
        super().__init__("ardb-restore-trace-state", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        label = arg.strip()
        if not label:
            gdb.write("[ARD] Usage: ardb-restore-trace-state <label>\n")
            return

        _DIAG_LOG(f"[DIAG] ardb-restore-trace-state '{label}': BEGIN")
        state = _SAVED_STATES.pop(label, None)
        if state is None:
            _DIAG_LOG(f"[DIAG] ardb-restore-trace-state '{label}': NO SAVED STATE (pop returned None)")
            gdb.write(f"[ARD] no saved trace state for '{label}'\n")
            return

        saved_callsite = sorted(state.get("callsite_installed", set()))
        _DIAG_LOG(f"[DIAG]   state['callsite_installed'] = {saved_callsite}")
        _DIAG_LOG(f"[DIAG]   state['active_roots'] = {sorted(state.get('active_roots', set()))}")
        _DIAG_LOG(f"[DIAG]   state['poll_entries'] count = {len(state.get('poll_entries', []))}")
        _DIAG_LOG(f"[DIAG]   current _CALLSITE_INSTALLED_FOR_FN (before restore) = {sorted(_CALLSITE_INSTALLED_FOR_FN)}")

        # 1. Restore whitelist（地址表带锚点校验复用，见设计文档 §6.2）。
        global _WHITELIST_EXACT, _WHITELIST_PREFIX, _WHITELIST_ADDR_MAP
        global _WHITELIST_ADDR_READY, _WHITELIST_ADDR_OBJFILES, _ASYNC_SYMBOL_SET
        _WHITELIST_EXACT = state["whitelist_exact"]
        _WHITELIST_PREFIX = state["whitelist_prefix"]
        _ASYNC_SYMBOL_SET = state["async_symbol_set"]

        cached_map = state.get("whitelist_addr_map") or {}
        objfile_names = state.get("whitelist_objfile_names") or []
        reused = False
        reuse_delta = None
        if cached_map and len(objfile_names) == 1:
            # 单 objfile 才能安全地整体复用/平移；多 objfile 统一平移会改错另一侧地址
            delta = _resolve_anchor_delta(cached_map)
            if delta is not None:
                _WHITELIST_ADDR_MAP = _shift_addr_map(cached_map, delta)
                _WHITELIST_ADDR_OBJFILES = set(objfile_names)
                _WHITELIST_ADDR_READY = True
                reused = True
                reuse_delta = delta
        if not reused:
            _WHITELIST_ADDR_MAP = {}
            _WHITELIST_ADDR_OBJFILES = set()
            _WHITELIST_ADDR_READY = False
        _DIAG_LOG(f"[DIAG]   addr map reused={reused} "
                  f"(cached={len(cached_map)} entries, objfiles={len(objfile_names)})")

        # 2. Restore tracking bookkeeping.
        _ACTIVE_ROOTS.clear()
        _ACTIVE_ROOTS.update(state["active_roots"])
        _CALLSITE_INSTALLED_FOR_FN.clear()
        _CALLSITE_INSTALLED_FOR_FN.update(state["callsite_installed"])
        _DIAG_LOG(f"[DIAG]   _CALLSITE_INSTALLED_FOR_FN (after restore) = {sorted(_CALLSITE_INSTALLED_FOR_FN)}")

        # 3. Restore coroutine tracking state (must happen before PollEntryBP
        #    re-install so that _push_coro / _CO_POLL_SEQ lookup sees the
        #    saved CID namespace and poll sequences).
        global _CO_NEXT_ID
        _CO_BY_KEY.clear()
        for sym, ptr, cid in state.get("co_by_key", []):
            _CO_BY_KEY[(sym, int(ptr))] = int(cid)

        _CO_META.clear()
        for cid_str, pair in state.get("co_meta", {}).items():
            _CO_META[int(cid_str)] = (pair[0], int(pair[1]))

        _CO_POLL_SEQ.clear()
        for cid_str, seq in state.get("co_poll_seq", {}).items():
            _CO_POLL_SEQ[int(cid_str)] = int(seq)

        _TLS_STACK.clear()
        for tid_str, stack in state.get("tls_stack", {}).items():
            _TLS_STACK[int(tid_str)] = [int(c) for c in stack]

        _CO_NEXT_ID = int(state.get("co_next_id", 1))

        # 4. Delete existing breakpoints before re-installing to avoid
        #    exponential duplication across repeated kernel↔user group switches.
        for bp in list(_CREATED_BPS):
            try:
                bp.delete()
            except Exception:
                pass
        _CREATED_BPS.clear()
        for bp in list(_RUN_SCOPED_BPS):
            try:
                bp.delete()
            except Exception:
                pass
        _RUN_SCOPED_BPS.clear()
        # Also clean up any orphan PollEntryBP instances that survived the
        # delete above.  This can happen on RISC-V (GDB 15) when a symbol
        # file was removed before the BP's delete() was called — GDB may
        # fail silently, leaving the BP behind.  Without this sweep, each
        # kernel↔user group switch accumulates one more orphan BP at the
        # same location.
        for bp in list(gdb.breakpoints()):
            if isinstance(bp, PollEntryBP):
                try:
                    bp.delete()
                except Exception:
                    pass

        # 5. Re-install PollEntryBP for every saved entry.
        restored = 0
        for location, poll_sym, internal in state["poll_entries"]:
            try:
                PollEntryBP(
                    location,
                    poll_sym=poll_sym,
                    internal=internal,
                    temporary=False,
                )
                restored += 1
            except Exception as e:
                gdb.write(
                    f"[ARD] restore: failed to re-install PollEntryBP "
                    f"at '{location}': {e}\n"
                )

        # 5.5 Re-install CallSiteBP from saved addresses（仅 delta==0，地址仍有效）。
        #     否则清空集合，下次 poll 命中时按当前符号表重扫重装。
        if reuse_delta == 0:
            callsite_restored = 0
            for addrs in state.get("callsite_addrs_by_fn", {}).values():
                for a in addrs:
                    try:
                        CallSiteBP(int(a))
                        callsite_restored += 1
                    except Exception:
                        pass
            _DIAG_LOG(f"[DIAG]   callsites restored: {callsite_restored}")
        else:
            _CALLSITE_INSTALLED_FOR_FN.clear()
            _CALLSITE_ADDRS_BY_FN.clear()
            _DIAG_LOG("[DIAG]   callsites NOT restored (delta!=0/unresolved) -> rescan on next poll")

        # 桶同步：恢复后的全局状态存入该程序的桶（旧序列化格式由此迁移）
        global _active_program
        _PROGRAM_STATES[label] = _snapshot_bucket()
        _active_program = label

        coro_count = len(_CO_BY_KEY)
        gdb.write(
            f"[ARD] restored trace state '{label}': "
            f"{restored}/{len(state['poll_entries'])} poll entries, "
            f"{coro_count} coros\n"
        )


class ARDSetCurrentProgramCommand(gdb.Command):
    """Set the event-driven current user program name.
    Usage: ardb-set-current-program <name>"""
    def __init__(self):
        super().__init__("ardb-set-current-program", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        global _CURRENT_USER_PROGRAM
        name = arg.strip()
        if not name:
            gdb.write("[ARD] Usage: ardb-set-current-program <name>\n")
            return
        _CURRENT_USER_PROGRAM = _normalize_program_name(name)
        gdb.write(f"[ARD] current user program set: {_CURRENT_USER_PROGRAM}\n")


class ARDSetMemoryRangesCommand(gdb.Command):
    """Set kernel/user memory ranges for program classification.
    Usage: ardb-set-memory-ranges {"kernel": [[lo, hi], ...], "user": [[lo, hi], ...]}"""
    def __init__(self):
        super().__init__("ardb-set-memory-ranges", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        global _KERNEL_RANGES, _USER_RANGES
        try:
            payload = json.loads(arg)
            k = payload.get("kernel")
            u = payload.get("user")
            if k:
                _KERNEL_RANGES = [(int(lo, 0), int(hi, 0)) for lo, hi in k]
            if u:
                _USER_RANGES = [(int(lo, 0), int(hi, 0)) for lo, hi in u]
            gdb.write(f"[ARD] memory ranges set: kernel={_KERNEL_RANGES} user={_USER_RANGES}\n")
        except Exception as e:
            gdb.write(f"[ARD] failed to parse memory ranges: {e}\n")


class ARDResetTraceStateCommand(gdb.Command):
    """Discard saved trace state for a label.
    Usage: ardb-reset-trace-state <label>"""

    def __init__(self):
        super().__init__("ardb-reset-trace-state", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        label = arg.strip()
        if not label:
            gdb.write("[ARD] Usage: ardb-reset-trace-state <label>\n")
            return
        if label in _SAVED_STATES:
            del _SAVED_STATES[label]
            gdb.write(f"[ARD] cleared saved trace state '{label}'\n")
        else:
            gdb.write(f"[ARD] no saved trace state for '{label}'\n")


class ARDDiagCommand(gdb.Command):
    """Dump diagnostic state for debugging save/restore flow.
    Usage: ardb-diag"""

    def __init__(self):
        super().__init__("ardb-diag", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        gdb.write("=== ARDB Diagnostic State ===\n")
        gdb.write(f"_ACTIVE_ROOTS ({len(_ACTIVE_ROOTS)}): {sorted(_ACTIVE_ROOTS)}\n")
        gdb.write(f"_CALLSITE_INSTALLED_FOR_FN ({len(_CALLSITE_INSTALLED_FOR_FN)}): {sorted(_CALLSITE_INSTALLED_FOR_FN)}\n")
        gdb.write(f"_CREATED_BPS: {len(_CREATED_BPS)} total\n")
        poll_count = sum(1 for bp in _CREATED_BPS if isinstance(bp, PollEntryBP))
        call_count = sum(1 for bp in _CREATED_BPS if isinstance(bp, CallSiteBP))
        gdb.write(f"  PollEntryBP: {poll_count}, CallSiteBP: {call_count}\n")
        gdb.write(f"_RUN_SCOPED_BPS: {len(_RUN_SCOPED_BPS)}\n")
        gdb.write(f"_SAVED_STATES labels: {list(_SAVED_STATES.keys())}\n")
        for lbl, st in _SAVED_STATES.items():
            gdb.write(f"  '{lbl}': active_roots={len(st.get('active_roots',set()))}, "
                      f"callsite_installed={len(st.get('callsite_installed',set()))}, "
                      f"poll_entries={len(st.get('poll_entries',[]))}\n")
        gdb.write(f"_CO_BY_KEY: {len(_CO_BY_KEY)} entries, _CO_NEXT_ID={_CO_NEXT_ID}\n")
        gdb.write(f"_TLS_STACK: {dict((k,len(v)) for k,v in _TLS_STACK.items())}\n")
        gdb.write("=== End Diagnostic State ===\n")


# -------------------------
# Entry
# -------------------------

def install():
    global _EVENTS_INSTALLED

    gdb.execute("set pagination off", to_string=True)
    gdb.execute("set debuginfod enabled off", to_string=True)

    ARDTraceCommand()
    ARDResetCommand()
    ARDProfileReportCommand()
    ARDLoadWhitelistCommand()
    ARDGenWhitelistCommand()
    ARDGetSnapshotCommand()
    ARDGetGroupedWhitelistCommand()
    ARDUpdateWhitelistCommand()
    ARDInferTraceRootCommand()
    ARDTraceUserCrateCommand()
    ARDSaveTraceStateCommand()
    ARDRestoreTraceStateCommand()
    ARDResetTraceStateCommand()
    ARDSetCurrentProgramCommand()
    ARDSetMemoryRangesCommand()
    ARDDiagCommand()

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