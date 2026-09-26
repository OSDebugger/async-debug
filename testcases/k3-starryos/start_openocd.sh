#!/usr/bin/env bash
set -euo pipefail

testcase_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

openocd_bin=${K3_OPENOCD_BIN:-openocd}
openocd_scripts=${K3_OPENOCD_SCRIPTS:-"$testcase_dir/openocd"}
interface_cfg=${K3_OPENOCD_INTERFACE_CFG:-interface/jlink.cfg}
target_cfg=${K3_OPENOCD_TARGET_CFG:-target/spacemit-k3.cfg}
adapter_speed=${K3_OPENOCD_ADAPTER_SPEED:-100}
log_dir=${K3_OPENOCD_LOG_DIR:-"$testcase_dir/logs"}

if [[ ! -d "$openocd_scripts" ]]; then
    echo "[k3-starryos] OpenOCD scripts directory not found: $openocd_scripts" >&2
    exit 1
fi

if [[ "$openocd_bin" == */* ]]; then
    if [[ ! -x "$openocd_bin" ]]; then
        echo "[k3-starryos] OpenOCD executable not found: $openocd_bin" >&2
        exit 1
    fi
elif ! command -v "$openocd_bin" >/dev/null 2>&1; then
    echo "[k3-starryos] OpenOCD is not in PATH: $openocd_bin" >&2
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

echo "[k3-starryos] OpenOCD log: $log_file"
"$openocd_bin" "${openocd_args[@]}" "$@" 2>&1 | tee "$log_file"
