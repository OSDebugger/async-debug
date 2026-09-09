# ARD — Async Rust Debugger

> 面向 Rust 异步程序与操作系统调试的 VS Code 源代码级调试器扩展  
> Branch: `async-integration`

ARD（Async Rust Debugger）是在 GDB / GDB-MI 基础上构建的 Rust 异步调试工具，目标是同时解决两类问题：

- **传统调用栈无法表达 Rust async/await 的逻辑等待关系**
- **操作系统调试中内核态 / 用户态之间的符号表、断点组与执行状态切换复杂**

当前仓库将异步执行流分析、Async Inspector 图形化展示以及 OS 调试能力整合到同一个 VS Code Debug Adapter 中。

---

## 1. 项目目标

Rust `async/await` 会被编译器转换为状态机。程序运行时，Future 通过 `poll` 被反复驱动，因此 GDB 的物理调用栈通常只能看到某一次 `poll` 的局部执行现场，而不能直接回答：

- 当前 Future 正在等待哪个 Future？
- 一条异步执行链是如何跨多个 poll 周期形成的？
- 当前观察到的关系是真实的 await 关系，还是仅仅来自时间邻近或普通调用？
- 在调试暂停时，历史上成立的异步关系是否仍然代表“当前状态”？
- 当调试对象跨线程、跨地址空间甚至跨特权级运行时，如何保持调试状态的一致性？

ARD 试图在**源码、调试信息与真实运行时事件**之间建立一条可验证的调试链路，把传统物理调用栈扩展为更接近开发者思维方式的异步逻辑执行视图。

---

## 2. 核心能力

### 2.1 Rust 异步执行流恢复

ARD 基于编译器生成的调试信息与真实 `poll` 事件分析异步状态机，并同时维护两类关系：

- **await edge**：表示逻辑等待关系，例如 `Future A -> Future B`
- **call edge**：表示本次真实运行中发生的调用推进关系

通过二者结合，可以避免仅依赖物理调用栈理解异步程序。

### 2.2 Async Inspector

仓库内置 VS Code `Async Inspector` 面板，将异步执行拓扑以树形方式展示。

主要能力包括：

- async / sync 节点区分
- 协程 ID
- poll 次数
- 当前运行状态
- await edge / call edge 展示
- 点击节点跳转源码
- Trace 控制
- Whitelist 生成、编辑与应用
- History / Snapshot 调试视图

Async Inspector 与 VS Code 原生 Call Stack 并存：

```text
VS Code Call Stack
    ↓
物理调用栈 / 断点 / 单步 / 变量

Async Inspector
    ↓
异步逻辑关系 / poll / wait / history
```

因此调试时可以同时观察“CPU 当前执行在哪里”和“异步逻辑上为什么会执行到这里”。

---

## 3. 异步关系验证

单纯看到两个 Future 先后被 `poll`，并不足以证明它们之间存在真实的 await 关系。

ARD 当前的运行时关系恢复流程会综合使用：

```text
Parent Future 当前状态
        +
Parent 当前等待对象
        +
Child 实际 poll 事件
        +
Future 实例 / 类型 / 地址等运行时信息
        ↓
Candidate Relation
        ↓
Runtime Relation Validation
        ↓
Validated Await Relation
```

只有能够被运行时证据支持的关系才进入已验证关系集合。

设计原则是：

> **有证据才建立关系；证据不足时保留 Unknown，而不是猜测。**

---

## 4. Current Snapshot 与 History

异步调试中一个容易被忽略的问题是：

> 一条关系过去真实成立，并不代表它在当前暂停时仍然成立。

因此 ARD 将两种语义分开：

### History

记录运行过程中曾经真实发生过的异步关系与执行事件，用于回答：

> 程序是如何运行到这里的？

### Snapshot

只描述当前调试暂停时仍能够被运行时状态支持的关系，用于回答：

> 程序现在正在等待谁？

这使得历史执行轨迹和当前执行状态不会被混为一谈。

---

## 5. OS 调试能力

ARD 同时包含从前序 OS debugger 工作迁移而来的操作系统调试能力。

主要包括：

- OSStateMachine
- Kernel / User breakpoint group
- kernel ↔ user 边界断点
- Hook breakpoint
- 动态进程断点组
- Debug symbol 自动切换
- RISC-V remote debugging
- QEMU attach
- GDB remote target attach

针对组件化 OS，还支持：

### 函数名边界断点

不再只依赖：

```text
filepath + line
```

也可以直接通过：

```text
function
```

定位位于外部 crate 中的特权级切换函数。

### 方向属性

边界断点可以显式声明：

```text
kernel_to_user
user_to_kernel
```

解决两个方向的切换点同时位于内核地址空间时的歧义。

### 动态断点组注入

新创建的用户进程组可以自动继承 user → kernel 边界断点，避免动态进程出现后调试链断裂。

---

## 6. 调试架构

```text
┌─────────────────────────────┐
│          VS Code            │
│                             │
│  Call Stack   Async Inspector
└──────────────┬──────────────┘
               │ DAP
               ▼
┌─────────────────────────────┐
│       GDBDebugSession       │
│                             │
│  Async Trace / OS State     │
└──────────────┬──────────────┘
               │ GDB/MI2
               ▼
┌─────────────────────────────┐
│             GDB             │
│                             │
│ Python Runtime Trace Logic  │
└──────────────┬──────────────┘
               │
       ┌───────┴────────┐
       │                │
       ▼                ▼
     QEMU          OpenOCD / GDB Server
       │                │
       ▼                ▼
 Rust Program       Real Hardware / OS
```

---

## 7. 当前验证平台

| 平台 / 场景 | 状态 | 说明 |
|---|---|---|
| Native Rust async | ✅ | 用于异步关系、poll 与并发场景验证 |
| Embassy | ✅ | 验证异步追踪不依赖 Tokio 等特定运行时 |
| rCore / OSStateMachine | ✅ | 内核态 / 用户态切换基础能力 |
| StarryOS / QEMU | ✅ | 组件化 OS 调试流程 |
| ReL4 async | ✅ / 持续验证 | 已验证真实 async syscall / coroutine 路径 |
| K3 COM260 + StarryOS | 🚧 | 真板底层 GDB / OpenOCD / JTAG 链路已验证，ARD 集成持续推进 |

---

## 8. K3 COM260 真板调试链

当前项目已经将研究范围从 QEMU 扩展到真实 RISC-V SoC。

真板基础链路：

```text
ARD
 ↓
GDB / GDB-MI
 ↓
OpenOCD
 ↓
J-Link
 ↓
K3 JTAG
 ↓
RISC-V Debug Module
 ↓
StarryOS
```

K3 + StarryOS 基础调试已经验证：

- Host-DWARF ELF
- GDB remote connection
- PC → Rust source mapping
- Rust source breakpoint
- source-level `next`
- OpenOCD + J-Link + K3 JTAG
- StarryOS 真板启动

这部分工作用于进一步验证 ARD 在真实操作系统与真实硬件调试场景中的适用性。

---

## 9. 仓库结构

```text
async-debug/
├── async_rust_debugger/      # GDB Python：async runtime tracing
├── src/
│   ├── extension.ts          # VS Code extension entry
│   ├── debugAdapter.ts       # Debug Adapter factory
│   ├── gdbDebugSession.ts    # DAP / GDB session
│   ├── backend/
│   │   └── mi2.ts            # GDB/MI2 backend
│   └── ...                   # Async Inspector / source resolver / OS debug
├── testcases/                # Rust async / Embassy / OS test cases
├── docs/                     # Project documentation
├── .vscode/                  # Development / debugging configurations
├── package.json
└── README.md
```

---

## 10. 开发环境

建议环境：

```text
VS Code >= 1.80
Node.js / npm
TypeScript
GDB / gdb-multiarch / target-specific GDB
Python 3
Rust toolchain
```

OS 调试场景还可能需要：

```text
QEMU
OpenOCD
J-Link
Cross toolchain
```

具体取决于被调试目标。

---

## 11. 构建

Clone：

```bash
git clone https://github.com/OSDebugger/async-debug.git
cd async-debug
git checkout async-integration
```

安装依赖：

```bash
npm install
```

编译 VS Code 扩展：

```bash
npm run compile
```

开发过程中持续编译：

```bash
npm run watch
```

然后使用 VS Code 打开仓库，按 `F5` 启动 **Extension Development Host**。

---

## 12. 基础 Launch 配置

ARD 注册的 debugger type 为：

```json
"type": "ardb"
```

普通 Rust 程序可以使用 launch 模式：

```json
{
  "type": "ardb",
  "request": "launch",
  "name": "Launch Rust Program",
  "program": "${workspaceFolder}/target/debug/app",
  "cwd": "${workspaceFolder}"
}
```

Remote / OS 场景可以使用 attach 模式：

```json
{
  "type": "ardb",
  "request": "attach",
  "name": "ARD Remote Debug",
  "cwd": "${workspaceFolder}",
  "target": ":1234",
  "gdbpath": "gdb-multiarch",
  "executable": "${workspaceFolder}/kernel.elf",
  "qemuPath": "qemu-system-riscv64",
  "qemuArgs": [],
  "stopAtConnect": true,
  "program_counter_id": 32,
  "first_breakpoint_group": "kernel"
}
```

不同 OS / 开发板需要根据实际 ELF、GDB Server、地址空间和边界断点进行配置。

---

## 13. Async Inspector 使用思路

典型流程：

```text
启动 ARD Debug Session
        ↓
Open Async Inspector
        ↓
生成 / 配置 whitelist
        ↓
Apply Whitelist
        ↓
启用 Trace
        ↓
程序继续运行
        ↓
断点 / pause
        ↓
查看 Current Snapshot
        ↓
查看 History
```

其中：

- **Snapshot**：当前暂停时的异步状态
- **History**：运行过程中累积的执行历史
- **Clear History**：清空历史观察数据
- **Whitelist**：限制需要追踪的目标，避免无关 Future / poll 造成过高调试开销

---

## 14. 设计原则

### Runtime evidence first

运行时真实事实优先于仅通过静态结构推断关系。

### Conservative debugging

无法确认的关系宁可显示 Unknown，也不构造未经证实的逻辑关系。

### Physical + Logical

不替代 GDB 原生调用栈，而是在其基础上补充 async logical execution view。

### Runtime-independent

尽量依赖 Rust 编译结果、DWARF、符号与真实执行事件，而不是绑定 Tokio 等特定异步运行时内部实现。

### OS-independent direction

OS 调试能力尽量从具体 OS 路径中抽象出通用边界、方向、符号和断点管理机制。

---

## 15. 项目演进

```text
2023–2024
code-debug
│
├─ VS Code Debug Adapter
├─ OSStateMachine
└─ breakpoint groups
        ↓
2025
ARDB prototype
│
├─ Future / poll analysis
├─ await edge
├─ call edge
└─ logical async trace
        ↓
2026
async-integration
│
├─ Async Inspector
├─ Snapshot / History
├─ runtime relation validation
├─ OS debugger integration
├─ Embassy / ReL4
├─ StarryOS
└─ K3 real-hardware debugging
```

---

## 16. 前序工作

本项目建立在多个阶段的持续开发基础上：

- 2023–2024：`code-debug`，建立 VS Code OS debugger 与四状态机断点组管理
- 2025：ARDB，研究 Rust async 的 await edge / call edge 双关系恢复
- 2026：`async-integration`，将异步调试、图形化 Inspector、OS 调试与真实硬件验证整合到统一平台

相关仓库：

- code-debug  
  https://github.com/chenzhiy2001/code-debug

- 2025 Async Trace  
  https://github.com/OSDebugger/code-debug_Asynchronous-trace

---

## 17. 相关项目

- StarryOS  
  https://github.com/Starry-OS/StarryOS

- rCore-Tutorial-v3  
  https://github.com/rcore-os/rCore-Tutorial-v3

- Embassy  
  https://github.com/embassy-rs/embassy

- ReL4  
  https://github.com/rel4team2/rel4_kernel

---

## 18. 文档与开发日志

阶段性开发记录：

- ARD / K3 Development Logs  
  https://osdebugger.github.io/k3gdb/

仓库中的更多技术说明请参考：

```text
docs/
```

---

## 19. Project Status

当前仓库处于持续开发与实验验证阶段。

现阶段重点：

- Rust async relation correctness
- Current / History execution semantics
- OSStateMachine regression validation
- ReL4 async debugging
- StarryOS integration
- K3 COM260 real-hardware debugging
- RISC-V / cross-privilege debugging

部分能力依赖目标程序保留足够的 DWARF / debug information；Release 优化可能导致 async state machine 内部字段被优化掉，从而降低可观测性。

---

## 20. License

本项目遵循仓库中的 [LICENSE](./LICENSE)。

---

## Citation / Acknowledgement

如果本项目对你的研究、教学或调试工作有帮助，欢迎引用或在项目中注明来源。

ARD 仍处于持续研究与开发阶段，欢迎通过 Issues / Discussions 交流 Rust async debugging、OS debugging、RISC-V debugging 与真实硬件调试相关问题。
