#!/usr/bin/env bash
set -euo pipefail

QEMU=/home/user/AsyncOS/taic-qemu/build/qemu-system-riscv64
IMAGE=/home/user/AsyncOS/rel4-manifest-workspace/rel4_kernel/build/images/sel4test-driver-image-riscv-spike
LOG_DIR="$(cd "$(dirname "$0")" && pwd)/logs"
LOG="$LOG_DIR/rel4_fast_suite_$(date +%Y%m%d_%H%M%S).log"

mkdir -p "$LOG_DIR"

echo "===== ReL4 fast diagnostic suite ====="
date
echo "QEMU=$QEMU"
echo "IMAGE=$IMAGE"
echo "LOG=$LOG"

if [ ! -x "$QEMU" ]; then
  echo "ERROR: QEMU not executable: $QEMU"
  exit 1
fi

if [ ! -f "$IMAGE" ]; then
  echo "ERROR: image not found: $IMAGE"
  exit 1
fi

CMD="timeout 300s $QEMU -machine virt -cpu rv64 -nographic -serial mon:stdio -m size=4095M -bios none -kernel $IMAGE -smp 2"

echo
echo "===== run command ====="
echo "$CMD"
echo

set +e
script -q -f -c "$CMD" "$LOG"
STATUS=$?
set -e

echo
echo "===== run exit code: $STATUS ====="

echo
echo "===== success markers from log ====="
grep -E "Booting all finished|seL4 Test|Test suite passed|All is well|Test .* passed|Test .* failed|panic|ERROR" "$LOG" || true

echo
echo "Log saved to: $LOG"

if grep -q "Test suite passed. 9 tests passed. 0 tests disabled." "$LOG" && grep -q "All is well in the universe" "$LOG"; then
  echo "RESULT: SUCCESS"
  exit 0
fi

echo "RESULT: NOT CONFIRMED"
exit "$STATUS"
