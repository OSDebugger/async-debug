"""Bounded storage for validator-approved observed async relations."""

from collections import OrderedDict
from copy import deepcopy
from typing import Any, Dict, Optional, Tuple


RelationKey = Tuple[int, int, str]


def _positive_int(value) -> Optional[int]:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if parsed > 0 else None


class ValidatedRelationStore:
    """Own observed relation records without depending on GDB or runtime state."""

    def __init__(self, max_relations: int = 1000):
        limit = _positive_int(max_relations)
        if limit is None:
            raise ValueError("max_relations must be a positive integer")
        self._max_relations = limit
        self._relations: "OrderedDict[RelationKey, Dict[str, Any]]" = OrderedDict()
        self._next_relation_id = 1
        self._eviction_count = 0
        self._store_generation = 1

    def add_validated_relation(
        self,
        validation: dict,
        parent_node: dict,
        child_hit: dict,
    ) -> Optional[Dict[str, Any]]:
        """Store one successful observed validation; reject every other input."""
        if not isinstance(validation, dict):
            return None
        if (
            validation.get("matched") is not True
            or validation.get("confidence") != "observed"
            or validation.get("relation_kind") != "await"
        ):
            return None
        if not isinstance(parent_node, dict) or not isinstance(child_hit, dict):
            return None

        parent_cid = _positive_int(parent_node.get("cid"))
        child_cid = _positive_int(child_hit.get("child_cid"))
        event_id = _positive_int(child_hit.get("event_id"))
        if parent_cid is None or child_cid is None or event_id is None:
            return None

        required_strings = {
            "parent_symbol": child_hit.get("parent_symbol"),
            "child_symbol": child_hit.get("child_symbol"),
            "parent_address": child_hit.get("parent_address"),
            "child_address": child_hit.get("child_address"),
            "child_type": child_hit.get("child_type"),
        }
        if any(not isinstance(value, str) or not value for value in required_strings.values()):
            return None

        key = (parent_cid, child_cid, "await")
        # Keep the actual successful observation for read-only current checks.
        # This is not an instance epoch: poll counters only delimit executions.
        parent_poll = parent_node.get("poll")
        current_evidence = {
            "child_hit": deepcopy(child_hit),
            "parent_poll_sequence": _positive_int(
                parent_poll.get("sequence") if isinstance(parent_poll, dict) else None
            ),
        }
        existing = self._relations.get(key)
        if existing is not None:
            # Same event is deliberately counted again: each successful Builder
            # submission is an observed occurrence. Older events are rejected.
            if event_id < existing["last_event_id"]:
                return None
            existing["last_event_id"] = event_id
            existing["occurrence_count"] += 1
            existing["evidence"] = deepcopy(list(validation.get("evidence") or ()))
            existing["current_evidence"] = current_evidence
            self._relations.move_to_end(key)
            return deepcopy(existing)

        record = {
            "relation_id": self._next_relation_id,
            "parent_cid": parent_cid,
            "child_cid": child_cid,
            **required_strings,
            "confidence": "observed",
            "kind": "await",
            "evidence": deepcopy(list(validation.get("evidence") or ())),
            "first_event_id": event_id,
            "last_event_id": event_id,
            "occurrence_count": 1,
            "current_evidence": current_evidence,
        }
        self._next_relation_id += 1
        self._relations[key] = record

        while len(self._relations) > self._max_relations:
            self._relations.popitem(last=False)
            self._eviction_count += 1
        return deepcopy(record)

    def get_relations(self):
        """Return a deep copy in stable insertion/last-update order."""
        return deepcopy(list(self._relations.values()))

    def get_metadata(self):
        """Return detached bounded-store metadata without changing the store."""
        records = list(self._relations.values())
        relation_ids = [record["relation_id"] for record in records]
        first_events = [record["first_event_id"] for record in records]
        last_events = [record["last_event_id"] for record in records]
        return deepcopy({
            "capacity": self._max_relations,
            "size": len(records),
            "eviction_count": self._eviction_count,
            "oldest_retained_relation_id": min(relation_ids) if relation_ids else None,
            "newest_relation_id": max(relation_ids) if relation_ids else None,
            "oldest_retained_event_id": min(first_events) if first_events else None,
            "newest_event_id": max(last_events) if last_events else None,
            "store_generation": self._store_generation,
        })

    def clear(self):
        self._relations.clear()

    def reset(self):
        self._relations.clear()
        self._next_relation_id = 1
        self._eviction_count = 0
        self._store_generation += 1
