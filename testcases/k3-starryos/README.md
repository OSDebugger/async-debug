# K3 COM260 + StarryOS N Host-DWARF

中文操作入口：[ARD + K3 StarryOS N Host-DWARF 完整上手教程](GETTING_STARTED.zh-CN.md)，
按顺序覆盖启动、双窗口配置、白名单、Trace、sleep 1、History / Observer / Snapshot。

This is one ARD remote-target example, using **N Host-DWARF** only. It does not
ship StarryOS, rootfs, firmware, a toolchain or a complete deployment environment.
Hardware tests require a K3 COM260 board, J-Link, UART/USB access and separately
prepared, board-validated N boot assets. Downloading ARD does not supply them.

## Prepare external dependencies

Use Python 3.10+, GNU readelf and Git for host checks; gdb-multiarch (RISC-V enabled)
and the ARD VS Code extension development environment for debugging. Rebuilding N
requires the toolchain, features and dependency revisions recorded in its build
manifest. Obtain those matching tools independently; the host tools above do not
replace the OS build toolchain.
The ARD scripts never build or download firmware, or create a rootfs.

```bash
export STARRYOS_WORKSPACE=/absolute/path/to/prepared-N-workspace
export K3_OPENOCD_LAUNCHER=/absolute/path/to/existing-verified/start_openocd.sh
```

Alternatively copy `config/baseline.env.example` to ignored `config/baseline.env`,
edit it and source it with `set -a` / `set +a`. Shell wrappers load that file if
present; the Python checker and VS Code use exported variables or explicit args.

Expected workspace contract (paths can be overridden in `--config` JSON):

```text
<workspace>/
├── boot_n_candidate.sh             # existing authoritative N boot entry
├── scripts/                       # its existing helpers, not copied into ARD
├── configs/candidate.json          # its validated firmware/image/site identities
├── artifacts/starryos.elf
├── artifacts/manifest.json
├── source/                        # matching Git checkout and dependency sources
└── temp/
    ├── build-manifest.json
    └── copied-files-sha256.json    # source records, at least the selected time.rs
```

The manifests must record ELF path/size/SHA256, build workspace, poll_source and
source_head. The source manifest is a list of path/sha256 records relative to the
workspace. For a new external build, produce equivalent truthful build/source
records; do not copy another build's manifest to make checks pass.

N's launcher additionally needs its pinned FSBL, OpenSBI/U-Boot, BIN, FIT, DTB,
identity evidence, fastboot, mkimage, exclusive UART and a prepared UFS rootfs.
The launcher/config may contain site-specific paths and hardware identity checks.
Supplying a different workspace path does **not** relocate those
external dependencies. Prepare and validate them independently; ARD does not edit
that launcher or bypass its checks.

## Host-only verification

From the ARD repository root:

```bash
python3 testcases/k3-starryos/verify_n_workspace.py
# Equivalent explicit workspace selection:
python3 testcases/k3-starryos/verify_n_workspace.py --workspace /absolute/path/to/prepared-N-workspace
python3 -B -m unittest discover -s testcases/k3-starryos/tests -v
```

CLI workspace/launcher values override environment values, then JSON values.
The checker prints JSON, writes no files, runs only offline readelf and read-only
Git queries, and never contacts a target. Save outputs to a fresh directory under
`temp/`. Checks cover ELF identity, DWARF, selected source content and paths,
source HEAD vs build source_head, launcher availability and port roles.
A can PASS; B-G remain PENDING. Exit 0 is not hardware success.

Checks verify artifact identity and selected source provenance, **not a rebuild**,
all dependency contents, FIT/firmware safety or the currently loaded board image.
For relocated unmodified assets, explicitly map the original workspace prefix:

```bash
python3 testcases/k3-starryos/verify_n_workspace.py --source-prefix-map /original/workspace=/new/workspace
```

This maps manifest identities and DWARF comp_dir for the offline check; it does not
change the ELF or configure GDB. For debugging, separately configure GDB's
`set substitute-path /original/workspace/source /new/workspace/source`, e.g. via
ARD launch `autorun` (supported by the existing adapter). Dependency crate paths
may need additional substitutions. A rebuild at the new location is another option
but requires new matching artifacts/manifests and separate validation.

## Boot and OpenOCD (hardware operations)

The following commands are for a separately authorized hardware session. They are
not host tests. Boot requires BootROM recovery and exclusive UART, as enforced by
the existing N launcher; normal N startup uses a writable rootfs.

```bash
# Offline checks/plan ONLY; neither external launcher is executed:
./testcases/k3-starryos/boot_golden_flow.sh --check
./testcases/k3-starryos/start_openocd.sh --check

# Hardware operations; do not run during host-only verification:
sudo ./testcases/k3-starryos/boot_golden_flow.sh --workspace /absolute/path/to/prepared-N-workspace
./testcases/k3-starryos/start_openocd.sh
```

`boot_golden_flow.sh` delegates through its Python entry exactly:

```text
<workspace>/boot_n_candidate.sh --image host-dwarf
```

No `--boot`, `--start`, timeout, UART, console or logging override is added. The
external N implementation alone owns preflight checks, firmware/RAM transfers,
UFS inspection, bootm, shell detection and minicom handoff. Its exit status and
terminal are preserved by exec. In particular, `--boot` would change N's default
start selection and is deliberately not injected. Boot logic is owned by the
external launcher. Additional external boot modes are not exposed by this example.

`start_openocd.sh` delegates to K3_OPENOCD_LAUNCHER without changing arguments or
JTAG settings. Provide a launcher validated for J-Link/K3, cluster 0/core 0 and
100 kHz adapter speed.
GDB remote is **localhost:3333**; 4444 is Telnet and 6666 is Tcl. Files under
`openocd/` are configuration references, not selected by the wrapper. Prepare the
external launcher's OpenOCD binary and configuration dependencies separately.

## ARD launch and verification

Export STARRYOS_WORKSPACE before starting VS Code. Start **Extension Development
Host** from the repository's existing `.vscode/launch.json`, then open the N
workspace and merge `launch.json.example` into its local `.vscode/launch.json`.
Select the single **K3 StarryOS N Host-DWARF ARD** entry. It uses the exported
workspace's `artifacts/starryos.elf`, gdb-multiarch from PATH and localhost:3333.
No preLaunchTask boots hardware or starts OpenOCD. ARD uses `request: launch` with
remote for the already-running server; enableOsDebug stays false until separately
validated.

See the A-G criteria below. The minimal board regression uses sleep 2 and the
sleep_until/TimerFuture symbols. It does not require test-timerfd; check your own
rootfs before selecting additional programs. Manual observations do not change
automated test statuses.

## Test directory and runtime outputs

This directory contains only test scripts, configurations, test source and this
README. Store logs, snapshots, reports and temporary test outputs under the ARD
repository `temp/`, using a separate directory for each run. External N/OpenOCD
launchers keep their own output locations; configure and manage those separately.

## A–G acceptance criteria

Every new run starts B-G at **PENDING**. Manual evidence does not change
those automated statuses. A host check exiting zero means only its static checks
passed; its overall JSON status remains PENDING until board work is performed.

| Stage | Required observations for a new board run | Automation in this checker |
| --- | --- | --- |
| A Workspace / ELF | ELF exists; DWARF sections exist; ax_task DWARF comp_dir maps to current source; selected source hash matches source manifest; source HEAD matches build source_head; ELF hash/size/path match artifact and build manifests | Actual static PASS/FAIL |
| B GDB basics | Remote connection to 3333 succeeds; `TimerFuture::poll` breakpoint hits; stopped PC resolves to the matching Rust source location | PENDING |
| C ARD DAP | N launch succeeds in Extension Development Host; user-set source breakpoint hits; DAP stopped event arrives; Inspector displays | PENDING |
| D RuntimeEvent | Correct whitelist loads; internal observer breakpoints install; poll-entry RuntimeEvent is generated; event admission_action=ALLOW | PENDING |
| E History / Observer | Nonempty nodes, edges and events; observed `sleep_until → TimerFuture::poll`; repeated execution accumulates enter/exit counts; Observer Tree displays | PENDING |
| F Snapshot | `empty=false`; non-null Future address and resolved type; active status agrees with the paused frame/task; retain poll state status separately | PENDING |
| G Further capabilities | Investigate synchronous context; verify deeper nested Futures and task isolation; implement and execute complete automated regression | PENDING |

For D, preserve the raw schema: logs may express admission as
`admission result={'action': 'ALLOW', ...}` rather than a literal
`admission_action` field. Record the representation and its event association;
a string ALLOW elsewhere in the log is insufficient. Likewise E needs actual
before/after counters, not just a tree screenshot. A criteria row is not evidence
that every item in it has passed.

## Scope and limitations

The minimal regression targets this relationship:

```text
sleep_until::{async_fn#0}
    → TimerFuture::poll
```

Known limits:

1. `starry_kernel::syscall::task::schedule::sleep_impl` and
   `starry_kernel::syscall::task::schedule::sys_clock_nanosleep` require further
   investigation for synchronous context collection. Adding them to the whitelist
   alone does not establish that History contains the corresponding context.
2. A `call_edge_accepted` event with relation source `recent_root_thread` indicates
   execution association, not a fully Future-identity-validated await relation.
3. Hand-written TimerFuture has no compiler `__state` field. Snapshot poll state
   `unsupported` is a known limit, distinct from an empty/failed Snapshot.
4. The smoke flow does not assume test-timerfd is installed. Ordinary sleep does
   not exercise `timeout_at_wall`.
5. Generic symbols in grouped/flat whitelists must be complete. Check probe
   installation output for errors such as `unmatched quote`; missing events alone
   do not prove that a function never executed.

## Minimal board regression

1. Run `python3 testcases/k3-starryos/verify_n_workspace.py` on the host first.
   Save stdout to a **new** stage's `results/workspace.json`; stop on A failure.
2. Under explicit board authorization, boot N using the command above and start
   the existing external OpenOCD launcher. Check image identity and port roles.
   The wrapper adds only --image host-dwarf, preserving N default modes. Avoid competing GDB sessions.
3. For B, use the established GDB procedure, stop in
   `ax_task::future::time::{impl#1}::poll`, and save PC/source/ELF evidence.
   For C, open the N workspace in Extension Development Host and select
   **K3 StarryOS N Host-DWARF ARD** from `launch.json.example`.
   No boot/OpenOCD startup task is attached to that launch entry.
4. Load the minimal two-entry flat whitelist through the existing Inspector flow:

   ```text
   ax_task::future::time::sleep_until::{async_fn#0}
   ax_task::future::time::{impl#1}::poll
   ```

   Retain matching grouped async metadata. Save whitelist load/probe-install
   output, then choose sleep_until as Trace Root. A chosen root alone is not
   evidence of RuntimeEvent collection.
5. Manually execute `sleep 2` in the board shell, then use the established
   continue/stop procedure. Capture D-F evidence at a real source stop. Repeat
   once for count accumulation, recording before/after results and task identity.
6. Save DAP/stopped and Inspector evidence, raw RuntimeEvents, History,
   Observer Tree and Snapshot JSON. Keep failures and PENDING items; do not infer
   exit counts if execution has not completed. Leave G PENDING.

Host artifact validation is not a build or proof of firmware/FIT/UFS safety.

Board startup, OpenOCD and GDB commands require a hardware session.
The host checker never executes them, opens a network socket,
continues/steps/halts/resets a target, or writes UFS.
Store each run's raw output, test results and per-criterion evidence under a new
directory in the ARD repository `temp/`. Collect Snapshot, History and Observer
exports separately: a Snapshot alone does not prove History counters or edges.
Preserve existing artifacts and previous run outputs.
