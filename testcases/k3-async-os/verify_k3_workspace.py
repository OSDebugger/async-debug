#!/usr/bin/env python3
"""Host-DWARF 工作区离线校验(attach 前的身份对齐)。

检查顺序:
  1. asyncos.elf / asyncos.bin / manifest.json 存在;
  2. manifest 的 elf_sha256 / bin_sha256 与实际文件一致;
  3. git HEAD 与 manifest.commit 一致,且工作树干净(脏树 → FAIL 并提示先冻结;
     子模块内部改动不计入干净树检查——其内容由 source_files 磁盘哈希兜住);
  4. source_files 逐文件重新 sha256 比对,不一致 → FAIL 并打印该文件路径。

用法: python3 verify_k3_workspace.py --workspace /home/iris/data/async-os-original
"""

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

MANIFEST_NAME = "manifest.json"
ARTIFACT_DIR = "artifacts/k3-host-dwarf"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fail(message: str) -> None:
    print(f"[FAIL] {message}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description="Host-DWARF 工作区离线校验(身份对齐)")
    parser.add_argument(
        "--workspace",
        default=None,
        help="async-os-original 工作区根目录(默认取环境变量 ASYNC_OS_WORKSPACE)",
    )
    args = parser.parse_args()

    import os
    workspace_value = args.workspace or os.environ.get("ASYNC_OS_WORKSPACE")
    if not workspace_value:
        fail("缺少 --workspace(且未设置 ASYNC_OS_WORKSPACE)")
        return 2
    workspace = Path(workspace_value).resolve()
    if not workspace.is_dir():
        fail(f"工作区不存在: {workspace}")
        return 2

    artifact_dir = workspace / ARTIFACT_DIR
    elf = artifact_dir / "asyncos.elf"
    bin_ = artifact_dir / "asyncos.bin"
    manifest_path = artifact_dir / MANIFEST_NAME

    # ① 产物存在
    for p in (elf, bin_, manifest_path):
        if not p.is_file():
            fail(f"产物缺失: {p}")
            return 1

    # 读 manifest
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError) as exc:
        fail(f"manifest.json 无法解析: {exc}")
        return 1
    for field in ("commit", "elf_sha256", "bin_sha256", "source_files"):
        if field not in manifest:
            fail(f"manifest.json 缺字段: {field}")
            return 1

    # ② elf/bin 哈希一致
    if sha256(elf) != manifest["elf_sha256"]:
        fail("asyncos.elf 与 manifest.elf_sha256 不一致(重新构建或还原产物)")
        return 1
    if sha256(bin_) != manifest["bin_sha256"]:
        fail("asyncos.bin 与 manifest.bin_sha256 不一致(重新构建或还原产物)")
        return 1

    # ③ git 状态对齐(子模块内部改动不参与;其内容由 source_files 磁盘哈希兜住)
    def git(*argv: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", *argv], cwd=workspace, capture_output=True, text=True
        )

    head = git("rev-parse", "HEAD")
    if head.returncode != 0:
        fail(f"git rev-parse 失败: {head.stderr.strip()}")
        return 1
    if head.stdout.strip() != manifest["commit"]:
        fail(
            f"git HEAD({head.stdout.strip()[:8]}) != manifest.commit({manifest['commit'][:8]});"
            " 提交新改动后需重新构建(scripts/k3_host_dwarf_build.sh)"
        )
        return 1
    status = git("status", "--porcelain", "--ignore-submodules=dirty")
    if status.stdout.strip():
        fail("工作树脏,先冻结或还原(manifest 与实际构建输入不再一致):")
        for line in status.stdout.splitlines()[:20]:
            print(f"    {line}", file=sys.stderr)
        return 1

    # ④ source_files 逐文件比对
    mismatches = []
    for rel, expected_hash in manifest["source_files"].items():
        path = workspace / rel
        if not path.is_file():
            mismatches.append(f"{rel} (缺失)")
            continue
        if sha256(path) != expected_hash:
            mismatches.append(rel)
    if mismatches:
        fail("以下源文件与构建时不一致(重新构建后重试):")
        for rel in mismatches:
            print(f"    {rel}", file=sys.stderr)
        return 1

    print(
        f"PASS: {workspace} 与 manifest 身份对齐"
        f"(commit={manifest['commit'][:8]}, {len(manifest['source_files'])} 个源文件一致)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
