import os
import re
import struct
import gdb
import json
import time
import copy
from datetime import datetime, timezone

from async_rust_debugger.future_pointer_resolver import FuturePointerResolver
from async_rust_debugger.runtime_relation_builder import RuntimeRelationBuilder
from async_rust_debugger.runtime_relation_store import ValidatedRelationStore
from async_rust_debugger.runtime_snapshot_relation_projector import project_snapshot_relations

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

# Runtime History Tree: cumulative call graph for runtime events admitted by
# the main whitelist policy. PollEntryBP writes admitted runtime hits in place.
_CALL_GRAPH_NODES = {}
_CALL_GRAPH_ROOTS = []
_STABLE_CALL_ROOTS = {}  # node key -> first entry event; never removed by edges
_CALL_GRAPH_EDGES = set()
_CALL_GRAPH_EVENTS = []
_CALL_GRAPH_NEXT_EVENT_ID = 1
_CALL_GRAPH_MAX_EVENTS = 5000
_CALL_STACK = {}       # thread_num -> [{key, func, cid}, ...]
_RECENT_CALL_ROOT_BY_THREAD = {}  # thread_num -> {key, cid, event_id}
_RECENT_CALL_ROOT_GLOBAL = None
_RECENT_CALL_ROOT_MAX_EVENT_GAP = 64
_RECENT_CALL_PARENT_BY_THREAD = {}  # thread_num -> most recent non-root admitted function
_RECENT_CALL_PARENT_GLOBAL = None
_RECENT_CALL_PARENT_MAX_EVENT_GAP = 64

def _call_graph_now():
    try:
        return datetime.now(timezone.utc).isoformat()
    except Exception:
        return ""


def _json_safe(value):
    try:
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, (list, tuple, set)):
            return [_json_safe(v) for v in value]
        if isinstance(value, dict):
            return {str(k): _json_safe(v) for k, v in value.items()}
        return str(value)
    except Exception:
        return "<unserializable>"


def _refresh_call_graph_display_label(key, node):
    try:
        if node.get("dispatch_observe"):
            queue_name = node.get("dispatch_queue_state_name", "unknown")
            branch_name = node.get("dispatch_branch_name", "unknown")
            raw_label = node.get("dispatch_raw_label")
            raw_text = "none" if raw_label == (1 << 64) - 1 else str(raw_label)
            node["displayLabel"] = (
                f"{key} [dispatch={branch_name} label={raw_text} queue={queue_name}]"
            )
        else:
            latest = "yes" if node.get("active") else "no"
            node["displayLabel"] = f"{key} [calls={node.get('enter_count', 0)} active={latest}]"
    except Exception:
        pass


def _record_call_event(event, **fields):
    global _CALL_GRAPH_NEXT_EVENT_ID
    try:
        rec = {
            "event_id": _CALL_GRAPH_NEXT_EVENT_ID,
            "event": str(event),
            "timestamp": _call_graph_now(),
        }
        _CALL_GRAPH_NEXT_EVENT_ID += 1
        for k, v in fields.items():
            rec[str(k)] = _json_safe(v)
        _CALL_GRAPH_EVENTS.append(rec)
        overflow = len(_CALL_GRAPH_EVENTS) - _CALL_GRAPH_MAX_EVENTS
        if overflow > 0:
            del _CALL_GRAPH_EVENTS[:overflow]
    except Exception:
        pass


def _call_graph_node_key(func):
    try:
        value = str(func or "").strip()
        return value or "<unknown>"
    except Exception:
        return "<unknown>"


def _mark_stable_call_root(key, first_enter_event=None):
    """Remember a graph entry point independently from later graph edges."""
    try:
        if key not in _CALL_GRAPH_NODES:
            return False
        node = _CALL_GRAPH_NODES[key]
        event_id = first_enter_event or node.get("first_enter_event") or _CALL_GRAPH_NEXT_EVENT_ID
        existing = _STABLE_CALL_ROOTS.get(key)
        if existing is None or event_id < existing:
            _STABLE_CALL_ROOTS[key] = event_id
        if key not in _CALL_GRAPH_ROOTS:
            _CALL_GRAPH_ROOTS.append(key)
        return True
    except Exception as e:
        _record_call_event("call_graph_error", where="_mark_stable_call_root", error=_json_safe(e))
        return False


def _remember_recent_call_root(tid, key, cid=None):
    global _RECENT_CALL_ROOT_GLOBAL
    try:
        if key not in _STABLE_CALL_ROOTS or key not in _CALL_GRAPH_NODES:
            return
        record = {
            "key": key,
            "cid": cid,
            "event_id": _CALL_GRAPH_NEXT_EVENT_ID,
            "func": key,
            "thread_id": tid,
        }
        _RECENT_CALL_ROOT_BY_THREAD[tid] = record
        _RECENT_CALL_ROOT_GLOBAL = record
    except Exception as e:
        _record_call_event("call_graph_error", where="_remember_recent_call_root", error=_json_safe(e))


def _remember_recent_call_parent(tid, key, cid=None):
    global _RECENT_CALL_PARENT_GLOBAL
    try:
        if key in _STABLE_CALL_ROOTS or key not in _CALL_GRAPH_NODES:
            return
        record = {
            "key": key,
            "cid": cid,
            "event_id": _CALL_GRAPH_NEXT_EVENT_ID,
            "func": key,
            "thread_id": tid,
        }
        _RECENT_CALL_PARENT_BY_THREAD[tid] = record
        _RECENT_CALL_PARENT_GLOBAL = record
    except Exception as e:
        _record_call_event("call_graph_error", where="_remember_recent_call_parent", error=_json_safe(e))


def _recent_parent_candidates(tid, child_key):
    """Return ordered, validated fallback parent candidates for an empty call stack."""
    try:
        if child_key in _STABLE_CALL_ROOTS:
            return []

        candidates = []
        seen = set()

        def add_candidate(source, record, order, require_stable, max_gap):
            if not record:
                return
            key = record.get("key")
            if not key or key == child_key or key in seen:
                return
            if key not in _CALL_GRAPH_NODES:
                return
            is_stable = key in _STABLE_CALL_ROOTS
            if is_stable != require_stable:
                return
            event_id = int(record.get("event_id") or 0)
            event_gap = _CALL_GRAPH_NEXT_EVENT_ID - event_id if event_id else 0
            if event_id and event_gap > max_gap:
                return
            seen.add(key)
            candidates.append({
                "key": key,
                "cid": record.get("cid"),
                "source": source,
                "order": order,
                "func": record.get("func") or key,
                "thread_id": record.get("thread_id"),
                "event_gap": event_gap,
            })

        add_candidate(
            "recent_parent_thread",
            _RECENT_CALL_PARENT_BY_THREAD.get(tid),
            1,
            False,
            _RECENT_CALL_PARENT_MAX_EVENT_GAP,
        )
        add_candidate(
            "recent_parent_global",
            _RECENT_CALL_PARENT_GLOBAL,
            2,
            False,
            _RECENT_CALL_PARENT_MAX_EVENT_GAP,
        )

        stable_keys = [key for key in _STABLE_CALL_ROOTS if key in _CALL_GRAPH_NODES]
        if len(stable_keys) == 1:
            stable_key = stable_keys[0]
            root_thread = _RECENT_CALL_ROOT_BY_THREAD.get(tid)
            if root_thread and root_thread.get("key") != stable_key:
                root_thread = None
            root_global = _RECENT_CALL_ROOT_GLOBAL
            if root_global and root_global.get("key") != stable_key:
                root_global = None
            add_candidate(
                "recent_root_thread",
                root_thread,
                3,
                True,
                _RECENT_CALL_ROOT_MAX_EVENT_GAP,
            )
            add_candidate(
                "recent_root_global",
                root_global,
                4,
                True,
                _RECENT_CALL_ROOT_MAX_EVENT_GAP,
            )
        return candidates
    except Exception as e:
        _record_call_event("call_graph_error", where="_recent_parent_candidates", error=_json_safe(e))
        return []


def _ensure_call_graph_node(func, cid=None, **meta):
    try:
        key = _call_graph_node_key(func)
        node = _CALL_GRAPH_NODES.get(key)
        if node is None:
            node = {
                "type": meta.get("type", "async"),
                "cid": cid if cid else None,
                "func": key,
                "displayLabel": key,
                "addr": meta.get("addr", ""),
                "state": meta.get("state", "N/A"),
                "origin": meta.get("origin", "runtime-call-graph"),
                "historyKind": "call-graph",
                "thread_id": meta.get("thread_id"),
                "parent_cid": None,
                "enter_count": 0,
                "exit_count": 0,
                "active_count": 0,
                "active": False,
                "first_enter_event": None,
                "last_enter_event": None,
                "last_exit_event": None,
                "children": [],
            }
            _CALL_GRAPH_NODES[key] = node
        for field in (
            "type", "addr", "state", "state_read_status", "state_read_error",
            "origin", "source", "privilege", "transition_event", "thread_id",
            "depth", "depth_before", "depth_after", "parent_func",
            "matched_top", "error", "last_seen",
            "semantic_kind", "node_kind", "edge_kind",
            "admission_action", "admission_reason",
            "dispatch_observe", "dispatch_queue_state",
            "dispatch_queue_state_name", "dispatch_raw_label",
            "dispatch_branch_id", "dispatch_branch_name", "dispatch_sender",
            "dispatch_sender_kind", "dispatch_read_status",
            "dispatch_read_error",
        ):
            if field in meta:
                node[field] = _json_safe(meta.get(field))
        if cid:
            node["cid"] = cid
        _refresh_call_graph_display_label(key, node)
        return key, node
    except Exception as e:
        _record_call_event("call_graph_error", where="_ensure_call_graph_node", error=_json_safe(e))
        return None, None


def _call_graph_has_path(start_key, target_key):
    try:
        if start_key == target_key:
            return True
        visited = set()
        stack = [start_key]
        while stack:
            key = stack.pop()
            if key in visited:
                continue
            visited.add(key)
            node = _CALL_GRAPH_NODES.get(key)
            children = list(node.get("children", [])) if node else []
            children.extend(child for parent, child in _CALL_GRAPH_EDGES if parent == key)
            for child_key in children:
                if child_key == target_key:
                    return True
                if child_key not in visited:
                    stack.append(child_key)
        return False
    except Exception as e:
        _record_call_event("call_graph_error", where="_call_graph_has_path", error=_json_safe(e))
        return False


def _call_graph_find_parents(child_key):
    """Return every currently recorded parent for a call graph node."""
    try:
        parents = set()
        for parent_key, edge_child_key in _CALL_GRAPH_EDGES:
            if edge_child_key == child_key and parent_key in _CALL_GRAPH_NODES:
                parents.add(parent_key)
        for parent_key, node in _CALL_GRAPH_NODES.items():
            if child_key in node.get("children", []):
                parents.add(parent_key)
        return sorted(
            parents,
            key=lambda key: (
                _CALL_GRAPH_NODES.get(key, {}).get("first_enter_event") or 0,
                key,
            ),
        )
    except Exception as e:
        _record_call_event("call_graph_error", where="_call_graph_find_parents", error=_json_safe(e))
        return []


def _call_graph_remove_edge(parent_key, child_key, reason="", **meta):
    """Remove one historical edge when a more precise parent supersedes it."""
    try:
        edge = (parent_key, child_key)
        parent = _CALL_GRAPH_NODES.get(parent_key)
        had_edge = edge in _CALL_GRAPH_EDGES
        had_child = bool(parent and child_key in parent.get("children", []))
        if not had_edge and not had_child:
            return False

        _CALL_GRAPH_EDGES.discard(edge)
        if parent:
            parent["children"] = [
                key for key in parent.get("children", []) if key != child_key
            ]

        child = _CALL_GRAPH_NODES.get(child_key)
        if child and child.get("parent_func") == parent_key and not _call_graph_find_parents(child_key):
            child["parent_func"] = None
            child["parent_cid"] = None

        _record_call_event(
            "call_edge_removed",
            reason=reason or "edge_removed",
            parent_key=parent_key,
            child_key=child_key,
            new_parent_key=meta.get("new_parent_key"),
            parent_source=meta.get("parent_source", "call_stack"),
            candidate_order=meta.get("candidate_order"),
            candidate_func=meta.get("candidate_func"),
            candidate_thread_id=meta.get("candidate_thread_id"),
            event_gap=meta.get("event_gap"),
        )
        return True
    except Exception as e:
        _record_call_event("call_graph_error", where="_call_graph_remove_edge", error=_json_safe(e))
        return False


def _record_call_edge(parent_key, child_key, parent_cid=None, child_cid=None, **meta):
    try:
        if child_key not in _CALL_GRAPH_NODES:
            return "missing_child"
        if not parent_key or parent_key not in _CALL_GRAPH_NODES:
            _mark_stable_call_root(child_key)
            return "root"
        if parent_key == child_key:
            _record_call_event(
                "call_edge_skipped", reason="self_edge",
                parent_cid=parent_cid, child_cid=child_cid,
                parent_key=parent_key, child_key=child_key,
                parent_source=meta.get("parent_source", "call_stack"),
                candidate_order=meta.get("candidate_order"),
                candidate_func=meta.get("candidate_func", parent_key),
                candidate_thread_id=meta.get("candidate_thread_id"),
                event_gap=meta.get("event_gap"),
            )
            return "self_edge"
        if _call_graph_has_path(child_key, parent_key):
            _record_call_event(
                "call_edge_skipped", reason="would_form_cycle",
                parent_cid=parent_cid, child_cid=child_cid,
                parent_key=parent_key, child_key=child_key,
                parent_source=meta.get("parent_source", "call_stack"),
                candidate_order=meta.get("candidate_order"),
                candidate_func=meta.get("candidate_func", parent_key),
                candidate_thread_id=meta.get("candidate_thread_id"),
                event_gap=meta.get("event_gap"),
            )
            return "would_form_cycle"
        if child_key in _STABLE_CALL_ROOTS and parent_key not in _STABLE_CALL_ROOTS:
            child_first = (
                _CALL_GRAPH_NODES[child_key].get("first_enter_event")
                or _CALL_GRAPH_NODES[child_key].get("last_enter_event") or 0
            )
            parent_first = (
                _CALL_GRAPH_NODES[parent_key].get("first_enter_event")
                or _CALL_GRAPH_NODES[parent_key].get("last_enter_event") or 0
            )
            if child_first and parent_first and child_first <= parent_first:
                _record_call_event(
                    "call_edge_skipped", reason="root_parent_protected",
                    parent_cid=parent_cid, child_cid=child_cid,
                    parent_key=parent_key, child_key=child_key,
                    parent_source=meta.get("parent_source", "call_stack"),
                    candidate_order=meta.get("candidate_order"),
                    candidate_func=meta.get("candidate_func", parent_key),
                    candidate_thread_id=meta.get("candidate_thread_id"),
                    event_gap=meta.get("event_gap"),
                )
                return "root_parent_protected"

        existing_parents = [
            key for key in _call_graph_find_parents(child_key) if key != parent_key
        ]
        coarse_parents = []
        for old_parent_key in existing_parents:
            if _call_graph_has_path(old_parent_key, parent_key):
                coarse_parents.append(old_parent_key)
                continue
            if _call_graph_has_path(parent_key, old_parent_key):
                _record_call_event(
                    "call_edge_skipped", reason="less_precise_parent_existing",
                    parent_cid=parent_cid, child_cid=child_cid,
                    parent_key=parent_key, child_key=child_key,
                    existing_parent_key=old_parent_key,
                    parent_source=meta.get("parent_source", "call_stack"),
                    candidate_order=meta.get("candidate_order"),
                    candidate_func=meta.get("candidate_func", parent_key),
                    candidate_thread_id=meta.get("candidate_thread_id"),
                    event_gap=meta.get("event_gap"),
                )
                return "less_precise_parent_existing"
            _record_call_event(
                "call_edge_skipped", reason="unrelated_parent_existing",
                parent_cid=parent_cid, child_cid=child_cid,
                parent_key=parent_key, child_key=child_key,
                existing_parent_key=old_parent_key,
                parent_source=meta.get("parent_source", "call_stack"),
                candidate_order=meta.get("candidate_order"),
                candidate_func=meta.get("candidate_func", parent_key),
                candidate_thread_id=meta.get("candidate_thread_id"),
                event_gap=meta.get("event_gap"),
            )
            return "unrelated_parent_existing"

        for old_parent_key in coarse_parents:
            _call_graph_remove_edge(
                old_parent_key,
                child_key,
                reason="reparent_to_more_precise_parent",
                new_parent_key=parent_key,
                **meta,
            )

        edge = (parent_key, child_key)
        if edge not in _CALL_GRAPH_EDGES:
            _CALL_GRAPH_EDGES.add(edge)
            children = _CALL_GRAPH_NODES[parent_key].setdefault("children", [])
            if child_key not in children:
                children.append(child_key)
        if child_key not in _STABLE_CALL_ROOTS:
            child = _CALL_GRAPH_NODES[child_key]
            child["parent_cid"] = parent_cid
            child["parent_func"] = parent_key
        _record_call_event(
            "call_edge_accepted",
            parent_key=parent_key,
            child_key=child_key,
            parent_cid=parent_cid,
            child_cid=child_cid,
            parent_source=meta.get("parent_source", "call_stack"),
            candidate_order=meta.get("candidate_order"),
            candidate_func=meta.get("candidate_func", parent_key),
            candidate_thread_id=meta.get("candidate_thread_id"),
            event_gap=meta.get("event_gap"),
        )
        return "accepted"
    except Exception as e:
        _record_call_event("call_graph_error", where="_record_call_edge", error=_json_safe(e))
        return "error"


def _record_call_enter(func, cid=None, parent_cid=None, **meta):
    """Record one whitelist-admitted runtime call entry."""
    if (
        meta.get("admission_action") != "ALLOW"
        or meta.get("admission_reason") != "whitelist_runtime_execution_hit"
    ):
        return None
    try:
        tid = meta.get("thread_id")
        if tid is None:
            tid = _thread_id()
        stack = _CALL_STACK.setdefault(tid, [])
        parent_frame = stack[-1] if stack else None
        parent_key = parent_frame.get("key") if parent_frame else None
        parent_source = "call_stack" if parent_frame else "none"
        candidate_order = 0
        candidate_func = parent_key or ""
        candidate_thread_id = tid if parent_frame else None
        candidate_event_gap = 0 if parent_frame else None
        if parent_cid is None and parent_frame:
            parent_cid = parent_frame.get("cid")

        key, node = _ensure_call_graph_node(func, cid, **meta)
        if not node:
            return None

        is_first_enter = node.get("first_enter_event") is None
        node["enter_count"] = int(node.get("enter_count", 0)) + 1
        node["seenCount"] = node["enter_count"]
        node["active_count"] = int(node.get("active_count", 0)) + 1
        node["active"] = node["active_count"] > 0
        node["currentlyInLatestSnapshot"] = True
        node["last_seen"] = _call_graph_now()
        node["last_enter_event"] = _CALL_GRAPH_NEXT_EVENT_ID
        if is_first_enter:
            node["first_enter_event"] = _CALL_GRAPH_NEXT_EVENT_ID
        _refresh_call_graph_display_label(key, node)

        edge_status = None
        if parent_key:
            edge_status = _record_call_edge(
                parent_key,
                key,
                parent_cid=parent_cid,
                child_cid=cid,
                thread_id=tid,
                parent_source=parent_source,
                candidate_order=candidate_order,
                candidate_func=candidate_func,
                candidate_thread_id=candidate_thread_id,
                event_gap=candidate_event_gap,
            )
        else:
            for candidate in _recent_parent_candidates(tid, key):
                candidate_order = candidate["order"]
                candidate_func = candidate["func"]
                candidate_thread_id = candidate["thread_id"]
                candidate_event_gap = candidate["event_gap"]
                candidate_status = _record_call_edge(
                    candidate["key"],
                    key,
                    parent_cid=candidate["cid"],
                    child_cid=cid,
                    thread_id=tid,
                    parent_source=candidate["source"],
                    candidate_order=candidate_order,
                    candidate_func=candidate_func,
                    candidate_thread_id=candidate_thread_id,
                    event_gap=candidate_event_gap,
                )
                if candidate_status == "accepted":
                    parent_key = candidate["key"]
                    parent_cid = candidate["cid"]
                    parent_source = candidate["source"]
                    edge_status = candidate_status
                    break
                if candidate_status in (
                    "less_precise_parent_existing",
                    "unrelated_parent_existing",
                ):
                    parent_key = node.get("parent_func")
                    parent_cid = node.get("parent_cid")
                    parent_source = "existing_parent"
                    edge_status = candidate_status
                    break
            if edge_status not in (
                "accepted",
                "less_precise_parent_existing",
                "unrelated_parent_existing",
            ):
                parent_key = None
                parent_cid = None
                parent_source = "none"
                candidate_func = ""
                candidate_thread_id = None
                candidate_event_gap = None
                _mark_stable_call_root(key, node.get("first_enter_event"))
                edge_status = _record_call_edge(
                    None,
                    key,
                    child_cid=cid,
                    thread_id=tid,
                )

        if edge_status == "accepted" and key not in _STABLE_CALL_ROOTS:
            node["parent_cid"] = parent_cid
            node["parent_func"] = parent_key

        event_fields = dict(meta)
        event_fields.update({
            "cid": cid,
            "parent_cid": parent_cid,
            "func": key,
            "parent_func": parent_key,
            "parent_source": parent_source,
            "candidate_order": candidate_order,
            "candidate_func": candidate_func,
            "candidate_thread_id": candidate_thread_id,
            "event_gap": candidate_event_gap,
            "edge_status": edge_status,
        })
        _record_call_event("call_enter", **event_fields)
        if key in _STABLE_CALL_ROOTS:
            _remember_recent_call_root(tid, key, cid)
        elif edge_status == "accepted":
            _remember_recent_call_parent(tid, key, cid)

        frame = {"key": key, "func": key, "cid": cid, "thread_id": tid}
        stack.append(frame)
        return frame
    except Exception as e:
        _record_call_event("call_graph_error", where="_record_call_enter", error=_json_safe(e))
        return None


def _record_call_exit(func, cid=None, **meta):
    """Close one graph call frame and restore the node's active state."""
    try:
        tid = meta.get("thread_id")
        if tid is None:
            tid = _thread_id()
        key = _call_graph_node_key(meta.get("call_key") or func)
        stack = _CALL_STACK.setdefault(tid, [])
        depth_before = len(stack)
        matched_top = bool(stack and stack[-1].get("key") == key)
        if matched_top:
            stack.pop()
        else:
            for index in range(len(stack) - 1, -1, -1):
                if stack[index].get("key") == key:
                    del stack[index]
                    break

        node = _CALL_GRAPH_NODES.get(key)
        if node:
            node["exit_count"] = int(node.get("exit_count", 0)) + 1
            node["active_count"] = max(0, int(node.get("active_count", 0)) - 1)
            node["active"] = node["active_count"] > 0
            node["currentlyInLatestSnapshot"] = node["active"]
            node["last_seen"] = _call_graph_now()
            node["last_exit_event"] = _CALL_GRAPH_NEXT_EVENT_ID
            _refresh_call_graph_display_label(key, node)

        event_fields = dict(meta)
        event_fields.update({
            "cid": cid,
            "func": key,
            "depth_before": depth_before,
            "depth_after": len(stack),
            "matched_top": matched_top,
        })
        _record_call_event("call_exit", **event_fields)
    except Exception as e:
        _record_call_event(
            "call_graph_error",
            where="_record_call_exit",
            cid=cid,
            error=_json_safe(e),
        )


def _validate_call_graph():
    """Validate the graph without changing runtime state or control flow."""
    errors = []
    warnings = []
    root_keys = set()

    def add_error(kind, detail):
        errors.append(f"{kind}: {detail}")

    def add_warning(kind, detail):
        warnings.append(f"{kind}: {detail}")

    try:
        nodes = _CALL_GRAPH_NODES
        node_keys = set(nodes.keys())
        adjacency = {key: set() for key in node_keys}
        incoming = {key: set() for key in node_keys}
        seen_registry_edges = set()

        try:
            registry_edges = list(_CALL_GRAPH_EDGES)
        except Exception as e:
            registry_edges = []
            add_error("invalid_edge_registry", _json_safe(e))

        for raw_edge in registry_edges:
            try:
                parent_key, child_key = raw_edge
                edge = (parent_key, child_key)
            except Exception:
                add_error("invalid_edge", repr(raw_edge))
                continue
            if edge in seen_registry_edges:
                add_warning("duplicate_edge", f"{parent_key} -> {child_key}")
            seen_registry_edges.add(edge)
            if parent_key not in node_keys:
                add_error("missing_node_reference", f"parent {parent_key}")
            if child_key not in node_keys:
                add_error("missing_node_reference", f"child {child_key}")
            if parent_key == child_key:
                add_error("self_loop", f"{parent_key} -> {child_key}")
            if parent_key in node_keys and child_key in node_keys:
                adjacency[parent_key].add(child_key)
                incoming[child_key].add(parent_key)

        for parent_key, node in nodes.items():
            try:
                children = node.get("children", [])
                if children is None:
                    children = []
                child_items = list(children)
            except Exception as e:
                add_warning("invalid_children", f"{parent_key}: {_json_safe(e)}")
                continue
            seen_children = set()
            for child_key in child_items:
                if child_key in seen_children:
                    add_warning("duplicate_edge", f"{parent_key} -> {child_key}")
                seen_children.add(child_key)
                if child_key not in node_keys:
                    add_error("missing_node_reference", f"child {child_key}")
                    continue
                if parent_key == child_key:
                    add_error("self_loop", f"{parent_key} -> {child_key}")
                adjacency[parent_key].add(child_key)
                incoming[child_key].add(parent_key)

        root_keys = set(_CALL_GRAPH_ROOTS)
        root_keys.update(_STABLE_CALL_ROOTS.keys())
        for root_key in root_keys:
            if root_key not in node_keys:
                add_error("missing_root_node", str(root_key))

        for node_key in node_keys:
            if node_key not in root_keys and not incoming[node_key]:
                add_warning("orphan_node", str(node_key))

        colour = {key: 0 for key in node_keys}
        reported_cycles = set()

        def visit(node_key, path):
            colour[node_key] = 1
            for child_key in adjacency.get(node_key, ()):
                if colour[child_key] == 1:
                    try:
                        start = path.index(child_key)
                        cycle = tuple(path[start:] + [child_key])
                    except ValueError:
                        cycle = (node_key, child_key)
                    if cycle not in reported_cycles:
                        reported_cycles.add(cycle)
                        add_error("cycle", " -> ".join(str(key) for key in cycle))
                elif colour[child_key] == 0:
                    visit(child_key, path + [child_key])
            colour[node_key] = 2

        for node_key in node_keys:
            if colour[node_key] == 0:
                visit(node_key, [node_key])

        for node_key, node in nodes.items():
            admission_action = node.get("admission_action")
            admission_reason = node.get("admission_reason")
            if admission_action is None:
                add_warning("missing_admission_action", str(node_key))
            elif admission_action != "ALLOW":
                add_error("invalid_admission_action", f"{node_key} action={admission_action}")
            if admission_reason is None:
                add_warning("missing_admission_reason", str(node_key))
            elif admission_reason != "whitelist_runtime_execution_hit":
                add_error("invalid_admission_reason", f"{node_key} reason={admission_reason}")

            dispatch_observe = node.get("dispatch_observe")
            is_dispatch = (
                dispatch_observe is True
                or str(dispatch_observe).lower() == "true"
                or node.get("semantic_kind") == "dispatch_observation"
                or node.get("node_kind") == "dispatch_observation"
            )
            if is_dispatch:
                add_error("dispatch_node", str(node.get("func") or node_key))
    except Exception as e:
        add_error("validator_failure", _json_safe(e))

    result = {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "stats": {
            "nodes_count": len(_CALL_GRAPH_NODES),
            "edges_count": len(_CALL_GRAPH_EDGES),
            "roots_count": len(root_keys),
            "events_count": len(_CALL_GRAPH_EVENTS),
        },
    }
    return result


def _clear_call_graph():
    """Clear cumulative RuntimeEventGraph state without touching collectors."""
    global _CALL_GRAPH_NEXT_EVENT_ID
    global _RECENT_CALL_ROOT_GLOBAL
    global _RECENT_CALL_PARENT_GLOBAL

    _CALL_GRAPH_NODES.clear()
    _CALL_GRAPH_ROOTS.clear()
    _STABLE_CALL_ROOTS.clear()
    _CALL_GRAPH_EDGES.clear()
    _CALL_GRAPH_EVENTS.clear()
    _CALL_STACK.clear()
    _RECENT_CALL_ROOT_BY_THREAD.clear()
    _RECENT_CALL_ROOT_GLOBAL = None
    _RECENT_CALL_PARENT_BY_THREAD.clear()
    _RECENT_CALL_PARENT_GLOBAL = None
    _CALL_GRAPH_NEXT_EVENT_ID = 1


def _export_call_graph_relation_annotations():
    """Project validated await evidence onto existing graph edges only."""
    try:
        annotated_edges = set()
        for record in _RUNTIME_RELATION_STORE.get_relations():
            # History clear establishes a view baseline without mutating the
            # validator's fact store.  Only evidence observed after that
            # baseline may annotate the newly accumulated execution graph.
            if _history_relation_occurrence_delta(record) <= 0:
                continue
            if (
                record.get("kind") != "await"
                or record.get("confidence") != "observed"
            ):
                continue
            parent_key = _call_graph_node_key(record.get("parent_symbol"))
            child_key = _call_graph_node_key(record.get("child_symbol"))
            edge = (parent_key, child_key)
            if edge in _CALL_GRAPH_EDGES:
                annotated_edges.add(edge)

        return [
            {
                "parent": parent_key,
                "child": child_key,
                "relation": {
                    "kind": "await",
                    "confidence": "observed",
                    "source": "ValidatedRelationStore",
                },
            }
            for parent_key, child_key in sorted(annotated_edges)
        ]
    except Exception:
        # Relation annotation is auxiliary and must never affect History topology.
        return []


def _export_call_graph():
    """Export RuntimeEventGraph as a detached History Tree payload."""
    try:
        exported_keys = set()

        def export_node_fields(src):
            out = {}
            for field, value in src.items():
                if field == "children":
                    continue
                if field in ("privilege", "transition_event"):
                    continue
                if str(field).startswith("dispatch_"):
                    continue
                out[str(field)] = _json_safe(value)
            return out

        def clone_node(key, path_seen=None):
            if path_seen is None:
                path_seen = set()
            if key in path_seen or key in exported_keys:
                return None
            src = _CALL_GRAPH_NODES.get(key)
            if not src:
                return None
            exported_keys.add(key)
            next_path = set(path_seen)
            next_path.add(key)
            out = export_node_fields(src)
            out["children"] = []
            for child_key in src.get("children", []):
                child = clone_node(child_key, next_path)
                if child is not None:
                    out["children"].append(child)
            return out

        node_order = sorted(
            _CALL_GRAPH_NODES.keys(),
            key=lambda key: (
                _CALL_GRAPH_NODES[key].get("first_enter_event")
                or _CALL_GRAPH_NODES[key].get("last_enter_event")
                or 0,
                key,
            ),
        )
        root_keys = [
            key for key, _event_id in sorted(
                _STABLE_CALL_ROOTS.items(), key=lambda item: (item[1], item[0])
            )
            if key in _CALL_GRAPH_NODES
        ]
        compatibility_roots = sorted(
            (
                key for key in _CALL_GRAPH_ROOTS
                if key in _CALL_GRAPH_NODES and key not in root_keys
            ),
            key=lambda key: (
                _CALL_GRAPH_NODES[key].get("first_enter_event")
                or _CALL_GRAPH_NODES[key].get("last_enter_event")
                or 0,
                key,
            ),
        )
        root_keys.extend(compatibility_roots)
        if not root_keys and node_order:
            root_keys = [node_order[0]]
            _mark_stable_call_root(root_keys[0])

        roots = []
        for key in root_keys:
            root = clone_node(key)
            if root is not None:
                roots.append(root)
        if not roots and node_order:
            root = clone_node(node_order[0])
            if root is not None:
                roots.append(root)
                _mark_stable_call_root(node_order[0])

        nodes = []
        for key in node_order:
            node = export_node_fields(_CALL_GRAPH_NODES[key])
            node["children"] = [
                child_key
                for child_key in _CALL_GRAPH_NODES[key].get("children", [])
                if child_key in _CALL_GRAPH_NODES
            ]
            nodes.append(node)

        edges = [
            {"parent": parent_key, "child": child_key}
            for parent_key, child_key in sorted(
                _CALL_GRAPH_EDGES,
                key=lambda edge: (
                    _CALL_GRAPH_NODES.get(edge[0], {}).get("first_enter_event") or 0,
                    _CALL_GRAPH_NODES.get(edge[1], {}).get("first_enter_event") or 0,
                    edge[0],
                    edge[1],
                ),
            )
        ]
        events = _json_safe(list(_CALL_GRAPH_EVENTS))
        counts = {
            "nodes": len(_CALL_GRAPH_NODES),
            "edges": len(_CALL_GRAPH_EDGES),
            "roots": len(roots),
            "stable_roots": sum(
                1 for key in _STABLE_CALL_ROOTS if key in _CALL_GRAPH_NODES
            ),
            "events": len(_CALL_GRAPH_EVENTS),
        }
        return {
            "type": "history_tree",
            "graph_kind": "call_graph",
            "nodes": nodes,
            "edges": edges,
            "relation_annotations": _export_call_graph_relation_annotations(),
            "roots": roots,
            "events": events,
            "counts": counts,
            "nodes_count": counts["nodes"],
            "edges_count": counts["edges"],
            "roots_count": counts["roots"],
            "stable_roots_count": counts["stable_roots"],
            "events_count": counts["events"],
        }
    except Exception as e:
        counts = {
            "nodes": len(_CALL_GRAPH_NODES),
            "edges": len(_CALL_GRAPH_EDGES),
            "roots": 0,
            "stable_roots": len(_STABLE_CALL_ROOTS),
            "events": len(_CALL_GRAPH_EVENTS),
        }
        return {
            "type": "history_tree",
            "graph_kind": "call_graph",
            "nodes": [],
            "edges": [],
            "relation_annotations": [],
            "roots": [],
            "events": [],
            "counts": counts,
            "nodes_count": counts["nodes"],
            "edges_count": counts["edges"],
            "roots_count": 0,
            "stable_roots_count": counts["stable_roots"],
            "events_count": counts["events"],
            "error": _json_safe(e),
        }


_RUNTIME_CHILD_HIT_CACHE = []
_RUNTIME_CHILD_HIT_CACHE_LIMIT = 1000
_RUNTIME_CHILD_HIT_NEXT_EVENT_ID = 1

_RUNTIME_RELATION_STORE = ValidatedRelationStore(max_relations=1000)
_RUNTIME_RELATION_BUILDER = RuntimeRelationBuilder(_RUNTIME_RELATION_STORE)


def _clear_runtime_child_hits():
    global _RUNTIME_CHILD_HIT_NEXT_EVENT_ID
    _RUNTIME_CHILD_HIT_CACHE.clear()
    _RUNTIME_CHILD_HIT_NEXT_EVENT_ID = 1


def _get_runtime_child_hits():
    """Return a copy so callers cannot mutate the internal evidence cache."""
    return [dict(record) for record in _RUNTIME_CHILD_HIT_CACHE]

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

class _PollActivation(int):
    """CID-compatible TLS entry carrying one observed invocation identity."""

    def __new__(cls, cid, token):
        entry = super().__new__(cls, cid)
        entry.token = token
        return entry

    def __reduce__(self):
        return type(self), (int(self), self.token)


def _push_coro(cid: int, tid: int, sequence: int) -> int:
    # Store reset already advances the observation domain on reset/disable.
    epoch = _RUNTIME_RELATION_STORE.get_metadata()["store_generation"]
    token = (epoch, tid, int(cid), sequence)
    st = _TLS_STACK.setdefault(tid, [])
    st.append(_PollActivation(cid, token))
    return len(st) - 1  # depth

def _current_coro():
    tid = _thread_id()
    st = _TLS_STACK.get(tid, [])
    return (st[-1], len(st) - 1) if st else (0, -1)

def _retire_poll_activation(tid: int, token):
    """Retire only the bound invocation, never an arbitrary matching CID."""
    if token is None or token[1] != tid:
        return
    st = _TLS_STACK.get(tid, [])
    for i, entry in enumerate(st):
        if getattr(entry, "token", None) == token:
            del st[i]
            return

def _finish_breakpoint_needs_c_language(frame) -> bool:
    """Detect GDB's Rust high-half numeric breakpoint limitation."""
    try:
        caller = frame.older()
        if caller is None:
            return False
        return_pc = int(caller.pc())
        pointer_bits = _ptr_size() * 8
        return_pc &= (1 << pointer_bits) - 1
        return (
            str(frame.language()).lower() == "rust"
            and bool(return_pc & (1 << (pointer_bits - 1)))
        )
    except Exception:
        return False

class _PopOnReturnBP(gdb.FinishBreakpoint):
    """Close the graph frame, then pop the main coroutine TLS stack."""
    def __init__(
        self,
        tid: int,
        cid: int | None,
        func: str = "",
        graph_entered: bool = False,
        cleanup_tls: bool = True,
        activation_token=None,
    ):
        frame = gdb.selected_frame()
        previous_language = None
        use_c_language = _finish_breakpoint_needs_c_language(frame)
        try:
            if use_c_language:
                previous_language = str(gdb.parameter("language"))
                gdb.execute("set language c", to_string=True)
            super().__init__(frame, internal=True)
        finally:
            if previous_language is not None:
                gdb.execute(f"set language {previous_language}", to_string=True)
        self.silent = True
        self.tid = tid
        self.cid = cid
        self.func = func
        self.graph_entered = graph_entered
        self.cleanup_tls = cleanup_tls
        self.activation_token = activation_token
        self._retired = False
        _RUN_SCOPED_BPS.append(self)

    def stop(self):
        if not self.cleanup_tls:
            # Preserve the generic observer's original return semantics.
            if self.graph_entered:
                _record_call_exit(self.func, self.cid, thread_id=self.tid)
            return False
        if self._retired:
            return False
        if self.cleanup_tls and self.activation_token is not None:
            if self.activation_token[0] != _RUNTIME_RELATION_STORE.get_metadata()["store_generation"]:
                self._retire()
                return False
        if self.graph_entered:
            _record_call_exit(self.func, self.cid, thread_id=self.tid)

        # Generic synchronous RuntimeEvents share graph exit handling but never
        # participate in main's coroutine TLS stack.
        self._retire()
        return False

    def _retire(self):
        if self._retired:
            return
        self._retired = True
        if self.cleanup_tls:
            _retire_poll_activation(self.tid, self.activation_token)

    def out_of_scope(self):
        # Observer retirement is not a normal return or a historical event.
        if self.cleanup_tls:
            self._retire()


# -------------------------
# State (breakpoints / whitelist)
# -------------------------

_CREATED_BPS = []
_RUN_SCOPED_BPS = []

# Whitelist-owned async runtime observers.  These are instrumentation rather
# than user-selected trace roots and feed the existing PollEntryBP fact path.
_RUNTIME_EVENT_BPS = []
_ACTIVE_RUNTIME_EVENT_SYMBOLS = set()

_CALLSITE_INSTALLED_FOR_FN = set()   # per-run: avoid re-installing callsite BPs
_ACTIVE_ROOTS = set()                # poll symbols we installed PollEntryBP for
ACTIVE_TRACE_ROOT = None            # observation context only; never a probe

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

CALL_MNEMONIC_RE = re.compile(r"^\s*call\w*\b", re.IGNORECASE)
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
    return int(gdb.parse_and_eval(f"${name}"))

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
        voidp = gdb.lookup_type("char").pointer()
        return int(v.cast(charp))
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

def _make_runtime_event(event_kind, symbol, addr, thread_id, source, metadata=None):
    """Build a runtime event without mutating the RuntimeEventGraph."""
    return {
        "event_kind": str(event_kind or "runtime_hit"),
        "symbol": str(symbol or ""),
        "addr": addr or "",
        "thread_id": thread_id,
        "source": str(source or "runtime"),
        "timestamp": _call_graph_now(),
        "metadata": dict(metadata or {}),
    }


def _classify_runtime_event(raw_event):
    """Classify a runtime event using main's existing whitelist lookups."""
    symbol = str(raw_event.get("symbol") or "")
    source = str(raw_event.get("source") or "runtime")
    is_future_poll = source == "poll-entry"
    metadata = dict(raw_event.get("metadata") or {})
    raw_addr = raw_event.get("addr")
    code_addr = None
    try:
        code_addr = int(raw_addr, 0) if isinstance(raw_addr, str) else int(raw_addr)
    except (TypeError, ValueError, OverflowError):
        code_addr = None

    name_match = _whitelist_allows_by_name(symbol) if symbol else None
    addr_match = _whitelist_allows_by_addr(code_addr) if code_addr is not None else None
    whitelist_match = name_match or addr_match
    metadata.update({
        "source": source,
        "whitelist_allowed": bool(whitelist_match),
        "whitelist_reason": (
            "name_match" if name_match
            else "address_match" if addr_match
            else "whitelist_rejected"
        ),
        "whitelist_match": whitelist_match,
    })
    return {
        "type": "async" if is_future_poll else "sync",
        "semantic_kind": "future_poll" if is_future_poll else "runtime_call",
        "node_kind": "call",
        "edge_kind": "call",
        "symbol": symbol,
        "addr": raw_event.get("addr", ""),
        "thread_id": raw_event.get("thread_id"),
        "source": source,
        "timestamp": raw_event.get("timestamp", ""),
        "metadata": metadata,
    }


def _admit_trace_candidate(candidate):
    """Return the future graph-write admission decision for a candidate."""
    symbol = str(candidate.get("symbol") or "")
    if not symbol:
        return {"action": "REJECT", "reason": "missing_symbol"}
    if not candidate.get("metadata", {}).get("whitelist_allowed"):
        return {"action": "REJECT", "reason": "whitelist_not_allowed"}
    return {"action": "ALLOW", "reason": "whitelist_runtime_execution_hit"}

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
    global _RECENT_CALL_ROOT_GLOBAL, _RECENT_CALL_PARENT_GLOBAL
    for bp in list(_RUN_SCOPED_BPS):
        try:
            bp.delete()
        except Exception:
            pass
    _RUN_SCOPED_BPS.clear()

    _CALLSITE_INSTALLED_FOR_FN.clear()
    _invalidate_whitelist_addrs()

    _TLS_STACK.clear()
    _CALL_STACK.clear()
    _RECENT_CALL_ROOT_BY_THREAD.clear()
    _RECENT_CALL_ROOT_GLOBAL = None
    _RECENT_CALL_PARENT_BY_THREAD.clear()
    _RECENT_CALL_PARENT_GLOBAL = None
    _CO_BY_KEY.clear()
    _CO_META.clear()
    _CO_POLL_SEQ.clear()
    _clear_runtime_child_hits()
    _RUNTIME_RELATION_STORE.reset()
    _reset_history_relation_baseline()
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
        pointer_result = FuturePointerResolver.resolve(gdb.selected_frame())
        this_ptr = pointer_result.address

        poll_sym = self.poll_sym or fn
        cid = 0
        is_new = False
        depth = -1
        parent_cid = None
        activation_token = None

        existing_stack = _TLS_STACK.get(tid, [])
        if existing_stack:
            parent_cid = existing_stack[-1]

        if poll_sym and this_ptr is not None:
            cid, is_new = _get_or_make_coro_id(poll_sym, this_ptr)

        # poll sequence per coro instance
        seq = 0
        if cid:
            seq = _CO_POLL_SEQ.get(cid, 0) + 1
            _CO_POLL_SEQ[cid] = seq
            depth = _push_coro(cid, tid, seq)
            activation_token = _TLS_STACK[tid][-1].token

        indent = "  " * max(depth, 0)

        if parent_cid is not None and cid:
            child_hit = _record_runtime_child_hit(tid, parent_cid, cid, seq)
            if child_hit is not None:
                _build_runtime_relation(child_hit)

        _build_whitelist_addr_map_if_needed(caller_is_user_visible=(not self.internal))

        # RuntimeEvent pipeline plus call-enter graph write.  This augments the
        # existing CID/Future/Snapshot facts and uses the main whitelist as the
        # only graph admission source.
        graph_frame = None
        graph_cid = None
        try:
            runtime_pc = _current_pc()
            runtime_state = (
                _read_env_state(poll_sym, this_ptr)
                if poll_sym and this_ptr is not None
                else "N/A"
            )
            runtime_event = _make_runtime_event(
                "call_entry_hit",
                poll_sym,
                hex(runtime_pc),
                tid,
                "poll-entry",
                {
                    "cid": cid if cid else None,
                    "future_address": hex(this_ptr) if this_ptr is not None else "",
                    "pc": hex(runtime_pc),
                    "poll": seq,
                    "state": runtime_state,
                },
            )
            _log_ard(
                f"[ARD DEBUG] runtime_event create symbol={runtime_event.get('symbol')}"
            )
            runtime_candidate = _classify_runtime_event(runtime_event)
            _log_ard(f"[ARD DEBUG] classify result={runtime_candidate!r}")
            runtime_admission = _admit_trace_candidate(runtime_candidate)
            _log_ard(f"[ARD DEBUG] admission result={runtime_admission!r}")
            if runtime_admission.get("action") == "ALLOW":
                graph_metadata = dict(runtime_candidate.get("metadata") or {})
                graph_cid = graph_metadata.pop("cid", None)
                graph_metadata.update({
                    "type": runtime_candidate.get("type"),
                    "thread_id": runtime_candidate.get("thread_id"),
                    "addr": runtime_candidate.get("addr", ""),
                    "origin": "runtime-event",
                    "semantic_kind": runtime_candidate.get("semantic_kind"),
                    "node_kind": runtime_candidate.get("node_kind"),
                    "edge_kind": runtime_candidate.get("edge_kind"),
                    "admission_action": runtime_admission.get("action"),
                    "admission_reason": runtime_admission.get("reason"),
                })
                _log_ard("[ARD DEBUG] before call_enter")
                graph_frame = _record_call_enter(
                    runtime_candidate.get("symbol"),
                    graph_cid,
                    **graph_metadata,
                )
                _log_ard(f"[ARD DEBUG] after call_enter frame={graph_frame!r}")
        except Exception as e:
            # Graph diagnostics must not change the original PollEntryBP stop policy.
            _log_ard(f"[ARD DEBUG] runtime graph exception: {e!r}")

        # A single FinishBreakpoint owns graph exit and the original TLS cleanup.
        if cid or graph_frame is not None:
            try:
                _PopOnReturnBP(
                    tid,
                    cid,
                    graph_frame.get("func") if graph_frame else poll_sym,
                    graph_entered=graph_frame is not None,
                    activation_token=activation_token,
                )
            except Exception:
                if graph_frame is not None:
                    _record_call_exit(
                        graph_frame.get("func"),
                        graph_cid,
                        thread_id=tid,
                        return_breakpoint_failed=True,
                    )
                if cid:
                    _retire_poll_activation(tid, activation_token)
                raise

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


def _quote_gdb_break_location(symbol: str) -> str:
    """Preserve exact Rust symbols containing spaces, commas, or braces."""
    return "'" + str(symbol).replace("\\", "\\\\").replace("'", "\\'") + "'"


class RuntimeEventBP(PollEntryBP):
    """Whitelist-owned observer that reuses the existing async fact pipeline."""

    def __init__(self, symbol: str):
        super().__init__(
            _quote_gdb_break_location(symbol),
            poll_sym=symbol,
            internal=True,
            temporary=False,
        )
        self.runtime_symbol = symbol
        _RUNTIME_EVENT_BPS.append(self)
        _ACTIVE_RUNTIME_EVENT_SYMBOLS.add(symbol)
        _ACTIVE_ROOTS.add(symbol)


class GenericRuntimeEventBP(gdb.Breakpoint):
    """Record a synchronous whitelist function as a graph child only."""

    def __init__(self, symbol: str):
        super().__init__(
            _quote_gdb_break_location(symbol),
            type=gdb.BP_BREAKPOINT,
            internal=True,
            temporary=False,
        )
        self.silent = True
        self.runtime_symbol = symbol
        _CREATED_BPS.append(self)
        _RUNTIME_EVENT_BPS.append(self)
        _ACTIVE_RUNTIME_EVENT_SYMBOLS.add(symbol)

    def stop(self) -> bool:
        tid = _thread_id()

        # Sync functions enrich an active async execution path; they must not
        # become independent trace roots when called outside that path.
        if not _CALL_STACK.get(tid):
            return False

        graph_frame = None
        try:
            runtime_pc = _current_pc()
            runtime_event = _make_runtime_event(
                "call_entry_hit",
                self.runtime_symbol,
                hex(runtime_pc),
                tid,
                "generic-runtime-entry",
                {"pc": hex(runtime_pc)},
            )
            runtime_candidate = _classify_runtime_event(runtime_event)
            runtime_admission = _admit_trace_candidate(runtime_candidate)
            if runtime_admission.get("action") == "ALLOW":
                graph_metadata = dict(runtime_candidate.get("metadata") or {})
                graph_metadata.update({
                    "type": runtime_candidate.get("type"),
                    "thread_id": runtime_candidate.get("thread_id"),
                    "addr": runtime_candidate.get("addr", ""),
                    "origin": "runtime-event",
                    "semantic_kind": runtime_candidate.get("semantic_kind"),
                    "node_kind": runtime_candidate.get("node_kind"),
                    "edge_kind": runtime_candidate.get("edge_kind"),
                    "admission_action": runtime_admission.get("action"),
                    "admission_reason": runtime_admission.get("reason"),
                })
                graph_frame = _record_call_enter(
                    runtime_candidate.get("symbol"),
                    None,
                    **graph_metadata,
                )

            if graph_frame is not None:
                try:
                    _PopOnReturnBP(
                        tid,
                        None,
                        graph_frame.get("func"),
                        graph_entered=True,
                        cleanup_tls=False,
                    )
                except Exception:
                    _record_call_exit(
                        graph_frame.get("func"),
                        None,
                        thread_id=tid,
                        return_breakpoint_failed=True,
                    )
                    raise
        except Exception as exc:
            # Generic probes remain transparent to inferior execution.
            _log_ard(f"[ARD DEBUG] sync runtime graph exception: {exc!r}")
        return False


def _remove_runtime_event_breakpoints():
    """Delete only whitelist observers, preserving unrelated breakpoints."""
    for bp in list(_RUNTIME_EVENT_BPS):
        symbol = getattr(bp, "runtime_symbol", "")
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
        if symbol:
            _ACTIVE_RUNTIME_EVENT_SYMBOLS.discard(symbol)
            _ACTIVE_ROOTS.discard(symbol)
    _RUNTIME_EVENT_BPS.clear()


def _install_whitelist_runtime_event_breakpoints():
    """Install async and synchronous observers for exact whitelist symbols.

    Prefix entries cannot be installed before a concrete runtime symbol is
    known; the existing awaitee/call-site discovery path continues to cover
    those entries.  Symbols classified as async by grouped whitelist metadata
    keep the full coroutine fact path, while synchronous exact symbols use
    graph-only probes.
    """
    _remove_runtime_event_breakpoints()
    if not _whitelist_enabled():
        return 0

    _load_async_symbol_set_from_grouped()
    installed = 0
    for symbol in sorted(_WHITELIST_EXACT or ()):
        if symbol in _ACTIVE_RUNTIME_EVENT_SYMBOLS:
            continue
        try:
            if _is_async_symbol(symbol):
                if symbol in _ACTIVE_ROOTS:
                    continue
                RuntimeEventBP(symbol)
            else:
                GenericRuntimeEventBP(symbol)
            installed += 1
        except Exception as exc:
            _log_ard(
                f"[ARD] whitelist runtime observer install failed: "
                f"{symbol}: {exc}"
            )
    return installed


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
        global ACTIVE_TRACE_ROOT
        sym = arg.strip()
        if not sym:
            gdb.write("Usage: ardb-trace <poll-symbol>\n")
            return

        gdb.execute("set pagination off", to_string=True)
        gdb.execute("set debuginfod enabled off", to_string=True)

        if sym == ACTIVE_TRACE_ROOT:
            gdb.write(f"[ARD] trace root already selected: {sym}\n")
            return

        if _whitelist_enabled() and (not _whitelist_allows_by_name(sym)):
            gdb.write(f"[ARD] warning: root not in whitelist: {sym}\n")

        # The trace target is a view selection only.  Runtime collection is
        # owned by whitelist-installed RuntimeEventBP instances.
        ACTIVE_TRACE_ROOT = sym
        gdb.write(f"[ARD] trace root: {sym}\n")


class ARDResetCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-reset", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        global ACTIVE_TRACE_ROOT
        global _RECENT_CALL_ROOT_GLOBAL, _RECENT_CALL_PARENT_GLOBAL
        for bp in list(_CREATED_BPS):
            try:
                bp.delete()
            except Exception:
                pass
        _CREATED_BPS.clear()
        _RUN_SCOPED_BPS.clear()

        _CALLSITE_INSTALLED_FOR_FN.clear()
        _ACTIVE_ROOTS.clear()
        _RUNTIME_EVENT_BPS.clear()
        _ACTIVE_RUNTIME_EVENT_SYMBOLS.clear()
        ACTIVE_TRACE_ROOT = None

        _invalidate_whitelist_addrs()

        _TLS_STACK.clear()
        _CALL_STACK.clear()
        _RECENT_CALL_ROOT_BY_THREAD.clear()
        _RECENT_CALL_ROOT_GLOBAL = None
        _RECENT_CALL_PARENT_BY_THREAD.clear()
        _RECENT_CALL_PARENT_GLOBAL = None
        _CO_BY_KEY.clear()
        _CO_META.clear()
        _CO_POLL_SEQ.clear()
        _clear_runtime_child_hits()
        _RUNTIME_RELATION_STORE.reset()
        _reset_history_relation_baseline()
        global _CO_NEXT_ID
        _CO_NEXT_ID = 1

        # Reset runtime facts while preserving the loaded whitelist observer
        # configuration, matching Debugger-2 lifecycle semantics.
        _install_whitelist_runtime_event_breakpoints()

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

        installed = _install_whitelist_runtime_event_breakpoints()

        gdb.write(
            f"[ARD] whitelist loaded: exact={len(wl_exact)} "
            f"prefix={len(wl_prefix)} observers={installed} from {path}\n"
        )


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

class ARDGetLegacySnapshotCommand(gdb.Command):
    """
    Get a mixed-mode snapshot of the current call stack, including 
    asynchronous coroutines and synchronous function calls.
    Usage: ardb-get-snapshot
    """
    def __init__(self):
        super().__init__("ardb-get-snapshot-legacy", gdb.COMMAND_USER)

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
        #    Only do this if the shadow stack is non-empty; if nothing has been
        #    traced yet, we should not fabricate nodes from physical frames.
        phys_tail = []
        shadow_cids = set(stack)  # CIDs already on the shadow stack
        if not stack:
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
                    node_state = "NON-ASYNC"
                    node_addr = hex(frame.pc())

                    if frame_type == "async":
                        # For async frames, try to read the env ptr from the
                        # frame's debug info (first argument / self).
                        # $rdi is unreliable for non-entry frames.
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
                        # Fallback to $rdi if debug info failed
                        if not this_ptr:
                            try:
                                frame.select()
                                this_ptr = _reg_u64("rdi")
                            except Exception:
                                pass

                        if this_ptr:
                            try:
                                # First try exact match
                                cid_phys, is_new = _get_or_make_coro_id(fname, this_ptr)

                                # If we just created a new CID, check if there's
                                # an existing CID with a nearby address for the
                                # same function.  Pin wrapping can shift the
                                # pointer by a small offset, so we merge to
                                # prevent identity fragmentation.
                                if is_new:
                                    nearby = _find_nearby_coro(fname, this_ptr)
                                    if nearby is not None and nearby != cid_phys:
                                        # Merge: discard the newly created CID,
                                        # reuse the nearby one
                                        key_new = (fname, int(this_ptr))
                                        _CO_BY_KEY.pop(key_new, None)
                                        _CO_META.pop(cid_phys, None)
                                        _CO_POLL_SEQ.pop(cid_phys, None)
                                        cid_phys = nearby

                                if cid_phys not in shadow_cids:
                                    node_cid = cid_phys
                                    node_poll = _CO_POLL_SEQ.get(cid_phys, 0)
                                    node_addr = hex(this_ptr)
                                    node_state = _read_env_state(fname, this_ptr)
                            except Exception:
                                pass

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


# ---------------------------------------------------------------------------
# Stable async machine protocol v1
# ---------------------------------------------------------------------------

_ASYNC_PROTOCOL = "ardb.async"
_ASYNC_PROTOCOL_VERSION = 1
_ASYNC_SESSION_ID = "main-runtime-trace"
_TRACE_ENABLED = False
_TRACE_CAPTURE_HISTORY = True
_HISTORY_RELATION_OCCURRENCE_BASELINE = {}
_HISTORY_RELATION_EVENT_FLOOR = None
_HISTORY_STORE_EVICTION_BASELINE = 0
_HISTORY_BASELINE_GENERATION = 0


def _capture_history_relation_baseline():
    """Capture a detached History view baseline without mutating Store/facts."""
    global _HISTORY_RELATION_EVENT_FLOOR
    global _HISTORY_STORE_EVICTION_BASELINE
    global _HISTORY_BASELINE_GENERATION

    records = _RUNTIME_RELATION_STORE.get_relations()
    metadata = _RUNTIME_RELATION_STORE.get_metadata()
    _HISTORY_RELATION_OCCURRENCE_BASELINE.clear()
    _HISTORY_RELATION_OCCURRENCE_BASELINE.update({
        int(record["relation_id"]): int(record["occurrence_count"])
        for record in records
    })
    _HISTORY_RELATION_EVENT_FLOOR = metadata.get("newest_event_id")
    _HISTORY_STORE_EVICTION_BASELINE = int(metadata.get("eviction_count", 0))
    _HISTORY_BASELINE_GENERATION += 1
    return {
        "occurrences": dict(_HISTORY_RELATION_OCCURRENCE_BASELINE),
        "event_floor": _HISTORY_RELATION_EVENT_FLOOR,
        "eviction_count": _HISTORY_STORE_EVICTION_BASELINE,
        "generation": _HISTORY_BASELINE_GENERATION,
    }


def _reset_history_relation_baseline():
    """Reset only History view state at a relation/session boundary."""
    global _HISTORY_RELATION_EVENT_FLOOR
    global _HISTORY_STORE_EVICTION_BASELINE
    global _HISTORY_BASELINE_GENERATION
    _HISTORY_RELATION_OCCURRENCE_BASELINE.clear()
    _HISTORY_RELATION_EVENT_FLOOR = None
    _HISTORY_STORE_EVICTION_BASELINE = 0
    _HISTORY_BASELINE_GENERATION = 0


def _history_relation_occurrence_delta(record):
    """Return the future History-window count for one detached Store record."""
    try:
        relation_id = int(record["relation_id"])
        occurrence_count = int(record["occurrence_count"])
        if relation_id in _HISTORY_RELATION_OCCURRENCE_BASELINE:
            return max(
                0,
                occurrence_count
                - int(_HISTORY_RELATION_OCCURRENCE_BASELINE[relation_id]),
            )
        if _HISTORY_RELATION_EVENT_FLOOR is not None:
            if int(record["first_event_id"]) <= int(_HISTORY_RELATION_EVENT_FLOOR):
                return 0
        return max(0, occurrence_count)
    except (KeyError, TypeError, ValueError, OverflowError):
        return 0


def _machine_response(schema: str, data=None, error=None):
    """Write exactly one JSON line for a stable machine-facing command."""
    payload = {
        "protocol": _ASYNC_PROTOCOL,
        "schema": schema,
        "version": _ASYNC_PROTOCOL_VERSION,
        "ok": error is None,
        "data": data if error is None else None,
        "error": error,
    }
    gdb.write(json.dumps(payload, separators=(",", ":")) + "\n")
    return payload


def _machine_error(code: str, message: str, recoverable: bool = True):
    return {
        "code": code,
        "message": message,
        "recoverable": bool(recoverable),
    }


def _export_latest_snapshot_debug(payload):
    """Best-effort sidecar export; never changes the machine response."""
    try:
        temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
        if not temp_dir or not isinstance(payload, dict):
            return
        data = payload.get("data")
        thread_id = data.get("thread_id") if isinstance(data, dict) else None
        captured_ns = time.time_ns()
        debug_dir = os.path.join(temp_dir, "debug")
        os.makedirs(debug_dir, exist_ok=True)
        debug_path = os.path.join(debug_dir, "last_snapshot_v1_envelope.json")
        temporary_path = debug_path + ".tmp"
        artifact = {
            "captured_at_utc": time.strftime(
                "%Y-%m-%dT%H:%M:%S", time.gmtime(captured_ns // 1_000_000_000)
            ) + f".{captured_ns % 1_000_000_000:09d}Z",
            "captured_at_unix_ns": captured_ns,
            "thread_id": thread_id,
            "envelope": payload,
        }
        with open(temporary_path, "w", encoding="utf-8") as debug_file:
            debug_file.write(json.dumps(artifact, separators=(",", ":")) + "\n")
        os.replace(temporary_path, debug_path)
    except Exception:
        # Debug export is optional and must never break ordinary snapshot queries.
        pass


def _quote_gdb_source_symbol(symbol: str) -> str:
    """Quote a Rust symbol for GDB linespec APIs without changing identity."""
    return "'" + str(symbol).replace("\\", "\\\\").replace("'", "\\'") + "'"


def _resolve_snapshot_source_path(file_name: str | None):
    """Resolve a DWARF path within bounded workspace/testcase roots."""
    if not file_name:
        return None

    if os.path.isabs(file_name):
        if not os.path.exists(file_name):
            _log_ard(
                "[ARD] snapshot source path unavailable; preserving DWARF path: "
                f"input={file_name!r}"
            )
        return file_name

    workspace_candidate = os.path.abspath(file_name)
    if os.path.exists(workspace_candidate):
        return workspace_candidate

    workspace = os.getcwd()
    testcases_dir = os.path.join(workspace, "testcases")
    matches = []
    try:
        testcase_names = sorted(os.listdir(testcases_dir))
    except OSError:
        testcase_names = []

    for testcase_name in testcase_names:
        testcase_root = os.path.join(testcases_dir, testcase_name)
        if not os.path.isdir(testcase_root):
            continue
        candidate = os.path.abspath(os.path.join(testcase_root, file_name))
        if os.path.exists(candidate):
            matches.append(candidate)

    if _WHITELIST_PATH:
        whitelist_root = os.path.dirname(
            os.path.dirname(os.path.abspath(_WHITELIST_PATH))
        )
        contextual_candidate = os.path.abspath(
            os.path.join(whitelist_root, file_name)
        )
        if contextual_candidate in matches:
            return contextual_candidate

    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        _log_ard(
            "[ARD] snapshot source resolve ambiguous: "
            f"input={file_name!r} candidates={matches!r}"
        )
    else:
        _log_ard(
            "[ARD] snapshot source unresolved; preserving DWARF path: "
            f"input={file_name!r}"
        )
    return file_name


def _snapshot_source_fields(poll_sym: str):
    file_name = None
    full_path = None
    line = None
    quoted_symbol = _quote_gdb_source_symbol(poll_sym)

    # Prefer GDB's resolved symtab path.  It already accounts for the loaded
    # objfile's compilation directory and GDB source substitutions.
    try:
        _locations, sals = gdb.decode_line(quoted_symbol)
        for sal in sals or ():
            symtab = getattr(sal, "symtab", None)
            if not symtab:
                continue
            file_name = getattr(symtab, "filename", "") or file_name
            try:
                full_path = symtab.fullname() or full_path
            except Exception:
                pass
            try:
                line = int(getattr(sal, "line", 0) or line or 0) or None
            except Exception:
                pass
            if full_path:
                _log_ard(
                    "[ARD] snapshot source resolved via GDB symtab: "
                    f"symbol={poll_sym!r} path={full_path!r}"
                )
                break
    except Exception as exc:
        _log_ard(
            "[ARD] snapshot source decode_line failed: "
            f"symbol={poll_sym!r} error={exc!r}"
        )

    # info line remains a field-completion fallback when decode_line cannot
    # provide a SAL or omits the filename/line.
    try:
        info = gdb.execute(f"info line {quoted_symbol}", to_string=True)
        match = _re_info_line.match(info)
        if match:
            if not line:
                line = int(match.group(1))
            if not file_name:
                file_name = match.group(2) or None
    except Exception as exc:
        _log_ard(
            "[ARD] snapshot source info-line failed: "
            f"symbol={poll_sym!r} error={exc!r}"
        )

    if not full_path:
        full_path = _resolve_snapshot_source_path(file_name)

    display_path = file_name or full_path
    return {
        "name": os.path.basename(display_path) if display_path else None,
        "path": full_path,
        "line": line,
    }


def _state_read_failure_status(error_text: str):
    normalized = (error_text or "").lower()
    unsupported_markers = (
        "no type named",
        "no symbol",
        "no member named",
        "there is no member",
        "optimized out",
    )
    return "unsupported" if any(marker in normalized for marker in unsupported_markers) else "error"


def _future_state_metadata(poll_sym: str, this_ptr: int):
    """Read Future type and its named __state field without mutating trace state."""
    result = {
        "state": None,
        "status": "unsupported",
        "error": None,
        "source": "unknown",
        "future_type": None,
        "future_type_source": "unknown",
    }

    if not this_ptr:
        result["error"] = "missing future pointer"
        return result

    env_type_name = _pollsym_to_envtype(poll_sym)
    if not env_type_name:
        result["error"] = "unsupported poll symbol"
        return result

    try:
        env_type = gdb.lookup_type(env_type_name)
        concrete_type = env_type.strip_typedefs()
        result["future_type"] = str(concrete_type)
        result["future_type_source"] = "dwarf"
    except Exception as exc:
        result["status"] = _state_read_failure_status(str(exc))
        result["error"] = str(exc) or "future type lookup failed"
        return result

    try:
        env_value = gdb.Value(this_ptr).cast(env_type.pointer()).dereference()
        # Only the named Rust generator discriminant is accepted. Do not guess
        # state from the first integer-like field.
        result["state"] = int(env_value["__state"])
        result["status"] = "ok"
        result["error"] = None
        result["source"] = "dwarf"
    except Exception as exc:
        result["state"] = None
        result["status"] = _state_read_failure_status(str(exc))
        result["error"] = str(exc) or "future state read failed"

    return result


def _runtime_child_type(poll_sym: str):
    """Read a compiler Future type for evidence without Snapshot state."""
    env_type_name = _pollsym_to_envtype(poll_sym)
    if env_type_name:
        try:
            return str(gdb.lookup_type(env_type_name).strip_typedefs())
        except Exception:
            pass

    trait_poll = re.fullmatch(
        r"<(.+) as core::future::future::Future>::poll",
        str(poll_sym or ""),
    )
    if trait_poll:
        try:
            return str(gdb.lookup_type(trait_poll.group(1)).strip_typedefs())
        except Exception:
            pass

    # Rust may expose an impl method only as `crate::{impl#N}::poll`, which
    # carries no recoverable owner type in the symbol.  At the real poll entry,
    # use the exact DWARF `self: Pin<&mut T>` value instead of guessing T from
    # the symbol.  This is deliberately fail-closed and minimal-testcase safe.
    try:
        frame = gdb.selected_frame()
        frame_name = _normalize_sym_name(frame.name() or "")
        if frame_name != _normalize_sym_name(str(poll_sym or "")):
            return ""

        self_value = frame.read_var("self")
        self_type = self_value.type.strip_typedefs()
        if not str(self_type).startswith("core::pin::Pin<"):
            return ""

        pointer_value = self_value["__pointer"]
        pointer_type = pointer_value.type.strip_typedefs()
        reference_codes = {
            code
            for code in (
                getattr(gdb, "TYPE_CODE_PTR", None),
                getattr(gdb, "TYPE_CODE_REF", None),
                getattr(gdb, "TYPE_CODE_RVALUE_REF", None),
            )
            if code is not None
        }
        if pointer_type.code not in reference_codes:
            return ""

        target_type = pointer_type.target().strip_typedefs()
        target_name = str(target_type).strip()
        return target_name if target_name else ""
    except Exception:
        pass
    return ""


def _record_runtime_child_hit(thread_id: int, parent_cid: int,
                              child_cid: int, child_poll_sequence: int):
    """Append a direct-parent poll-entry fact without changing trace state."""
    global _RUNTIME_CHILD_HIT_NEXT_EVENT_ID

    if not thread_id or not parent_cid or not child_cid:
        return None
    if parent_cid == child_cid:
        return None

    stack = _TLS_STACK.get(thread_id, [])
    if len(stack) < 2 or stack[-2:] != [parent_cid, child_cid]:
        return None

    parent_meta = _CO_META.get(parent_cid)
    child_meta = _CO_META.get(child_cid)
    if not parent_meta or not child_meta:
        return None

    parent_symbol, parent_pointer = parent_meta
    child_symbol, child_pointer = child_meta
    if not parent_symbol or not parent_pointer or not child_symbol or not child_pointer:
        return None

    record = {
        "event_id": _RUNTIME_CHILD_HIT_NEXT_EVENT_ID,
        "thread_id": int(thread_id),
        "parent_cid": int(parent_cid),
        "parent_symbol": str(parent_symbol),
        "parent_address": hex(int(parent_pointer)),
        "child_cid": int(child_cid),
        "child_symbol": str(child_symbol),
        "child_address": hex(int(child_pointer)),
        "child_type": _runtime_child_type(child_symbol),
        "child_poll_sequence": int(child_poll_sequence),
        "source": "poll-entry-direct-parent",
    }
    _RUNTIME_CHILD_HIT_NEXT_EVENT_ID += 1
    _RUNTIME_CHILD_HIT_CACHE.append(record)

    overflow = len(_RUNTIME_CHILD_HIT_CACHE) - _RUNTIME_CHILD_HIT_CACHE_LIMIT
    if overflow > 0:
        del _RUNTIME_CHILD_HIT_CACHE[:overflow]

    return dict(record)


def _unknown_awaitee_candidate():
    return {
        "address": None,
        "type": None,
        "source": "unknown",
        "confidence": "unknown",
    }


def _awaitee_candidate_address(awaitee_value):
    """Return the candidate object's address without unwrapping containers."""
    try:
        concrete_type = awaitee_value.type.strip_typedefs()
        type_code = concrete_type.code
        pointer_codes = {
            code
            for code in (
                getattr(gdb, "TYPE_CODE_PTR", None),
                getattr(gdb, "TYPE_CODE_REF", None),
                getattr(gdb, "TYPE_CODE_RVALUE_REF", None),
            )
            if code is not None
        }
        embedded_codes = {
            code
            for code in (
                getattr(gdb, "TYPE_CODE_STRUCT", None),
                getattr(gdb, "TYPE_CODE_UNION", None),
                getattr(gdb, "TYPE_CODE_ENUM", None),
            )
            if code is not None
        }

        type_name = str(concrete_type)
        unsupported_wrappers = (
            "core::pin::Pin<",
            "core::option::Option<",
        )
        if any(marker in type_name for marker in unsupported_wrappers):
            return None

        if type_code in pointer_codes:
            address = _normalize_addr(awaitee_value)
        elif type_code in embedded_codes:
            address = _normalize_addr(awaitee_value.address)
        else:
            return None

        return address if address else None
    except Exception:
        return None


def _read_awaitee_candidate(poll_sym: str, this_ptr: int):
    """Read an exact active-variant __awaitee field without trace mutation."""
    unknown = _unknown_awaitee_candidate()
    if not poll_sym or not this_ptr:
        return unknown

    env_type_name = _pollsym_to_envtype(poll_sym)
    if not env_type_name:
        return unknown

    try:
        env_type = gdb.lookup_type(env_type_name)
        env_value = gdb.Value(this_ptr).cast(env_type.pointer()).dereference()
        state = int(env_value["__state"])
    except Exception:
        return unknown

    variants = [
        field
        for field in env_type.fields()
        if field.name is not None and str(field.name) == str(state)
    ]
    if len(variants) != 1:
        return unknown

    try:
        variant_type = variants[0].type
        payload = env_value.address.cast(variant_type.pointer()).dereference()
        awaitee_value = payload["__awaitee"]
        awaitee_type = str(awaitee_value.type.strip_typedefs())
        awaitee_address = _awaitee_candidate_address(awaitee_value)
    except Exception:
        return unknown

    if not awaitee_type or not awaitee_address:
        return unknown

    return {
        "address": hex(awaitee_address),
        "type": awaitee_type,
        "source": "dwarf-active-variant-field",
        "confidence": "high",
    }


def _snapshot_node_v1(cid: int, active: bool):
    poll_sym, this_ptr = _CO_META.get(cid, ("<unknown>", 0))
    sequence = int(_CO_POLL_SEQ.get(cid, 0))
    state_metadata = _future_state_metadata(poll_sym, this_ptr)
    awaitee_candidate = _read_awaitee_candidate(poll_sym, this_ptr)

    return {
        "node_id": f"cid:{cid}",
        "cid": cid,
        "kind": "async" if _is_async_symbol(poll_sym) else "sync",
        "function": poll_sym,
        "future_address": hex(this_ptr) if this_ptr else None,
        "future_type": state_metadata["future_type"],
        "future_type_source": state_metadata["future_type_source"],
        "poll": {
            "sequence": sequence,
            "state": state_metadata["state"],
            "status": state_metadata["status"],
            "error": state_metadata["error"],
            "source": state_metadata["source"],
        },
        "awaitee_candidate": awaitee_candidate,
        "edge_from_parent": "await",
        "active": bool(active),
        "privilege": "unknown",
        "origin": "runtime_trace",
        "source": _snapshot_source_fields(poll_sym),
        "physical": False,
    }


def _build_runtime_relation(child_hit: dict):
    """Build from detached facts; never expose Store mutation to callers."""
    try:
        parent_cid = int(child_hit.get("parent_cid", 0))
        parent_node = dict(_snapshot_node_v1(parent_cid, active=False))
        parent_node["thread_id"] = int(child_hit.get("thread_id", 0))
        event_id = int(child_hit.get("event_id", 0))
        return _RUNTIME_RELATION_BUILDER.build(
            parent_node,
            dict(child_hit),
            event_id,
        )
    except Exception:
        return None


def _get_validated_runtime_relations():
    """Return a detached copy of the internal observed relation records."""
    return _RUNTIME_RELATION_STORE.get_relations()


def _snapshot_v1_data():
    tid = _thread_id()
    stack = list(_TLS_STACK.get(tid, []))
    async_path = [
        _snapshot_node_v1(cid, index == len(stack) - 1)
        for index, cid in enumerate(stack)
    ]
    async_path = project_snapshot_relations(
        async_path,
        _get_validated_runtime_relations(),
        thread_id=tid,
    )
    return {
        "session_id": _ASYNC_SESSION_ID,
        "generation": sum(int(value) for value in _CO_POLL_SEQ.values()),
        "thread_id": tid,
        "empty": len(async_path) == 0,
        "privilege": "unknown",
        "transition": {
            "kind": "none",
            "symbol": None,
            "pc": None,
            "path": [],
        },
        "async_path": async_path,
    }


class ARDAsyncCapabilitiesCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-async-capabilities", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        _machine_response("capabilities", {
            "protocol": _ASYNC_PROTOCOL,
            "versions": {
                "snapshot": 1,
                "history": 1,
                "execution_history": 1,
                "observer_tree": 1,
            },
            "deprecated_versions": {"history": 1},
            "features": [
                "snapshot",
                "history",
                "execution-history",
                "observer-tree",
                "trace-control",
                "history-clear",
            ],
            "trace": {
                "enabled": _TRACE_ENABLED,
                "capture_history": _TRACE_CAPTURE_HISTORY,
            },
            "implementation": "runtime_trace.py",
        })


def _owned_probe_objects():
    probes = []
    seen = set()
    for bp in list(_CREATED_BPS) + list(_RUN_SCOPED_BPS):
        identity = id(bp)
        if identity not in seen:
            probes.append(bp)
            seen.add(identity)
    return probes


def _valid_probe_count():
    count = 0
    for bp in _owned_probe_objects():
        try:
            if bp.is_valid():
                count += 1
        except Exception:
            pass
    return count


def _trace_status_v1():
    history_tree = _export_call_graph()
    history_counts = history_tree.get("counts", {})
    return {
        "enabled": _TRACE_ENABLED,
        "roots": [ACTIVE_TRACE_ROOT] if ACTIVE_TRACE_ROOT else [],
        "runtime_probe_count": _valid_probe_count(),
        "run_scoped_probe_count": len(_RUN_SCOPED_BPS),
        "capture_history": _TRACE_CAPTURE_HISTORY,
        "history": {
            "nodes": int(history_counts.get("nodes", 0)),
            "edges": int(history_counts.get("edges", 0)),
            "events": int(history_counts.get("events", 0)),
            "cleared": bool(history_tree.get("cleared", False)),
        },
    }


def _load_whitelist_for_machine(path: str):
    global _WHITELIST_EXACT, _WHITELIST_PREFIX, _WHITELIST_PATH
    wl_exact, wl_prefix = _load_whitelist_file(path)
    _WHITELIST_EXACT = wl_exact
    _WHITELIST_PREFIX = wl_prefix
    _WHITELIST_PATH = path
    _invalidate_whitelist_addrs()


class ARDTraceEnableCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-trace-enable", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        global _TRACE_ENABLED, _TRACE_CAPTURE_HISTORY, ACTIVE_TRACE_ROOT
        try:
            capture_history_was_enabled = _TRACE_CAPTURE_HISTORY
            options = json.loads((arg or "").strip() or "{}")
            if not isinstance(options, dict):
                raise ValueError("input must be a JSON object")

            root = options.get("root")
            if root is not None and not isinstance(root, str):
                raise ValueError("root must be a string")
            root = (root or "").strip()

            whitelist_path = options.get("whitelist_path")
            if whitelist_path is not None and not isinstance(whitelist_path, str):
                raise ValueError("whitelist_path must be a string")
            whitelist_path = (whitelist_path or "").strip()

            capture_history = options.get("capture_history", True)
            if not isinstance(capture_history, bool):
                raise ValueError("capture_history must be a boolean")

            if whitelist_path:
                _load_whitelist_for_machine(whitelist_path)

            if root:
                ACTIVE_TRACE_ROOT = root

            # Re-enable the existing whitelist observer set even when the
            # caller reuses a previously loaded whitelist without a path.
            if _whitelist_enabled():
                _install_whitelist_runtime_event_breakpoints()

            if capture_history and not capture_history_was_enabled:
                _capture_history_relation_baseline()
            _TRACE_CAPTURE_HISTORY = capture_history
            _TRACE_ENABLED = True
            _machine_response("trace-status", _trace_status_v1())
        except (ValueError, json.JSONDecodeError) as exc:
            _machine_response(
                "trace-status",
                error=_machine_error("INVALID_ARGUMENT", str(exc)),
            )
        except Exception as exc:
            _machine_response(
                "trace-status",
                error=_machine_error("INSTRUMENTATION_FAILED", str(exc)),
            )


class ARDTraceDisableCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-trace-disable", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        global _TRACE_ENABLED, ACTIVE_TRACE_ROOT
        for bp in _owned_probe_objects():
            try:
                bp.delete()
            except Exception:
                pass
        _CREATED_BPS.clear()
        _RUN_SCOPED_BPS.clear()
        _CALLSITE_INSTALLED_FOR_FN.clear()
        _ACTIVE_ROOTS.clear()
        _RUNTIME_EVENT_BPS.clear()
        _ACTIVE_RUNTIME_EVENT_SYMBOLS.clear()
        ACTIVE_TRACE_ROOT = None
        _invalidate_whitelist_addrs()
        _clear_runtime_child_hits()
        _TLS_STACK.clear()
        _RUNTIME_RELATION_STORE.reset()
        _reset_history_relation_baseline()
        _TRACE_ENABLED = False
        _machine_response("trace-status", _trace_status_v1())


class ARDTraceStatusCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-trace-status", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        _machine_response("trace-status", _trace_status_v1())


class ARDGetSnapshotCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-get-snapshot", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        try:
            payload = _machine_response("snapshot", _snapshot_v1_data())
            _export_latest_snapshot_debug(payload)
            # The current main stackTrace still probes this legacy diagnostic file.
            # Overwrite it with the v1 envelope so an older bare snapshot can never
            # be reused as stale current data; the main path safely falls back.
            temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
            if temp_dir:
                snapshot_path = os.path.join(os.getcwd(), temp_dir, "ardb_snapshot.json")
                try:
                    with open(snapshot_path, "w", encoding="utf-8") as snapshot_file:
                        snapshot_file.write(json.dumps(payload, separators=(",", ":")) + "\n")
                except Exception:
                    pass
        except Exception as exc:
            _machine_response(
                "snapshot",
                error=_machine_error("INTERNAL", str(exc)),
            )


class ARDGetHistoryTreeCommand(gdb.Command):
    """Return the cumulative RuntimeEventGraph History Tree as JSON."""
    def __init__(self):
        super().__init__("ardb-get-history-tree", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        gdb.write(json.dumps(_export_call_graph()) + "\n")




def _find_observer_subtree(nodes, observer_root):
    """Return a detached subtree selected from exported History roots."""
    if not observer_root:
        return None

    for node in nodes if isinstance(nodes, list) else []:
        if not isinstance(node, dict):
            continue
        if node.get("func") == observer_root:
            return copy.deepcopy(node)
        found = _find_observer_subtree(node.get("children", []), observer_root)
        if found is not None:
            return found
    return None


class ARDGetObserverTreeCommand(gdb.Command):
    """Project ACTIVE_TRACE_ROOT from the detached History Tree."""
    def __init__(self):
        super().__init__("ardb-get-observer-tree", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        observer_root = ACTIVE_TRACE_ROOT or None
        try:
            history_tree = _export_call_graph()
            observer_subtree = _find_observer_subtree(
                history_tree.get("roots", []),
                observer_root,
            )
            roots = [observer_subtree] if observer_subtree is not None else []
            subtree_keys = set()
            pending = list(roots)
            while pending:
                node = pending.pop()
                if not isinstance(node, dict):
                    continue
                func = node.get("func")
                if isinstance(func, str) and func:
                    subtree_keys.add(func)
                children = node.get("children", [])
                if isinstance(children, list):
                    pending.extend(children)
            relation_annotations = [
                copy.deepcopy(annotation)
                for annotation in history_tree.get("relation_annotations", [])
                if (
                    isinstance(annotation, dict)
                    and annotation.get("parent") in subtree_keys
                    and annotation.get("child") in subtree_keys
                )
            ]
            gdb.write(json.dumps({
                "type": "observer_tree",
                "observer_root": observer_root,
                "roots": roots,
                "relation_annotations": relation_annotations,
            }) + "\n")
        except Exception as exc:
            gdb.write(json.dumps({
                "type": "observer_tree",
                "observer_root": observer_root,
                "roots": [],
                "relation_annotations": [],
                "error": _json_safe(exc),
            }) + "\n")


class ARDClearHistoryTreeCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-clear-history-tree", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        global ACTIVE_TRACE_ROOT
        _clear_call_graph()
        _capture_history_relation_baseline()
        ACTIVE_TRACE_ROOT = None
        payload = _export_call_graph()
        payload["cleared"] = True
        gdb.write(json.dumps(payload) + "\n")

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
    Usage: ardb-update-whitelist {"enabled_crates": ["my_app", "my_lib"], "async_only": false}
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
            async_only = bool(payload.get("async_only", False))
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
                        if async_only and sym_info.get("kind") != "async":
                            continue
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
            installed = _install_whitelist_runtime_event_breakpoints()
        except Exception as e:
            gdb.write(f'[ARD] failed to reload whitelist: {e}\n')
            return

        gdb.write(
            f'[ARD] whitelist updated: {len(enabled_crates)} crates enabled, '
            f'{idx} symbols, observers={installed} -> {flat_path}, async_only={str(async_only).lower()}\n'
        )


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
    ARDAsyncCapabilitiesCommand()
    ARDTraceEnableCommand()
    ARDTraceDisableCommand()
    ARDTraceStatusCommand()
    ARDGetSnapshotCommand()
    ARDGetHistoryTreeCommand()
    ARDGetObserverTreeCommand()
    ARDClearHistoryTreeCommand()
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

    gdb.write("[ARD] installed. Commands: ardb-async-capabilities, ardb-trace-enable, ardb-trace-disable, ardb-trace-status, ardb-get-snapshot, ardb-get-history-tree, ardb-get-observer-tree, ardb-clear-history-tree, ardb-gen-whitelist, ardb-load-whitelist, ardb-trace, ardb-reset, ardb-get-whitelist-grouped, ardb-update-whitelist, ardb-infer-trace-root\n")
