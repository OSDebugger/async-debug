#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/home/user/RustDebug/rust-debugger-DA}
KERNEL=${KERNEL:-/home/user/AsyncOS/rel4-manifest-workspace/rel4_kernel/build-rel4-async-debuginfo-only/kernel/kernel.elf}
USER_ELF=${USER_ELF:-/home/user/AsyncOS/rel4-manifest-workspace/rel4_kernel/build-rel4-async-debuginfo-only/cargo/build/riscv64imac-sel4/release/example}
GDB=${GDB:-gdb-multiarch}
REMOTE=${REMOTE:-:1234}
TIMEOUT=${TIMEOUT:-240}
TRANSITION_PROBE_CONFIG=${TRANSITION_PROBE_CONFIG:-$ROOT/testcases/rel4-async/transition-probe.json}

USER_TEXT_ADDR=${USER_TEXT_ADDR:-0x1ab3c}
USER_START_ADDR=${USER_START_ADDR:-0x1c580}
USER_REGISTER_ADDR=${USER_REGISTER_ADDR:-0x1c626}
USER_WRAPPER_ADDR=${USER_WRAPPER_ADDR:-0x27d7a}
KERNEL_LABEL33_ADDR=${KERNEL_LABEL33_ADDR:-0xffffffff84017ff8}
KERNEL_SPAWN_ADDR=${KERNEL_SPAWN_ADDR:-0xffffffff84018042}
COROUTINE_SYMBOL=${COROUTINE_SYMBOL:-rustlib::async_runtime::coroutine::Coroutine::execute}
ASYNC_HANDLER_SYMBOL=${ASYNC_HANDLER_SYMBOL:-rustlib::async_runtime::async_syscall_handler::async_syscall_handler::{async_fn#0}}

STAMP=${STAMP:-$(date +%Y%m%d_%H%M%S)}
LOG_DIR=${LOG_DIR:-$ROOT/temp/rel4_async_privilege_chain_probe_$STAMP}
GDB_SCRIPT="$LOG_DIR/privilege_chain_probe.gdb"
LOG="$LOG_DIR/privilege_chain_probe.log"
SNAPSHOT_JSON="$LOG_DIR/privilege_chain_snapshot.json"
SUMMARY="$LOG_DIR/privilege_chain_summary.md"

mkdir -p "$LOG_DIR" "$ROOT/temp"

cat > "$GDB_SCRIPT" <<EOF
set pagination off
set confirm off
set breakpoint pending on
set architecture riscv:rv64
set python print-stack full

set \$hit_coroutine = 0
set \$hit_async_handler = 0

target remote $REMOTE

python import async_rust_debugger

ardb-reset
ardb-transition-reset
ardb-gen-whitelist
ardb-load-whitelist $ROOT/temp/poll_functions.txt

add-symbol-file $USER_ELF $USER_TEXT_ADDR

echo \n===== REL4 ASYNC PRIVILEGE CHAIN =====\n
ardb-enable-transition-probe $TRANSITION_PROBE_CONFIG
ardb-transition-probe-status
ardb-trace '$COROUTINE_SYMBOL'
ardb-trace '$ASYNC_HANDLER_SYMBOL'

break '$COROUTINE_SYMBOL'
commands
  silent
  set \$hit_coroutine = \$hit_coroutine + 1
  echo \n[7] [KERNEL ASYNC][async] Coroutine::execute\n
  echo \n===== ARD SNAPSHOT =====\n
  ardb-get-snapshot
  disable \$_hit_bpnum
  if \$hit_async_handler >= 1
    echo \n===== REL4 ASYNC PRIVILEGE CHAIN SUMMARY =====\n
    printf "hit_coroutine=%d\\n", \$hit_coroutine
    printf "hit_async_handler=%d\\n", \$hit_async_handler
    echo \n===== TRANSITION PROBE STATUS =====\n
    ardb-transition-probe-status
    echo \n===== TRANSITION PATH STATUS =====\n
    ardb-transition-status
    echo \n===== FINAL ARD SNAPSHOT =====\n
    ardb-get-snapshot
    echo \n===== ARD HIT SUMMARY =====\n
    shell grep -E "child-hit|caller-frame-hit|\\[ARD\\]\\[async\\]" $ROOT/temp/ardb.log | tail -20 || true
    quit
  end
  continue
end

break '$ASYNC_HANDLER_SYMBOL'
commands
  silent
  set \$hit_async_handler = \$hit_async_handler + 1
  echo \n[8] [KERNEL ASYNC][async] async_syscall_handler::{async_fn#0}\n
  echo \n===== ARD SNAPSHOT =====\n
  ardb-get-snapshot
  disable \$_hit_bpnum
  if \$hit_coroutine >= 1
    echo \n===== REL4 ASYNC PRIVILEGE CHAIN SUMMARY =====\n
    printf "hit_coroutine=%d\\n", \$hit_coroutine
    printf "hit_async_handler=%d\\n", \$hit_async_handler
    echo \n===== TRANSITION PROBE STATUS =====\n
    ardb-transition-probe-status
    echo \n===== TRANSITION PATH STATUS =====\n
    ardb-transition-status
    echo \n===== FINAL ARD SNAPSHOT =====\n
    ardb-get-snapshot
    echo \n===== ARD HIT SUMMARY =====\n
    shell grep -E "child-hit|caller-frame-hit|\\[ARD\\]\\[async\\]" $ROOT/temp/ardb.log | tail -20 || true
    quit
  end
  continue
end

continue

echo \n===== REL4 ASYNC PRIVILEGE CHAIN SUMMARY =====\n
printf "hit_coroutine=%d\\n", \$hit_coroutine
printf "hit_async_handler=%d\\n", \$hit_async_handler
echo \n===== TRANSITION PROBE STATUS =====\n
ardb-transition-probe-status
echo \n===== TRANSITION PATH STATUS =====\n
ardb-transition-status
echo \n===== FINAL ARD SNAPSHOT =====\n
ardb-get-snapshot
echo \n===== ARD HIT SUMMARY =====\n
shell grep -E "child-hit|caller-frame-hit|\\[ARD\\]\\[async\\]" $ROOT/temp/ardb.log | tail -20 || true

quit
EOF

cd "$ROOT"

set +e
PYTHONPATH="$ROOT" \
ASYNC_RUST_DEBUGGER_TEMP_DIR="$ROOT/temp" \
REL4_USER_START_ADDR="$USER_START_ADDR" \
REL4_USER_REGISTER_ADDR="$USER_REGISTER_ADDR" \
REL4_USER_WRAPPER_ADDR="$USER_WRAPPER_ADDR" \
REL4_KERNEL_LABEL33_ADDR="$KERNEL_LABEL33_ADDR" \
REL4_KERNEL_SPAWN_ADDR="$KERNEL_SPAWN_ADDR" \
timeout "$TIMEOUT"s "$GDB" -q "$KERNEL" -x "$GDB_SCRIPT" 2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}
set -e

if grep -Eq "could not connect|Connection refused|Operation not permitted" "$LOG"; then
  STATUS=2
fi

python3 - "$LOG" "$SNAPSHOT_JSON" "$SUMMARY" "$STATUS" <<'PY'
import json
import re
import sys
from pathlib import Path

log_path = Path(sys.argv[1])
snapshot_path = Path(sys.argv[2])
summary_path = Path(sys.argv[3])
status = int(sys.argv[4])
text = log_path.read_text(errors="replace") if log_path.exists() else ""

decoder = json.JSONDecoder()
snapshots = []
for match in re.finditer(r"\{", text):
    try:
        obj, end = decoder.raw_decode(text[match.start():])
    except Exception:
        continue
    if isinstance(obj, dict) and isinstance(obj.get("path"), list):
        snapshots.append(obj)

snapshot = snapshots[-1] if snapshots else None
if snapshot is not None:
    snapshot_path.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n")
else:
    snapshot_path.write_text("")

def contains(pattern: str) -> bool:
    return pattern in text

def hit_count(name: str):
    m = re.findall(rf"{re.escape(name)}=(\d+)", text)
    return int(m[-1]) if m else 0

handler_state = None
handler_status = None
handler_child_hit = None
coroutine_state = None
coroutine_status = None
coroutine_child_hit = None
transition_path = []
if snapshot:
    transition_path = snapshot.get("transition_path") if isinstance(snapshot.get("transition_path"), list) else []
    for node in snapshot.get("path", []):
        func = str(node.get("func", ""))
        if "Coroutine::execute" in func:
            coroutine_state = node.get("state")
            coroutine_status = node.get("state_read_status")
            coroutine_child_hit = node.get("child_hit_match")
        if "async_syscall_handler" in func:
            handler_state = node.get("state")
            handler_status = node.get("state_read_status")
            handler_child_hit = node.get("child_hit_match")

child_hit = contains("child-hit")
caller_hit = contains("caller-frame-hit")
transition_labels = {
    str(node.get("label", ""))
    for node in transition_path
    if isinstance(node, dict)
}
hit_user_wrapper = "syscall wrapper" in transition_labels
hit_kernel_label = "UintrRegisterAsyncSyscall label 33 / decode_invocation" in transition_labels
hit_user_start = "syscall_test.rs:81" in transition_labels
hit_user_register = "syscall_test.rs:99/101" in transition_labels
hit_async_spawn = "async_syscall_handler spawn site" in transition_labels
hit_coroutine = hit_count("hit_coroutine") > 0 or contains("[7] [KERNEL ASYNC] Coroutine::execute")
hit_async_handler = hit_count("hit_async_handler") > 0 or contains("[8] [KERNEL ASYNC] async_syscall_handler")
chain_observed = hit_user_wrapper and hit_kernel_label and hit_coroutine and hit_async_handler
connection_failed = any(
    marker in text
    for marker in ["could not connect", "Connection refused", "Operation not permitted"]
)

lines = [
    "# rel4 async privilege chain summary",
    "",
    "## Result",
    "",
    f"- gdb exit status: {status}",
    f"- connection failed: {'yes' if connection_failed else 'no'}",
    f"- privilege chain observed: {'yes' if chain_observed else 'no'}",
    f"- user wrapper hit: {'yes' if hit_user_wrapper else 'no'}",
    f"- kernel label 33 / UintrRegisterAsyncSyscall hit: {'yes' if hit_kernel_label else 'no'}",
    f"- Coroutine::execute hit: {'yes' if hit_coroutine else 'no'}",
    f"- async_syscall_handler hit: {'yes' if hit_async_handler else 'no'}",
    f"- ardb-get-snapshot non-empty: {'yes' if snapshot else 'no'}",
    f"- transition_path non-empty: {'yes' if transition_path else 'no'}",
    f"- async_syscall_handler state is 0: {'yes' if handler_state == 0 or handler_state == '0' else 'no'}",
    f"- child-hit log observed: {'yes' if child_hit else 'no'}",
    f"- caller-frame-hit log observed: {'yes' if caller_hit else 'no'}",
    "",
    "## Concise Chain",
    "",
    "```text",
    f"[1] [USER][sync] syscall_test.rs:81 - {'hit' if hit_user_start else 'missed'}",
    f"[2] [USER][sync] syscall_test.rs:99/101 or 104 - {'hit' if hit_user_register else 'missed'}",
    f"[3] [USER][sync] syscall wrapper - {'hit' if hit_user_wrapper else 'missed'}",
    f"[4] [TRANSITION] user_to_kernel transition_event=user_to_kernel - {'observed' if hit_kernel_label else 'not observed'}",
    f"[5] [KERNEL][sync] UintrRegisterAsyncSyscall label 33 / decode_invocation - {'hit' if hit_kernel_label else 'missed'}",
    f"[6] [KERNEL][sync] async_syscall_handler spawn site - {'hit' if hit_async_spawn else 'missed'}",
    f"[7] [KERNEL ASYNC][async] Coroutine::execute - {'hit' if hit_coroutine else 'missed'} state={coroutine_state if coroutine_state is not None else 'N/A'} state_read_status={coroutine_status if coroutine_status else 'N/A'} child_hit={coroutine_child_hit if coroutine_child_hit else 'N/A'}",
    f"[8] [KERNEL ASYNC][async] async_syscall_handler::{{async_fn#0}} - {'hit' if hit_async_handler else 'missed'} state={handler_state if handler_state is not None else 'N/A'} state_read_status={handler_status if handler_status else 'N/A'} child_hit={handler_child_hit if handler_child_hit else 'N/A'}",
    "```",
    "",
    "## Hit Counts",
    "",
]
for key in ["hit_coroutine", "hit_async_handler"]:
    lines.append(f"- {key}: {hit_count(key)}")
lines += [
    f"- transition probe nodes observed: {len(transition_path)}",
    f"- configured boundary labels observed: {len(transition_labels)}",
]

lines += ["", "## Snapshot", ""]

if snapshot:
    lines += [
        f"- thread_id: {snapshot.get('thread_id')}",
        f"- privilege: {snapshot.get('privilege')}",
        f"- transition_event: {snapshot.get('transition_event')}",
        f"- transition_path length: {len(transition_path)}",
        f"- path length: {len(snapshot.get('path', []))}",
        "",
        "### Transition Path",
        "",
    ]
    if transition_path:
        for node in transition_path:
            lines.append(
                f"- [{node.get('seq')}] {node.get('privilege')} {node.get('type')} "
                f"{node.get('label')} | func={node.get('func', '')} | "
                f"event={node.get('event', '')} | pc={node.get('pc', '')}"
            )
    else:
        lines.append("- empty")
    lines += [
        "",
        "### Path Nodes",
        "",
    ]
    for node in snapshot.get("path", []):
        lines.append(
            f"- {node.get('func')} | origin={node.get('origin')} | "
            f"state={node.get('state')} | state_read_status={node.get('state_read_status')} | "
            f"child_hit_match={node.get('child_hit_match')}"
        )
else:
    lines.append("- no snapshot JSON was extracted from the GDB log")

lines += [
    "",
    "## Known Limitations",
    "",
    "- Ordinary GDB backtrace does not automatically stitch a cross-privilege logical stack.",
    "- This script reconstructs the chain from breakpoint hit order.",
    "- This script does not implement multi-HART or multi-thread precise correlation.",
    "- `transition_path` is recorded by `ardb-enable-transition-probe` using transition-probe.json.",
    "- Ordinary `run_snapshot_probe.sh` snapshots may not include `transition_path`.",
    "- Inspector displays the cross-privilege chain only when the snapshot contains `transition_path`.",
]

summary_path.write_text("\n".join(lines) + "\n")
PY

cat "$SUMMARY"
exit "$STATUS"
