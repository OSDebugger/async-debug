#!/bin/bash
# =============================================================
# ARD 性能测试 A：测量每次断点停止时 Python stop() 回调的耗时
# 在 Linux 调试服务器上运行。需要：gdb、cargo、/usr/bin/time
#
# 用法:
#   ./profile_test_A.sh [trace-root-symbol]
#   # 默认 trace root 为 minimal::block_on
#
# 跑三遍:
#   RUN 1  baseline   —— 不装任何跟踪断点，程序正常跑完（对照）
#   RUN 2  profile    —— ARDB_PROFILE=1，装跟踪断点，输出每类断点的耗时统计
#   RUN 3  detail     —— ARDB_PROFILE_DETAIL=1，额外输出 stop() 内部分段耗时
#
# 结果解读:
#   RUN1 与 RUN2 的 Elapsed 之差 = 跟踪带来的总时间开销（总侵入量）
#   RUN2 的 "ALL ... total python stop() time" = Python 回调部分
#   (总侵入量 - Python 回调时间) ≈ GDB 自身每次停止的固定开销
#
# 如果 ardb-trace 报符号不存在，先在服务器上查实际符号名:
#   gdb -batch -ex "info functions block_on" testcases/minimal/target/debug/minimal
# =============================================================
set -euo pipefail

TRACE_ROOT="${1:-minimal::block_on}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
TESTCASE="$ROOT/testcases/minimal"
TEMP_DIR="$ROOT/temp"

export PYTHONPATH="$ROOT"
export ASYNC_RUST_DEBUGGER_TEMP_DIR="$TEMP_DIR"
mkdir -p "$TEMP_DIR"

echo "[profile] 编译 testcases/minimal ..."
(cd "$TESTCASE" && cargo build --quiet)

BINARY="$TESTCASE/target/debug/minimal"

echo
echo "[profile] === RUN 1: baseline（无跟踪，对照） ==="
/usr/bin/time -v gdb -batch \
    -ex "python import async_rust_debugger" \
    -ex run "$BINARY" 2>&1 \
    | tee "$TEMP_DIR/ardb_profile_baseline.log" \
    | grep -E "Elapsed \(wall clock\)|exited normally" || true

echo
echo "[profile] === RUN 2: 跟踪 + 总耗时统计（ARDB_PROFILE=1），root = $TRACE_ROOT ==="
ARDB_PROFILE=1 /usr/bin/time -v gdb -batch \
    -ex "python import async_rust_debugger" \
    -ex "ardb-trace $TRACE_ROOT" \
    -ex run "$BINARY" 2>&1 \
    | tee "$TEMP_DIR/ardb_profile_run.log" \
    | grep -E "Elapsed \(wall clock\)|ARD-PROFILE" || true

echo
echo "[profile] === RUN 3: 跟踪 + 内部分段统计（ARDB_PROFILE_DETAIL=1），root = $TRACE_ROOT ==="
ARDB_PROFILE=1 ARDB_PROFILE_DETAIL=1 gdb -batch \
    -ex "python import async_rust_debugger" \
    -ex "ardb-trace $TRACE_ROOT" \
    -ex run "$BINARY" 2>&1 \
    | tee "$TEMP_DIR/ardb_profile_detail.log" \
    | grep "ARD-PROFILE" || true

echo
echo "[profile] 完成。完整输出保存在:"
echo "  $TEMP_DIR/ardb_profile_baseline.log"
echo "  $TEMP_DIR/ardb_profile_run.log"
echo "  $TEMP_DIR/ardb_profile_detail.log"
