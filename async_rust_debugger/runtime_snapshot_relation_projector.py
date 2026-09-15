"""Read-only projection of validated relations onto Snapshot path copies."""

from copy import deepcopy

from async_rust_debugger.runtime_relation_validator import (
    RuntimeRelationValidator,
    _positive_int,
)


def _unknown_relation(parent, child):
    return {
        "kind": "unknown",
        "confidence": "unknown",
        "parent_cid": parent.get("cid") if isinstance(parent, dict) else None,
        "child_cid": child.get("cid") if isinstance(child, dict) else None,
        "child_future_address": (
            child.get("future_address") if isinstance(child, dict) else None
        ),
        "evidence": [],
    }


def _matches(parent, child, relation):
    if not all(isinstance(value, dict) for value in (parent, child, relation)):
        return False
    if relation.get("kind") != "await" or relation.get("confidence") != "observed":
        return False
    evidence = relation.get("evidence")
    if not isinstance(evidence, list) or not all(isinstance(item, str) for item in evidence):
        return False
    return (
        parent.get("cid") == relation.get("parent_cid")
        and parent.get("function") == relation.get("parent_symbol")
        and parent.get("future_address") == relation.get("parent_address")
        and child.get("cid") == relation.get("child_cid")
        and child.get("function") == relation.get("child_symbol")
        and child.get("future_address") == relation.get("child_address")
    )


def _currently_valid(parent, child, relation, thread_id):
    """Recheck fresh node facts against a retained actual poll observation."""
    retained = relation.get("current_evidence")
    if not isinstance(retained, dict):
        return False
    hit = retained.get("child_hit")
    parent_poll = parent.get("poll")
    child_poll = child.get("poll")
    if not all(isinstance(value, dict) for value in (hit, parent_poll, child_poll)):
        return False
    # No numeric Rust state assumptions: the trusted candidate reader must also
    # find the unique active variant's exact __awaitee field at this stop.
    if parent_poll.get("status") != "ok" or parent_poll.get("state") is None:
        return False
    parent_sequence = _positive_int(parent_poll.get("sequence"))
    child_sequence = _positive_int(child_poll.get("sequence"))
    if (
        parent_sequence is None
        or parent_sequence != _positive_int(retained.get("parent_poll_sequence"))
        or child_sequence is None
        or child_sequence != _positive_int(hit.get("child_poll_sequence"))
    ):
        return False
    if (
        hit.get("child_cid") != child.get("cid")
        or hit.get("child_symbol") != child.get("function")
        or hit.get("child_address") != child.get("future_address")
        or hit.get("child_type") != relation.get("child_type")
        or hit.get("event_id") != relation.get("last_event_id")
    ):
        return False
    current_parent = deepcopy(parent)
    current_parent["thread_id"] = thread_id
    return RuntimeRelationValidator.validate_await_relation(
        current_parent, hit, relation.get("last_event_id")
    ).get("matched") is True


def project_snapshot_relations(async_path, relation_records, thread_id=None):
    """Return a projected deep copy without reading GDB or mutating inputs."""
    if not isinstance(async_path, list):
        return []

    projected = deepcopy(async_path)
    records = deepcopy(relation_records) if isinstance(relation_records, list) else []

    for index, child in enumerate(projected):
        if not isinstance(child, dict):
            continue
        if index == 0:
            child["relation_from_parent"] = {
                "kind": "root",
                "confidence": "observed",
                "parent_cid": None,
                "child_cid": None,
                "child_future_address": None,
                "evidence": ["path-root"],
            }
            child["edge_from_parent"] = None
            continue

        parent = projected[index - 1]
        matched = next(
            (relation for relation in records
             if _matches(parent, child, relation)
             and _currently_valid(parent, child, relation, thread_id)),
            None,
        )
        if matched is None:
            child["relation_from_parent"] = _unknown_relation(parent, child)
            child["edge_from_parent"] = "unknown"
            continue

        child["relation_from_parent"] = {
            "kind": "await",
            "confidence": "observed",
            "parent_cid": matched["parent_cid"],
            "child_cid": matched["child_cid"],
            "child_future_address": matched["child_address"],
            "evidence": deepcopy(matched["evidence"]),
        }
        child["edge_from_parent"] = "await"

    return projected
