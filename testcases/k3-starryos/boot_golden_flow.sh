#!/usr/bin/env bash
set -euo pipefail

testcase_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
config_file=${K3_CONFIG_FILE:-"$testcase_dir/config/baseline.env"}
if [[ -f "$config_file" ]]; then
    # Optional user-owned configuration; no generated or downloaded assets.
    set -a
    source "$config_file"
    set +a
fi
export PYTHONDONTWRITEBYTECODE=1
exec python3 "$testcase_dir/k3_boot_state_machine.py" --operation boot "$@"
