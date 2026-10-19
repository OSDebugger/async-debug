# note: when importing always starts from the package root
# example: import async_rust_debugger.module.submodule
import gdb

import async_rust_debugger.runtime_trace as rt
rt.install()

# output = gdb.execute("info functions", to_string=True)
# funcs = parse_info_functions(output)
# for f in funcs:
#     if f["return_type"] and "core::task::poll::Poll<" in f["return_type"]:
#         print("Found poll function: ", f["signature"])

# translate function signatures to future names
# look up future names in debug info via `info types``
# save to local file
# user choose futures he want to trace in the file
# read file
# set breakpoints on poll functions of chosen futures
# the breakpoints come with behaviors
# like 
#   break ...
#   commands
#   silent
#   ... do something ...
#   continue
#   end