#!/usr/bin/env python3
"""TeamUp v0.3 additive event-log runtime (stdlib only)."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import stat
import sys
import tempfile
import uuid
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:  # POSIX/macOS only; operations fail with TeamUpError when unavailable.
    import fcntl
except ImportError:  # pragma: no cover - exercised by a patched portability test
    fcntl = None


VERSION = "0.3.0"
LEDGER_SCHEMA_VERSION = 4
WATCHDOG_SCHEMA_VERSION = 1
AUTHORITY_ALGORITHM = "sha256-teamup-confirmation-v1"
AUTHORITY_DOMAIN = b"teamup-confirmation-v1\0"
DEFAULT_AUTHORITY_ENV = "TEAMUP_CONFIRMATION_SECRET"
DEFAULT_ACTIVE_STORE_POINTER_ENV = "TEAMUP_ACTIVE_STORE_POINTER"
DEFAULT_ACTIVE_STORE_POINTER = "~/.70proposal/runtime/teamup/ACTIVE_STORE.json"
ACTIVE_STORE_POINTER_SCHEMA = "teamup/active-store-pointer/v1"
ACTIVE_STORE_RECEIPT_SCHEMA = "teamup/runtime-cutover-receipt/v1"
MIN_AUTHORITY_SECRET_BYTES = 32
TEAM_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
ACTIVE = {"DISPATCHED", "RETURN_CLAIMED_UNOBSERVED", "RETURN_SUBMITTED_UNCONFIRMED"}
TERMINAL = {"RETURN_CONFIRMED", "BLOCKED", "STALE", "HOLD"}
TASK_KINDS = {"execution", "creative", "strategy", "judgment"}
RETURN_CHANNELS = {"direct_thread_tool", "local_final_only", "artifact_mailbox"}
EXECUTION_TRANSPORTS = {"visible_user_owned_thread", "background_subagent", "local_worker"}
MESSAGE_PURPOSES = {"work_dispatch", "return_or_status"}
SOURCE_ROLES = {"worker", "child_main", "project_main", "main_brain"}
TARGET_ROLES = {"staffed_worker", "project_main", "portfolio_main"}
TARGET_RUNTIME_POLICIES = {"preserve", "override"}
MISSION_STATES = {"working", "waiting_worker", "waiting_user", "complete", "unknown"}
TEAM_ACTIVITY = {"active", "idle"}
# Historical readers accept all event types ever emitted by supported ledgers.
# Current writers intentionally expose the smaller writable set below.
REPLAY_EVENT_TYPES = {
    "TEAM_INITIALIZED",
    "TASK_ADDED",
    "DEPENDENCY_ADDED",
    "DISPATCHED",
    "MESSAGE_RECORDED",
    "MISSION_STATE_SET",
    "WATCHDOG_TICK_RECORDED",
    "RETURN_SUBMITTED",
    "DIRECT_RETURN_OBSERVED",
    "RETURN_CONFIRMED",
    "BLOCKED",
    "STALE",
    "ROLE_SEAT_REGISTERED",
    "ROLE_SEAT_RETIRED",
    "SEAT_DISPATCH_ACKED",
    "EXECUTION_HOST_REBIND",
    "EXECUTION_HOST_REBIND_HOLD",
    "MISSION_COMPLETED",
}
WRITABLE_EVENT_TYPES = REPLAY_EVENT_TYPES - {"DIRECT_RETURN_OBSERVED"}
# Retained as an internal compatibility alias for consumers that need the
# replay-recognized vocabulary. New append paths must use WRITABLE_EVENT_TYPES.
EVENT_TYPES = REPLAY_EVENT_TYPES
ROLE_FAMILIES = {
    "research", "data", "strategy_creative", "production", "content_delivery_qa", "browser_visual_qa",
    "integrity_review",
}
SEAT_LIFECYCLE = {"ACTIVE", "RETIRED"}
NEW_THREAD_REASONS = {
    "no_compatible_seat", "capability_incompatibility", "isolation_requirement",
    "quarantined_seat", "clean_independent_acceptance", "saturated_context",
}
REBIND_BLOCK_REASON = "EXECUTION_HOST_REBIND_REQUIRED"
HOST_BINDING_FIELDS = {
    "case_id", "grant_hash", "opaque_scope_identity", "scope_caps_hash", "capability_profile_id", "output_root",
}


class TeamUpError(ValueError):
    """A user-facing contract or state transition error."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.utcoffset() is None:
            raise ValueError("timezone required")
        return parsed
    except (AttributeError, ValueError) as exc:
        raise TeamUpError(f"invalid timestamp: {value}") from exc


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _semantic_hash(value: dict[str, Any], field: str = "semantic_hash") -> str:
    unsigned = dict(value)
    unsigned.pop(field, None)
    return hashlib.sha256(canonical(unsigned).encode("utf-8")).hexdigest()


def resolve_store(
    store: str | Path | None,
    team_id: str,
    active_store_pointer: str | Path | None = None,
) -> Path:
    """Resolve one external active store and reject stale explicit paths.

    A pointer is authoritative only for its own team. Other TeamUp teams keep
    their existing explicit-store behavior.
    """
    explicit = Path(store).expanduser().resolve() if store is not None else None
    pointer_raw = active_store_pointer or os.environ.get(
        DEFAULT_ACTIVE_STORE_POINTER_ENV, DEFAULT_ACTIVE_STORE_POINTER
    )
    pointer_path = Path(pointer_raw).expanduser().resolve(strict=False)
    if not pointer_path.exists():
        if explicit is None:
            raise TeamUpError("--store is required when no active TeamUp store pointer exists")
        return explicit
    if pointer_path.is_symlink() or not pointer_path.is_file():
        raise TeamUpError("active TeamUp store pointer must be a regular non-symlink file")
    try:
        pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TeamUpError("active TeamUp store pointer is malformed") from exc
    if not isinstance(pointer, dict):
        raise TeamUpError("active TeamUp store pointer must be an object")
    if pointer.get("team_id") != team_id:
        if explicit is not None:
            return explicit
        raise TeamUpError("active TeamUp store pointer belongs to another team")
    required = {
        "schema_version", "status", "team_id", "active_store_parent", "team_root",
        "source_tree_sha256", "destination_tree_sha256", "event_count", "last_seq",
        "cutover_receipt_path", "cutover_receipt_sha256", "no_delete", "semantic_hash",
    }
    if set(pointer) != required or pointer.get("schema_version") != ACTIVE_STORE_POINTER_SCHEMA:
        raise TeamUpError("active TeamUp store pointer fields or schema are invalid")
    if pointer.get("status") != "ACTIVE" or pointer.get("no_delete") is not True:
        raise TeamUpError("active TeamUp store pointer is not ACTIVE/no-delete")
    if pointer.get("semantic_hash") != _semantic_hash(pointer):
        raise TeamUpError("active TeamUp store pointer semantic hash drift")
    for field in ("source_tree_sha256", "destination_tree_sha256", "cutover_receipt_sha256"):
        _require_checksum(pointer.get(field), f"active_pointer.{field}")
    if not isinstance(pointer.get("event_count"), int) or pointer["event_count"] < 1:
        raise TeamUpError("active TeamUp store pointer event_count is invalid")
    if pointer.get("last_seq") != pointer["event_count"]:
        raise TeamUpError("active TeamUp store pointer sequence is not contiguous")

    active_parent = Path(pointer["active_store_parent"]).expanduser().resolve(strict=False)
    expected_parent = (pointer_path.parent / "active").resolve(strict=False)
    if active_parent != expected_parent:
        raise TeamUpError("active TeamUp store pointer escapes the canonical active root")
    team_root = Path(pointer["team_root"]).expanduser().resolve(strict=False)
    if team_root != (active_parent / team_id).resolve(strict=False):
        raise TeamUpError("active TeamUp store pointer team root mismatch")
    receipt_path = Path(pointer["cutover_receipt_path"]).expanduser().resolve(strict=False)
    if receipt_path.is_symlink() or not receipt_path.is_file():
        raise TeamUpError("active TeamUp cutover receipt is missing or unsafe")
    if _file_sha256(receipt_path) != pointer["cutover_receipt_sha256"]:
        raise TeamUpError("active TeamUp cutover receipt hash drift")
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TeamUpError("active TeamUp cutover receipt is malformed") from exc
    if (
        not isinstance(receipt, dict)
        or receipt.get("schema_version") != ACTIVE_STORE_RECEIPT_SCHEMA
        or receipt.get("status") != "CUTOVER_COMPLETE"
        or receipt.get("team_id") != team_id
        or Path(receipt.get("active_store_path", "")).expanduser().resolve(strict=False) != active_parent
        or Path(receipt.get("destination_team_root", "")).expanduser().resolve(strict=False) != team_root
        or receipt.get("destination_tree_sha256") != pointer["destination_tree_sha256"]
        or receipt.get("event_count") != pointer["event_count"]
        or receipt.get("last_seq") != pointer["last_seq"]
        or receipt.get("no_delete") is not True
    ):
        raise TeamUpError("active TeamUp cutover receipt does not bind the pointer")
    if explicit is not None and explicit != active_parent:
        raise TeamUpError("explicit TeamUp store conflicts with the canonical active pointer")
    return active_parent


def atomic_json(path: Path, value: Any) -> None:
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _secret_bytes(secret: str | bytes | None) -> bytes:
    if isinstance(secret, str):
        secret = secret.encode("utf-8")
    if not isinstance(secret, bytes) or len(secret) < MIN_AUTHORITY_SECRET_BYTES:
        raise TeamUpError(
            f"confirmation authority secret must be at least {MIN_AUTHORITY_SECRET_BYTES} bytes"
        )
    return secret


def authority_fingerprint(secret: str | bytes | None) -> str:
    return hashlib.sha256(AUTHORITY_DOMAIN + _secret_bytes(secret)).hexdigest()


def _require_identifier(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TeamUpError(f"{name} must be nonempty")
    return value


def _require_checksum(value: Any, name: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise TeamUpError(f"{name} must be a 64-character SHA-256 hex digest")
    return value.lower()


def _require_choice(value: Any, name: str, choices: set[str]) -> str:
    value = _require_identifier(value, name)
    if value not in choices:
        raise TeamUpError(f"invalid {name}: {value}")
    return value


def _canonical_identifier_set(value: Any, name: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise TeamUpError(f"{name} must be a non-empty list")
    if any(not isinstance(item, str) or not item.strip() for item in value):
        raise TeamUpError(f"{name} must contain nonempty identifiers")
    return sorted(set(value))


def _host_binding(value: Any) -> dict[str, str]:
    """Validate non-secret host binding references needed for a bounded rebind."""
    if not isinstance(value, dict) or set(value) != HOST_BINDING_FIELDS:
        raise TeamUpError("host_binding must contain exactly the bounded host identity fields")
    return {field: _require_identifier(value[field], f"host_binding.{field}") for field in sorted(HOST_BINDING_FIELDS)}


def _validate_message_intent(
    payload: dict[str, Any], *, authoritative_main_thread_id: str | None = None
) -> None:
    """Fail closed for a recorded message without ever sending that message."""
    _require_identifier(payload.get("message_id"), "message_id")
    _require_identifier(payload.get("source_thread_id"), "source_thread_id")
    _require_identifier(payload.get("target_thread_id"), "target_thread_id")
    purpose = _require_choice(payload.get("message_purpose"), "message_purpose", MESSAGE_PURPOSES)
    source_role = _require_choice(payload.get("source_role"), "source_role", SOURCE_ROLES)
    target_role = _require_choice(payload.get("target_role"), "target_role", TARGET_ROLES)
    policy = _require_choice(
        payload.get("target_runtime_policy"),
        "target_runtime_policy",
        TARGET_RUNTIME_POLICIES,
    )
    overrides = {
        name: payload.get(name)
        for name in ("target_model", "target_thinking", "target_service_mode")
        if payload.get(name) is not None
    }
    for name, value in overrides.items():
        _require_identifier(value, name)

    if purpose == "return_or_status" and policy != "preserve":
        raise TeamUpError("return_or_status requires target_runtime_policy=preserve")
    if policy == "preserve" and overrides:
        raise TeamUpError("preserve runtime policy cannot carry runtime overrides")
    if policy == "override" and not (
        purpose == "work_dispatch" and target_role == "staffed_worker"
    ):
        raise TeamUpError(
            "runtime override is allowed only for work_dispatch to a staffed_worker"
        )
    if target_role in {"project_main", "portfolio_main"} and (
        policy != "preserve" or overrides
    ):
        raise TeamUpError("messages to a main brain must preserve its runtime")
    if policy == "override" and authoritative_main_thread_id is not None:
        if source_role != "main_brain" or payload["source_thread_id"] != authoritative_main_thread_id:
            raise TeamUpError(
                "runtime override work_dispatch requires the owning team main brain"
            )


def empty_state(team_id: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "runtime_version": VERSION,
        "ledger_schema_version": 1,
        "team_id": team_id,
        "initialized": False,
        "team": None,
        "last_seq": 0,
        "tasks": {},
        "messages": {},
        "seats": {},
        "seat_dispatch_acks": {},
        "metrics": {},
    }


def _mission(state: dict[str, Any]) -> dict[str, Any]:
    return state.get(
        "mission",
        {
            "state": "unknown",
            "generation": "initial",
            "expected_worker_thread_id": None,
        },
    )


def _watchdog_decision(state: dict[str, Any], team_activity: str) -> str:
    if team_activity not in TEAM_ACTIVITY:
        raise TeamUpError(f"invalid team_activity: {team_activity}")
    mission = _mission(state)
    if team_activity == "active":
        return "quiet_active"
    if mission["state"] == "waiting_user":
        return "quiet_waiting_user"
    if mission["state"] == "complete":
        return "stop_watchdog"
    ticks = state.get("watchdog_ticks", [])
    streak = 0
    for tick in reversed(ticks):
        if tick["generation"] != mission["generation"] or tick["team_activity"] != "idle":
            break
        streak += 1
    if streak >= 2:
        return "escalate_user"
    if mission["state"] == "waiting_worker":
        return "nudge_main_waiting_worker"
    return "nudge_main_working_or_unknown"


def _task(state: dict[str, Any], task_id: str) -> dict[str, Any]:
    try:
        return state["tasks"][task_id]
    except KeyError as exc:
        raise TeamUpError(f"unknown task: {task_id}") from exc


def _assert_no_cycle(tasks: dict[str, Any]) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(task_id: str) -> None:
        if task_id in visiting:
            raise TeamUpError(f"dependency cycle detected at task: {task_id}")
        if task_id in visited:
            return
        visiting.add(task_id)
        for dependency in tasks[task_id]["depends_on"]:
            if dependency not in tasks:
                raise TeamUpError(f"unknown dependency: {dependency}")
            visit(dependency)
        visiting.remove(task_id)
        visited.add(task_id)

    for task_id in tasks:
        visit(task_id)


def compute_metrics(state: dict[str, Any], events: Iterable[dict[str, Any]]) -> dict[str, Any]:
    events = list(events)
    dispatches = [event for event in events if event["type"] == "DISPATCHED"]
    confirmed = [event for event in events if event["type"] == "RETURN_CONFIRMED"]
    stale = [event for event in events if event["type"] == "STALE"]
    per_task = Counter(event["payload"]["task_id"] for event in dispatches)
    pairs = Counter(
        (event["payload"]["model"], event["payload"]["thinking"])
        for event in dispatches
    )
    lifecycle = [event for event in events if event["type"] in {"DISPATCHED", "RETURN_SUBMITTED", "DIRECT_RETURN_OBSERVED", "RETURN_CONFIRMED", "BLOCKED", "STALE"}]
    elapsed = None
    if lifecycle:
        elapsed = max(
            0.0,
            (parse_time(lifecycle[-1]["ts"]) - parse_time(lifecycle[0]["ts"])).total_seconds(),
        )
    count = len(dispatches)
    return {
        "dispatch_count": count,
        "confirmed_count": len(confirmed),
        "confirmed_rate": len(confirmed) / count if count else 0.0,
        "stale_count": len(stale),
        "stale_rate": len(stale) / count if count else 0.0,
        "rework_count": sum(max(0, value - 1) for value in per_task.values()),
        "elapsed_seconds": elapsed,
        "model_thinking": [
            {"model": model, "thinking": thinking, "dispatch_count": value}
            for (model, thinking), value in sorted(pairs.items())
        ],
        "token_count": None,
        "cost": None,
    }


def replay(team_id: str, events: Iterable[dict[str, Any]]) -> dict[str, Any]:
    events = list(events)
    state = empty_state(team_id)
    seen_events: set[str] = set()
    seen_dispatches: dict[str, str] = {}
    seen_submissions: dict[str, str] = {}
    seen_receipts: dict[str, str] = {}
    seen_messages: set[str] = set()
    seen_direct_observations: dict[str, str] = {}
    seen_watchdog_cycles: set[str] = set()
    previous_time: datetime | None = None
    for expected_seq, event in enumerate(events, 1):
        if event.get("seq") != expected_seq:
            raise TeamUpError(f"event sequence mismatch: expected {expected_seq}")
        if event.get("team_id") != team_id:
            raise TeamUpError("cross-team event detected")
        if event.get("type") not in REPLAY_EVENT_TYPES:
            raise TeamUpError(f"unknown event type: {event.get('type')}")
        if event.get("event_id") in seen_events:
            raise TeamUpError("duplicate event_id")
        event_time = parse_time(event.get("ts", ""))
        if previous_time is not None and event_time < previous_time:
            raise TeamUpError(f"event timestamp decreased at sequence {expected_seq}")
        previous_time = event_time
        seen_events.add(event["event_id"])
        payload = event.get("payload", {})
        event_type = event["type"]

        if event_type == "TEAM_INITIALIZED":
            if state["initialized"]:
                raise TeamUpError("team initialized twice")
            if payload.get("mode") not in {"BUILD MODE", "APPLICATION MODE"}:
                raise TeamUpError("invalid operating mode")
            if not payload.get("team_emoji") or not payload.get("main_brain_thread_id"):
                raise TeamUpError("team emoji and main-brain thread are required")
            authority = payload.get("confirmation_authority")
            if authority is not None and (
                authority.get("algorithm") != AUTHORITY_ALGORITHM
                or not authority.get("fingerprint")
            ):
                raise TeamUpError("invalid confirmation authority metadata")
            ledger_schema_version = payload.get("ledger_schema_version", 1)
            if not isinstance(ledger_schema_version, int) or ledger_schema_version not in {1, 2, 3, 4}:
                raise TeamUpError("unsupported ledger schema version")
            state["initialized"] = True
            state["team"] = payload
            state["ledger_schema_version"] = ledger_schema_version
            if ledger_schema_version >= 3:
                state["direct_return_observations"] = {}
            if ledger_schema_version >= 4:
                state["seats"] = {}
                state["seat_dispatch_acks"] = {}
            if payload.get("watchdog_schema_version") == WATCHDOG_SCHEMA_VERSION:
                state["mission"] = {
                    "state": "unknown",
                    "generation": "initial",
                    "expected_worker_thread_id": None,
                }
                state["watchdog_ticks"] = []
        elif not state["initialized"]:
            raise TeamUpError("first event must initialize the team")
        elif event_type == "TASK_ADDED":
            task_id = payload["task_id"]
            if task_id in state["tasks"]:
                raise TeamUpError(f"task already exists: {task_id}")
            kind = payload["kind"]
            if kind not in TASK_KINDS:
                raise TeamUpError(f"invalid task kind: {kind}")
            if kind != "execution" and not payload.get("manual_gate"):
                raise TeamUpError("non-execution tasks are always manual-gated")
            state["tasks"][task_id] = {
                "task_id": task_id,
                "kind": kind,
                "manual_gate": bool(payload["manual_gate"]),
                "depends_on": list(payload.get("depends_on", [])),
                "status": "PENDING",
                "dispatch_count": 0,
                "last_transition_at": event["ts"],
                "dispatch": None,
                "return": None,
                "block_reason": None,
                "seat_id": None,
                "seat_generation": None,
                "host_binding": None,
                "rebind_count": 0,
            }
            _assert_no_cycle(state["tasks"])
        elif event_type == "DEPENDENCY_ADDED":
            task = _task(state, payload["task_id"])
            dependency = payload["depends_on"]
            _task(state, dependency)
            if dependency not in task["depends_on"]:
                task["depends_on"].append(dependency)
                task["depends_on"].sort()
            _assert_no_cycle(state["tasks"])
        elif event_type == "ROLE_SEAT_REGISTERED":
            if state["ledger_schema_version"] < 4:
                raise TeamUpError("role seats require ledger schema 4")
            seat_id = _require_identifier(payload.get("seat_id"), "seat_id")
            if seat_id in state["seats"]:
                raise TeamUpError(f"role seat already exists: {seat_id}")
            case_id = _require_identifier(payload.get("case_id"), "case_id")
            role_family = _require_choice(payload.get("role_family"), "role_family", ROLE_FAMILIES)
            capability_set = _canonical_identifier_set(payload.get("capability_set"), "capability_set")
            isolation_class = _require_identifier(payload.get("isolation_class"), "isolation_class")
            state["seats"][seat_id] = {
                "seat_id": seat_id,
                "case_id": case_id,
                "seat_key": hashlib.sha256(canonical({
                    "case_id": case_id, "role_family": role_family,
                    "capability_set": capability_set, "isolation_class": isolation_class,
                }).encode("utf-8")).hexdigest(),
                "role_family": role_family,
                "capability_set": capability_set,
                "isolation_class": isolation_class,
                "lifecycle": "ACTIVE",
                "current_generation": _require_identifier(payload.get("generation"), "generation"),
                "active_task_id": None,
                "last_dispatch_id": None,
                "retirement_reason": None,
                "new_thread_reason": _require_choice(
                    payload.get("new_thread_reason"), "new_thread_reason", NEW_THREAD_REASONS
                ),
            }
        elif event_type == "ROLE_SEAT_RETIRED":
            seat = state["seats"].get(payload.get("seat_id"))
            if not seat:
                raise TeamUpError("cannot retire unknown role seat")
            if seat["lifecycle"] != "ACTIVE":
                raise TeamUpError("only an active role seat can retire")
            if seat["active_task_id"] is not None:
                raise TeamUpError("cannot retire a role seat with an active task")
            seat.update(lifecycle="RETIRED", retirement_reason=_require_identifier(payload.get("reason"), "reason"))
        elif event_type == "SEAT_DISPATCH_ACKED":
            if state["ledger_schema_version"] < 4:
                raise TeamUpError("seat dispatch ACK requires ledger schema 4")
            ack_id = _require_identifier(payload.get("ack_id"), "ack_id")
            if ack_id in state["seat_dispatch_acks"]:
                raise TeamUpError("duplicate seat dispatch ACK")
            task = _task(state, payload.get("task_id"))
            if task["status"] not in ACTIVE:
                raise TeamUpError("seat dispatch ACK requires an active task")
            if payload.get("dispatch_id") != (task["dispatch"] or {}).get("dispatch_id"):
                raise TeamUpError("seat dispatch ACK does not match current dispatch")
            if not task["seat_id"] or payload.get("seat_id") != task["seat_id"]:
                raise TeamUpError("seat dispatch ACK does not match task role seat")
            if payload.get("generation") != task["seat_generation"]:
                raise TeamUpError("seat dispatch ACK does not match task generation")
            if payload.get("context_hash") != _require_checksum(payload.get("context_hash"), "context_hash"):
                raise TeamUpError("seat dispatch ACK context hash is invalid")
            native_receipt = _require_checksum(
                payload.get("native_transport_receipt_sha256"), "native_transport_receipt_sha256"
            )
            state["seat_dispatch_acks"][ack_id] = {
                "ack_id": ack_id,
                "task_id": task["task_id"],
                "seat_id": task["seat_id"],
                "dispatch_id": task["dispatch"]["dispatch_id"],
                "generation": task["seat_generation"],
                "context_hash": payload["context_hash"],
                "native_transport_receipt_sha256": native_receipt,
            }
        elif event_type == "DISPATCHED":
            task = _task(state, payload["task_id"])
            if task["status"] not in {"PENDING", "BLOCKED", "STALE"}:
                raise TeamUpError(f"cannot dispatch from {task['status']}")
            unmet = [
                dependency for dependency in task["depends_on"]
                if state["tasks"][dependency]["status"] != "RETURN_CONFIRMED"
            ]
            if unmet:
                raise TeamUpError(f"cannot dispatch with unmet dependencies: {', '.join(unmet)}")
            if task["manual_gate"] and not payload.get("manual_override", False):
                raise TeamUpError("manual-gated task requires manual_override")
            if not isinstance(payload.get("manual_override", False), bool):
                raise TeamUpError("manual_override must be boolean")
            dispatch_intent = {
                "message_purpose": payload.get("message_purpose", "work_dispatch"),
                "target_role": payload.get("target_role", "staffed_worker"),
                "target_runtime_policy": payload.get("target_runtime_policy", "override"),
                "target_model": payload.get("target_model", payload.get("model")),
                "target_thinking": payload.get("target_thinking", payload.get("thinking")),
                "target_service_mode": payload.get("target_service_mode"),
            }
            if (
                dispatch_intent["message_purpose"] != "work_dispatch"
                or dispatch_intent["target_role"] != "staffed_worker"
                or dispatch_intent["target_runtime_policy"] != "override"
            ):
                raise TeamUpError("DISPATCHED must be a staffed-worker work_dispatch")
            dispatch_id = payload["dispatch_id"]
            if dispatch_id in seen_dispatches:
                raise TeamUpError(f"duplicate dispatch_id: {dispatch_id}")
            seen_dispatches[dispatch_id] = task["task_id"]
            seat_id = payload.get("seat_id")
            seat_generation = payload.get("seat_generation")
            host_binding = payload.get("host_binding")
            if seat_id is not None or seat_generation is not None or host_binding is not None:
                if state["ledger_schema_version"] < 4:
                    raise TeamUpError("seat or host dispatch binding requires ledger schema 4")
                seat_id = _require_identifier(seat_id, "seat_id")
                seat = state["seats"].get(seat_id)
                if not seat or seat["lifecycle"] != "ACTIVE":
                    raise TeamUpError("dispatch requires an active registered role seat")
                if seat["active_task_id"] not in {None, task["task_id"]}:
                    raise TeamUpError("role seat is already assigned to another active task")
                if seat_generation != seat["current_generation"]:
                    raise TeamUpError("dispatch role seat generation is not current")
                host_binding = _host_binding(host_binding)
                if host_binding["case_id"] != seat["case_id"]:
                    raise TeamUpError("dispatch host binding case does not match role seat")
                seat.update(active_task_id=task["task_id"], last_dispatch_id=dispatch_id)
            task.update(
                status="DISPATCHED",
                dispatch_count=task["dispatch_count"] + 1,
                last_transition_at=event["ts"],
                dispatch=payload,
                block_reason=None,
                seat_id=seat_id,
                seat_generation=seat_generation,
                host_binding=host_binding,
            )
            task["return"] = None
        elif event_type == "MESSAGE_RECORDED":
            _validate_message_intent(
                payload, authoritative_main_thread_id=state["team"]["main_brain_thread_id"]
            )
            message_id = payload["message_id"]
            if message_id in seen_messages:
                raise TeamUpError(f"duplicate message_id: {message_id}")
            seen_messages.add(message_id)
            state["messages"][message_id] = payload
        elif event_type == "MISSION_STATE_SET":
            mission_state = _require_choice(
                payload.get("mission_state"), "mission_state", MISSION_STATES
            )
            generation = _require_identifier(payload.get("generation"), "generation")
            expected_worker = payload.get("expected_worker_thread_id")
            if mission_state == "waiting_worker":
                _require_identifier(expected_worker, "expected_worker_thread_id")
            elif expected_worker is not None:
                raise TeamUpError("expected_worker_thread_id is only valid for waiting_worker")
            state["mission"] = {
                "state": mission_state,
                "generation": generation,
                "expected_worker_thread_id": expected_worker,
            }
            state.setdefault("watchdog_ticks", [])
        elif event_type == "WATCHDOG_TICK_RECORDED":
            cycle_id = _require_identifier(payload.get("cycle_id"), "cycle_id")
            if cycle_id in seen_watchdog_cycles:
                raise TeamUpError(f"duplicate watchdog cycle_id: {cycle_id}")
            activity = _require_choice(payload.get("team_activity"), "team_activity", TEAM_ACTIVITY)
            mission = _mission(state)
            expected_decision = _watchdog_decision(state, activity)
            if payload.get("generation") != mission["generation"]:
                raise TeamUpError("watchdog tick generation does not match mission")
            if payload.get("mission_state") != mission["state"]:
                raise TeamUpError("watchdog tick mission_state does not match mission")
            if payload.get("decision") != expected_decision:
                raise TeamUpError("watchdog tick decision does not match mission state")
            seen_watchdog_cycles.add(cycle_id)
            state.setdefault("watchdog_ticks", []).append(
                {
                    "cycle_id": cycle_id,
                    "team_activity": activity,
                    "generation": mission["generation"],
                    "mission_state": mission["state"],
                    "decision": expected_decision,
                }
            )
        elif event_type == "RETURN_SUBMITTED":
            task = _task(state, payload["task_id"])
            if task["status"] != "DISPATCHED":
                raise TeamUpError(f"cannot submit return from {task['status']}")
            submission_id = _require_identifier(payload.get("submission_id"), "submission_id")
            if submission_id in seen_submissions:
                raise TeamUpError(f"duplicate submission_id: {submission_id}")
            expected_mailbox = task["dispatch"].get("artifact_mailbox")
            submitted_mailbox = payload.get("artifact_mailbox")
            if expected_mailbox and submitted_mailbox not in {None, expected_mailbox}:
                raise TeamUpError("submitted artifact mailbox does not match dispatch")
            mailbox_backed = bool(expected_mailbox or submitted_mailbox)
            if mailbox_backed:
                if not submitted_mailbox:
                    submitted_mailbox = expected_mailbox
                    payload = {**payload, "artifact_mailbox": submitted_mailbox}
                submitted_checksum = payload.get("mailbox_sha256")
                if submitted_checksum is None and state["ledger_schema_version"] == 1:
                    payload = {
                        **payload,
                        "mailbox_evidence": {
                            "status": "legacy_no_submitted_checksum",
                            "submitted_sha256": None,
                            "observed_sha256": None,
                        },
                    }
                else:
                    payload = {
                        **payload,
                        "mailbox_sha256": _require_checksum(
                            submitted_checksum, "mailbox_sha256"
                        ),
                        "mailbox_evidence": {
                            "status": "submitted_checksum_unconfirmed",
                            "submitted_sha256": _require_checksum(
                                submitted_checksum, "mailbox_sha256"
                            ),
                            "observed_sha256": None,
                        },
                    }
            elif payload.get("mailbox_sha256") is not None:
                raise TeamUpError("mailbox_sha256 requires a mailbox-backed return")
            seen_submissions[submission_id] = task["task_id"]
            direct_claim_unobserved = (
                state["ledger_schema_version"] == 3
                and task["dispatch"]["return_channel"] == "direct_thread_tool"
            )
            task.update(
                status=(
                    "RETURN_CLAIMED_UNOBSERVED"
                    if direct_claim_unobserved
                    else "RETURN_SUBMITTED_UNCONFIRMED"
                ),
                last_transition_at=event["ts"],
            )
            task["return"] = payload
        elif event_type == "DIRECT_RETURN_OBSERVED":
            if state["ledger_schema_version"] < 3:
                raise TeamUpError("direct return observation requires ledger schema 3")
            task = _task(state, payload["task_id"])
            if task["status"] != "RETURN_CLAIMED_UNOBSERVED":
                raise TeamUpError(f"cannot observe direct return from {task['status']}")
            if task["dispatch"]["return_channel"] != "direct_thread_tool":
                raise TeamUpError("direct return observation requires direct_thread_tool return channel")
            if payload.get("submission_id") != task["return"]["submission_id"]:
                raise TeamUpError("direct return observation submission_id does not match")
            observation_id = _require_identifier(
                payload.get("direct_observation_id"), "direct_observation_id"
            )
            if observation_id in seen_direct_observations:
                raise TeamUpError(f"duplicate direct_observation_id: {observation_id}")
            main_thread_id = state["team"]["main_brain_thread_id"]
            if payload.get("target_thread_id") != main_thread_id:
                raise TeamUpError("direct return observation target must be the authoritative main brain")
            if payload.get("observed_by_thread_id") != main_thread_id:
                raise TeamUpError("only the authoritative main brain can observe a direct return")
            authority = state["team"].get("confirmation_authority")
            if not authority:
                raise TeamUpError("legacy store lacks confirmation authority; re-initialize a new store")
            if payload.get("authority_fingerprint") != authority["fingerprint"]:
                raise TeamUpError("direct return observation lacks verified main-brain authority")
            payload = {
                **payload,
                "inbound_digest_sha256": _require_checksum(
                    payload.get("inbound_digest_sha256"), "inbound_digest_sha256"
                ),
            }
            seen_direct_observations[observation_id] = task["task_id"]
            state["direct_return_observations"][observation_id] = payload
            task["return"] = {**task["return"], "direct_return_observation": payload}
            task.update(status="RETURN_SUBMITTED_UNCONFIRMED", last_transition_at=event["ts"])
        elif event_type == "RETURN_CONFIRMED":
            task = _task(state, payload["task_id"])
            if task["status"] == "RETURN_CLAIMED_UNOBSERVED":
                raise TeamUpError(
                    "direct-thread return requires main-observed inbound digest evidence"
                )
            if task["status"] != "RETURN_SUBMITTED_UNCONFIRMED":
                raise TeamUpError(f"cannot confirm return from {task['status']}")
            if not payload.get("destination_observed"):
                raise TeamUpError("destination-observed receipt evidence is required")
            receipt_id = _require_identifier(payload.get("receipt_id"), "receipt_id")
            _require_identifier(payload.get("submission_id"), "submission_id")
            if payload.get("submission_id") != task["return"]["submission_id"]:
                raise TeamUpError("confirmation submission_id does not match")
            if payload.get("receipt_id") == payload.get("submission_id"):
                raise TeamUpError("receipt_id must be distinct from submission_id")
            if payload.get("confirmed_by_thread_id") != state["team"]["main_brain_thread_id"]:
                raise TeamUpError("only the authoritative main brain can confirm a return")
            authority = state["team"].get("confirmation_authority")
            if not authority:
                raise TeamUpError("legacy store lacks confirmation authority; re-initialize a new store")
            if payload.get("authority_fingerprint") != authority["fingerprint"]:
                raise TeamUpError("confirmation event lacks verified main-brain authority")
            direct_observation_id = payload.get("direct_observation_id")
            if (
                state["ledger_schema_version"] == 3
                and task["dispatch"]["return_channel"] == "direct_thread_tool"
            ):
                observation = task["return"].get("direct_return_observation")
                if not observation:
                    raise TeamUpError(
                        "direct-thread return requires main-observed inbound digest evidence"
                    )
                if direct_observation_id != observation["direct_observation_id"]:
                    raise TeamUpError("confirmation direct_observation_id does not match")
            elif direct_observation_id is not None:
                raise TeamUpError("direct_observation_id is only valid for schema-3 direct-thread returns")
            submitted_checksum = task["return"].get("mailbox_sha256")
            if submitted_checksum:
                observed_checksum = _require_checksum(
                    payload.get("observed_mailbox_sha256"), "observed_mailbox_sha256"
                )
                if observed_checksum != submitted_checksum:
                    raise TeamUpError("observed mailbox checksum does not match submission")
                payload = {
                    **payload,
                    "observed_mailbox_sha256": observed_checksum,
                    "mailbox_evidence": {
                        "status": "verified_checksum_match",
                        "submitted_sha256": submitted_checksum,
                        "observed_sha256": observed_checksum,
                    },
                }
            elif payload.get("observed_mailbox_sha256") is not None:
                raise TeamUpError("observed mailbox checksum requires a mailbox-backed return")
            elif task["return"].get("mailbox_evidence", {}).get("status") == "legacy_no_submitted_checksum":
                payload = {
                    **payload,
                    "mailbox_evidence": {
                        "status": "legacy_no_submitted_checksum",
                        "submitted_sha256": None,
                        "observed_sha256": None,
                    },
                }
            if receipt_id in seen_receipts:
                raise TeamUpError(f"duplicate receipt_id: {receipt_id}")
            seen_receipts[receipt_id] = task["task_id"]
            task["return"] = {**task["return"], **payload}
            task.update(status="RETURN_CONFIRMED", last_transition_at=event["ts"])
            if task["seat_id"] and task["seat_id"] in state.get("seats", {}):
                state["seats"][task["seat_id"]]["active_task_id"] = None
        elif event_type == "EXECUTION_HOST_REBIND":
            if state["ledger_schema_version"] < 4:
                raise TeamUpError("execution host rebind requires ledger schema 4")
            task = _task(state, payload.get("task_id"))
            if task["status"] != "BLOCKED" or task["block_reason"] != REBIND_BLOCK_REASON:
                raise TeamUpError("execution host rebind requires a stopped rebind-blocked task")
            if not payload.get("original_attempt_stopped"):
                raise TeamUpError("execution host rebind requires original_attempt_stopped")
            if task["rebind_count"] >= 1:
                raise TeamUpError("execution host rebind budget exhausted; record durable Hold")
            if payload.get("original_dispatch_id") != (task["dispatch"] or {}).get("dispatch_id"):
                raise TeamUpError("execution host rebind original dispatch does not match")
            replacement = _host_binding(payload.get("replacement_host_binding"))
            if replacement != task["host_binding"]:
                raise TeamUpError("execution host rebind may not change case/grant/scope/capability/output root")
            replacement_seat = state["seats"].get(payload.get("replacement_seat_id"))
            current_seat = state["seats"].get(task["seat_id"])
            if not replacement_seat or replacement_seat["lifecycle"] != "ACTIVE":
                raise TeamUpError("execution host rebind replacement seat must be active")
            if not current_seat or replacement_seat["role_family"] != current_seat["role_family"]:
                raise TeamUpError("execution host rebind replacement seat is incompatible")
            if not set(current_seat["capability_set"]).issubset(replacement_seat["capability_set"]):
                raise TeamUpError("execution host rebind replacement seat lacks capabilities")
            if replacement_seat["active_task_id"] not in {None, task["task_id"]}:
                raise TeamUpError("execution host rebind replacement seat is busy")
            current_seat["active_task_id"] = None
            replacement_seat["active_task_id"] = task["task_id"]
            task.update(
                status="PENDING",
                last_transition_at=event["ts"],
                block_reason=None,
                rebind_count=1,
                seat_id=replacement_seat["seat_id"],
                seat_generation=replacement_seat["current_generation"],
            )
        elif event_type == "EXECUTION_HOST_REBIND_HOLD":
            if state["ledger_schema_version"] < 4:
                raise TeamUpError("execution host rebind Hold requires ledger schema 4")
            task = _task(state, payload.get("task_id"))
            if task["status"] != "BLOCKED" or task["block_reason"] != REBIND_BLOCK_REASON:
                raise TeamUpError("execution host rebind Hold requires a stopped rebind-blocked task")
            if task["rebind_count"] < 1:
                raise TeamUpError("execution host rebind Hold requires one prior compatible rebind")
            if not payload.get("original_attempt_stopped"):
                raise TeamUpError("execution host rebind Hold requires original_attempt_stopped")
            task.update(status="HOLD", last_transition_at=event["ts"], block_reason="EXECUTION_HOST_REBIND_DURABLE_HOLD")
            if task["seat_id"] and task["seat_id"] in state.get("seats", {}):
                state["seats"][task["seat_id"]]["active_task_id"] = None
        elif event_type == "MISSION_COMPLETED":
            if state["ledger_schema_version"] < 4:
                raise TeamUpError("mission completion cleanup requires ledger schema 4")
            if any(task["status"] in ACTIVE for task in state["tasks"].values()):
                raise TeamUpError("cannot complete mission with active tasks")
            for seat in state.get("seats", {}).values():
                if seat["lifecycle"] == "ACTIVE":
                    seat["active_task_id"] = None
            state["mission"] = {
                "state": "complete",
                "generation": _require_identifier(payload.get("generation"), "generation"),
                "expected_worker_thread_id": None,
            }
        elif event_type == "BLOCKED":
            task = _task(state, payload["task_id"])
            if task["status"] not in ACTIVE:
                raise TeamUpError(f"cannot block from {task['status']}")
            task.update(status="BLOCKED", last_transition_at=event["ts"], block_reason=payload["reason"])
            if (
                payload["reason"] != REBIND_BLOCK_REASON
                and task["seat_id"] in state.get("seats", {})
            ):
                state["seats"][task["seat_id"]]["active_task_id"] = None
        elif event_type == "STALE":
            task = _task(state, payload["task_id"])
            if task["status"] not in ACTIVE:
                raise TeamUpError(f"cannot mark stale from {task['status']}")
            task.update(status="STALE", last_transition_at=event["ts"])
            if task["seat_id"] in state.get("seats", {}):
                state["seats"][task["seat_id"]]["active_task_id"] = None
        state["last_seq"] = expected_seq

    state["metrics"] = compute_metrics(state, events)
    return state


class Runtime:
    def __init__(self, store: str | Path, team_id: str):
        if not TEAM_ID_RE.fullmatch(team_id):
            raise TeamUpError("team_id must be a safe 1-128 character identifier")
        self.store = Path(store).expanduser().resolve()
        self.team_id = team_id
        self.root = self.store / team_id
        self.events_path = self.root / "events.ndjson"
        self.state_path = self.root / "state.json"
        self.pending_path = self.root / "pending.json"
        self.lock_path = self.root / ".events.lock"
        self._fixed_paths = (
            self.events_path,
            self.state_path,
            self.pending_path,
            self.lock_path,
        )
        self._assert_safe_paths()

    def _require_platform(self) -> None:
        if fcntl is None:
            raise TeamUpError(
                "unsupported platform: POSIX/macOS fcntl advisory locking is required"
            )
        if not hasattr(os, "O_NOFOLLOW"):
            raise TeamUpError(
                "unsupported platform: O_NOFOLLOW is required for path isolation"
            )

    def _assert_safe_paths(self) -> None:
        if os.path.lexists(self.root) and self.root.is_symlink():
            raise TeamUpError("team root must not be a symlink")
        resolved_root = self.root.resolve(strict=False)
        if resolved_root.parent != self.store:
            raise TeamUpError("resolved team root escapes the declared store")
        if self.root.exists() and not self.root.is_dir():
            raise TeamUpError("team root must be a directory")
        for path in self._fixed_paths:
            if os.path.lexists(path) and path.is_symlink():
                raise TeamUpError(f"runtime path must not be a symlink: {path.name}")
            if path.exists() and not path.is_file():
                raise TeamUpError(f"runtime path must be a regular file: {path.name}")
            if path.resolve(strict=False).parent != resolved_root:
                raise TeamUpError(f"runtime path escapes the team root: {path.name}")

    def _prepare_root(self) -> None:
        self._require_platform()
        self._assert_safe_paths()
        self.store.mkdir(parents=True, exist_ok=True)
        self.root.mkdir(mode=0o700, exist_ok=True)
        self._assert_safe_paths()

    @contextmanager
    def _exclusive_lock(self):
        self._prepare_root()
        flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW
        try:
            descriptor = os.open(self.lock_path, flags, 0o600)
        except OSError as exc:
            raise TeamUpError(f"cannot open safe event lock: {exc}") from exc
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise TeamUpError("event lock must be a regular file")
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            self._assert_safe_paths()
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def _read_text_file(self, path: Path) -> str:
        self._assert_safe_paths()
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            raise
        except OSError as exc:
            raise TeamUpError(f"cannot open safe runtime file {path.name}: {exc}") from exc
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise TeamUpError(f"runtime path must be a regular file: {path.name}")
            with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
                descriptor = -1
                return handle.read()
        finally:
            if descriptor >= 0:
                os.close(descriptor)

    def _read_events_unlocked(self) -> list[dict[str, Any]]:
        if not self.events_path.exists():
            return []
        events = []
        text = self._read_text_file(self.events_path)
        for line_number, line in enumerate(text.splitlines(), 1):
            if not line.strip():
                raise TeamUpError(f"blank event line: {line_number}")
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise TeamUpError(f"invalid event JSON at line {line_number}") from exc
        return events

    def read_events(self) -> list[dict[str, Any]]:
        with self._exclusive_lock():
            return self._read_events_unlocked()

    def _projections(self, events: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
        state = replay(self.team_id, events)
        pending = {
            "schema_version": 1,
            "runtime_version": VERSION,
            "ledger_schema_version": state["ledger_schema_version"],
            "team_id": self.team_id,
            "last_seq": state["last_seq"],
            "pending": [
                {
                    "task_id": task["task_id"],
                    "status": task["status"],
                    "return_channel": task["dispatch"]["return_channel"],
                    "artifact_mailbox": task["dispatch"].get("artifact_mailbox"),
                    "submission_id": (task["return"] or {}).get("submission_id"),
                    "mailbox_evidence": (task["return"] or {}).get("mailbox_evidence"),
                }
                for task in state["tasks"].values()
                if task["status"] in ACTIVE
            ],
        }
        pending["pending"].sort(key=lambda item: item["task_id"])
        return state, pending

    def _write_projections_locked(self, events: list[dict[str, Any]]) -> dict[str, Any]:
        """Write projections while the caller holds this team's exclusive lock."""
        state, pending = self._projections(events)
        self._assert_safe_paths()
        atomic_json(self.state_path, state)
        atomic_json(self.pending_path, pending)
        self._assert_safe_paths()
        return state

    def rebuild(self) -> dict[str, Any]:
        with self._exclusive_lock():
            return self._write_projections_locked(self._read_events_unlocked())

    def validate(self) -> dict[str, Any]:
        with self._exclusive_lock():
            events = self._read_events_unlocked()
            expected, pending_expected = self._projections(events)
            actual = None
            if self.state_path.exists():
                actual = json.loads(self._read_text_file(self.state_path))
            pending_actual = None
            if self.pending_path.exists():
                pending_actual = json.loads(self._read_text_file(self.pending_path))
            return {
                "valid": True,
                "event_count": len(events),
                "state_projection_exact": actual == expected,
                "pending_projection_exact": pending_actual == pending_expected,
            }

    def _semantic_duplicate(self, events: list[dict[str, Any]], event_type: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        identity_fields = {
            "DISPATCHED": "dispatch_id",
            "MESSAGE_RECORDED": "message_id",
            "WATCHDOG_TICK_RECORDED": "cycle_id",
            "DIRECT_RETURN_OBSERVED": "direct_observation_id",
            "RETURN_SUBMITTED": "submission_id",
            "RETURN_CONFIRMED": "receipt_id",
        }
        field = identity_fields.get(event_type)
        if not field:
            return None
        identifier = payload.get(field)
        for event in events:
            if event["type"] == event_type and event["payload"].get(field) == identifier:
                if event["payload"] != payload:
                    raise TeamUpError(f"conflicting duplicate {field}: {identifier}")
                return event
        return None

    def _logical_timestamp(self, events: list[dict[str, Any]], now: str | None) -> str:
        """Keep implicit wall time monotonic; never normalize explicit rollback input."""
        if now is not None:
            return now
        wall_time = utc_now()
        if not events or parse_time(wall_time) >= parse_time(events[-1]["ts"]):
            return wall_time
        return events[-1]["ts"]

    def _append_locked(self, event_type: str, payload: dict[str, Any], *, now: str | None, idempotency_key: str | None) -> dict[str, Any]:
        # This is the deepest canonical-write boundary.  Do not rely on the
        # public method's guard: internal callers and reflective/adversarial
        # callers must not be able to append replay-only history.
        if event_type not in WRITABLE_EVENT_TYPES:
            raise TeamUpError(f"invalid event type: {event_type}")
        events = self._read_events_unlocked()
        if idempotency_key:
            for event in events:
                if event.get("idempotency_key") == idempotency_key:
                    if event["type"] != event_type or event["payload"] != payload:
                        raise TeamUpError(f"conflicting idempotency key: {idempotency_key}")
                    return event
        duplicate = self._semantic_duplicate(events, event_type, payload)
        if duplicate:
            return duplicate
        event = {
            "seq": len(events) + 1,
            "event_id": str(uuid.uuid4()),
            "team_id": self.team_id,
            "type": event_type,
            "ts": self._logical_timestamp(events, now),
            "idempotency_key": idempotency_key,
            "payload": payload,
        }
        candidate = [*events, event]
        replay(self.team_id, candidate)
        try:
            descriptor = os.open(
                self.events_path,
                os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW,
                0o600,
            )
        except OSError as exc:
            raise TeamUpError(f"cannot open safe event log: {exc}") from exc
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise TeamUpError("event log must be a regular file")
            with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
                descriptor = -1
                handle.write(canonical(event) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        finally:
            if descriptor >= 0:
                os.close(descriptor)
        self._write_projections_locked(candidate)
        return event

    def append(self, event_type: str, payload: dict[str, Any], *, now: str | None = None, idempotency_key: str | None = None) -> dict[str, Any]:
        if event_type not in WRITABLE_EVENT_TYPES:
            raise TeamUpError(f"invalid event type: {event_type}")
        with self._exclusive_lock():
            return self._append_locked(event_type, payload, now=now, idempotency_key=idempotency_key)

    def init(self, *, team_emoji: str, mode: str, main_brain_thread_id: str, confirmation_secret: str | bytes | None, now: str | None = None) -> dict[str, Any]:
        payload = {
            "team_emoji": team_emoji,
            "mode": mode,
            "main_brain_thread_id": main_brain_thread_id,
            "ledger_schema_version": LEDGER_SCHEMA_VERSION,
            "watchdog_schema_version": WATCHDOG_SCHEMA_VERSION,
            "confirmation_authority": {
                "algorithm": AUTHORITY_ALGORITHM,
                "fingerprint": authority_fingerprint(confirmation_secret),
            },
        }
        return self.append("TEAM_INITIALIZED", payload, now=now, idempotency_key="team:init")

    def add_task(self, task_id: str, *, kind: str = "execution", manual_gate: bool | None = None, depends_on: list[str] | None = None, now: str | None = None) -> dict[str, Any]:
        if kind not in TASK_KINDS:
            raise TeamUpError(f"invalid task kind: {kind}")
        if kind != "execution":
            if manual_gate is False:
                raise TeamUpError("non-execution tasks are always manual-gated")
            manual_gate = True
        elif manual_gate is None:
            manual_gate = False
        payload = {
            "task_id": task_id,
            "kind": kind,
            "manual_gate": bool(manual_gate),
            "depends_on": sorted(set(depends_on or [])),
        }
        return self.append("TASK_ADDED", payload, now=now, idempotency_key=f"task:{task_id}")

    def add_dependency(self, task_id: str, depends_on: str, *, now: str | None = None) -> dict[str, Any]:
        return self.append(
            "DEPENDENCY_ADDED",
            {"task_id": task_id, "depends_on": depends_on},
            now=now,
            idempotency_key=f"dependency:{task_id}:{depends_on}",
        )

    def dispatch(self, task_id: str, *, dispatch_id: str, role_id: str, execution_transport: str, return_channel: str, artifact_mailbox: str | None, model: str, thinking: str, model_control: str, thinking_control: str, stale_after_seconds: int, manual_override: bool = False, seat_id: str | None = None, seat_generation: str | None = None, host_binding: dict[str, str] | None = None, now: str | None = None) -> dict[str, Any]:
        if execution_transport not in EXECUTION_TRANSPORTS:
            raise TeamUpError(f"invalid execution_transport: {execution_transport}")
        if return_channel not in RETURN_CHANNELS:
            raise TeamUpError(f"invalid return_channel: {return_channel}")
        if stale_after_seconds <= 0:
            raise TeamUpError("stale_after_seconds must be positive")
        if return_channel == "artifact_mailbox" and not artifact_mailbox:
            raise TeamUpError("artifact_mailbox return channel requires a mailbox path")
        if not isinstance(manual_override, bool):
            raise TeamUpError("manual_override must be boolean")
        payload = {
            "task_id": task_id,
            "dispatch_id": dispatch_id,
            "role_id": role_id,
            "execution_transport": execution_transport,
            "return_channel": return_channel,
            "artifact_mailbox": artifact_mailbox,
            "model": model,
            "thinking": thinking,
            "model_control": model_control,
            "thinking_control": thinking_control,
            "stale_after_seconds": stale_after_seconds,
            "manual_override": manual_override,
            "message_purpose": "work_dispatch",
            "target_role": "staffed_worker",
            "target_runtime_policy": "override",
            "target_model": model,
            "target_thinking": thinking,
            "target_service_mode": None,
            "seat_id": seat_id,
            "seat_generation": seat_generation,
            "host_binding": host_binding,
        }
        with self._exclusive_lock():
            state = replay(self.team_id, self._read_events_unlocked())
            task = _task(state, task_id)
            unmet = [
                dependency for dependency in task["depends_on"]
                if state["tasks"][dependency]["status"] != "RETURN_CONFIRMED"
            ]
            if unmet:
                raise TeamUpError(f"cannot dispatch with unmet dependencies: {', '.join(unmet)}")
            if task["manual_gate"] and not manual_override:
                raise TeamUpError("manual-gated task requires manual_override")
            return self._append_locked("DISPATCHED", payload, now=now, idempotency_key=None)

    def register_role_seat(
        self, *, seat_id: str, case_id: str, role_family: str, capability_set: list[str],
        isolation_class: str, generation: str, new_thread_reason: str, now: str | None = None,
    ) -> dict[str, Any]:
        return self.append(
            "ROLE_SEAT_REGISTERED",
            {
                "seat_id": seat_id,
                "case_id": case_id,
                "role_family": role_family,
                "capability_set": _canonical_identifier_set(capability_set, "capability_set"),
                "isolation_class": isolation_class,
                "generation": generation,
                "new_thread_reason": new_thread_reason,
            },
            now=now,
            idempotency_key=f"seat:{seat_id}",
        )

    def retire_role_seat(self, seat_id: str, *, reason: str, now: str | None = None) -> dict[str, Any]:
        return self.append(
            "ROLE_SEAT_RETIRED", {"seat_id": seat_id, "reason": reason}, now=now,
            idempotency_key=f"seat-retire:{seat_id}",
        )

    def acknowledge_seat_dispatch(
        self, task_id: str, *, ack_id: str, seat_id: str, dispatch_id: str, generation: str,
        context_hash: str, native_transport_receipt_sha256: str, now: str | None = None,
    ) -> dict[str, Any]:
        return self.append(
            "SEAT_DISPATCH_ACKED",
            {
                "ack_id": ack_id, "task_id": task_id, "seat_id": seat_id,
                "dispatch_id": dispatch_id, "generation": generation,
                "context_hash": _require_checksum(context_hash, "context_hash"),
                "native_transport_receipt_sha256": _require_checksum(
                    native_transport_receipt_sha256, "native_transport_receipt_sha256"
                ),
            },
            now=now,
            idempotency_key=f"seat-ack:{ack_id}",
        )

    def rebind_execution_host(
        self, task_id: str, *, original_dispatch_id: str, replacement_seat_id: str,
        replacement_host_binding: dict[str, str], original_attempt_stopped: bool,
        now: str | None = None,
    ) -> dict[str, Any]:
        return self.append(
            "EXECUTION_HOST_REBIND",
            {
                "task_id": task_id,
                "original_dispatch_id": original_dispatch_id,
                "replacement_seat_id": replacement_seat_id,
                "replacement_host_binding": _host_binding(replacement_host_binding),
                "original_attempt_stopped": bool(original_attempt_stopped),
            },
            now=now,
        )

    def hold_execution_host_rebind(
        self, task_id: str, *, original_attempt_stopped: bool, now: str | None = None,
    ) -> dict[str, Any]:
        return self.append(
            "EXECUTION_HOST_REBIND_HOLD",
            {"task_id": task_id, "original_attempt_stopped": bool(original_attempt_stopped)},
            now=now,
        )

    def complete_mission(self, *, generation: str, now: str | None = None) -> dict[str, Any]:
        return self.append(
            "MISSION_COMPLETED", {"generation": generation}, now=now,
            idempotency_key=f"mission-complete:{generation}",
        )

    def record_message(
        self,
        *,
        message_id: str,
        message_purpose: str,
        source_thread_id: str,
        source_role: str,
        target_thread_id: str,
        target_role: str,
        target_runtime_policy: str,
        target_model: str | None = None,
        target_thinking: str | None = None,
        target_service_mode: str | None = None,
        now: str | None = None,
    ) -> dict[str, Any]:
        payload = {
            "message_id": message_id,
            "message_purpose": message_purpose,
            "source_thread_id": source_thread_id,
            "source_role": source_role,
            "target_thread_id": target_thread_id,
            "target_role": target_role,
            "target_runtime_policy": target_runtime_policy,
            "target_model": target_model,
            "target_thinking": target_thinking,
            "target_service_mode": target_service_mode,
        }
        with self._exclusive_lock():
            state = replay(self.team_id, self._read_events_unlocked())
            _validate_message_intent(
                payload,
                authoritative_main_thread_id=state["team"]["main_brain_thread_id"],
            )
            return self._append_locked(
                "MESSAGE_RECORDED",
                payload,
                now=now,
                idempotency_key=f"message:{message_id}",
            )

    def set_mission_state(
        self,
        mission_state: str,
        *,
        generation: str,
        expected_worker_thread_id: str | None = None,
        now: str | None = None,
    ) -> dict[str, Any]:
        payload = {
            "mission_state": mission_state,
            "generation": generation,
            "expected_worker_thread_id": expected_worker_thread_id,
        }
        return self.append(
            "MISSION_STATE_SET", payload, now=now, idempotency_key=f"mission:{generation}"
        )

    def watchdog_tick(
        self, *, cycle_id: str, team_activity: str, now: str | None = None
    ) -> dict[str, Any]:
        _require_identifier(cycle_id, "cycle_id")
        with self._exclusive_lock():
            state = replay(self.team_id, self._read_events_unlocked())
            mission = _mission(state)
            payload = {
                "cycle_id": cycle_id,
                "team_activity": team_activity,
                "generation": mission["generation"],
                "mission_state": mission["state"],
                "decision": _watchdog_decision(state, team_activity),
            }
            return self._append_locked(
                "WATCHDOG_TICK_RECORDED",
                payload,
                now=now,
                idempotency_key=f"watchdog:{cycle_id}",
            )

    def submit_return(self, task_id: str, *, submission_id: str, artifact_mailbox: str | None = None, mailbox_sha256: str | None = None, now: str | None = None) -> dict[str, Any]:
        _require_identifier(submission_id, "submission_id")
        return self.append(
            "RETURN_SUBMITTED",
            {
                "task_id": task_id,
                "submission_id": submission_id,
                "artifact_mailbox": artifact_mailbox,
                "mailbox_sha256": _require_checksum(mailbox_sha256, "mailbox_sha256") if mailbox_sha256 is not None else None,
            },
            now=now,
        )

    def confirm_return(self, task_id: str, *, submission_id: str, receipt_id: str, destination_observed: bool, confirmed_by_thread_id: str, confirmation_secret: str | bytes | None, observed_mailbox_sha256: str | None = None, direct_observation_id: str | None = None, now: str | None = None) -> dict[str, Any]:
        if not destination_observed:
            raise TeamUpError("destination-observed receipt evidence is required")
        _require_identifier(receipt_id, "receipt_id")
        _require_identifier(submission_id, "submission_id")
        if receipt_id == submission_id:
            raise TeamUpError("receipt_id must be distinct from submission_id")
        state = replay(self.team_id, self.read_events())
        authoritative = (state["team"] or {}).get("main_brain_thread_id")
        if confirmed_by_thread_id != authoritative:
            raise TeamUpError("only the authoritative main brain can confirm a return")
        authority = (state["team"] or {}).get("confirmation_authority")
        if not authority:
            raise TeamUpError("legacy store lacks confirmation authority; re-initialize a new store")
        supplied_fingerprint = authority_fingerprint(confirmation_secret)
        if not hmac.compare_digest(supplied_fingerprint, authority["fingerprint"]):
            raise TeamUpError("invalid main-brain confirmation capability")
        return self.append(
            "RETURN_CONFIRMED",
            {
                "task_id": task_id,
                "submission_id": submission_id,
                "receipt_id": receipt_id,
                "destination_observed": True,
                "confirmed_by_thread_id": confirmed_by_thread_id,
                "authority_fingerprint": authority["fingerprint"],
                "observed_mailbox_sha256": _require_checksum(observed_mailbox_sha256, "observed_mailbox_sha256") if observed_mailbox_sha256 is not None else None,
                "direct_observation_id": direct_observation_id,
            },
            now=now,
        )

    def block(self, task_id: str, reason: str, *, now: str | None = None) -> dict[str, Any]:
        return self.append("BLOCKED", {"task_id": task_id, "reason": reason}, now=now)

    def reconcile(self, *, now: str | None = None) -> list[str]:
        with self._exclusive_lock():
            events = self._read_events_unlocked()
            timestamp = self._logical_timestamp(events, now)
            current = parse_time(timestamp)
            state = replay(self.team_id, events)
            stale_tasks = []
            for task_id, task in sorted(state["tasks"].items()):
                if task["status"] not in ACTIVE:
                    continue
                threshold = task["dispatch"]["stale_after_seconds"]
                age = (current - parse_time(task["last_transition_at"])).total_seconds()
                if age >= threshold:
                    self._append_locked(
                        "STALE",
                        {"task_id": task_id, "age_seconds": age, "threshold_seconds": threshold},
                        now=timestamp,
                        idempotency_key=f"stale:{task_id}:{task['dispatch']['dispatch_id']}",
                    )
                    stale_tasks.append(task_id)
            return stale_tasks

    def ready_wave(self) -> list[str]:
        state = replay(self.team_id, self.read_events())
        ready = []
        for task_id, task in sorted(state["tasks"].items()):
            if task["status"] != "PENDING" or task["kind"] != "execution" or task["manual_gate"]:
                continue
            if all(state["tasks"][dependency]["status"] == "RETURN_CONFIRMED" for dependency in task["depends_on"]):
                ready.append(task_id)
        return ready

    def stats(self) -> dict[str, Any]:
        state = replay(self.team_id, self.read_events())
        return state["metrics"]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="teamup", description=__doc__)
    parser.add_argument(
        "--store",
        help="parent directory for isolated team stores; must match an active pointer when one exists",
    )
    parser.add_argument(
        "--active-store-pointer",
        help=f"active store pointer (default: ${DEFAULT_ACTIVE_STORE_POINTER_ENV} or {DEFAULT_ACTIVE_STORE_POINTER})",
    )
    parser.add_argument("--team-id", required=True)
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init")
    init.add_argument("--team-emoji", required=True)
    init.add_argument("--mode", required=True, choices=["BUILD MODE", "APPLICATION MODE"])
    init.add_argument("--main-brain-thread-id", required=True)
    init.add_argument("--confirmation-secret-file")
    init.add_argument("--confirmation-secret-env", default=DEFAULT_AUTHORITY_ENV)

    task = sub.add_parser("add-task")
    task.add_argument("task_id")
    task.add_argument("--kind", choices=sorted(TASK_KINDS), default="execution")
    task.add_argument(
        "--manual-gate",
        action="store_true",
        help="manually gate an execution task; non-execution kinds are always gated",
    )
    task.add_argument("--depends-on", action="append", default=[])

    dependency = sub.add_parser("add-dependency")
    dependency.add_argument("task_id")
    dependency.add_argument("depends_on")

    dispatch = sub.add_parser("dispatch")
    dispatch.add_argument("task_id")
    dispatch.add_argument("--dispatch-id", required=True)
    dispatch.add_argument("--role-id", required=True)
    dispatch.add_argument("--execution-transport", required=True, choices=sorted(EXECUTION_TRANSPORTS))
    dispatch.add_argument("--return-channel", required=True, choices=sorted(RETURN_CHANNELS))
    dispatch.add_argument("--artifact-mailbox")
    dispatch.add_argument("--model", required=True)
    dispatch.add_argument("--thinking", required=True)
    dispatch.add_argument("--model-control", required=True)
    dispatch.add_argument("--thinking-control", required=True)
    dispatch.add_argument("--stale-after-seconds", required=True, type=int)
    dispatch.add_argument("--manual-override", action="store_true")

    message = sub.add_parser(
        "record-message",
        help="record and validate a message intent; this command never sends a message",
    )
    message.add_argument("--message-id", required=True)
    message.add_argument("--message-purpose", required=True, choices=sorted(MESSAGE_PURPOSES))
    message.add_argument("--source-thread-id", required=True)
    message.add_argument("--source-role", required=True, choices=sorted(SOURCE_ROLES))
    message.add_argument("--target-thread-id", required=True)
    message.add_argument("--target-role", required=True, choices=sorted(TARGET_ROLES))
    message.add_argument(
        "--target-runtime-policy", required=True, choices=sorted(TARGET_RUNTIME_POLICIES)
    )
    message.add_argument("--target-model")
    message.add_argument("--target-thinking")
    message.add_argument("--target-service-mode")

    submit = sub.add_parser("submit-return")
    submit.add_argument("task_id")
    submit.add_argument("--submission-id", required=True)
    submit.add_argument("--artifact-mailbox")
    submit.add_argument("--mailbox-sha256")

    confirm = sub.add_parser("confirm-return")
    confirm.add_argument("task_id")
    confirm.add_argument("--submission-id", required=True)
    confirm.add_argument("--receipt-id", required=True)
    confirm.add_argument("--destination-observed", action="store_true")
    confirm.add_argument("--confirmed-by-thread-id", required=True)
    confirm.add_argument("--observed-mailbox-sha256")
    confirm.add_argument("--confirmation-secret-file")
    confirm.add_argument("--confirmation-secret-env", default=DEFAULT_AUTHORITY_ENV)

    mission = sub.add_parser("set-mission-state")
    mission.add_argument("--state", required=True, choices=sorted(MISSION_STATES))
    mission.add_argument("--generation", required=True)
    mission.add_argument("--expected-worker-thread-id")

    watchdog = sub.add_parser("watchdog-tick")
    watchdog.add_argument("--cycle-id", required=True)
    watchdog.add_argument("--team-activity", required=True, choices=sorted(TEAM_ACTIVITY))

    block = sub.add_parser("block")
    block.add_argument("task_id")
    block.add_argument("--reason", required=True)

    reconcile = sub.add_parser("reconcile")
    reconcile.add_argument("--now")

    for name in ("ready-wave", "stats", "validate", "rebuild"):
        sub.add_parser(name)
    return parser


def _read_cli_secret(args: argparse.Namespace) -> bytes:
    secret_file = getattr(args, "confirmation_secret_file", None)
    if secret_file:
        try:
            return Path(secret_file).read_bytes().strip()
        except OSError as exc:
            raise TeamUpError(f"cannot read confirmation secret file: {exc}") from exc
    environment_name = getattr(args, "confirmation_secret_env", DEFAULT_AUTHORITY_ENV)
    value = os.environ.get(environment_name)
    if value is None:
        raise TeamUpError(
            f"confirmation secret required via --confirmation-secret-file or {environment_name}"
        )
    return value.encode("utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        runtime = Runtime(
            resolve_store(args.store, args.team_id, args.active_store_pointer),
            args.team_id,
        )
        if args.command == "init":
            result = runtime.init(
                team_emoji=args.team_emoji,
                mode=args.mode,
                main_brain_thread_id=args.main_brain_thread_id,
                confirmation_secret=_read_cli_secret(args),
            )
        elif args.command == "add-task":
            result = runtime.add_task(
                args.task_id,
                kind=args.kind,
                manual_gate=True if args.manual_gate else None,
                depends_on=args.depends_on,
            )
        elif args.command == "add-dependency":
            result = runtime.add_dependency(args.task_id, args.depends_on)
        elif args.command == "dispatch":
            result = runtime.dispatch(
                args.task_id,
                dispatch_id=args.dispatch_id,
                role_id=args.role_id,
                execution_transport=args.execution_transport,
                return_channel=args.return_channel,
                artifact_mailbox=args.artifact_mailbox,
                model=args.model,
                thinking=args.thinking,
                model_control=args.model_control,
                thinking_control=args.thinking_control,
                stale_after_seconds=args.stale_after_seconds,
                manual_override=args.manual_override,
            )
        elif args.command == "record-message":
            result = runtime.record_message(
                message_id=args.message_id,
                message_purpose=args.message_purpose,
                source_thread_id=args.source_thread_id,
                source_role=args.source_role,
                target_thread_id=args.target_thread_id,
                target_role=args.target_role,
                target_runtime_policy=args.target_runtime_policy,
                target_model=args.target_model,
                target_thinking=args.target_thinking,
                target_service_mode=args.target_service_mode,
            )
        elif args.command == "submit-return":
            result = runtime.submit_return(
                args.task_id,
                submission_id=args.submission_id,
                artifact_mailbox=args.artifact_mailbox,
                mailbox_sha256=args.mailbox_sha256,
            )
        elif args.command == "confirm-return":
            result = runtime.confirm_return(
                args.task_id,
                submission_id=args.submission_id,
                receipt_id=args.receipt_id,
                destination_observed=args.destination_observed,
                confirmed_by_thread_id=args.confirmed_by_thread_id,
                confirmation_secret=_read_cli_secret(args),
                observed_mailbox_sha256=args.observed_mailbox_sha256,
            )
        elif args.command == "set-mission-state":
            result = runtime.set_mission_state(
                args.state,
                generation=args.generation,
                expected_worker_thread_id=args.expected_worker_thread_id,
            )
        elif args.command == "watchdog-tick":
            result = runtime.watchdog_tick(
                cycle_id=args.cycle_id, team_activity=args.team_activity
            )
        elif args.command == "block":
            result = runtime.block(args.task_id, args.reason)
        elif args.command == "reconcile":
            result = {"stale_tasks": runtime.reconcile(now=args.now)}
        elif args.command == "ready-wave":
            result = {"ready": runtime.ready_wave()}
        elif args.command == "stats":
            result = runtime.stats()
        elif args.command == "validate":
            result = runtime.validate()
        elif args.command == "rebuild":
            result = runtime.rebuild()
        else:  # pragma: no cover
            parser.error("unknown command")
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    except TeamUpError as exc:
        print(f"teamup: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
