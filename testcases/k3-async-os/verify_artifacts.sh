#!/usr/bin/env bash
# golden flow 状态机 preflight 的校验入口:对 K3_DWARF_BASELINE 工作区做
# Host-DWARF 身份对齐(与 verify_k3_workspace.py 同源,无参调用)。
set -euo pipefail

testcase_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
workspace=${K3_DWARF_BASELINE:-${ASYNC_OS_WORKSPACE:-}}

if [[ -z "$workspace" ]]; then
    echo "[k3-asyncos] K3_DWARF_BASELINE is not set." >&2
    exit 2
fi

exec python3 "$testcase_dir/verify_k3_workspace.py" --workspace "$workspace"
