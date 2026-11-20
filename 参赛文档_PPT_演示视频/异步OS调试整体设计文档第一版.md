# 异步 OS 调试 — 整体设计（第一版）

## 背景

我们这个调试器目前有两个独立工作的功能：

**异步函数追踪**（launch 模式）。在调试单个 Rust 异步程序时，通过 GDB Python 脚本在 poll 函数入口和 call 指令处自动安装断点，维护一个"协程影子栈"，追踪协程之间的调用关系。用户可以在 VS Code 的 Async Inspector 面板里看到一棵异步调用树。

**OS 特权级调试**（attach 模式）。通过 QEMU + GDB remote protocol 连接到一个运行中的操作系统，自动检测 kernel↔user 的切换，在边界处切换符号表和断点组，让用户的断点在正确的地址空间里生效。这个功能是从 code-debug 移植过来的。

问题是：这两个功能目前完全独立，**无法在一个调试会话里同时使用**。如果我想调试一个异步 OS（比如用 Rust async 写的内核组件，或者内核提供了 async syscall），我就没法在 OS 调试模式下看到异步调用树。

下面提到的python端即为异步追踪的部分，TypeScript端即为OS调试的部分。

---

## 为什么现在不兼容

主要为两个层面上的不兼容：

**第一层：事件分发层。**

由于OS调试和异步程序调试是在不同的模式下设计的，前者是attach模式，后者为launch模式，当前两个调试模式的事件分发逻辑不同，所以OS调试和异步调试没办法一起进行。

**第二层：追踪断点的存活问题。**

当特权级切换时，异步追踪中基于地址的 CallSiteBP 存储的地址不会被清除，但是这些地址的内容会发生变化。

比如在内核里有一个 call 0x80200500 指令，CallSiteBP 装在 *0x80200100。切到用户空间后，地址 0x80200100 还是那个数字，但里面装的是用户程序的代码了。这个断点如果还在，会在一个错误的指令上触发。

**要让异步追踪在 OS 调试下工作，需要解决两个问题——确保OS调试和异步调试在统一模式下能够一起工作，以及异步调试追踪断点能跟着OS调试断点组一起切换。**

---

## 核心设计思路

### 思路一：影子栈全程连续，不需要在边界插入节点

我之前考虑过在 kernel↔user 切换时往影子栈里插入一个 `type: "boundary"` 的标记节点，用来在树里表示"这里穿越了特权级边界"。

后来想了一下，没必要。因为：
- 边界信息可以通过节点自身的地址空间属性来表示（kernel 地址 vs user 地址）
- 在 UI 上用颜色或图标区分就够了
- 插一个无 CID 的边界节点反而让影子栈的管理更复杂

所以最终决定：**影子栈不区分特权级，CID 全局递增，一棵树贯穿 kernel 和 user。**

### 思路二：Python端追踪状态按断点组保存和恢复

基于不兼容的第二层，我们使用保存/恢复方案：**切走时把当前组的追踪状态存下来（包括装了哪些 PollEntryBP、扫过了哪些函数的 call sites、白名单内容等），切回来时恢复**。Python 端每次只维护当前活跃组的追踪断点。

### 思路三：切换时机由 TypeScript 端控制，Python 不自行感知

Python 可以监听 `gdb.events.new_objfile` 来检测符号表的变化，然后推断当前处于哪个特权级。但这种方式不靠谱——加载符号表的动作不一定只来自我们的切换逻辑，而且从符号表反推特权级本身就是猜。

更干净的做法是：**TypeScript 端是切换的发起者**，它在 `updateCurrentBreakpointGroup` 的前后，显式调用 Python 命令来保存和恢复追踪状态。Python 只需要提供保存和恢复的接口，不需要知道"group"是什么概念。

---

## 改动

### Python 端

新增三个 GDB 命令：

**`ardb-save-trace-state <label>`**

把当前追踪相关的状态序列化存到内存里（按 label 索引）。保存的内容包括：

- 白名单数据：`_WHITELIST_EXACT`、`_WHITELIST_PREFIX`、`_WHITELIST_ADDR_MAP`、`_WHITELIST_ADDR_READY`
- 追踪状态：`_ACTIVE_ROOTS`（哪些 poll 函数已装有 PollEntryBP）、`_CALLSITE_INSTALLED_FOR_FN`（哪些函数已扫描过 call 指令）
- 异步符号集：`_ASYNC_SYMBOL_SET`
- 所有 PollEntryBP 的元信息（location、poll_sym、internal 标志），用于恢复时重新安装

这些状态保存后，当前的追踪断点本身不删——由 TypeScript 端在切换时统一清理。

以下状态**不保存**，因为它们需要跨特权级连续：

- `_TLS_STACK`（影子栈）— kernel 里 push 的 CID 在切到 user 后还在栈上
- `_CO_BY_KEY` / `_CO_META` / `_CO_POLL_SEQ` — 全局 CID 注册表
- `_CO_NEXT_ID` — CID 自增计数器
- `_PopOnReturnBP` 实例 — 它们绑定到具体栈帧，只要帧还在就活着

**`ardb-restore-trace-state <label>`**

从 label 恢复追踪状态：

1. 恢复白名单和异步符号集
2. 在新符号表下重新构建地址映射（因为同一函数在不同符号表下的地址不同）
3. 重新安装之前保存的 PollEntryBP（在新符号表下解析函数名）
4. 恢复 `_ACTIVE_ROOTS` 和 `_CALLSITE_INSTALLED_FOR_FN`

恢复后**不重新扫描 call sites**——之前已经扫描过的函数不需要再扫。如果新地址空间下有之前没见过的 poll 调用关系，会在 PollEntryBP 命中时自然被发现和追踪。

**`ardb-reset-trace-state <label>`**

清除保存的状态，释放内存。在调试会话结束或用户手动 reset 时调用。

### TypeScript 端（gdbDebugSession.ts）

**第一个改动：确保 stopped 事件能到达 Async Inspector。**

目前的 `sendUserStoppedEvent()` 已经会发送 `StoppedEvent`（在 `handleBreakpointHit` 里或直接发送 `pause` 类型）。OS 状态机的各个 path（`check_stop_in_kernel`、`check_if_user_to_kernel_border_yet` 等）最终也会调到 `sendUserStoppedEvent`。我需要确认每条路径都不会漏掉，特别是 hook 匹配成功自动 continue 的路径（hook 不应该触发 snapshot，因为那是透明切换）。

**第二个改动：在断点组切换前后加入追踪状态切换。**

在 `doAction` 方法中，涉及断点组切换的 action 有两个：

- `high_level_switch_breakpoint_group_to_low_level` — user→kernel 切换
- `low_level_switch_breakpoint_group_to_high_level` — kernel→user 切换

这两个 action 内部调用了 `updateCurrentBreakpointGroup`。我需要在调用前加上 `ardb-save-trace-state <当前组名>`，在 `updateCurrentBreakpointGroup` 的 Promise 链（重新插入断点之后）加上 `ardb-restore-trace-state <目标组名>`。

### UI 层（Async Inspector 面板）

目前的 inspector 面板只有一个全局的白名单和 trace root 设置。改动：

- **分组展示**：面板上同时展示所有断点组的白名单和 trace root 配置，不仅展示当前 active 的组。这样即使当前停在内核态，用户也可以预先配好用户态的 trace root。
- **地址空间标识**：树节点上区分 kernel 和 user，通过颜色或图标。判断依据是节点地址落在 kernel 还是 user 的内存范围（这些范围在 launch.json 里配好）。



