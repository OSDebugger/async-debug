
## runtime_trace.py 调试操作清单

## 📌 说明

本指南用于在 VS Code + GDB 环境下调试 `runtime_trace.py`。
以启动embassy/examples/std/src/bin/tick.rs为例


## 🧩 VS Code

### 1. 打开项目

打开项目目录：

```bash
~/rust-debugger-DA
````

---

### 2. 确认 runtime_trace.py 已添加 debugpy 钩子

```python
import os
import re
import struct
import gdb
import json
import sys

if os.environ.get("ARDB_PY_DEBUG") == "1":
    preferred = os.environ.get("ARDB_DEBUGPY_PYTHON")

    if preferred and os.path.exists(preferred):
        sys.executable = preferred
    elif (not sys.executable) or (not os.path.exists(sys.executable)) or sys.executable == "/usr/bin/python":
        if os.path.exists("/usr/bin/python3"):
            sys.executable = "/usr/bin/python3"

    import debugpy
    debugpy.listen(("127.0.0.1", 5678))
    print(f"[runtime_trace] sys.executable = {sys.executable}")
    print("[runtime_trace] waiting for debugger on 5678...")
    debugpy.wait_for_client()
    print("[runtime_trace] debugger attached.")
```

---

### 3. 配置 VS Code 调试器

确保 ~/rust-debugger-DA/.vscode/launch.json 中包含：

```json
{
  "name": "Attach to GDB Python",
  "type": "python",
  "request": "attach",
  "connect": {
    "host": "127.0.0.1",
    "port": 5678
  },
  "justMyCode": false
}
```

---

### 4. 设置断点

建议打在：

* 函数入口
* 关键逻辑位置(例: _ptr_size 等)

---

## 💻 终端

### 1. 进入项目

```bash
cd ~/rust-debugger-DA
```

---

### 2. 激活虚拟环境

```bash
source .pydebug/bin/activate
```

> 📌 说明：
>
> 1.创建虚拟环境通常需要执行
>
> ```bash
> python3 -m venv .pydebug
> ```
> 2.在虚拟环境安装包
>
>```bash
> pip install debugpy
> ```

---

### 3. 启动 GDB

```bash
ARDB_PY_DEBUG=1 \
ARDB_DEBUGPY_PYTHON=$(pwd)/.pydebug/bin/python \
PYTHONPATH=$(pwd):$(pwd)/.pydebug/lib/python3.12/site-packages \
ASYNC_RUST_DEBUGGER_TEMP_DIR=$(pwd)/temp \
gdb --args ./testcases/embassy/examples/std/target/debug/tick
```

> 📌 说明：
>
> testcases/embassy/examples/std/target/debug/tick 是 Rust 项目编译生成的可执行文件，
>也就是这个指令下的产物：
> ```bash
> cargo build --bin tick
> ```
> 
---

## 🐞 GDB

### 1. 验证 Python 环境

```gdb
python import debugpy; print("debugpy ok")
python import async_rust_debugger; print("async_rust_debugger ok")
```

---

### 2. 等待调试器连接

应看到：

```
[runtime_trace] waiting for debugger on 5678...
```

---

## 🔗 回到 VS Code

### 1. 选择调试配置

选择：

```
Attach to GDB Python
```

---

### 2. 启动调试（F5）

成功后会看到：

```
[runtime_trace] debugger attached.
```

---

## 🔁 回到 GDB

执行：

```gdb
ardb-reset
ardb-load-whitelist temp/poll_functions.txt
run
```

---

## 🎯 调试

当 VS Code 命中断点时：

* 查看变量（Locals）
* 查看调用栈（Call Stack）
* 单步调试

---

## ✅ 成功标志

* VS Code 成功连接 debugpy
* 命中 `runtime_trace.py` 断点
* 可以查看变量和调用栈

