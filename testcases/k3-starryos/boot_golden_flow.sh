#!/usr/bin/env bash
set -euo pipefail

testcase_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
config_file=${K3_CONFIG_FILE:-"$testcase_dir/config/baseline.env"}

if [[ -f "$config_file" ]]; then
    # shellcheck disable=SC1090
    set -a
    source "$config_file"
    set +a
fi

if [[ -z "${K3_DWARF_BASELINE:-}" ]]; then
    echo "[k3-starryos] K3_DWARF_BASELINE is not set." >&2
    echo "Copy config/baseline.env.example to config/baseline.env, uncomment and edit" >&2
    echo "K3_DWARF_BASELINE," >&2
    echo "or export K3_DWARF_BASELINE before running this script." >&2
    exit 2
fi

if [[ ! -d "$K3_DWARF_BASELINE" ]]; then
    echo "[k3-starryos] baseline directory not found: $K3_DWARF_BASELINE" >&2
    exit 2
fi

required_artifacts=(
    artifacts/fsbl/FSBL.bin
    artifacts/u-boot/k3-jtag-ram-opensbi-uboot.itb
    artifacts/starryos/starryos_host_dwarf_release.bin
    artifacts/starryos/spacemit-k3-com260-ifx.dtb
    tools/verify_artifacts.sh
)
for relative_path in "${required_artifacts[@]}"; do
    if [[ ! -f "$K3_DWARF_BASELINE/$relative_path" ]]; then
        echo "[k3-starryos] required baseline file not found: $K3_DWARF_BASELINE/$relative_path" >&2
        exit 2
    fi
done

if [[ ! -x "$K3_DWARF_BASELINE/tools/verify_artifacts.sh" ]]; then
    echo "[k3-starryos] baseline verifier is not executable: $K3_DWARF_BASELINE/tools/verify_artifacts.sh" >&2
    exit 2
fi

export K3_AUTO_BOOT_LOG_DIR=${K3_AUTO_BOOT_LOG_DIR:-"$testcase_dir/logs"}
exec python3 "$testcase_dir/k3_boot_state_machine.py" "$@"
