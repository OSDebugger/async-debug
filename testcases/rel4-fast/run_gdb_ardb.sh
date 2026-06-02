#!/usr/bin/env bash
set -euo pipefail

PROJECT=/home/user/RustDebug/rust-debugger-DA
KERNEL=/home/user/AsyncOS/rel4-manifest-workspace/rel4_kernel/build/kernel/kernel.elf
GDB_SCRIPT="$PROJECT/testcases/rel4-fast/ardb_repro.gdb"
TEMP_DIR="$PROJECT/temp"

CMD=(
  gdb-multiarch
  -q
  "$KERNEL"
  -x "$GDB_SCRIPT"
)

echo "===== ReL4 fast suite GDB / ARD ====="
date
echo "PROJECT=$PROJECT"
echo "KERNEL=$KERNEL"
echo "GDB_SCRIPT=$GDB_SCRIPT"
echo "PYTHONPATH=$PROJECT"
echo "ASYNC_RUST_DEBUGGER_TEMP_DIR=$TEMP_DIR"

if ! command -v gdb-multiarch >/dev/null 2>&1; then
  echo "ERROR: gdb-multiarch not found in PATH" >&2
  exit 1
fi

if [ ! -f "$KERNEL" ]; then
  echo "ERROR: kernel ELF not found: $KERNEL" >&2
  exit 1
fi

if [ ! -f "$GDB_SCRIPT" ]; then
  echo "ERROR: GDB script not found: $GDB_SCRIPT" >&2
  exit 1
fi

mkdir -p "$TEMP_DIR"

echo
echo "===== run command ====="
echo "PYTHONPATH=$PROJECT ASYNC_RUST_DEBUGGER_TEMP_DIR=$TEMP_DIR ${CMD[*]}"
echo

cd "$PROJECT"
PYTHONPATH="$PROJECT" ASYNC_RUST_DEBUGGER_TEMP_DIR="$TEMP_DIR" exec "${CMD[@]}"
