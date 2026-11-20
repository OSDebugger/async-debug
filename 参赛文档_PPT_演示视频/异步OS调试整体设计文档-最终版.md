# 异步 OS 调试——整体设计（最终版）

> 本文是《异步OS调试整体设计文档（第一版）》的最终版，记录第一版设计（2026-07）之后，在 async-os 上实际调试、修复问题的过程，以及最终采用的方案。
> 验证环境：async-os（RISC-V 64），QEMU 8.2.2，gdb-multiarch 15，调试机为 Linux 服务器。

## 一、问题与目标

调试器有两个独立的功能：

- **异步函数追踪**（launch 模式）：通过 GDB Python 脚本在 poll 函数入口自动安装断点，维护一个协程影子栈，在 Async Inspector 面板中还原出一棵异步调用树。
- **OS 特权级调试**（attach 模式）：连接 QEMU 中运行的操作系统，检测内核态与用户态的切换，在边界处切换符号表和断点组，让用户断点在正确的地址空间生效。这个功能移植自开源项目 code-debug。

两个功能不能在同一会话中使用，原因有两层：

1. 两种模式（launch / attach）的事件分发逻辑相互独立；
2. 异步追踪中基于地址的断点（CallSiteBP）在特权级切换后指向的指令内容已经变化，会在错误指令上触发。

**目标**：在一个会话里同时进行跨特权级断点调试和异步执行流还原，并在 async-os 上完成验证。

## 二、总体结构

最终方案由三层组成，全部在一个调试会话内工作：

| 层 | 组成 | 说明 |
| --- | --- | --- |
| 调试适配层 | TypeScript（gdbDebugSession.ts、breakpointGroups.ts、OSStateMachine.ts） | 断点组管理、特权级切换、DAP 事件分发 |
| 追踪层 | GDB Python 脚本（runtime_trace.py、static_analysis/） | 白名单、影子栈、快照生成 |
| 展示层 | Async Inspector 面板 | 异步树展示 |

一次"断点命中到树节点"的过程：

1. 内核态 hook 断点命中。hook 是透明断点：命中后读取当前用户程序名，确定下一个断点组，然后自动继续，用户无感知；
2. 用户态断点命中，系统暂停；
3. TypeScript 端切换断点组：保存旧组的追踪状态 → 切换符号文件 → 重插断点 → 恢复新组追踪状态 → 重新生成白名单 → 为用户态 crate 安装 poll 追踪断点；
4. 停止事件触发快照：Python 端用当前线程的影子栈，加上物理栈回退，生成异步链并写入快照文件；
5. 面板读取快照，按协程实例累积渲染异步树。

## 三、第一版的设计思路及后续调整

第一版设计有三条思路。落地过程中三条思路都保留了下来，另外解决了一些第一版没有考虑到的问题：

| 思路 | 内容 | 调整情况 |
| --- | --- | --- |
| 一 | 影子栈全程连续，不在特权级边界插入标记节点 | 保留。边界信息由节点地址空间属性表达，UI 用颜色区分内核态/用户态 |
| 二 | 追踪状态按断点组保存/恢复 | 保留并实现（ardb-save-trace-state / ardb-restore-trace-state） |
| 三 | 切换时机由 TypeScript 端控制，Python 不自行感知 | 保留。Python 只提供保存/恢复接口，不知道"组"的概念 |

第一版设计在 async-os 上落地时，先后遇到六类问题。下面第四节记录这些问题和修复过程，第五节说明最终采用的核心机制。

## 四、开发过程中的问题与修复

### 4.1 问题列表

| # | 问题 | 原因 | 修复 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | 用户态断点不命中 | 用户程序是动态链接 PIE，被 ld-musl 重映射 | 静态化编译 + 按 ELF 类型加载符号 | hello_world::main 断点命中 |
| 2 | pipetest 断点不命中 | O3 优化丢掉了 DWARF 行表，产生 pending 断点 | 用户程序改 O0 + 检测 pending 断点 | 行 8/9/10/11 全部解析 |
| 3 | hook 断点重复插入 | 组切换时既删又插，删除失败被吞掉 | hook 改为全局内核态断点，只插一次 | 重复断点消失 |
| 4 | 异步树为空 | 七个子问题，见 4.2 | 见 4.2 | pipetest 协程链完整显示 |
| 5 | reset 不清理产物 | 没有实现清理 | 删除 5 个产物文件 | 重复调试无残留 |
| 6 | 调用堆栈面板内容混乱 | 逻辑链和物理栈混在一起 | 堆栈面板只显示物理栈，逻辑链只在 Inspector | 面板内容不再混淆 |

### 4.2 问题四的七个子问题

| 子问题 | 现象 | 原因 | 修复 |
| --- | --- | --- | --- |
| 4.1 | 白名单 327 个符号全是内核 crate | 白名单在内核态生成，用户 ELF 没加载 | 切组加载用户符号后自动重新生成白名单 |
| 4.2 | 用户 crate 名被提取成返回类型 | `set language c` 污染符号渲染 | 生成白名单前执行 `set language auto` |
| 4.3 | 用户态 async 符号没有追踪 | 白名单恢复后没装用户 poll 断点 | 新增 ardb-trace-user-crate 命令自动安装 |
| 4.4 | 停在 poll 之前时树为空 | 影子栈为空时直接返回空链 | 物理栈回退：空栈时遍历物理栈逐帧分类 |
| 4.5 | 面板丢掉全 null 链 | 选根规则要求 cid 非空 | 加瞬态链（key=-1），每次停止替换 |
| 4.6 | 断点命中但 UI 不变红 | multi-location 断点 line 为 NaN | line 回退到 locations[0].line，再回退请求行 |
| 4.7 | async 帧环境指针读不到 | musl 无展开表 + 内核 release 构建 | 编译选项限制，候选方案见第六节 |

### 4.3 问题一的排查过程

问题一说明了一个经验：符号表视角下的"交叉验证"不够，要验证运行时实际状态。当时断点地址在符号表视角下是自洽的（`info line` 和 decodedline 一致），但断点从不命中。最终在 `user_return`（sret 之前）设内核断点，读取 TrapFrame 的 sepc 字段：

```
TrapFrame sepc = 0x4065b08   ← 用户态实际执行地址
断点假设地址  = 0x40008e0a   ← 按 textAddr=0x4000000 计算，从未执行
```

原因：hello_world 是 musl 动态链接 PIE。async-os 的 loader 看到 PT_INTERP 后把 ld-musl 当主程序加载到 0x4000000，hello_world 的代码段由 ld-musl 在运行时映射到其他地址。调试器按 0x4000000 加载符号，断点地址全部错误。

### 4.4 调试中总结的经验

1. "交叉验证"要验证运行时真相：`info line` / decodedline 只是符号视角自洽，关键证据是 TrapFrame sepc；
2. 本地复现不等于现场复现：`set language c` 污染问题本地复现不出，用户现场日志才暴露；
3. 用时间戳断案：文件 mtime 对比会话日志时间；
4. 同地址多断点：GDB 同地址的 Python 断点 stop() 都会被调用（隔离实验验证过）；
5. multi-location 断点：同一行多个地址语义不同（poll 入口 / poll 体内 / 包装壳）。

## 五、最终方案的核心机制

### 5.1 断点组切换流程（breakpointGroups.ts）

`updateCurrentBreakpointGroup` 的流程共七步：

1. 保存追踪状态：`ardb-save-trace-state <旧组>`（失败不影响切换）；
2. 清理旧组：删除旧组用户断点和函数名 border 断点。hook 断点不删不插——hook 在内核态函数上，全局唯一，只在 debug-ready 时插入一次；
3. 切换符号文件：只卸载经 addSymbolFile 加载的文件；主内核 ELF（file-exec-and-symbols 加载）永不卸载；新组文件按 ELF e_type 加载——ET_EXEC 不带地址，ET_DYN 带 textAddr 基址（mi2.ts:828）；
4. 重插断点：新组用户断点 + 函数名 border 断点；
5. 恢复追踪状态：`ardb-restore-trace-state <新组>`；如果加载了新符号文件，依次执行 `ardb-gen-whitelist` → `ardb-update-whitelist` → `ardb-load-whitelist` → `ardb-trace-user-crate <新组>`；
6. 通知 UI 断点恢复；
7. 继续执行（透明切换时）。

### 5.2 白名单

白名单是可追踪函数的列表（async poll 函数 + 同步辅助函数），由符号表分析生成（static_analysis/gen_whitelist.py），存到 `temp/poll_functions.txt`，支持 `*` 后缀前缀匹配。用户勾选启用的 crate。内核态生成的白名单缺用户符号，所以切组加载用户符号后会自动重新生成并合并（问题 4.1 的修复）。

### 5.3 影子栈与协程实例识别

- 协程实例用 `(poll 符号, this 指针)` 识别（runtime_trace.py `_CO_BY_KEY`），同一函数的多个实例各占一个 cid；
- 影子栈按 GDB 线程号分栈（`_TLS_STACK`），每个 CPU 各记各的协程嵌套关系；
- cid 全局递增，一棵树贯穿内核态和用户态（第一版思路一）。

### 5.4 快照与物理栈回退

`ardb-get-snapshot` 生成当前线程的异步链：

1. 有影子栈时：取影子栈的协程链，末尾追加物理栈分类帧；
2. 影子栈为空时（停在同步代码或 poll 之前）：遍历物理栈（最多 40 帧），逐帧分成 async/sync 构建链；
3. 全 null cid 的链作为瞬态链返回（key=-1），面板每次停止替换，不和按 cid 累积的协程树混在一起。

### 5.5 用户程序静态化

用户程序统一用 `-C target-feature=+crt-static` 静态编译（ET_EXEC、无解释器），避免动态链接重映射导致的断点地址错误；用 O0 + debug 编译，保留完整行表。调试器侧 addSymbolFile 按 e_type 区分加载方式，并检测 pending 断点，防止未解析断点被标绿。

## 六、验证结果与已知限制

### 6.1 验证结果

- hello_world 和 pipetest 全链路验证通过：hook 识别组 → 组切换 → 用户断点命中 → 异步链快照 → 面板显示；
- 调用堆栈面板显示 GDB 物理栈，逻辑链只在 Async Inspector 展示；
- 测试：12 个测试文件（11 个 TypeScript + 1 个 Python），429 条 TypeScript 断言，覆盖状态机、断点组、trace-state 保存/恢复等。

### 6.2 已知限制

1. **async 帧环境指针读不到（问题 4.7）**：musl 工具链 `-fno-unwind-tables` 和内核 release 构建导致中间帧没有可靠的 CFA，GDB 启发式展开的帧寄存器不可靠，async 帧 cid=null、state=N/A。候选方案：伪 cid（帧地址派生，state=N/A），或改编译选项（`-C force-unwind-tables=yes`，需要改内核构建配置，成本高）（未定）。
2. **跨特权级栈分离**：停在用户态断点时 GDB 展开的是用户栈，内核帧在内核栈上，不参与展开。想让树同时包含内核和用户协程，需要追踪内核 async 锚点（如 `trampoline::task_api::user_task_top`，它的 poll 驱动用户任务、等用户任务完成才返回，和用户态 poll 同时在栈上）（待验证）。
3. **单核假设**：断点组和状态机是全局单例。pipetest 场景是单 CPU（QEMU `-smp 1`），多 CPU 并发跨特权级时断点组语义会失效。影子栈按线程分栈，多核不串线，但快照只有一条链，组切换需要按 CPU 分开。
4. **QEMU 无断点读盘卡顿**：TCG 无断点时 TB chaining 延迟中断检查。调试场景一直挂着 hook/border 断点，不受影响。
