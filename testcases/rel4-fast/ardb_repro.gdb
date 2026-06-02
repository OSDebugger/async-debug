set pagination off
set confirm off
set architecture riscv:rv64
set python print-stack full

target remote :1234

python import async_rust_debugger

ardb-reset
ardb-gen-whitelist
ardb-load-whitelist /home/user/RustDebug/rust-debugger-DA/temp/poll_functions.txt

ardb-trace 'rustlib::async_runtime::coroutine::Coroutine::execute'
break 'rustlib::async_runtime::coroutine::Coroutine::execute'

continue
