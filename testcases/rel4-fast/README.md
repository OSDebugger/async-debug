# ReL4 fast diagnostic suite

This testcase runs the ReL4 taic_test fast diagnostic suite through taic-qemu.

It uses the existing ReL4 image:

```text
/home/user/AsyncOS/rel4-manifest-workspace/rel4_kernel/build/images/sel4test-driver-image-riscv-spike
```

The current fast suite is filtered by sel4test regex and runs:

- BIND0001
- CNODEOP0001
- CNODEOP0002
- CSPACE0001
- DOMAINS0001
- IPC0001
- IPC0002

Slow tests such as IPC1001 and IPC1002 are not deleted. They are only filtered out.

## Run Fast Suite

```bash
cd /home/user/RustDebug/rust-debugger-DA/testcases/rel4-fast
./run_fast_suite.sh
```

Expected success markers:

```text
Booting all finished, dropped to user space
seL4 Test
Test suite passed. 9 tests passed. 0 tests disabled.
All is well in the universe
RESULT: SUCCESS
```

## GDB Remote Debugging

Terminal 1:

```bash
cd /home/user/RustDebug/rust-debugger-DA/testcases/rel4-fast
./start_gdb_qemu.sh
```

Terminal 2:

```bash
cd /home/user/RustDebug/rust-debugger-DA/testcases/rel4-fast
./run_gdb_ardb.sh
```

`start_gdb_qemu.sh` starts QEMU with `-S -s`, so QEMU waits for GDB on `:1234`.
`run_gdb_ardb.sh` loads `kernel.elf`, connects with `target remote :1234`, imports
`async_rust_debugger`, resets ARD state, regenerates and loads the whitelist from
`/home/user/RustDebug/rust-debugger-DA/temp/poll_functions.txt`, installs a trace
root and breakpoint on `rustlib::async_runtime::coroutine::Coroutine::execute`,
then continues execution.

The default GDB/ARD flow is:

```gdb
set architecture riscv:rv64
target remote :1234

python import async_rust_debugger

ardb-reset
ardb-gen-whitelist
ardb-load-whitelist /home/user/RustDebug/rust-debugger-DA/temp/poll_functions.txt

ardb-trace 'rustlib::async_runtime::coroutine::Coroutine::execute'
break 'rustlib::async_runtime::coroutine::Coroutine::execute'

continue
```

## Common GDB Commands

```gdb
continue
bt
info registers pc ra sp
info symbol $pc
ardb-get-snapshot
info breakpoints
disable <number>
delete <number>
```

To stop QEMU from its terminal, press `Ctrl+A` then `x`.

## Verified Breakpoints

- `init_kernel`
- `rustlib::async_runtime::coroutine::Coroutine::execute`

## Current Limits

- Related ReL4 Rust async runtime symbols appear as `Non-debugging symbols` in GDB.
- The ARD no-debug-block fallback prevents crashes when `frame.block()` is unavailable.
- A complete async tree is not available yet.
- `ardb-get-snapshot` is stable, but `path` may currently be empty.

## External Paths

See [source-map.json](source-map.json) for the QEMU, image, kernel ELF, and source root
paths used by this testcase.
