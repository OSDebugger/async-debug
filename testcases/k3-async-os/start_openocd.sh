#!/usr/bin/env bash
set -euo pipefail

# 清掉可能残留的 OpenOCD 实例：一个 J-Link 一个板子，只允许一个实例，
# 残留实例会占住 6666/4444/3333 端口，导致新实例起不来。
# 实测 OpenOCD 不响应 SIGTERM（疑似卡在 jaylink USB 层），必须用 -9 强杀。
# 注意：如果调试会话正连着 OpenOCD，这里会把它一起杀掉，重起后重新 F5 即可。
pkill -9 -x openocd 2>/dev/null || true
sleep 0.5

testcase_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

openocd_bin=${K3_OPENOCD_BIN:-openocd}
openocd_scripts=${K3_OPENOCD_SCRIPTS:-"$testcase_dir/openocd"}
interface_cfg=${K3_OPENOCD_INTERFACE_CFG:-interface/jlink.cfg}
target_cfg=${K3_OPENOCD_TARGET_CFG:-target/spacemit-k3.cfg}
adapter_speed=${K3_OPENOCD_ADAPTER_SPEED:-100}
log_dir=${K3_OPENOCD_LOG_DIR:-"$testcase_dir/logs"}

if [[ ! -d "$openocd_scripts" ]]; then
    echo "[k3-asyncos] OpenOCD scripts directory not found: $openocd_scripts" >&2
    exit 1
fi

if [[ "$openocd_bin" == */* ]]; then
    if [[ ! -x "$openocd_bin" ]]; then
        echo "[k3-asyncos] OpenOCD executable not found: $openocd_bin" >&2
        exit 1
    fi
elif ! command -v "$openocd_bin" >/dev/null 2>&1; then
    echo "[k3-asyncos] OpenOCD is not in PATH: $openocd_bin" >&2
    exit 1
fi

mkdir -p "$log_dir"
log_file="$log_dir/openocd_$(date +%Y%m%d_%H%M%S).log"

openocd_args=(
    -s "$openocd_scripts"
    -f "$interface_cfg"
    -c "set SPEED $adapter_speed"
    -c 'set CLUSTERS {0}'
    -c 'set CLUSTER0_COREIDS {0}'
    -f "$target_cfg"
    -c "adapter speed $adapter_speed"
)

echo "[k3-asyncos] OpenOCD log: $log_file"
"$openocd_bin" "${openocd_args[@]}" "$@" 2>&1 | tee "$log_file"
