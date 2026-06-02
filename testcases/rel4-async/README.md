# rel4-async

`rel4-async` exercises the ReL4 `rust-root-task-demo` async syscall workload for ARD dynamic tracing.

## CPU Requirement

This testcase requires the RISC-V N extension (RVN). The UINTC receiver registration path reads the `utvec` CSR in the kernel. With taic-qemu, run the image with:

```sh
-cpu rvgcsu-n
```

The provided `run_qemu_gdbstub.sh` helper uses this CPU model by default.

Do not use `-cpu rv64` for this testcase. That CPU does not enable RVN, and the kernel can stop progressing at:

```asm
csrr a0,utvec
```

The expected OpenSBI ISA string contains `n`, for example:

```text
Boot HART ISA : rv64imafdcnsuh
```

## Main Artifacts

- Kernel: `/home/user/AsyncOS/rel4-manifest-workspace/rel4_kernel/build-rel4-async-debuginfo-only/kernel/kernel.elf`
- Image: `/home/user/AsyncOS/rel4-manifest-workspace/rel4_kernel/build-rel4-async-debuginfo-only/images/example-image-riscv-spike`
- User ELF: `/home/user/AsyncOS/rel4-manifest-workspace/rel4_kernel/build-rel4-async-debuginfo-only/cargo/build/riscv64imac-sel4/release/example`

## ARD Snapshot Probe

Start QEMU:

```sh
./run_qemu_gdbstub.sh
```

Then run the snapshot probe from the repository root:

```sh
./testcases/rel4-async/run_snapshot_probe.sh
```

The expected ARD whitelist contains three roots, and the snapshot path should include both:

- `rustlib::async_runtime::coroutine::Coroutine::execute`
- `rustlib::async_runtime::async_syscall_handler::async_syscall_handler::{async_fn#0}`

## VS Code ARD Debugging Flow

1. Open VS Code at the debugger repository root:

   ```text
   /home/user/RustDebug/rust-debugger-DA
   ```

2. Select and start `Run Extension - rel4-async`.
3. In the new Extension Development Host window, confirm that the workspace is:

   ```text
   /home/user/RustDebug/rust-debugger-DA/testcases/rel4-async
   ```

4. Run the `rel4-async: start qemu gdbstub` task. You can also start QEMU manually:

   ```sh
   ./run_qemu_gdbstub.sh
   ```

   Wait until QEMU is ready for a GDB connection before starting the debugger. The helper script keeps the required `-cpu rvgcsu-n` setting.

5. Select `Debug rel4-async kernel (ARD attach)` and start debugging. The adapter loads the kernel ELF and pauses at its synthetic entry stop. It connects to `:1234` on the first `Continue`.
6. Open Async Inspector, click `Reset`, then click `Gen Whitelist`.

   The plugin should generate and load:

   ```text
   /home/user/RustDebug/rust-debugger-DA/testcases/rel4-async/temp/poll_functions.txt
   ```

   The corresponding GDB command is:

   ```text
   ardb-load-whitelist /home/user/RustDebug/rust-debugger-DA/testcases/rel4-async/temp/poll_functions.txt
   ```

7. Trace these candidates from Async Inspector, or run the commands in the Debug Console:

   ```text
   ardb-trace 'rustlib::async_runtime::coroutine::Coroutine::execute'
   ardb-trace 'rustlib::async_runtime::async_syscall_handler::async_syscall_handler::{async_fn#0}'
   ```

8. Continue execution to connect to the QEMU gdbstub and wait for a trace hit. Click `Snapshot`, or let the Inspector refresh automatically after a real stop.
9. The expected tree is:

   ```text
   Coroutine::execute
     -> async_syscall_handler
   ```

10. The testcase-local `temp/` directory should contain:

    ```text
    poll_functions.txt
    ardb.log
    ardb_snapshot.json
    ```

Do not use the repository-level whitelist for this VS Code route:

```text
/home/user/RustDebug/rust-debugger-DA/temp/poll_functions.txt
```

## VS Code GUI E2E Validation

### Prerequisites

Use a fresh QEMU instance for every GUI validation run. Do not reuse an old QEMU instance after the workload has completed: its PC may already be in the idle loop, so the async breakpoints will not be hit again.

Before starting QEMU, confirm that an old process is not using `:1234`:

```sh
ss -ltnp | rg ':1234'
```

The QEMU helper must keep `-cpu rvgcsu-n`. The Extension Development Host workspace must be:

```text
/home/user/RustDebug/rust-debugger-DA/testcases/rel4-async
```

### Standard Startup Order

1. From the repository-root VS Code window, start `Run Extension - rel4-async`.
2. In the Extension Development Host window, run the `rel4-async: start qemu gdbstub` task.
3. Confirm that QEMU is listening on `:1234`.
4. Start `Debug rel4-async kernel (ARD attach)`.
5. Open Async Inspector.
6. Click `Reset`.
7. Click `Gen Whitelist`.
8. Confirm output equivalent to:

   ```text
   [ARD] wrote whitelist: 3 symbols -> /home/user/RustDebug/rust-debugger-DA/testcases/rel4-async/temp/poll_functions.txt
   [ARD] whitelist loaded: exact=3 prefix=0 from /home/user/RustDebug/rust-debugger-DA/testcases/rel4-async/temp/poll_functions.txt
   ```

9. Confirm that this repository-level file was not updated:

   ```text
   /home/user/RustDebug/rust-debugger-DA/temp/poll_functions.txt
   ```

### Trace Full Symbols

Do not trace shortened names:

```text
ardb-trace Coroutine::execute
ardb-trace async_syscall_handler
```

Use the full symbols from the generated `temp/poll_functions.txt`:

```text
ardb-trace rustlib::async_runtime::coroutine::Coroutine::execute
ardb-trace rustlib::async_runtime::async_syscall_handler::async_syscall_handler::{async_fn#0}
```

Successful trace commands should create breakpoints at real addresses, not pending breakpoints.

### Continue

Use the VS Code Continue button, or enter this GDB console command:

```text
continue
```

Do not enter:

```text
-exec continue
```

If Continue does not stop at an async breakpoint, first check:

- whether QEMU is still running;
- whether `:1234` is still listening;
- whether an old QEMU instance was reused;
- whether the PC has already reached the idle loop.

### Correct Address Examples

Known line breakpoint addresses for the current image are:

```text
Coroutine::execute:
0xffffffff84049b90

async_syscall_handler:
0xffffffff84019ebe
```

When setting manual address breakpoints, do not omit the high `84` portion.

### Snapshot And GUI Tree

After an async breakpoint is hit:

1. Click Async Inspector `Snapshot`.
2. Confirm that the snapshot `path` is not empty.
3. Confirm that the tree includes:

   ```text
   Coroutine::execute
     -> async_syscall_handler
   ```

If the snapshot contains `"path": []`, the current stopped context is not the target async context. Start a fresh QEMU run, or request the snapshot immediately when the async breakpoint is hit.

### Common Failures

1. No QEMU process is listening on `:1234`.
2. An old QEMU instance has completed the workload and entered the idle loop.
3. A shortened symbol name creates a pending breakpoint.
4. A manual address omits the high `84` portion.
5. `-exec continue` is entered instead of `continue`.
6. Snapshot is requested outside the target async stopped context, producing `"path": []`.
7. QEMU uses a CPU model other than `rvgcsu-n`.

### Quick GDB Checks

```text
info target
info breakpoints
info registers pc
x/i $pc
bt
info files
continue
```

### Verified Evidence

- With fresh QEMU, a plain GDB breakpoint hits `Coroutine::execute`.
- With fresh QEMU, a plain GDB breakpoint hits `async_syscall_handler`.
- The backtrace confirms `Coroutine::execute -> async_syscall_handler`.
- The rel4-async testcase-local whitelist generation and load path succeeds.
