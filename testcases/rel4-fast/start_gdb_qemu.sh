#!/usr/bin/env bash
set -euo pipefail

QEMU=/home/user/AsyncOS/taic-qemu/build/qemu-system-riscv64
IMAGE=/home/user/AsyncOS/rel4-manifest-workspace/rel4_kernel/build/images/sel4test-driver-image-riscv-spike

CMD=(
  "$QEMU"
  -machine virt
  -cpu rv64
  -nographic
  -serial mon:stdio
  -m size=4095M
  -bios none
  -kernel "$IMAGE"
  -smp 2
  -S
  -s
)

echo "===== ReL4 fast suite QEMU GDB stub ====="
date
echo "QEMU=$QEMU"
echo "IMAGE=$IMAGE"

if [ ! -x "$QEMU" ]; then
  echo "ERROR: QEMU not executable: $QEMU" >&2
  exit 1
fi

if [ ! -f "$IMAGE" ]; then
  echo "ERROR: image not found: $IMAGE" >&2
  exit 1
fi

echo
echo "QEMU will wait for GDB on :1234."
echo "Open another terminal and run:"
echo "  cd /home/user/RustDebug/rust-debugger-DA/testcases/rel4-fast"
echo "  ./run_gdb_ardb.sh"
echo
echo "===== run command ====="
printf '%q ' "${CMD[@]}"
echo
echo

exec "${CMD[@]}"
