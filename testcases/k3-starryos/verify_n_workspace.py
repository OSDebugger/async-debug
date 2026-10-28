#!/usr/bin/env python3
"""Read-only N workspace checks. Never boot, connect to, or control a target.

Print JSON to stdout; callers choose a fresh result path. Only stage A can PASS.
Usage and A-G acceptance criteria are documented in README.md.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


STAGES = {
    "A": "Workspace / ELF",
    "B": "GDB basics",
    "C": "ARD DAP",
    "D": "RuntimeEvent",
    "E": "History / Observer",
    "F": "Snapshot",
    "G": "Sync context / nested futures / task isolation / automated regression",
}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def readelf(*args):
    # Offline tool only; source_head below invokes read-only git rev-parse.
    return subprocess.run(
        ["readelf", *map(str, args)], check=True, capture_output=True,
        text=True, timeout=120,
    ).stdout


def source_head(source):
    return subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"], check=True,
        capture_output=True, text=True, timeout=15,
    ).stdout.strip()


def mapped_path(value, mappings):
    path = Path(value)
    for old, new in sorted(mappings, key=lambda item: len(item[0]), reverse=True):
        if path.is_relative_to(Path(old)):
            return Path(new) / path.relative_to(Path(old))
    return path


def add_config_arguments(parser):
    parser.add_argument("--config", type=Path,
                        default=Path(__file__).parent / "config/n-host-dwarf.json")
    parser.add_argument("--workspace", default=os.environ.get("STARRYOS_WORKSPACE"))
    parser.add_argument("--openocd-launcher", default=os.environ.get("K3_OPENOCD_LAUNCHER"))
    parser.add_argument("--source-prefix-map", action="append", default=[], metavar="OLD=NEW")


def load_config(args, require_launcher=True):
    config = json.loads(args.config.read_text())
    if not isinstance(config, dict):
        raise ValueError("config must be an object")
    workspace = args.workspace or config.get("workspace")
    if not workspace:
        raise ValueError("Set STARRYOS_WORKSPACE or --workspace to the prepared N workspace")
    config["workspace"] = str(Path(workspace).expanduser().absolute())
    launcher = args.openocd_launcher or config.get("openocd_launcher")
    if not launcher and require_launcher:
        raise ValueError("Set K3_OPENOCD_LAUNCHER or --openocd-launcher to an existing verified launcher")
    config["openocd_launcher"] = str(Path(launcher).expanduser().absolute()) if launcher else None
    maps = list(config.get("source_prefix_maps", []))
    for item in args.source_prefix_map:
        old, separator, new = item.partition("=")
        if not separator or not old or not new or not all(Path(x).is_absolute() for x in (old, new)):
            raise ValueError("--source-prefix-map requires absolute OLD=NEW paths")
        maps.append([old, new])
    if any(not isinstance(item, (list, tuple)) or len(item) != 2
           or not all(isinstance(x, str) and Path(x).is_absolute() for x in item) for item in maps):
        raise ValueError("source_prefix_maps must contain absolute [OLD, NEW] pairs")
    config["source_prefix_maps"] = maps
    return config


def verify(config):
    checks = []

    def record(name, passed, detail):
        checks.append({"name": name, "status": "PASS" if passed else "FAIL",
                       "detail": detail})

    try:
        workspace = Path(config["workspace"])
        if not workspace.is_absolute():
            raise ValueError("workspace must be absolute")
        mappings = config.get("source_prefix_maps", [])

        def local(key):
            relative = Path(config[key])
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError(f"{key} must be relative to workspace")
            path = workspace / relative
            if not path.resolve().is_relative_to(workspace.resolve()):
                raise ValueError(f"{key} escapes workspace")
            return path

        elf = local("elf")
        record("elf_exists", elf.is_file(), str(elf))
        record("ports", config["gdb_remote"] == "localhost:3333"
               and config["telnet_port"] == 4444 and config["tcl_port"] == 6666,
               "GDB=localhost:3333, Telnet=4444, Tcl=6666; no connections made")
        for key in ("boot_script",):
            path = local(key)
            record(key, path.is_file() and os.access(path, os.X_OK),
                   str(path) + " (must be executable; not executed)")
        launcher = Path(config["openocd_launcher"])
        record("openocd_launcher", launcher.is_file() and os.access(launcher, os.X_OK),
               str(launcher) + " (must be executable; not executed)")

        artifacts = json.loads(local("artifact_manifest").read_text())
        build = json.loads(local("build_manifest").read_text())
        artifact = artifacts[elf.name]
        built = build["artifacts"][elf.name]
        digest = sha256(elf)
        record("elf_hash", digest == artifact["sha256"] == built["sha256"], digest)
        record("elf_size", elf.stat().st_size == artifact["size"] == built["size"],
               str(elf.stat().st_size))
        record("manifest_paths", all(mapped_path(x["path"], mappings) == elf for x in (artifact, built))
               and mapped_path(build["workspace"], mappings) == workspace,
               "Both manifests must identify this workspace and ELF (explicit prefix maps allowed)")

        source = local("poll_source")
        entries = json.loads(local("source_manifest").read_text())
        entry = next(x for x in entries if x["path"] == config["poll_source"])
        record("poll_source", mapped_path(build["poll_source"], mappings) == source
               and sha256(source) == entry["sha256"],
               str(source) + "; compare content with source checksum manifest")
        head = source_head(workspace / "source")
        record("source_revision", head == build["source_head"],
               f"source HEAD={head}; build source_head={build['source_head']}")

        sections = readelf("-SW", elf)
        required = (".debug_info", ".debug_abbrev", ".debug_line", ".debug_str")
        record("dwarf_sections", all(re.search(re.escape(s) + r"\s", sections)
                                     for s in required), ", ".join(required))
        info = readelf("--debug-dump=info", "--dwarf-depth=1", elf)
        # Require an ax_task compilation unit whose own compilation directory
        # points to the current source tree, rather than a path in another CU.
        units = re.split(r"(?=Compilation Unit @ offset)", info)
        source_root = str(workspace / "source")
        mapped = any("DW_AT_name" in unit and "ax_task" in unit
                     and any("DW_AT_comp_dir" in line
                             and mapped_path(line.rsplit(": ", 1)[-1].strip(), mappings) == Path(source_root)
                             for line in unit.splitlines()) for unit in units)
        record("dwarf_source_root", mapped, source_root)
    except (OSError, ValueError, KeyError, TypeError, StopIteration,
            subprocess.SubprocessError) as exc:
        record("preflight_error", False, str(exc) or type(exc).__name__)

    passed = bool(checks) and all(x["status"] == "PASS" for x in checks)
    stages = {key: {"name": value, "automation_status": "PENDING"}
              for key, value in STAGES.items()}
    stages["A"]["automation_status"] = "PASS" if passed else "FAIL"
    return {
        "schema": "k3-n-host-check-v1", "mode": "host-static-only",
        "workspace": config.get("workspace"), "hardware_access": False,
        "source_prefix_maps": config.get("source_prefix_maps", []),
        "status": "PENDING" if passed else "FAIL", "checks": checks,
        "stages": stages,
        "note": "B-G were not executed; host PASS does not imply board or ARD PASS.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    add_config_arguments(parser)
    args = parser.parse_args()
    try:
        config = load_config(args)
        result = verify(config)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print(json.dumps({"status": "FAIL", "hardware_access": False,
                          "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["status"] == "FAIL" else 0


if __name__ == "__main__":
    raise SystemExit(main())
