import os
import re
import struct
import gdb
import json
# -------------------------
# Debug runtime_trace.py
# -------------------------
# import sys

# if os.environ.get("ARDB_PY_DEBUG") == "1":
#     preferred = os.environ.get("ARDB_DEBUGPY_PYTHON")

#     if preferred and os.path.exists(preferred):
#         sys.executable = preferred
#     elif (not sys.executable) or (not os.path.exists(sys.executable)) or sys.executable == "/usr/bin/python":
#         if os.path.exists("/usr/bin/python3"):
#             sys.executable = "/usr/bin/python3"

#     import debugpy
#     debugpy.listen(("127.0.0.1", 5678))
#     print(f"[runtime_trace] sys.executable = {sys.executable}")
#     print("[runtime_trace] waiting for debugger on 5678...")
#     debugpy.wait_for_client()
#     print("[runtime_trace] debugger attached.")

# -------------------------
# User-facing knobs
# -------------------------

MAX_CALLSITES_PER_FN = 1000

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
# parent poll symbol -> last observed direct child poll hit
_LAST_CHILD_HIT_BY_PARENT = {}
_LAST_CHILD_HIT_BY_CALLER_FRAME = {}
_LAST_CHILD_HIT_BY_FUNC_ADDR = {}
_LAST_CHILD_HIT_BY_STRUCTURED = {}
_CHILD_KEY_MISS_LOGGED = set()
_PRIVILEGE_STATE = "unknown"
_PRIVILEGE_TRANSITION_EVENT = "none"
_PRIVILEGE_LAST_SYMBOL = ""
_PRIVILEGE_LAST_PC = ""
_PRIVILEGE_ACTIVE_GROUP = "user"
_PRIVILEGE_BPS = {
    "user": [],
    "kernel": [],
}
_TRANSITION_PATH = []
_TRANSITION_SEQ = 0
_REL4_TRANSITION_PROBE_BPS = []

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
    st.append(cid)
    return len(st) - 1  # depth

def _current_coro():
    tid = _thread_id()
    st = _TLS_STACK.get(tid, [])
    return (st[-1], len(st) - 1) if st else (0, -1)


def _is_valid_state_value(value) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        s = value.strip()
        return s not in ("", "N/A", "unknown", "UNKNOWN", "<unknown>")
    return True


def _state_or_fallback(value, fallback):
    return value if _is_valid_state_value(value) else fallback


def _short_error(e, default: str = "") -> str:
    if e is None:
        return default
    cls = e.__class__.__name__
    mod = getattr(e.__class__, "__module__", "")
    if mod == "gdb":
        cls = f"gdb.{cls}"
    msg = str(e).strip()
    out = f"{cls}: {msg}" if msg else cls
    return out[:180]


def _state_info(state="N/A", status: str = "unsupported", error: str = ""):
    return {
        "state": state,
        "state_read_status": status,
        "state_read_error": error,
    }


def _state_fields(info):
    return {
        "state": info.get("state", "N/A"),
        "state_read_status": info.get("state_read_status", "unsupported"),
        "state_read_error": info.get("state_read_error", ""),
    }


def _child_hit_fields(match: str = "not_applicable", tid=None, parent_cid=None,
                      parent_symbol: str = "", child_symbol: str = "",
                      child_env_addr: str = ""):
    return {
        "child_hit_match": match,
        "child_hit_thread_id": tid,
        "child_hit_parent_cid": parent_cid,
        "child_hit_parent_symbol": parent_symbol or "",
        "child_hit_child_symbol": child_symbol or "",
        "child_hit_env_addr": child_env_addr or "",
    }


def _is_kernel_addr(addr) -> bool:
    a = _normalize_addr(addr)
    if a is None:
        return False
    try:
        ptr_bits = _ptr_size() * 8
    except Exception:
        ptr_bits = 64
    return a >= (1 << (ptr_bits - 1))


def _infer_privilege(addr=None, file: str = "", fullname: str = "", func: str = "") -> str:
    if addr:
        if _is_kernel_addr(addr):
            return "kernel"
        try:
            a = _normalize_addr(addr)
            if a is not None and a > 0:
                return "user"
        except Exception:
            pass

    text = " ".join(x for x in (file, fullname, func) if x).lower()
    if any(marker in text for marker in (
        "rel4_kernel/src",
        "/kernel/",
        "rustlib::",
        "trap_entry",
        "c_handle_",
        "decode_invocation",
    )):
        return "kernel"
    if any(marker in text for marker in (
        "rust-root-task-demo",
        "crates/example",
        "sel4_sys::",
        "sel4::",
    )):
        return "user"
    if _PRIVILEGE_STATE in ("user", "kernel", "transition"):
        return _PRIVILEGE_STATE
    return "unknown"


def _privilege_fields(addr=None, file: str = "", fullname: str = "", func: str = ""):
    privilege = _infer_privilege(addr, file, fullname, func)
    transition_event = "none"
    if _PRIVILEGE_TRANSITION_EVENT != "none":
        if privilege in ("kernel", "transition"):
            transition_event = _PRIVILEGE_TRANSITION_EVENT
    return {
        "privilege": privilege,
        "transition_event": transition_event,
    }


def _set_privilege_state(privilege: str, transition_event: str = "none",
                         symbol: str = "", pc=None):
    global _PRIVILEGE_STATE, _PRIVILEGE_TRANSITION_EVENT
    global _PRIVILEGE_LAST_SYMBOL, _PRIVILEGE_LAST_PC
    _PRIVILEGE_STATE = privilege if privilege in ("user", "kernel", "transition", "unknown") else "unknown"
    _PRIVILEGE_TRANSITION_EVENT = transition_event or "none"
    _PRIVILEGE_LAST_SYMBOL = symbol or ""
    if pc is None:
        _PRIVILEGE_LAST_PC = ""
    else:
        try:
            _PRIVILEGE_LAST_PC = f"{int(pc):#x}"
        except Exception:
            _PRIVILEGE_LAST_PC = str(pc)


def _set_privilege_group_enabled(group: str):
    global _PRIVILEGE_ACTIVE_GROUP
    group = (group or "").strip().lower()
    if group not in ("user", "kernel", "all", "none"):
        raise ValueError(f"unsupported privilege breakpoint group: {group}")
    _PRIVILEGE_ACTIVE_GROUP = group

    for bp_group, bps in _PRIVILEGE_BPS.items():
        enabled = group == "all" or group == bp_group
        if group == "none":
            enabled = False
        for bp in list(bps):
            try:
                if bp.is_valid():
                    bp.enabled = enabled
            except Exception:
                pass


def _register_privilege_bp(group: str, bp):
    group = (group or "").strip().lower()
    _PRIVILEGE_BPS.setdefault(group, []).append(bp)
    try:
        bp.enabled = _PRIVILEGE_ACTIVE_GROUP in ("all", group)
    except Exception:
        pass


def _clear_privilege_bps():
    for bps in _PRIVILEGE_BPS.values():
        for bp in list(bps):
            try:
                bp.delete()
            except Exception:
                pass
        bps.clear()


def _privilege_hit_label(label: str = "") -> str:
    if label:
        return label
    try:
        return _current_function_name()
    except Exception:
        return "<unknown>"


def _record_privilege_hit(group: str, label: str = ""):
    group = (group or "").strip().lower()
    symbol = _privilege_hit_label(label)
    try:
        pc = _current_pc()
    except Exception:
        pc = None

    if group == "user":
        _set_privilege_state("transition", "user_to_kernel", symbol, pc)
        _log_ard(f"[ARD][priv] user hit {symbol} pc={_PRIVILEGE_LAST_PC or 'unknown'}")
        _log_ard("[ARD][priv] transition user -> kernel")
        _set_privilege_group_enabled("kernel")
    elif group == "kernel":
        transition = _PRIVILEGE_TRANSITION_EVENT
        if transition == "none":
            transition = "user_to_kernel" if _PRIVILEGE_STATE in ("user", "transition") else "none"
        _set_privilege_state("kernel", transition, symbol, pc)
        _log_ard(f"[ARD][priv] kernel hit {symbol} pc={_PRIVILEGE_LAST_PC or 'unknown'}")
        _set_privilege_group_enabled("kernel")


def _record_async_privilege_hit(symbol: str):
    try:
        pc = _current_pc()
    except Exception:
        pc = None
    privilege = "kernel" if (pc is not None and _is_kernel_addr(pc)) else "user"
    transition = _PRIVILEGE_TRANSITION_EVENT
    if transition == "none" and privilege == "kernel" and _PRIVILEGE_STATE in ("user", "transition"):
        transition = "user_to_kernel"
    _set_privilege_state(privilege, transition, symbol, pc)
    _log_ard(f"[ARD][priv] {privilege} hit {symbol} pc={_PRIVILEGE_LAST_PC or 'unknown'}")


def _frame_source_fields():
    file = ""
    fullname = ""
    line = 0
    try:
        frame = gdb.selected_frame()
        sal = frame.find_sal()
        if sal and sal.symtab:
            file = sal.symtab.filename or ""
            try:
                fullname = sal.symtab.fullname()
            except Exception:
                fullname = file
            line = int(sal.line or 0)
    except Exception:
        pass
    return file, fullname, line


def _pc_hex(pc=None) -> str:
    if pc is None:
        try:
            pc = _current_pc()
        except Exception:
            return ""
    try:
        return f"{int(pc):#x}"
    except Exception:
        return str(pc) if pc is not None else ""


def _reset_transition_path():
    global _TRANSITION_PATH, _TRANSITION_SEQ
    _TRANSITION_PATH = []
    _TRANSITION_SEQ = 0


def _record_transition_node(node_type: str, privilege: str, label: str,
                            func: str = "", pc=None, file: str = "",
                            fullname: str = "", line=None, event: str = ""):
    global _TRANSITION_SEQ
    node_type = (node_type or "sync").strip().lower()
    privilege = (privilege or "unknown").strip().lower()
    label = (label or "").strip()
    func = (func or "").strip()
    event = (event or "").strip()

    if node_type not in ("sync", "transition", "async"):
        node_type = "sync"
    if privilege not in ("user", "kernel", "transition", "unknown"):
        privilege = "unknown"

    if not file and not fullname:
        auto_file, auto_fullname, auto_line = _frame_source_fields()
        file = auto_file
        fullname = auto_fullname
        if line in (None, "", 0, "0"):
            line = auto_line

    if not func and node_type != "transition":
        try:
            func = _current_function_name()
        except Exception:
            func = ""

    try:
        line_value = int(line) if line not in (None, "") else 0
    except Exception:
        line_value = 0

    _TRANSITION_SEQ += 1
    node = {
        "seq": _TRANSITION_SEQ,
        "type": node_type,
        "privilege": privilege,
        "label": label or event or func or node_type,
    }
    if func:
        node["func"] = func
    if event:
        node["event"] = event
    pc_text = _pc_hex(pc)
    if pc_text:
        node["pc"] = pc_text
    if file:
        node["file"] = file
    if fullname:
        node["fullname"] = fullname
    if line_value:
        node["line"] = line_value

    _TRANSITION_PATH.append(node)
    _log_ard(
        f"[ARD][transition] add seq={node['seq']} type={node_type} privilege={privilege} "
        f"label={node['label']} func={func or ''} event={event or ''} pc={pc_text or ''}"
    )
    return node


def _record_transition_event(event: str):
    event = (event or "unknown").strip()
    _set_privilege_state("transition", event)
    return _record_transition_node(
        "transition",
        "transition",
        event,
        event=event,
        pc="",
        file="",
        fullname="",
        line=0,
    )


def _get_transition_path_snapshot():
    return [dict(node) for node in _TRANSITION_PATH]


def _rel4_env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default or "").strip()


def _rel4_addr_location(env_name: str, default_addr: str) -> str:
    value = _rel4_env(env_name, default_addr)
    if not value:
        return ""
    return value if value.startswith("*") else f"*{value}"


def _rel4_probe_source_paths():
    user_fullname = _rel4_env(
        "REL4_ROOT_TASK_SRC",
        "/home/user/AsyncOS/rel4-manifest-workspace/projects/rust-root-task-demo/crates/example/src/syscall_test.rs",
    )
    kernel_fullname = _rel4_env(
        "REL4_KERNEL_SRC",
        "/home/user/AsyncOS/rel4-manifest-workspace/rel4_kernel/src/syscall/invocation/decode/mod.rs",
    )
    return user_fullname, kernel_fullname


def _rel4_warn_missing_path(path: str):
    if path and not os.path.exists(path):
        gdb.write(f"[ARD][rel4-chain] warning: source path not found: {path}\n")


def _rel4_transition_probe_specs():
    user_fullname, kernel_fullname = _rel4_probe_source_paths()
    user_file = "crates/example/src/syscall_test.rs"
    kernel_file = "src/syscall/invocation/decode/mod.rs"

    return [
        {
            "location": _rel4_addr_location("REL4_USER_START_ADDR", "0x1c580"),
            "node_type": "sync",
            "privilege": "user",
            "label": "syscall_test.rs:81",
            "func": "example::syscall_test::async_syscall_test",
            "file": user_file,
            "fullname": user_fullname,
            "line": 81,
            "message": "[1] [USER] syscall_test.rs:81",
        },
        {
            "location": _rel4_addr_location("REL4_USER_REGISTER_ADDR", "0x1c626"),
            "node_type": "sync",
            "privilege": "user",
            "label": "syscall_test.rs:99/101",
            "func": "example::syscall_test::async_syscall_test",
            "file": user_file,
            "fullname": user_fullname,
            "line": 101,
            "message": "[2] [USER] syscall_test.rs:99/101",
        },
        {
            "location": _rel4_addr_location("REL4_USER_WRAPPER_ADDR", "0x27d7a"),
            "node_type": "sync",
            "privilege": "user",
            "label": "syscall wrapper",
            "func": "seL4_Uint_Notification_register_async_syscall",
            "file": "",
            "fullname": _rel4_env("REL4_USER_WRAPPER_SRC", ""),
            "line": _rel4_env("REL4_USER_WRAPPER_LINE", "699"),
            "message": "[3] [USER] syscall wrapper",
        },
        {
            "location": _rel4_addr_location("REL4_KERNEL_LABEL33_ADDR", "0xffffffff84017ff8"),
            "event": "user_to_kernel",
            "node_type": "sync",
            "privilege": "kernel",
            "label": "UintrRegisterAsyncSyscall label 33 / decode_invocation",
            "func": "rustlib::syscall::invocation::decode::decode_invocation",
            "file": kernel_file,
            "fullname": kernel_fullname,
            "line": 93,
            "message": "[5] [KERNEL] UintrRegisterAsyncSyscall label 33 / decode_invocation",
            "event_message": "[4] [TRANSITION] user_to_kernel",
        },
        {
            "location": _rel4_addr_location("REL4_KERNEL_SPAWN_ADDR", "0xffffffff84018042"),
            "node_type": "sync",
            "privilege": "kernel",
            "label": "async_syscall_handler spawn site",
            "func": "rustlib::syscall::invocation::decode::decode_invocation",
            "file": kernel_file,
            "fullname": kernel_fullname,
            "line": 100,
            "message": "[6] [KERNEL] async_syscall_handler spawn site",
        },
    ]


def _rel4_set_privilege_for_spec(spec: dict):
    privilege = (spec.get("privilege") or "unknown").strip().lower()
    label = spec.get("label") or spec.get("func") or ""
    try:
        pc = _current_pc()
    except Exception:
        pc = None
    if privilege == "user":
        _set_privilege_state("user", "none", label, pc)
    elif privilege == "kernel":
        transition = _PRIVILEGE_TRANSITION_EVENT
        if transition == "none":
            transition = "user_to_kernel" if _PRIVILEGE_STATE in ("user", "transition") else "none"
        _set_privilege_state("kernel", transition, label, pc)


def _delete_rel4_transition_probe_bps():
    for bp in list(_REL4_TRANSITION_PROBE_BPS):
        try:
            bp.delete()
        except Exception:
            pass
        try:
            _CREATED_BPS.remove(bp)
        except ValueError:
            pass
        try:
            _RUN_SCOPED_BPS.remove(bp)
        except ValueError:
            pass
    _REL4_TRANSITION_PROBE_BPS.clear()


def _child_hit_key(tid, parent_cid, parent_sym: str, child_sym: str, child_addr: str):
    return (
        tid if tid is not None else "unknown",
        parent_cid if parent_cid is not None else "unknown",
        parent_sym or "",
        child_sym or "",
        child_addr or "",
    )


def _record_structured_child_hit(tid, parent_cid, parent_sym: str, parent_addr: str,
                                 child_sym: str, child_addr: str, hit: dict):
    rec = dict(hit)
    rec.update({
        "thread_id": tid,
        "parent_cid": parent_cid,
        "parent_symbol": parent_sym or "",
        "parent_addr": parent_addr or "",
        "child_symbol": child_sym or hit.get("func", ""),
        "child_env_addr": child_addr or hit.get("addr", ""),
    })
    key = _child_hit_key(tid, parent_cid, parent_sym, child_sym, child_addr)
    _LAST_CHILD_HIT_BY_STRUCTURED[key] = rec


def _find_structured_child_hit(tid, parent_cid, parent_sym: str,
                               child_sym: str, child_addr: str):
    key = _child_hit_key(tid, parent_cid, parent_sym, child_sym, child_addr)
    hit = _LAST_CHILD_HIT_BY_STRUCTURED.get(key)
    if hit:
        return hit

    # If the inferred child address is unavailable, still prefer a hit that
    # agrees on thread, parent CID/symbol, and child symbol.
    for (k_tid, k_parent_cid, k_parent_sym, k_child_sym, _k_child_addr), rec in _LAST_CHILD_HIT_BY_STRUCTURED.items():
        if k_tid != (tid if tid is not None else "unknown"):
            continue
        if parent_cid is not None and k_parent_cid != parent_cid:
            continue
        if parent_sym and k_parent_sym != parent_sym:
            continue
        if k_child_sym == child_sym:
            return rec
    return None


def _find_coro_id_for_symbol_addr(sym: str, addr: str):
    if not sym or not addr:
        return None
    for (poll_sym, this_ptr), cid in _CO_BY_KEY.items():
        if poll_sym != sym:
            continue
        try:
            if hex(int(this_ptr)) == addr:
                return cid
        except Exception:
            pass
    return None


def _merge_state_info_from_observed(base_info: dict, observed: dict) -> dict:
    state = observed.get("state")
    if _is_valid_state_value(state):
        return _state_info(
            state,
            observed.get("state_read_status", "ok"),
            observed.get("state_read_error", ""),
        )
    return base_info

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

# Async symbol set from grouped whitelist (symbols classified as "async")
_ASYNC_SYMBOL_SET = None   # set[str] | None

_EVENTS_INSTALLED = False


# -------------------------
# Low-level helpers
# -------------------------

CALL_MNEMONIC_RE = re.compile(r"^\s*(call\w*|bl|blx|jal|jalr|c\.jal|c\.jalr|c\.jr|c\.j)\b", re.IGNORECASE)
HEX_ADDR_RE = re.compile(r"(0x[0-9a-fA-F]+)")
RISCV_CALL_MNEMONIC_RE = re.compile(r"^\s*(call|jal|jalr|c\.jal|c\.jalr|c\.jr|c\.j)\b", re.IGNORECASE)

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
    addr = _normalize_addr(gdb.parse_and_eval(f"${name}"))
    if addr is None:
        raise ValueError(f"cannot normalize register ${name}")
    return addr

def _first_arg_reg() -> str:
    """
    Return the architecture-appropriate register name for the first argument.
    x86_64 SysV -> rdi
    ARM/Thumb (AAPCS) -> r0
    AArch64 (AAPCS64) -> x0
    RISC-V -> a0
    """
    try:
        arch_name = gdb.selected_frame().architecture().name().lower()
    except Exception:
        arch_name = ""

    if "aarch64" in arch_name:
        return "x0"

    if "riscv" in arch_name:
        return "a0"

    if "arm" in arch_name or "thumb" in arch_name:
        return "r0"

    return "rdi"


def _arch_name_or_empty() -> str:
    try:
        return gdb.selected_frame().architecture().name().lower()
    except Exception:
        return ""


def _riscv_arch_or_unknown() -> bool:
    arch = _arch_name_or_empty()
    return (not arch) or ("riscv" in arch)


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

def _parse_info_symbol_range(addr: int, window: int = 0x200):
    raw = _info_symbol_raw(addr)
    if not raw or raw.startswith("No symbol matches"):
        return (addr, addr + window, None)

    head = raw.split(" in section", 1)[0].strip()
    name = head
    offset = 0
    m = re.match(r"^(.*) \+ (0x[0-9a-fA-F]+|[0-9]+)$", head)
    if m:
        name = m.group(1).strip()
        off_s = m.group(2)
        try:
            offset = int(off_s, 0)
        except Exception:
            offset = 0

    start = max(0, addr - offset)
    if name:
        for resolver in (_try_addr_by_lookup_global_symbol, _try_addr_by_info_address):
            try:
                resolved = resolver(name)
            except Exception:
                resolved = None
            if resolved is not None and resolved <= addr:
                start = int(resolved)
                break
    end = start + window
    return (start, end, name or None)

def _function_range(frame=None) -> tuple[int, int, str | None, bool] | None:
    frame = frame or gdb.selected_frame()
    try:
        blk = frame.block()
        while blk is not None and blk.function is None:
            blk = blk.superblock
        if blk is not None and blk.start is not None and blk.end is not None:
            name = None
            try:
                name = str(blk.function.print_name) if blk.function is not None else None
            except Exception:
                name = None
            return (int(blk.start), int(blk.end), name, False)
    except (gdb.error, RuntimeError, Exception) as e:
        block_error = e
    else:
        block_error = None

    try:
        pc = int(frame.pc())
    except Exception:
        try:
            pc = _current_pc()
        except Exception:
            _log_ard("[ARD] warning: cannot get function range: no debug block and no pc")
            return None

    start, end, name = _parse_info_symbol_range(pc)
    if name:
        _log_ard(f"[ARD] warning: no debug block for {name}; using fallback range {start:#x}..{end:#x}")
    else:
        _log_ard(f"[ARD] warning: no debug block near pc={pc:#x}; using fallback range {start:#x}..{end:#x}")
    if block_error is not None:
        _log_ard(f"[ARD] warning: frame.block unavailable: {block_error}")
    return (start, end, name, True)

def _collect_call_sites() -> list[int]:
    r = _function_range()
    if r is None:
        _log_ard("[ARD] warning: cannot get function range; skipping call-site scan")
        return []
    start, end, name, degraded = r
    if degraded:
        label = name or f"{start:#x}"
        _log_ard(f"[ARD] warning: skipping call-site scan for no-debug-block function {label}")
        return []
    arch = gdb.selected_frame().architecture()
    insns = arch.disassemble(start, end)

    out = []
    seen = set()
    for ins in insns:
        asm = ins.get("asm", "").strip()
        if CALL_MNEMONIC_RE.match(asm):
            _log_ard(f"[ARD] call-detect insn: {asm}")
            a = _normalize_addr(ins["addr"])
            if a is None:
                continue
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


def _asm_instruction_text(asm: str) -> str:
    s = (asm or "").strip()
    s = re.sub(r"^=>\s*", "", s)
    m = re.match(r"^0x[0-9a-fA-F]+(?:\s+<[^>]*>)?:\s*(.*)$", s)
    if m:
        s = m.group(1).strip()
    if "\t" in s:
        parts = [p.strip() for p in s.split("\t") if p.strip()]
        for part in reversed(parts):
            if RISCV_CALL_MNEMONIC_RE.match(part):
                return part
        s = parts[-1] if parts else s
    s = re.sub(r"^(?:[0-9a-fA-F]{2}\s+)+", "", s).strip()
    return s


def _resolve_riscv_call_target_from_asm(asm: str) -> int | None:
    s = _asm_instruction_text(asm)
    m = RISCV_CALL_MNEMONIC_RE.match(s)
    if not m:
        return None

    mnemonic = m.group(1).lower()
    if mnemonic == "call" and not _riscv_arch_or_unknown():
        return None

    body, _sep, comment = s.partition("#")
    comment_target = HEX_ADDR_RE.search(comment)

    if mnemonic in ("jalr", "c.jr", "c.jalr"):
        if comment_target:
            target = int(comment_target.group(1), 16)
            _log_ard(f"[ARD] riscv-call-comment-target pc={_current_pc():#x} asm={s} target={target:#x}")
            return target
        _log_ard(f"[ARD] riscv-call-indirect-unresolved pc={_current_pc():#x} asm={s} reason=no static target")
        return None

    if mnemonic == "call" and ("*" in body or "(%" in body):
        return None

    target_m = HEX_ADDR_RE.search(body)
    if not target_m:
        return None

    target = int(target_m.group(1), 16)
    _log_ard(f"[ARD] riscv-call-direct pc={_current_pc():#x} asm={s} target={target:#x}")
    return target


def _resolve_call_target_from_asm(asm: str) -> int | None:
    s = asm.strip()
    target = _resolve_riscv_call_target_from_asm(s)
    if target is not None:
        return target

    # ARM/Thumb: bl/blx immediate
    m = re.search(r"\bblx?\s+0x([0-9a-fA-F]+)", s)
    if m:
        try:
            return int(m.group(1), 16)
        except Exception:
            return None
        
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

    return None


# -------------------------
# __awaitee extraction (best-effort)
# -------------------------

def _pollsym_to_envtype(poll_sym: str) -> str | None:
    """
    Map a poll symbol to the concrete async env type name.

    Important rule:
    - If the symbol names an async block poll like
      foo::{async_fn#0}::{async_block#0},
      the env type is foo::{async_fn#0}::{async_block_env#0}
      (only replace the async_block part).
    - Otherwise, for a plain async function poll like
      foo::{async_fn#0},
      the env type is foo::{async_fn_env#0}.
    """
    if "{async_block#" in poll_sym:
        return poll_sym.replace("{async_block#", "{async_block_env#")

    if "{async_fn#" in poll_sym:
        return poll_sym.replace("{async_fn#", "{async_fn_env#")

    return None

def _read_state_with_status(poll_sym: str, this_ptr: int):
    """
    Read the state discriminant from an async env struct.

    Returns a dict with state, state_read_status, and state_read_error.
    """
    if not this_ptr:
        return _state_info("N/A", "unsupported", "missing future pointer")

    env_type_name = _pollsym_to_envtype(poll_sym)
    if not env_type_name:
        return _state_info("N/A", "unsupported", "unsupported poll symbol")

    try:
        env_t = gdb.lookup_type(env_type_name)
        env_val = gdb.Value(this_ptr).cast(env_t.pointer()).dereference()
    except gdb.error as e:
        return _state_info("N/A", "error", _short_error(e))
    except Exception as e:
        return _state_info("N/A", "error", _short_error(e))

    # Primary: try the well-known __state field.
    try:
        state = int(env_val["__state"])
        return _state_info(state, "ok", "")
    except Exception as e:
        state_field_error = e

    # Fallback: read the first field as discriminant.
    try:
        fields = env_t.fields()
        if fields:
            first_name = fields[0].name
            if not first_name:
                return _state_info("N/A", "not_found", "missing discriminant field")
            first_val = env_val[first_name]
            first_code = first_val.type.strip_typedefs().code
            if first_code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL,
                              gdb.TYPE_CODE_ENUM):
                return _state_info(int(first_val), "ok", "")
    except gdb.error as e:
        return _state_info("N/A", "error", _short_error(e))
    except Exception as e:
        return _state_info("N/A", "error", _short_error(e))

    err = _short_error(state_field_error, "missing discriminant field")
    if "optimized out" in err.lower():
        return _state_info("N/A", "not_found", err)
    return _state_info("N/A", "not_found", "missing discriminant field")


def _read_env_state(poll_sym: str, this_ptr: int):
    return _read_state_with_status(poll_sym, this_ptr)["state"]


def _read_state_from_value_with_status(env_val):
    """
    Read the state discriminant directly from a GDB value that already
    represents an async env object.

    Returns a dict with state, state_read_status, and state_read_error.
    """
    try:
        return _state_info(int(env_val["__state"]), "ok", "")
    except Exception as e:
        state_field_error = e

    try:
        env_t = env_val.type.strip_typedefs()
        fields = env_t.fields()
        if fields:
            first_name = fields[0].name
            if not first_name:
                return _state_info("N/A", "not_found", "missing discriminant field")
            first_val = env_val[first_name]
            first_code = first_val.type.strip_typedefs().code
            if first_code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL, gdb.TYPE_CODE_ENUM):
                return _state_info(int(first_val), "ok", "")
    except gdb.error as e:
        return _state_info("N/A", "error", _short_error(e))
    except Exception as e:
        return _state_info("N/A", "error", _short_error(e))

    err = _short_error(state_field_error, "missing discriminant field")
    if "optimized out" in err.lower():
        return _state_info("N/A", "not_found", err)
    return _state_info("N/A", "not_found", "missing discriminant field")


def _read_env_state_from_value(env_val):
    return _read_state_from_value_with_status(env_val)["state"]

def _try_read_env_value_from_frame(frame: gdb.Frame, poll_sym: str):
    """
    Best-effort: for inlined async frames, try to read the hidden __awaitee
    variable from the current block or its superblock.

    Returns:
      - a gdb.Value representing the async env object
      - None if unavailable
    """
    try:
        block = frame.block()
    except Exception:
        return None

    candidates = []
    b = block
    steps = 0
    while b is not None and steps < 3:
        candidates.append(b)
        b = b.superblock
        steps += 1

    for b in candidates:
        try:
            v = frame.read_var("__awaitee", b)
        except Exception:
            continue

        try:
            ty_name = str(v.type.strip_typedefs())
        except Exception:
            ty_name = str(v.type)

        # Prefer an env object that matches the target poll symbol's env type
        env_type_name = _pollsym_to_envtype(poll_sym)
        if env_type_name and env_type_name in ty_name:
            return v

        # Also accept direct async env-looking types
        if "{async_fn_env#" in ty_name or "{async_block_env#" in ty_name:
            return v

    return None

def _try_read_local_awaitee_value(frame: gdb.Frame):
    """
    Read the current block's __awaitee, which usually represents the
    inner future being awaited by the current async frame.
    """
    try:
        block = frame.block()
    except Exception:
        return None

    try:
        return frame.read_var("__awaitee", block)
    except Exception:
        return None


def _value_type_name(val) -> str:
    try:
        return str(val.type.strip_typedefs())
    except Exception:
        try:
            return str(val.type)
        except Exception:
            return "UNKNOWN"


def _value_state_name(val):
    """
    Best-effort semantic state extraction from a GDB value string.
    Examples:
      Type::Unresumed -> Unresumed
      YieldCpu {polled: <optimized out>} -> YieldCpu
    """
    try:
        s = str(val).strip()
        if not s:
            return "N/A"

        if "{" in s:
            return s.split("{", 1)[0].strip()

        if "::" in s:
            return s.split("::")[-1].strip()

        return s
    except Exception:
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
        env_ptr = _reg_u64(_first_arg_reg())
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
def _extract_angle_inner_types(s: str) -> list[str]:
    out = []
    depth = 0
    cur = []
    for ch in s:
        if ch == '<':
            depth += 1
            if depth == 1:
                cur = []
                continue
        elif ch == '>':
            if depth == 1:
                inner = ''.join(cur).strip()
                if inner:
                    parts = [p.strip() for p in inner.split(',') if p.strip()]
                    out.extend(parts)
                cur = []
            depth = max(0, depth - 1)
            continue

        if depth >= 1:
            cur.append(ch)
    return out

def _symbol_query_tokens(ty: str) -> list[str]:
    ty = (ty or "").strip()
    if not ty:
        return []

    toks = [ty]

    base = ty.split("::")[-1].strip()
    if base and base not in toks:
        toks.append(base)

    for part in re.split(r"::|<|>|,|\s+", ty):
        part = part.strip()
        if len(part) >= 4 and part not in toks:
            toks.append(part)

    return toks

def _future_type_to_poll_symbol(future_ty: str) -> str | None:
    """
    Best-effort mapping:
      my_crate::FutureType
        -> <my_crate::FutureType as core::future::future::Future>::poll

    Strategy:
      1) Query by full type name, base name, and split tokens
      2) Accept lines containing both Future and poll
      3) Prefer exact matches containing the full future type
    """
    future_ty = (future_ty or "").strip()
    if not future_ty:
        return None

    tokens = _symbol_query_tokens(future_ty)
    base = future_ty.split("::")[-1].strip()

    all_matches = []

    for q in tokens:
        try:
            txt = gdb.execute(f"info functions {q}", to_string=True)
        except Exception:
            continue

        for line in txt.splitlines():
            s = line.strip()
            if not s:
                continue
            if "Future" not in s or "poll" not in s:
                continue

            score = 0
            if future_ty in s:
                score += 100
            if f"<{future_ty} as " in s:
                score += 100
            if base and base in s:
                score += 20
            if "::poll" in s:
                score += 20

            all_matches.append((score, s))

    if not all_matches:
        _log_ard(f"[ARD] future->poll miss: {future_ty}")
        return None

    all_matches.sort(key=lambda x: x[0], reverse=True)
    best = all_matches[0][1]
    _log_ard(f"[ARD] future->poll hit: {future_ty} -> {best}")
    return best
def _base_type_name(ty: str) -> str:
    ty = (ty or "").strip()
    if not ty:
        return ""
    return ty.split("::")[-1].strip()


def _infer_child_poll_from_current_frame(awaitee_ty: str) -> str | None:
    """
    Infer the awaited child's poll symbol by scanning the current frame's
    callsites and looking for a poll callee whose symbol mentions the awaitee type.
    This is more reliable than `info functions <type>` for Rust demangled names.
    """
    awaitee_ty = (awaitee_ty or "").strip()
    if not awaitee_ty:
        return None

    base = _base_type_name(awaitee_ty)

    try:
        r = _function_range()
        if r is None:
            return None
        start, end, _name, degraded = r
        if degraded:
            return None
        arch = gdb.selected_frame().architecture()
        insns = arch.disassemble(start, end)
    except Exception:
        return None

    candidates = []

    for ins in insns:
        asm = ins.get("asm", "").strip()
        if not CALL_MNEMONIC_RE.match(asm):
            continue

        target = _resolve_call_target_from_asm(asm)
        if not target:
            continue

        for callee in _callee_candidates(target):
            if "poll" not in callee or "Future" not in callee:
                continue

            score = 0
            if awaitee_ty in callee:
                score += 100
            if base and base in callee:
                score += 40
            if "::poll" in callee:
                score += 20

            candidates.append((score, callee))

    if not candidates:
        return None

    candidates.sort(key=lambda x: x[0], reverse=True)
    return candidates[0][1]

def _child_poll_symbol_from_awaitee_type(awaitee_ty: str) -> str | None:
    awaitee_ty = (awaitee_ty or "").strip()
    if not awaitee_ty:
        return None

    if "{async_fn_env#" in awaitee_ty:
        return awaitee_ty.replace("{async_fn_env#", "{async_fn#")

    if "{async_block_env#" in awaitee_ty:
        return awaitee_ty.replace("{async_block_env#", "{async_block#")

    # Prefer direct inference from current frame's callsites
    poll_sym = _infer_child_poll_from_current_frame(awaitee_ty)
    if poll_sym:
        _log_ard(f"[ARD] future->poll via-callsites: {awaitee_ty} -> {poll_sym}")
        return poll_sym

    # Fallback to the old info-functions strategy
    poll_sym = _future_type_to_poll_symbol(awaitee_ty)
    if poll_sym:
        return poll_sym

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

def _ard_diag_enabled() -> bool:
    value = os.environ.get("ARD_DIAG") or os.environ.get("ARDB_DIAG") or ""
    return value.lower() in ("1", "true", "yes", "on")

def _log_diag(message: str):
    if _ard_diag_enabled():
        _log_ard(message)

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
    if "async_runtime::coroutine::Coroutine::execute" in sym_name:
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

def _has_existing_real_async_child(snapshot_path, phys_tail, leaf_func: str) -> bool:
    """
    Check whether a real async child with the same function already exists
    either in the shadow-stack-derived snapshot path or in the physical tail.
    """
    try:
        for node in snapshot_path:
            if node.get("type") != "async":
                continue
            if node.get("cid") is None:
                continue
            if node.get("func") == leaf_func:
                return True

        for node in reversed(phys_tail):
            if node.get("type") != "async":
                continue
            if node.get("cid") is None:
                continue
            if node.get("func") == leaf_func:
                return True
    except Exception:
        pass
    return False

def _should_log_child_key_miss(leaf_func: str, node_addr: str) -> bool:
    if not leaf_func:
        return False

    key = (leaf_func, node_addr)
    if key in _CHILD_KEY_MISS_LOGGED:
        return False

    _CHILD_KEY_MISS_LOGGED.add(key)
    return True

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
        result = _normalize_addr(val)
        return result if result and result > 0xffff else 0

    try:
        ty = val.type.strip_typedefs()
        code = ty.code

        # Pointer or reference — this is what we want
        if code in (gdb.TYPE_CODE_PTR, gdb.TYPE_CODE_REF, gdb.TYPE_CODE_RVALUE_REF):
            result = _normalize_addr(val)
            return result if result and result > 0xffff else 0

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
        result = _normalize_addr(val)
        return result if result and result > 0xffff else 0
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
    _LAST_CHILD_HIT_BY_PARENT.clear()
    _LAST_CHILD_HIT_BY_CALLER_FRAME.clear()
    _LAST_CHILD_HIT_BY_FUNC_ADDR.clear()
    _LAST_CHILD_HIT_BY_STRUCTURED.clear()
    _CHILD_KEY_MISS_LOGGED.clear()
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
        _log_diag(
            f"[ARD][diag] PollEntryBP.stop enter fn={fn!r} poll_sym={self.poll_sym!r} internal={self.internal!r}"
        )
        try:
            frame = gdb.selected_frame()
            _log_diag(f"[ARD][diag] frame={frame.name()!r}")
        except Exception as e:
            frame = None
            _log_diag(f"[ARD][diag] frame read failed: {e!r}")
        try:
            pc = int(gdb.parse_and_eval("$pc"))
            _log_diag(f"[ARD][diag] pc=0x{pc:x}")
            _log_diag(f"[ARD][diag] info_symbol={_info_symbol_raw(pc)!r}")
        except Exception as e:
            _log_diag(f"[ARD][diag] pc/symbol failed: {e!r}")
        try:
            names = []
            f = gdb.newest_frame()
            depth_i = 0
            while f is not None and depth_i < 8:
                try:
                    names.append(f.name())
                except Exception:
                    names.append("<name-failed>")
                f = f.older()
                depth_i += 1
            _log_diag(f"[ARD][diag] bt_top={names!r}")
        except Exception as e:
            _log_diag(f"[ARD][diag] bt_top failed: {e!r}")

        # ---- coro context enter (best-effort) ----
        tid = _thread_id()
        try:
            _log_diag(
                f"[ARD][diag] TLS_STACK before tid={tid} stack={_TLS_STACK.get(tid, [])!r} all={_TLS_STACK!r}"
            )
        except Exception as e:
            _log_diag(f"[ARD][diag] TLS_STACK read failed: {e!r}")
        self_ptr = 0
        this_arg_ptr = 0
        if frame is not None:
            for arg_name in ("self", "this"):
                try:
                    arg_val = frame.read_var(arg_name)
                    arg_ptr = _extract_raw_ptr(arg_val)
                    if arg_name == "self":
                        self_ptr = arg_ptr
                    else:
                        this_arg_ptr = arg_ptr
                    _log_diag(
                        f"[ARD][diag] arg {arg_name}={arg_val!r} ptr=0x{arg_ptr:x}"
                    )
                except Exception as e:
                    _log_diag(f"[ARD][diag] arg {arg_name} read failed: {e!r}")
        a0_ptr = 0
        try:
            first_arg = _first_arg_reg()
            raw_reg_val = gdb.parse_and_eval(f"${first_arg}")
            a0_ptr = _normalize_addr(raw_reg_val) or 0
            this_ptr = self_ptr or this_arg_ptr or a0_ptr
            _log_ard(
                f"[ARD] ptr-selected self=0x{self_ptr:x} this=0x{this_arg_ptr:x} {first_arg}=0x{a0_ptr:x} selected=0x{this_ptr:x}"
            )
            if this_ptr <= 0x10000:
                _log_diag(f"[ARD][diag] this_ptr rejected by low-address filter: 0x{this_ptr:x}")
                this_ptr = 0
        except Exception as e:
            _log_diag(f"[ARD][diag] first arg read failed: {e!r}")
            this_ptr = 0
        _log_diag(f"[ARD][diag] final this_ptr=0x{this_ptr:x}")

        poll_sym = self.poll_sym or fn
        cid = 0
        is_new = False
        depth = -1
        _log_diag(f"[ARD][diag] before node create: poll_sym={poll_sym!r} this_ptr=0x{this_ptr:x}")

        if poll_sym and this_ptr:
            cid, is_new = _get_or_make_coro_id(poll_sym, this_ptr)
            _log_diag(f"[ARD][diag] cid selected: cid={cid!r} is_new={is_new!r}")
            depth = _push_coro(cid)
            _log_diag(
                f"[ARD][diag] TLS_STACK after push tid={tid} depth={depth} stack={_TLS_STACK.get(tid, [])!r} all={_TLS_STACK!r}"
            )
            try:
                _PopOnReturnBP(tid, cid)
            except Exception as e:
                _log_ard(f"[ARD] warning: PopOnReturnBP disabled for cid={cid}: {e!r}")
        else:
            _log_ard(
                f"[ARD] warning: no node created: poll_sym_present={bool(poll_sym)} this_ptr_present={bool(this_ptr)}"
            )

        indent = "  " * max(depth, 0)

        # poll sequence per coro instance
        seq = 0
        if cid:
            seq = _CO_POLL_SEQ.get(cid, 0) + 1
            _CO_POLL_SEQ[cid] = seq
            _log_diag(f"[ARD][diag] poll sequence updated: cid={cid} seq={seq}")
        state_info = (
            _read_state_with_status(poll_sym, this_ptr)
            if cid and this_ptr
            else _state_info("N/A", "unsupported", "missing future pointer")
        )
        _record_async_privilege_hit(poll_sym)
        if cid and this_ptr:
            addr_hex = hex(this_ptr)
            _LAST_CHILD_HIT_BY_FUNC_ADDR[(poll_sym, addr_hex)] = {
                "func": poll_sym,
                "cid": cid,
                "poll": seq,
                "addr": addr_hex,
                **_state_fields(state_info),
            }
            _log_diag(
                f"[ARD][diag] node cache updated: poll_sym={poll_sym!r} cid={cid} addr={addr_hex}"
            )
        # Record the latest direct child poll hit for the current parent.
        try:
            st = _TLS_STACK.get(tid, [])
            if cid and len(st) >= 2:
                parent_cid = st[-2]
                parent_sym, parent_ptr = _CO_META.get(parent_cid, ("", 0))
                if parent_sym:
                    child_addr = hex(this_ptr) if this_ptr else ""
                    hit = {
                        "func": poll_sym,
                        "cid": cid,
                        "poll": seq,
                        "addr": child_addr,
                        **_state_fields(state_info),
                    }
                    _LAST_CHILD_HIT_BY_PARENT[parent_sym] = hit
                    _record_structured_child_hit(
                        tid,
                        parent_cid,
                        parent_sym,
                        hex(parent_ptr) if parent_ptr else "",
                        poll_sym,
                        child_addr,
                        hit,
                    )
                    _log_ard(
                        f"[ARD] child-hit parent={parent_sym} parent_cid={parent_cid} child={poll_sym} cid={cid} poll={seq} addr={child_addr or '0x0'}"
                    )
                    _log_ard(f"[ARD][async] {parent_sym} -> {poll_sym}")
        except Exception:
            pass
                # Also record the most relevant async caller frame name from the physical stack.
        try:
            caller_frame = gdb.selected_frame().older()
            caller_async_name = ""

            while caller_frame:
                caller_name = caller_frame.name() or ""
                if caller_name and caller_name != poll_sym and _is_async_symbol(caller_name):
                    caller_async_name = caller_name
                    break
                caller_frame = caller_frame.older()

            if cid and caller_async_name:
                child_addr = hex(this_ptr) if this_ptr else ""
                caller_cid = None
                try:
                    for stack_cid in reversed(_TLS_STACK.get(tid, [])):
                        stack_sym, _stack_ptr = _CO_META.get(stack_cid, ("", 0))
                        if stack_sym == caller_async_name:
                            caller_cid = stack_cid
                            break
                except Exception:
                    caller_cid = None
                hit = {
                    "func": poll_sym,
                    "cid": cid,
                    "poll": seq,
                    "addr": child_addr,
                    **_state_fields(state_info),
                }
                _LAST_CHILD_HIT_BY_CALLER_FRAME[caller_async_name] = hit
                _record_structured_child_hit(
                    tid,
                    caller_cid,
                    caller_async_name,
                    "",
                    poll_sym,
                    child_addr,
                    hit,
                )
                _log_ard(
                    f"[ARD] caller-frame-hit caller={caller_async_name} caller_cid={caller_cid} child={poll_sym} cid={cid} poll={seq} addr={child_addr or '0x0'}"
                )
        except Exception:
            pass

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
                try:
                    CallSiteBP(a)
                except Exception as e:
                    _log_ard(f"[ARD]{indent} call-site bp install failed addr={a:#x}: {_short_error(e)}")

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


class PrivilegeGroupBP(gdb.Breakpoint):
    def __init__(self, group: str, location: str, label: str = ""):
        self.group = (group or "").strip().lower()
        if self.group not in ("user", "kernel"):
            raise ValueError("privilege breakpoint group must be user or kernel")
        super().__init__(location, type=gdb.BP_BREAKPOINT, internal=True)
        self.silent = True
        self.location_text = location
        self.label = label or location
        _CREATED_BPS.append(self)
        _RUN_SCOPED_BPS.append(self)
        _register_privilege_bp(self.group, self)

    def stop(self) -> bool:
        _record_privilege_hit(self.group, self.label)
        return False


class Rel4TransitionProbeBP(gdb.Breakpoint):
    def __init__(self, spec: dict):
        self.spec = dict(spec)
        location = self.spec.get("location") or ""
        super().__init__(location, type=gdb.BP_BREAKPOINT, internal=True)
        self.silent = True
        self.location_text = location
        _REL4_TRANSITION_PROBE_BPS.append(self)
        _CREATED_BPS.append(self)
        _RUN_SCOPED_BPS.append(self)

    def stop(self) -> bool:
        spec = self.spec
        try:
            event = (spec.get("event") or "").strip()
            if event:
                event_node = _record_transition_event(event)
                gdb.write(
                    f"[ARD][rel4-chain] {spec.get('event_message') or '[TRANSITION]'} "
                    f"transition_event={event_node.get('event', event)}\n"
                )

            _rel4_set_privilege_for_spec(spec)
            node = _record_transition_node(
                spec.get("node_type", "sync"),
                spec.get("privilege", "unknown"),
                spec.get("label", ""),
                func=spec.get("func", ""),
                file=spec.get("file", ""),
                fullname=spec.get("fullname", ""),
                line=spec.get("line", 0),
                pc=None,
            )
            gdb.write(f"[ARD][rel4-chain] {spec.get('message') or node.get('label')}\n")
            try:
                self.enabled = False
            except Exception:
                pass
        except Exception as e:
            gdb.write(f"[ARD][rel4-chain] warning: probe hit failed: {_short_error(e)}\n")
        return False

# -------------------------
# Commands
# -------------------------

class ARDTraceCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-trace", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        sym = arg.strip()
        if len(sym) >= 2 and sym[0] == sym[-1] and sym[0] in ("'", '"'):
            sym = sym[1:-1]
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


class ARDPrivAddCommand(gdb.Command):
    """
    Add a breakpoint to a privilege breakpoint group.
    Usage: ardb-priv-add <user|kernel> <location> [label]
    Example: ardb-priv-add user *0x27d7a seL4_Uint_Notification_register_async_syscall
    """
    def __init__(self):
        super().__init__("ardb-priv-add", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        try:
            parts = gdb.string_to_argv(arg)
        except Exception:
            parts = arg.split()
        if len(parts) < 2:
            gdb.write("Usage: ardb-priv-add <user|kernel> <location> [label]\n")
            return

        group = parts[0].strip().lower()
        location = parts[1].strip()
        label = " ".join(parts[2:]).strip() if len(parts) > 2 else location
        if group not in ("user", "kernel"):
            gdb.write("[ARD][priv] group must be user or kernel\n")
            return

        try:
            bp = PrivilegeGroupBP(group, location, label)
        except Exception as e:
            gdb.write(f"[ARD][priv] failed to add {group} breakpoint {location}: {e}\n")
            return
        gdb.write(
            f"[ARD][priv] added {group} breakpoint #{bp.number} {location} label={label} enabled={bp.enabled}\n"
        )


class ARDPrivEnableCommand(gdb.Command):
    """
    Enable one privilege breakpoint group.
    Usage: ardb-priv-enable <user|kernel|all|none>
    """
    def __init__(self):
        super().__init__("ardb-priv-enable", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        group = (arg or "").strip().lower()
        if not group:
            group = "user"
        try:
            _set_privilege_group_enabled(group)
        except Exception as e:
            gdb.write(f"[ARD][priv] failed to enable group: {e}\n")
            return
        gdb.write(f"[ARD][priv] active breakpoint group: {_PRIVILEGE_ACTIVE_GROUP}\n")


class ARDPrivResetCommand(gdb.Command):
    """
    Delete privilege breakpoint groups and reset privilege state.
    Usage: ardb-priv-reset
    """
    def __init__(self):
        super().__init__("ardb-priv-reset", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        global _PRIVILEGE_ACTIVE_GROUP
        _clear_privilege_bps()
        _PRIVILEGE_BPS["user"].clear()
        _PRIVILEGE_BPS["kernel"].clear()
        _PRIVILEGE_ACTIVE_GROUP = "user"
        _set_privilege_state("unknown", "none")
        _reset_transition_path()
        gdb.write("[ARD][priv] reset done.\n")


class ARDPrivStatusCommand(gdb.Command):
    """
    Print current privilege state and breakpoint group counts.
    Usage: ardb-priv-status
    """
    def __init__(self):
        super().__init__("ardb-priv-status", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        gdb.write(
            "[ARD][priv] "
            f"state={_PRIVILEGE_STATE} transition={_PRIVILEGE_TRANSITION_EVENT} "
            f"symbol={_PRIVILEGE_LAST_SYMBOL or ''} pc={_PRIVILEGE_LAST_PC or ''} "
            f"active_group={_PRIVILEGE_ACTIVE_GROUP} "
            f"user_bps={len(_PRIVILEGE_BPS.get('user', []))} "
            f"kernel_bps={len(_PRIVILEGE_BPS.get('kernel', []))}\n"
        )


class ARDTransitionResetCommand(gdb.Command):
    """
    Reset the structured cross-privilege transition path.
    Usage: ardb-transition-reset
    """
    def __init__(self):
        super().__init__("ardb-transition-reset", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        _reset_transition_path()
        gdb.write("[ARD][transition] reset done.\n")


class ARDTransitionAddCommand(gdb.Command):
    """
    Add one node to the structured transition path.
    Usage:
      ardb-transition-add type|privilege|label|func|file|fullname|line|pc
    Only the first three fields are required. Use pipe separators so labels
    and symbols may contain spaces.
    """
    def __init__(self):
        super().__init__("ardb-transition-add", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        raw = (arg or "").strip()
        if not raw:
            gdb.write("Usage: ardb-transition-add type|privilege|label|func|file|fullname|line|pc\n")
            return

        parts = [p.strip() for p in raw.split("|")]
        if len(parts) < 3:
            gdb.write("[ARD][transition] need at least type|privilege|label\n")
            return

        while len(parts) < 8:
            parts.append("")

        node_type, privilege, label, func, file, fullname, line, pc = parts[:8]
        node = _record_transition_node(
            node_type,
            privilege,
            label,
            func=func,
            file=file,
            fullname=fullname,
            line=line,
            pc=pc or None,
        )
        gdb.write(
            f"[ARD][transition] added seq={node.get('seq')} "
            f"{node.get('privilege')} {node.get('type')} {node.get('label')}\n"
        )


class ARDTransitionEventCommand(gdb.Command):
    """
    Add a transition event node.
    Usage: ardb-transition-event user_to_kernel
    """
    def __init__(self):
        super().__init__("ardb-transition-event", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        event = (arg or "").strip() or "unknown"
        node = _record_transition_event(event)
        gdb.write(f"[ARD][transition] event seq={node.get('seq')} {event}\n")


class ARDTransitionStatusCommand(gdb.Command):
    """
    Print the current transition path JSON.
    Usage: ardb-transition-status
    """
    def __init__(self):
        super().__init__("ardb-transition-status", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        gdb.write(json.dumps({"transition_path": _get_transition_path_snapshot()}) + "\n")


class ARDRel4EnableTransitionProbeCommand(gdb.Command):
    """
    Install rel4-async boundary breakpoints that populate transition_path.
    Usage: ardb-rel4-enable-transition-probe
    """
    def __init__(self):
        super().__init__("ardb-rel4-enable-transition-probe", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        _delete_rel4_transition_probe_bps()
        _reset_transition_path()

        try:
            gdb.execute("set breakpoint pending on", to_string=True)
        except Exception:
            pass

        specs = _rel4_transition_probe_specs()
        for path in {spec.get("fullname", "") for spec in specs}:
            _rel4_warn_missing_path(path)

        installed = 0
        failed = 0
        for spec in specs:
            location = spec.get("location") or ""
            if not location:
                failed += 1
                gdb.write(f"[ARD][rel4-chain] warning: empty location for {spec.get('label', '')}\n")
                continue
            try:
                bp = Rel4TransitionProbeBP(spec)
                installed += 1
                gdb.write(
                    f"[ARD][rel4-chain] installed #{bp.number} {location} "
                    f"{spec.get('label', '')}\n"
                )
            except Exception as e:
                failed += 1
                gdb.write(
                    f"[ARD][rel4-chain] warning: failed to install {location} "
                    f"{spec.get('label', '')}: {_short_error(e)}\n"
                )

        gdb.write(f"[ARD][rel4-chain] probe enabled: {installed} breakpoints")
        if failed:
            gdb.write(f" ({failed} failed)")
        gdb.write("\n")


class ARDRel4DisableTransitionProbeCommand(gdb.Command):
    """
    Delete rel4-async transition-path probe breakpoints and reset path state.
    Usage: ardb-rel4-disable-transition-probe
    """
    def __init__(self):
        super().__init__("ardb-rel4-disable-transition-probe", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        count = len(_REL4_TRANSITION_PROBE_BPS)
        _delete_rel4_transition_probe_bps()
        _reset_transition_path()
        gdb.write(f"[ARD][rel4-chain] probe disabled: deleted {count} breakpoints\n")


class ARDRel4TransitionProbeStatusCommand(gdb.Command):
    """
    Print rel4-async transition probe status.
    Usage: ardb-rel4-transition-probe-status
    """
    def __init__(self):
        super().__init__("ardb-rel4-transition-probe-status", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        valid = 0
        enabled = 0
        entries = []
        for bp in list(_REL4_TRANSITION_PROBE_BPS):
            try:
                is_valid = bp.is_valid()
            except Exception:
                is_valid = False
            if is_valid:
                valid += 1
                try:
                    if bp.enabled:
                        enabled += 1
                except Exception:
                    pass
            spec = getattr(bp, "spec", {}) or {}
            entries.append({
                "number": getattr(bp, "number", None),
                "valid": is_valid,
                "enabled": bool(getattr(bp, "enabled", False)) if is_valid else False,
                "location": spec.get("location", ""),
                "label": spec.get("label", ""),
                "privilege": spec.get("privilege", ""),
            })
        gdb.write(json.dumps({
            "rel4_transition_probe": {
                "total": len(_REL4_TRANSITION_PROBE_BPS),
                "valid": valid,
                "enabled": enabled,
                "breakpoints": entries,
            },
            "transition_path": _get_transition_path_snapshot(),
        }) + "\n")


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
        _LAST_CHILD_HIT_BY_PARENT.clear()
        _LAST_CHILD_HIT_BY_CALLER_FRAME.clear()
        _LAST_CHILD_HIT_BY_FUNC_ADDR.clear()
        _LAST_CHILD_HIT_BY_STRUCTURED.clear()
        _CHILD_KEY_MISS_LOGGED.clear()
        _clear_privilege_bps()
        _PRIVILEGE_BPS["user"].clear()
        _PRIVILEGE_BPS["kernel"].clear()
        _REL4_TRANSITION_PROBE_BPS.clear()
        global _PRIVILEGE_ACTIVE_GROUP
        _PRIVILEGE_ACTIVE_GROUP = "user"
        _set_privilege_state("unknown", "none")
        _reset_transition_path()
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
        try:
            _log_diag(
                f"[ARD][diag] snapshot enter thread={tid} stack={stack!r} all_tls={_TLS_STACK!r}"
            )
            _log_diag(
                f"[ARD][diag] snapshot roots={sorted(_ACTIVE_ROOTS)!r} co_by_key={list(_CO_BY_KEY.keys())[:20]!r}"
            )
            _log_diag(
                f"[ARD][diag] snapshot co_meta={dict(list(_CO_META.items())[:20])!r} poll_seq={dict(list(_CO_POLL_SEQ.items())[:20])!r}"
            )
        except Exception as e:
            _log_diag(f"[ARD][diag] snapshot state diag failed: {e!r}")
        
        snapshot = {
            "thread_id": tid,
            "privilege": _PRIVILEGE_STATE,
            "transition_event": _PRIVILEGE_TRANSITION_EVENT,
            "transition_symbol": _PRIVILEGE_LAST_SYMBOL,
            "transition_pc": _PRIVILEGE_LAST_PC,
            "transition_path": _get_transition_path_snapshot(),
            "path": []
        }
        
        # 1. Extract the shadow stack (traced coroutines and functions)
        top_async_func = ""
        for cid in stack:
            poll_sym, this_ptr = _CO_META.get(cid, ("<unknown>", 0))
            seq = _CO_POLL_SEQ.get(cid, 0)
            top_async_func = poll_sym

            node_type = "async" if _is_async_symbol(poll_sym) else "sync"

            state_info = _read_state_with_status(poll_sym, this_ptr)

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
                **_state_fields(state_info),
                **_child_hit_fields(),
                **_privilege_fields(hex(this_ptr), async_file, async_fullname, poll_sym),
                "origin": "trace",
                "file": async_file,
                "fullname": async_fullname,
                "line": async_line
            })
            
        # 2. Extract the physical stack tail (frames above the top traced function).
        #    Only do this if the shadow stack is non-empty; if nothing has been
        #    traced yet, we should not fabricate nodes from physical frames.
        phys_tail = []
        shadow_cids = set(stack)  # CIDs already on the shadow stack
        if not stack:
            try:
                _log_ard(
                    f"[ARD] warning: snapshot empty stack: thread={tid} all_tls={_TLS_STACK!r} co_meta={dict(list(_CO_META.items())[:20])!r}"
                )
            except Exception as e:
                _log_diag(f"[ARD][diag] snapshot empty-stack diag failed: {e!r}")
            json_output = json.dumps(snapshot) + "\n"
            gdb.write(json_output)
            temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
            if temp_dir:
                snapshot_path = os.path.join(os.getcwd(), temp_dir, "ardb_snapshot.json")
                try:
                    with open(snapshot_path, "w", encoding="utf-8") as f:
                        f.write(json_output)
                except Exception:
                    pass
            return
        try:
            saved_frame = gdb.selected_frame()
            frame = saved_frame
            while frame:
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
                    node_state_info = _state_info("NON-ASYNC", "unsupported", "non-async frame")
                    node_addr = hex(frame.pc())

                    if frame_type == "async":
                        # For async frames, try to read the env ptr from the
                        # frame's debug info (first argument / self).
                        # $rdi is unreliable for non-entry frames.
                        node_state_info = _state_info("N/A", "unsupported", "missing future pointer")
                        this_ptr = 0
                        env_val = None

                        try:
                            frame.select()
                            block = frame.block()
                            for sym in block:
                                if sym.is_argument:
                                    val = frame.read_var(sym)
                                    this_ptr = _extract_raw_ptr(val)
                                    if this_ptr:
                                        break
                        except Exception:
                            pass

                        # Fallback to register-based first arg
                        if not this_ptr:
                            try:
                                frame.select()
                                reg_ptr = _reg_u64(_first_arg_reg())
                                if reg_ptr > 0x10000:
                                    this_ptr = reg_ptr
                            except Exception:
                                pass

                        # Additional fallback for inlined async frames:
                        # try to read the hidden __awaitee env object directly
                        if not this_ptr:
                            try:
                                frame.select()
                                env_val = _try_read_env_value_from_frame(frame, fname)
                                if env_val is not None:
                                    node_state_info = _read_state_from_value_with_status(env_val)
                            except Exception:
                                pass

                        if this_ptr:
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
                                    node_cid = cid_phys
                                    node_poll = _CO_POLL_SEQ.get(cid_phys, 0)
                                    node_addr = hex(this_ptr)
                                    node_state_info = _read_state_with_status(fname, this_ptr)
                            except Exception:
                                pass

                    # Try to expand the currently awaited inner future as an extra leaf node.
                    try:
                        frame.select()
                        local_awaitee = _try_read_local_awaitee_value(frame)
                    except Exception:
                        local_awaitee = None

                    if local_awaitee is not None:
                        try:
                            awaitee_type = _value_type_name(local_awaitee)
                            outer_env_type = _pollsym_to_envtype(fname) or ""

                            if awaitee_type and awaitee_type != outer_env_type:
                                awaitee_state = _value_state_name(local_awaitee)
                                awaitee_state_info = (
                                    _state_info(awaitee_state, "ok", "")
                                    if _is_valid_state_value(awaitee_state)
                                    else _state_info("N/A", "unsupported", "no runtime future object")
                                )
                                awaitee_poll_sym = _child_poll_symbol_from_awaitee_type(awaitee_type)
                                leaf_func = awaitee_poll_sym or awaitee_type

                                leaf_cid = None
                                leaf_poll = 0
                                leaf_addr = f"{node_addr}::awaitee::{leaf_func}"
                                leaf_state_info = awaitee_state_info
                                leaf_origin = "inferred"
                                child_env_addr = ""
                                try:
                                    inferred_child_ptr = _extract_raw_ptr(local_awaitee)
                                    if inferred_child_ptr:
                                        child_env_addr = hex(inferred_child_ptr)
                                except Exception:
                                    child_env_addr = ""
                                parent_cid_for_hit = (
                                    node_cid
                                    if node_cid is not None
                                    else _find_coro_id_for_symbol_addr(fname, node_addr)
                                )
                                child_hit = _child_hit_fields(
                                    "miss",
                                    tid,
                                    parent_cid_for_hit,
                                    fname,
                                    leaf_func,
                                    child_env_addr,
                                )

                                observed = _find_structured_child_hit(
                                    tid,
                                    parent_cid_for_hit,
                                    fname,
                                    leaf_func,
                                    child_env_addr,
                                )
                                if observed and observed.get("func") == leaf_func:
                                    leaf_cid = observed.get("cid")
                                    leaf_poll = observed.get("poll", 0)
                                    leaf_addr = observed.get("addr") or leaf_addr
                                    leaf_state_info = _merge_state_info_from_observed(leaf_state_info, observed)
                                    leaf_origin = "trace-upgraded"
                                    child_hit = _child_hit_fields(
                                        "structured",
                                        observed.get("thread_id", tid),
                                        observed.get("parent_cid", parent_cid_for_hit),
                                        observed.get("parent_symbol", fname),
                                        observed.get("child_symbol", leaf_func),
                                        observed.get("child_env_addr") or observed.get("addr") or child_env_addr,
                                    )
                                    _log_ard(
                                        f"[ARD] snapshot-upgrade structured parent={fname} child={leaf_func} cid={leaf_cid} poll={leaf_poll} addr={leaf_addr}"
                                    )
                                else:
                                    observed = (
                                        _LAST_CHILD_HIT_BY_CALLER_FRAME.get(fname)
                                        or _LAST_CHILD_HIT_BY_PARENT.get(fname)
                                    )
                                    if observed and observed.get("func") == leaf_func:
                                        leaf_cid = observed.get("cid")
                                        leaf_poll = observed.get("poll", 0)
                                        leaf_addr = observed.get("addr") or leaf_addr
                                        leaf_state_info = _merge_state_info_from_observed(leaf_state_info, observed)
                                        leaf_origin = "trace-upgraded"
                                        child_hit = _child_hit_fields(
                                            "legacy_fallback",
                                            tid,
                                            parent_cid_for_hit,
                                            fname,
                                            leaf_func,
                                            observed.get("addr") or child_env_addr,
                                        )
                                        _log_ard(
                                            f"[ARD] snapshot-upgrade legacy parent={fname} child={leaf_func} cid={leaf_cid} poll={leaf_poll} addr={leaf_addr}"
                                        )
                                    else:
                                        observed_by_key = _LAST_CHILD_HIT_BY_FUNC_ADDR.get((leaf_func, node_addr))
                                        if observed_by_key:
                                            leaf_cid = observed_by_key.get("cid")
                                            leaf_poll = observed_by_key.get("poll", 0)
                                            leaf_addr = observed_by_key.get("addr") or leaf_addr
                                            leaf_state_info = _merge_state_info_from_observed(leaf_state_info, observed_by_key)
                                            leaf_origin = "trace-upgraded"
                                            child_hit = _child_hit_fields(
                                                "legacy_fallback",
                                                tid,
                                                parent_cid_for_hit,
                                                fname,
                                                leaf_func,
                                                observed_by_key.get("addr") or child_env_addr,
                                            )
                                            _log_ard(
                                                f"[ARD] snapshot-upgrade-by-child-key fallback child={leaf_func} cid={leaf_cid} poll={leaf_poll} addr={leaf_addr}"
                                            )
                                        elif _should_log_child_key_miss(leaf_func, node_addr):
                                            _log_ard(
                                                f"[ARD] snapshot-upgrade miss child={leaf_func} parent={fname} parent_cid={parent_cid_for_hit} child_addr={child_env_addr} node_addr={node_addr}"
                                            )

                                # If the next real async frame is already this same child poll,
                                # do not also append an inferred awaitee leaf.
                                if _has_existing_real_async_child(snapshot["path"], phys_tail, leaf_func):
                                    _log_ard(
                                        f"[ARD] awaitee-skip-duplicate parent={fname} child={leaf_func}"
                                    )
                                else:
                                    _log_ard(
                                        f"[ARD] awaitee-phys {fname} -> type={awaitee_type} poll={awaitee_poll_sym} state={awaitee_state}"
                                    )

                                    phys_tail.append({
                                        "type": "async",
                                        "cid": leaf_cid,
                                        "func": leaf_func,
                                        "addr": leaf_addr,
                                        "poll": leaf_poll,
                                        **_state_fields(leaf_state_info),
                                        **child_hit,
                                        **_privilege_fields(leaf_addr, phys_file, phys_fullname, leaf_func),
                                        "origin": leaf_origin,
                                        "file": phys_file,
                                        "fullname": phys_fullname,
                                        "line": phys_line
                                    })
                        except Exception:
                            pass

                    if node_cid is not None and node_poll == 0:
                        filled_poll = _CO_POLL_SEQ.get(node_cid, node_poll)
                        if filled_poll != 0:
                            node_poll = filled_poll
                            _log_ard(
                                f"[ARD] snapshot-fill-poll cid={node_cid} poll={node_poll} func={fname}"
                            )

                    phys_tail.append({
                        "type": frame_type,
                        "cid": node_cid,
                        "func": fname,
                        "addr": node_addr,
                        "poll": node_poll,
                        **_state_fields(node_state_info),
                        **_child_hit_fields(),
                        **_privilege_fields(node_addr, phys_file, phys_fullname, fname),
                        "origin": "physical",
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
    ARDPrivAddCommand()
    ARDPrivEnableCommand()
    ARDPrivResetCommand()
    ARDPrivStatusCommand()
    ARDTransitionResetCommand()
    ARDTransitionAddCommand()
    ARDTransitionEventCommand()
    ARDTransitionStatusCommand()
    ARDRel4EnableTransitionProbeCommand()
    ARDRel4DisableTransitionProbeCommand()
    ARDRel4TransitionProbeStatusCommand()
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

    gdb.write("[ARD] installed. Commands: ardb-gen-whitelist, ardb-load-whitelist, ardb-trace, ardb-get-snapshot, ardb-reset, ardb-get-whitelist-grouped, ardb-update-whitelist, ardb-infer-trace-root, ardb-priv-add, ardb-priv-enable, ardb-priv-reset, ardb-priv-status, ardb-transition-reset, ardb-transition-add, ardb-transition-event, ardb-transition-status, ardb-rel4-enable-transition-probe, ardb-rel4-disable-transition-probe, ardb-rel4-transition-probe-status\n")
