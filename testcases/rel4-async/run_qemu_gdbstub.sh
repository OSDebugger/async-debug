#!/usr/bin/env bash
set -euo pipefail

QEMU=${QEMU:-/home/user/AsyncOS/taic-qemu/build/qemu-system-riscv64}
IMAGE=${IMAGE:-/home/user/AsyncOS/rel4-manifest-workspace/rel4_kernel/build-rel4-async-debuginfo-only/images/example-image-riscv-spike}
LOG=${LOG:-/home/user/RustDebug/rust-debugger-DA/testcases/rel4-async/logs/rel4_async_qemu_gdbstub.log}

mkdir -p "$(dirname "$LOG")"

"$QEMU" \
  -machine virt \
  -cpu rvgcsu-n \
  -nographic \
  -serial mon:stdio \
  -m size=4095M \
  -bios none \
  -kernel "$IMAGE" \
  -smp 2 \
  -S \
  -s 2>&1 | tee "$LOG"
