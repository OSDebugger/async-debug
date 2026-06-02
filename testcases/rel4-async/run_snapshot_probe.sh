#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-/home/user/RustDebug/rust-debugger-DA}
KERNEL=${KERNEL:-/home/user/AsyncOS/rel4-manifest-workspace/rel4_kernel/build-rel4-async-debuginfo-only/kernel/kernel.elf}
USER_ELF=${USER_ELF:-/home/user/AsyncOS/rel4-manifest-workspace/rel4_kernel/build-rel4-async-debuginfo-only/cargo/build/riscv64imac-sel4/release/example}
GDB_SCRIPT=${GDB_SCRIPT:-/home/user/RustDebug/rust-debugger-DA/temp/rel4_async_snapshot_probe.gdb}
LOG=${LOG:-/home/user/RustDebug/rust-debugger-DA/testcases/rel4-async/logs/rel4_async_snapshot_probe.log}

mkdir -p "$(dirname "$LOG")" "$(dirname "$GDB_SCRIPT")" "$ROOT/temp"

cat > "$GDB_SCRIPT" <<EOF
set pagination off
set confirm off
set architecture riscv:rv64
set python print-stack full
set \$hit_coroutine = 0
set \$hit_async_handler = 0

target remote :1234

python import async_rust_debugger

ardb-reset
ardb-gen-whitelist
ardb-load-whitelist $ROOT/temp/poll_functions.txt

add-symbol-file $USER_ELF 0x1ab3c

echo \n===== whitelist =====\n
shell cat $ROOT/temp/poll_functions.txt

echo \n===== set ARD trace roots =====\n
ardb-trace 'rustlib::async_runtime::coroutine::Coroutine::execute'
ardb-trace 'rustlib::async_runtime::async_syscall_handler::async_syscall_handler::{async_fn#0}'

break 'rustlib::async_runtime::coroutine::Coroutine::execute'
commands
  silent
  set \$hit_coroutine = \$hit_coroutine + 1
  echo \n===== ASYNC ROOT HIT: Coroutine::execute =====\n
  bt
  info registers pc ra sp a0 a1 a2 a3 a4 a5 a6 a7
  info symbol \$pc
  info line *\$pc
  ardb-get-snapshot
  disable \$_hit_bpnum
  if \$hit_async_handler >= 1
    echo \n===== final snapshot after both roots =====\n
    ardb-get-snapshot
    echo \n===== ardb log tail =====\n
    shell tail -300 $ROOT/temp/ardb.log
    quit
  end
  continue
end

break 'rustlib::async_runtime::async_syscall_handler::async_syscall_handler::{async_fn#0}'
commands
  silent
  set \$hit_async_handler = \$hit_async_handler + 1
  echo \n===== ASYNC ROOT HIT: async_syscall_handler =====\n
  bt
  info registers pc ra sp a0 a1 a2 a3 a4 a5 a6 a7
  info symbol \$pc
  info line *\$pc
  ardb-get-snapshot
  disable \$_hit_bpnum
  if \$hit_coroutine >= 1
    echo \n===== final snapshot after both roots =====\n
    ardb-get-snapshot
    echo \n===== ardb log tail =====\n
    shell tail -300 $ROOT/temp/ardb.log
    quit
  end
  continue
end

info breakpoints
continue

echo \n===== final snapshot after continue returned =====\n
ardb-get-snapshot
echo \n===== ardb log tail =====\n
shell tail -300 $ROOT/temp/ardb.log

quit
EOF

cd "$ROOT"

PYTHONPATH="$ROOT" \
ASYNC_RUST_DEBUGGER_TEMP_DIR="$ROOT/temp" \
timeout 240s gdb-multiarch -q "$KERNEL" -x "$GDB_SCRIPT" 2>&1 | tee "$LOG"
