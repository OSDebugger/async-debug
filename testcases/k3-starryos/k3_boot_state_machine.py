#!/usr/bin/env python3
"""Compatibility entry for the N launcher; no local hardware state machine.

Default: delegate the hardware operation. --check is offline checks and plan only.
The external verified launcher owns firmware checks, UART and boot transitions.
"""

import argparse
import json
import os
from pathlib import Path
import sys

from verify_n_workspace import add_config_arguments, load_config, verify


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    add_config_arguments(parser)
    parser.add_argument("--operation", choices=("boot", "openocd"), default="boot")
    parser.add_argument("--check", action="store_true",
                        help="offline workspace checks and command plan; never invoke launcher")
    args = parser.parse_args(argv)
    try:
        config = load_config(args, require_launcher=args.check or args.operation == "openocd")
        workspace = Path(config["workspace"])
        if not workspace.is_dir():
            raise ValueError(f"N workspace not found: {workspace}")
        if args.operation == "boot":
            relative = Path(config["boot_script"])
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("boot_script must be relative to workspace")
            command = [str(workspace / relative), "--image", "host-dwarf"]
        else:
            command = [config["openocd_launcher"]]
        local_entries = [Path(__file__).resolve(), Path(__file__).with_name("boot_golden_flow.sh").resolve(),
                         Path(__file__).with_name("start_openocd.sh").resolve()]
        if Path(command[0]).resolve() in local_entries:
            raise ValueError("external launcher must not point back to an ARD wrapper")
        if not Path(command[0]).is_file() or not os.access(command[0], os.X_OK):
            raise ValueError(f"External launcher missing or not executable: {command[0]}")
        if args.check:
            result = verify(config)
            result["planned_command"] = command
            print(json.dumps(result, indent=2))
            return 1 if result["status"] == "FAIL" else 0
        print("[k3] Delegating hardware operation to verified external launcher: "
              + repr(command) + ". "
              "Boot can write a writable rootfs; no offline PASS proves hardware safety.", file=sys.stderr)
        os.execv(command[0], command)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"[k3] {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
