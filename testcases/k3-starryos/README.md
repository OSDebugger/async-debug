# K3 COM260 + StarryOS testcase

This directory is an ARD remote-target example for a StarryOS image running on a
Spacemit K3 COM260 Kit. It contains only host-side launch/configuration examples.
It does not contain StarryOS source code, a complete deployment environment, or
firmware artifacts.

The boot state machine is kept separate from ARD itself. It drives the verified
BootROM-to-StarryOS sequence using UART observations and fastboot readiness probes;
OpenOCD and ARD are started separately. The imported state-machine logic comes from
the existing K3 golden flow. Adding it here has not, by itself, repeated a real-board
validation.

## Hardware and host requirements

- Spacemit K3 COM260 Kit
- J-Link
- OpenOCD with J-Link and RISC-V support; this testcase supplies the required cfg files
- `python3`, `fastboot`, `minicom`, and access to the board UART
- `gdb-multiarch` (or another GDB with RISC-V support)
- a StarryOS source workspace matching the debug ELF

Before booting, manually place the board in BootROM USB Recovery and ensure no other
program owns the UART. The scripts do not control board power or `FORCE_RECOVERY`.

## Prepare the external baseline

Keep the K3 baseline outside this repository. Do not add its binary artifacts to
this testcase. Copy the configuration template and point it at the external frozen
baseline:

```bash
cp config/baseline.env.example config/baseline.env
${EDITOR:-vi} config/baseline.env
```

Uncomment `K3_DWARF_BASELINE` in the copied file and set it to the frozen baseline
directory. The boot entry point reports a clear error before invoking the state
machine if the directory or a required artifact is missing.

`K3_DWARF_BASELINE` must have the layout expected by the verified golden flow:

```text
<baseline>/
├── artifacts/fsbl/FSBL.bin
├── artifacts/u-boot/k3-jtag-ram-opensbi-uboot.itb
├── artifacts/starryos/starryos_host_dwarf_release.bin
├── artifacts/starryos/starryos_host_dwarf_release.elf
├── artifacts/starryos/spacemit-k3-com260-ifx.dtb
├── manifests/artifacts.sha256
└── tools/verify_artifacts.sh
```

The checksum verifier is intentionally required before the state machine sends any
artifact. The `.gitignore` in this directory excludes common K3 artifact extensions,
the local environment file, and runtime logs.

## Start the board

From this testcase directory, run:

```bash
./boot_golden_flow.sh
```

The state machine observes and drives:

```text
BootROM → FSBL/SPL → OpenSBI/U-Boot → StarryOS
```

It waits for explicit UART or USB fastboot evidence at every transition, loads the
kernel and DTB into the verified addresses, and waits for `Welcome to Starry OS!`.
Logs are written under `logs/` unless `K3_AUTO_BOOT_LOG_DIR` overrides that location.

This command performs real board boot operations, including fastboot transfers. Read
the script and verify the configured baseline before running it. It was not executed
while this testcase was added.

## Start OpenOCD

In a second terminal, run:

```bash
./start_openocd.sh
```

The default command uses the bundled `openocd/interface/jlink.cfg` and
`openocd/target/spacemit-k3.cfg`, preserving the verified settings: cluster 0, core 0,
and a 100 kHz adapter speed. It does not load the K3 baseline configuration or require
a separately installed K3 target cfg. Override the OpenOCD binary when needed:

```bash
K3_OPENOCD_BIN="$HOME/openocd/src/openocd" \
./start_openocd.sh
```

`K3_OPENOCD_SCRIPTS`, `K3_OPENOCD_INTERFACE_CFG`, and `K3_OPENOCD_TARGET_CFG` remain
available for explicit overrides. No repository script depends on a fixed deployment
path. OpenOCD serves GDB on its configured port (normally `localhost:3333`).

## Attach ARD in VS Code

1. In the ARD repository, start the existing **Extension Development Host** launch
   configuration. Do not replace the repository `.vscode/launch.json`.
2. Open the matching StarryOS source workspace in the Extension Development Host.
3. Copy `launch.json.example` into that workspace's `.vscode/launch.json`, or merge
   its configuration with the existing file.
4. Export the external DWARF ELF path before starting VS Code:

   ```bash
   set -a
   source config/baseline.env
   set +a
   export K3_STARRYOS_ELF="$K3_DWARF_BASELINE/artifacts/starryos/starryos_host_dwarf_release.elf"
   ```

5. Select **K3 COM260 StarryOS (ARD/OpenOCD)** and start debugging.

ARD's existing remote transport uses `request: "launch"` with `remote` to attach to
an already-running OpenOCD server. This avoids the QEMU-starting behavior of ARD's
current `request: "attach"` path. `enableOsDebug` remains `false` because this
testcase does not invent unverified K3 privilege ranges or border/hook breakpoints;
those can be added only after target-specific validation.

After GDB loads the ELF and attaches, use the existing Async Inspector workflow:
generate or load the whitelist, select a trace root, continue to a real breakpoint,
and inspect the Execution Graph and logical/physical call stack.

## Purpose and evidence boundary

This testcase is intended to validate:

- RISC-V real-hardware debugging
- DWARF source-level debugging
- ARD Async Inspector behavior on StarryOS

The scripts and configuration establish the integration path. They are not evidence
that all three items pass on every K3/StarryOS build; record real-board results
separately when the flow is executed.
