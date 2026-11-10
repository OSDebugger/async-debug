# 符号常驻 + 按程序断点插拔 + 多核并行调试 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 符号加载/卸载归零、断点按程序插拔（stop 侧程序门控兜底）、跟踪状态按程序常驻，支持单线程/并发/并行三场景。

**Architecture:** 符号文件一次加载永不卸载；Python 侧状态改为"每程序独立桶 + O(1) 上下文切换"（全局引用重绑定，不序列化）；断点带程序归属，stop 回调按命中 vCPU 的当前程序门控；影子栈按 (程序, task) 键；TS 侧活跃集合做差异插拔（Z0/z0）。

**Tech Stack:** TypeScript（VS Code 扩展 + MI2）、Python 3（GDB 内，无新依赖）、测试在真实 GDB 内执行（调试机）与 TS mock 测试（既有 test_whitelist_skip_chain.ts 模式）。

**Spec:** `docs/superpowers/specs/2026-10-20-symbol-resident-multicore-design.md`

## Global Constraints

- 状态切换必须 O(1)：程序上下文切换 = 全局引用重绑定到该程序的桶，禁止序列化/重建
- 门控判断最小化 GDB 查询：每次停止对每个 vCPU 至多读一次程序身份，禁止每断点重复读
- 错记 0 次：门控是正确性保证（错记比漏记严重得多；漏记允许有界）
- 断点插拔只做差异集合（新活跃 − 旧活跃 插入；旧活跃 − 新活跃 移除），禁止全删全插
- 内核断点常驻（高/低半区天然隔离）；内核断点命中时不做程序门控（任何上下文命中都记录）
- 上一轮建成物不得回退：白名单跳过逻辑（TS）、地址表锚点复用、grouped JSON 缓存、RISC-V jalr 解析
- 提交信息用中文、不加任何署名行；测试在调试机 GDB 15（riscv64-unknown-elf-gdb）与系统 gdb 上跑

## Review Focus

| # | 输入/条件 | 期望行为 | 归属任务 |
|---|---|---|---|
| 1 | 两个程序同时活跃，A 的断点被 B 的同 VA 执行触发（交叉命中） | stop 门控判定程序不匹配 → 静默 continue，零错记 | Task 4 |
| 2 | 程序切换点之间被调度上 vCPU（断点未插入的时间窗） | 命中漏记有界、不误记、不崩溃 | Task 5 设计 + Task 7 实测 |
| 3 | 任务跨核迁移后的连续 poll | 影子栈按 (程序, task) 键，调用链不中断 | Task 3 + Task 6 实测 |
| 4 | 两个程序的同名符号、同值 this_ptr 同时存在 | 每程序独立桶，互不污染 | Task 2 |
| 5 | 旧格式 saved state（上一轮序列化产物） | 状态桶迁移路径存在，旧状态不崩溃（可丢弃重建） | Task 2 |
| 6 | 内核断点命中（任何程序上下文） | 不做门控、照常记录 | Task 4 |

---

## 文件结构

| 文件 | 改动 | 职责 |
|---|---|---|
| `async_rust_debugger/runtime_trace.py` | Modify | 状态桶 + 上下文切换、程序/任务身份读取、断点归属与门控、ardb-get-vcpu-programs 命令 |
| `src/breakpointGroups.ts` | Modify | 去符号装卸、活跃集合并集差异插拔、per-vCPU 程序扫描接线 |
| `src/gdbDebugSession.ts` | Modify | 状态清理联动（reset 时清状态桶） |
| `src/test/test_program_state_buckets.py` | Create | Task 2/4 的 GDB 内测试 |
| `src/test/test_breakpoint_gating.py` | Create | Task 4 的 GDB 内测试（并入上者亦可） |
| `src/test/test_active_set_diff.ts` | Create | Task 5 的 TS mock 测试 |

---

### Task 1: 符号常驻化（TS）

**Files:**
- Modify: `src/breakpointGroups.ts`（符号装卸步骤删除，保留首次按需加载）
- Test: `src/test/test_symbol_resident.ts`（Create，仿 test_whitelist_skip_chain.ts 的 mock 模式）

**Interfaces:**
- Consumes: 现有 `loadedSymbolFiles: Set<string>` 与 `filesToAdd/filesToRemove` 计算逻辑
- Produces: 行为契约——`removeSymbolFile` 在会话内**永不被调用**；每个文件 `addSymbolFile` 至多一次（首次需要时）；组切换流程不再包含符号步骤

- [ ] **Step 1: 写测试** `src/test/test_symbol_resident.ts`

```typescript
// MockBackend 记录 removeSymbolFile 调用；makeSession 同 test_whitelist_skip_chain.ts
// 测试 1: testNoSymbolRemoveEver——连续三次 updateCurrentBreakpointGroup('user')/('kernel')
//         后 assert(backend.removedSymbolFiles.length === 0)
// 测试 2: testAddSymbolFileAtMostOnce——三次切回 'user' 后
//         assert(backend.addedSymbolFiles.filter(f => f === 'user.elf').length === 1)
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run compile && node out/test/test_symbol_resident.js`
Expected: FAIL（当前实现每次切换 remove/add）

- [ ] **Step 3: 实现**（`breakpointGroups.ts`）

删除组切换流程中的符号装卸两段（filesToRemove 的 removeSymbolFile 链、filesToAdd 的 addSymbolFile 链），保留 `filesToAdd` 的计算用于**首次加载**：仅对 `!this.loadedSymbolFiles.has(path)` 的文件执行 addSymbolFile 并加入集合。`loadedSymbolFiles` 只增不减。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2
Expected: PASS；同时 `node out/test/test_whitelist_skip_chain.js`、`node out/test/test_breakpointGroups_comprehensive.js` 全绿（后者需适配：旧断言"removeSymbolFile called"改为"never called"——若该文件有此类断言，同步修改并 ledger 记录）

- [ ] **Step 5: Commit**

```bash
git add src/breakpointGroups.ts src/test/test_symbol_resident.ts
git commit -m "feat：符号文件常驻，切换不再装卸"
```

---

### Task 2: 每程序状态桶与 O(1) 上下文切换（Python）

**Files:**
- Modify: `async_rust_debugger/runtime_trace.py`（新增状态桶与切换函数；save/restore 改造为桶迁移的兼容层）
- Test: `src/test/test_program_state_buckets.py`

**Interfaces:**
- Consumes: 现有全局状态变量清单（`_WHITELIST_EXACT/_WHITELIST_PREFIX/_WHITELIST_ADDR_MAP/_WHITELIST_ADDR_READY/_WHITELIST_ADDR_OBJFILES/_ASYNC_SYMBOL_SET/_CALLSITE_INSTALLED_FOR_FN/_CALLSITE_ADDRS_BY_FN/_ACTIVE_ROOTS/_CO_BY_KEY/_CO_META/_CO_POLL_SEQ/_TLS_STACK/_CO_NEXT_ID`）
- Produces:
  - `runtime_trace._PROGRAM_STATES: dict[str, dict]` — 程序名 → 状态桶（桶字段 = 上述全局变量名）
  - `runtime_trace._activate_program(name: str) -> None` — 把当前全局状态存回旧程序桶，把目标程序桶（不存在则新建空桶）加载进全局变量；O(1) 引用重绑定，无序列化
  - `runtime_trace._active_program: str | None` — 当前已激活的程序名
  - 兼容层：`ARDSaveTraceStateCommand/ARDRestoreTraceStateCommand` 改为桶的显式存取（保持命令可用，语义 = 桶快照），旧序列化格式读取失败时静默重建空桶

- [ ] **Step 1: 写测试**（GDB 内，覆盖 Review Focus #4/#5）

```python
def test_activate_swaps_state_between_programs():
    # 激活 "prog_a"：设 _WHITELIST_EXACT={"a::f"}、_CO_BY_KEY 一条
    # _activate_program("prog_b")：断言全局变空桶、_PROGRAM_STATES["prog_a"] 保留原值
    # _activate_program("prog_a")：断言全局恢复 a 的值（含 _CO_BY_KEY、_TLS_STACK 键值）
    # 两次往返后 _PROGRAM_STATES 只有 2 个桶，无序列化字符串参与

def test_activate_fresh_program_gets_empty_bucket():
    # _activate_program("new_prog") → 全局均为空/默认值，桶已建

def test_legacy_saved_state_migrates_or_rebuilds():
    # 手工构造旧格式 _SAVED_STATES（无桶结构）→ ardb-restore-trace-state 不崩溃，
    # 且状态被迁移进 _PROGRAM_STATES 或安全重建
```

- [ ] **Step 2: 运行确认失败**

Run: 调试机 `gdb -batch -ex "python import sys; sys.path.insert(0, '<repo>')" -ex 'source async_rust_debugger/__init__.py' testcases/minimal/target/debug/minimal -ex 'source src/test/test_program_state_buckets.py'`
Expected: FAIL（`_PROGRAM_STATES` 不存在）

- [ ] **Step 3: 实现**

`_activate_program` 的实现要点：用一个模块级 dict `_BUCKET_FIELDS = ("whitelist_exact", ...)` 循环存取，避免逐字段手写两遍（算法选择：字段清单驱动，新增状态字段只需改清单）；`ardb-reset` 清空 `_PROGRAM_STATES`。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2
Expected: PASS

- [ ] **Step 5: 回归（上一轮测试不得破坏）**

Run: 调试机依次跑 test_trace_state_save_restore / test_whitelist_cache / test_addr_map_reuse / test_callsite_restore / test_callsite_filter
Expected: 全部通过（save/restore 兼容层生效）

- [ ] **Step 6: Commit**

```bash
git add async_rust_debugger/runtime_trace.py src/test/test_program_state_buckets.py
git commit -m "feat：跟踪状态按程序分桶，O(1) 上下文切换"
```

---

### Task 3: 程序身份与任务判定（Python）

**Files:**
- Modify: `async_rust_debugger/runtime_trace.py`
- Test: 真机验证（本任务逻辑依赖 async-os 布局，无法离线单测；纯逻辑部分可测）

**Interfaces:**
- Consumes: Task 2 的 `_activate_program`/`_PROGRAM_STATES`
- Produces:
  - `runtime_trace._hit_vcpu_program(tid: int) -> str` — 读指定 GDB 线程（vCPU）的 PC：高半区或 S 态 → `"kernel"`；低半区 U 态 → 读任务结构得用户程序名（去前导 `/`）
  - `runtime_trace._current_task_id() -> str` — 当前命中 vCPU 的任务标识（影子栈键用）
  - `runtime_trace._ensure_active_program() -> None` — 判定当前命中 vCPU 的程序并 `_activate_program`（幂等：已激活同程序则跳过——O(1) 早退是命中路径的关键开销优化）
  - 任务结构读取布局：async-os 的 per-CPU 当前任务指针（内核：`__PERCPU_CURRENT_TASK_PTR` 基址取 `gp`；用户：经 `sscratch`→TrapFrame.gp）——**从现有 hook 断点配置中移植该读取逻辑**（async-os 工作区的 launch.json hook 命令即现成参考），移植后 hook 与调试器共用同一函数

- [ ] **Step 1: 读现有 hook 读取逻辑并移植**

读 async-os 工作区 launch.json 的 hook 命令（服务器 `/home/iristseng/data/async-os-original/.vscode/launch.json` 或调试器仓库内的 hook 配置），提取"读当前任务/程序名"的 GDB 表达式，封装为上述函数。

- [ ] **Step 2: 真机验证（单 vCPU）**

Run: 调试机以 ardb 调试 async-os（实验 B 流程）
Expected: `ardb-diag` 增强输出（本任务加）显示每次停止时判定的程序名与任务 ID；hello_world 段全部为 hello_world、pipetest 段全部为 pipetest、内核段为 kernel；无 Python 异常

- [ ] **Step 3: 纯逻辑部分测试**（GDB 内，`test_program_state_buckets.py` 追加）

```python
def test_program_name_normalization():
    # _normalize_program_name("/pipetest") == "pipetest"、("kernel") == "kernel"
```

- [ ] **Step 4: Commit**

```bash
git add async_rust_debugger/runtime_trace.py src/test/test_program_state_buckets.py
git commit -m "feat：按 vCPU 判定当前程序与任务身份"
```

---

### Task 4: 断点程序归属与 stop 门控（Python）

**Files:**
- Modify: `async_rust_debugger/runtime_trace.py`（PollEntryBP/CallSiteBP 构造加 `program` 参数；stop 开头接 `_ensure_active_program` + 门控）
- Test: `src/test/test_breakpoint_gating.py`

**Interfaces:**
- Consumes: Task 3 的 `_hit_vcpu_program`/`_ensure_active_program`
- Produces:
  - `PollEntryBP(location, poll_sym, internal, temporary, program: str = "")` — 新增可选参数；为空 = 内核断点（不门控）
  - `CallSiteBP(addr, program: str = "")` — 同上
  - 门控逻辑（stop 回调首段）：`_ensure_active_program()` → `bp.program` 非空且 ≠ `_active_program` → `return False`
  - `_ACTIVE_ROOTS` 等状态经 `_activate_program` 已指向当前程序桶（Task 2 完成后自然成立）

- [ ] **Step 1: 写测试**（GDB 内，覆盖 Review Focus #1/#6）

```python
def test_gate_blocks_cross_program_hit():
    # 注入 _PROGRAM_STATES 两桶；激活 prog_a；
    # 构造 PollEntryBP(..., program="prog_b")，调用其 stop()（内部 first-line 门控）
    # 断言返回 False 且 _CO_BY_KEY 无新条目（零错记）

def test_kernel_breakpoint_not_gated():
    # PollEntryBP(..., program="") 的 stop() 在 prog_a 激活时照常记录（返回 False 但
    # 协程状态推进——注意 stop 返回值语义：False=不停止执行；断言记录副作用发生）

def test_gate_matches_program_records():
    # program="prog_a" 的断点在 prog_a 激活时正常记录
```

（stop() 内部依赖真实寄存器/内存读取的路径用注入的假状态覆盖；`_hit_vcpu_program` 在测试中 monkeypatch 为固定值——测试文件内做 monkeypatch，不动生产代码。）

- [ ] **Step 2: 运行确认失败**

Run: 调试机 `gdb -batch ... -ex 'source src/test/test_breakpoint_gating.py'`（带 minimal 二进制）
Expected: FAIL（`program` 参数不存在）

- [ ] **Step 3: 实现**

所有 PollEntryBP/CallSiteBP 构造点（`ardb-trace`、`ardb-trace-user-crate`、awaitee 自动追踪、callsite 安装/重装、restore 重装）补传 `program`；callsite 安装路径用当前 `_active_program` 作为归属。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add async_rust_debugger/runtime_trace.py src/test/test_breakpoint_gating.py
git commit -m "feat：断点按程序归属，stop 门控零错记"
```

---

### Task 5: 活跃集合并集差异插拔（TS + Python）

**Files:**
- Modify: `async_rust_debugger/runtime_trace.py`（新命令 `ardb-get-vcpu-programs`）
- Modify: `src/breakpointGroups.ts`（组切换改为：per-vCPU 程序扫描 → 活跃并集 → 差异插拔）
- Test: `src/test/test_active_set_diff.ts`

**Interfaces:**
- Consumes: Task 3 的 `_hit_vcpu_program`
- Produces:
  - `ardb-get-vcpu-programs` 命令：输出 `{"1": "hello_world", "2": "kernel"}`（GDB 线程 ID → 程序名）JSON
  - TS 侧：`computeActiveSetDiff(prev: Set<string>, next: Set<string>) -> { insert: string[], remove: string[] }`（纯函数）
  - 断点组按程序映射：`programToGroup: Map<string, string>`（程序名 → 现有断点组名；程序名与组名不一时用此映射，缺省同名）
  - 插拔动作：insert 的程序组 → Z0 批量插入（现有 addBreakPoint 通路，跳过已插编号）；remove 的程序组 → z0 批量移除（跳过未插编号）

- [ ] **Step 1: 写测试** `src/test/test_active_set_diff.ts`

```typescript
// 纯函数测试：
// computeActiveSetDiff({a,b},{b,c}) → {insert:["c"], remove:["a"]}
// computeActiveSetDiff({},{}) → 两者皆空
// 组映射测试：programToGroup.get("pipetest") === "pipetest"（缺省同名）
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run compile && node out/test/test_active_set_diff.js`
Expected: FAIL（函数不存在）

- [ ] **Step 3: 实现**

TS 侧组切换流程重排为：停止 → `ardb-get-vcpu-programs` → 并集 → 差异插拔（不含符号步骤，Task 1 已删）→ continue。hook 断点仍全局常驻（现状不变）。插拔失败不阻塞 continue（best-effort + diag 日志）。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2；另跑 test_whitelist_skip_chain / test_symbol_resident / test_breakpointGroups_comprehensive 回归
Expected: 全绿

- [ ] **Step 5: 调试机 OS 实测（单 vCPU）**

Run: 实验 B 流程
Expected: 程序切换时仅差异断点插拔（diag 日志显示 insert/remove 数量），whitelist_rebuild 保持 ≈0；call 记录跨切换持续

- [ ] **Step 6: Commit**

```bash
git add async_rust_debugger/runtime_trace.py src/breakpointGroups.ts src/test/test_active_set_diff.ts
git commit -m "feat：断点按活跃程序集合并集差异插拔"
```

---

### Task 6: 多核并行适配（单步锁定 + 全 vCPU 扫描）

**Files:**
- Modify: `src/gdbDebugSession.ts`（特权级过渡单步：scheduler-locking + 单线程 vCont）
- Modify: `async_rust_debugger/runtime_trace.py`（stop 处理器内全 vCPU 扫描已在 Task 3 的函数基础上覆盖；补多命中串行化处理）

**Interfaces:**
- Consumes: Task 3/4/5 全部
- Produces: 行为契约——过渡期单步只放行目标 vCPU（其余冻结）；多 vCPU 同时命中时按 GDB selected thread 顺序处理，非选中命中断点静默 continue

- [ ] **Step 1: 调试机 smp>1 实测前检查**

Run: async-os 以 `-smp 2` 启动 ardb 调试
Expected: 记录基线行为（多核下当前实现的异常/崩溃点），作为本任务修复目标清单

- [ ] **Step 2: 实现单步锁定与多命中串行化**

单步：`set scheduler-locking on` + `vCont s:<thread>`（mi2 的 step 通路加 thread 参数）；多命中：stop 处理器对非 selected thread 的命中事件先处理（门控/记录），再处理 selected thread。

- [ ] **Step 3: smp=2 实测**

Run: 调试机 `-smp 2` 完整实验 B 流程
Expected: 无崩溃；hello_world/pipetest 记录完整；diag 显示各 vCPU 程序判定正确；单步仅目标 vCPU 推进

- [ ] **Step 4: Commit**

```bash
git add src/gdbDebugSession.ts async_rust_debugger/runtime_trace.py
git commit -m "feat：多核并行下单步锁定与多命中串行化"
```

---

### Task 7: 验收复测与数据记录

**Files:** 无代码改动；结果追加到 `temp/实验B_跨特权级异步跟踪开销测试/结果解读.md`（temp 为 gitignored，不提交）

- [ ] **Step 1: 实验 B 复测（smp=1）**

Expected: unload_symbols/load_symbols 除每程序首次进入外归零；单次往返 <200ms；whitelist_rebuild ≈0；call 记录跨切换持续

- [ ] **Step 2: 三场景功能回归**

Expected: 单线程（minimal，launch 模式）输出与上一轮一致；并发（实验 B 流程）记录完整；并行（smp=2）无错记（抽查 ardb.log 无跨程序调用记录）

- [ ] **Step 3: 数据记录**

在结果解读中追加"符号常驻优化后"一节：往返耗时对比、各步骤归零情况、门控触发次数（diag 统计）、错记 0 验证

---

## 自检记录

- **Spec 覆盖**：§6.1→Task 1；§6.2→Task 4+5；§6.3→Task 2+3；§6.4→Task 6；§6.5（UI）→ 不在本计划（spec §7 顺序 4 为独立 UI 项，另行安排）；§8 验收→Task 7
- **类型一致性**：`_activate_program(name: str) -> None`（Task 2 定义，Task 3/4 消费）；`_hit_vcpu_program(tid: int) -> str`（Task 3 定义，Task 5 命令消费）；`computeActiveSetDiff(prev: Set<string>, next: Set<string>) -> {insert: string[], remove: string[]}`（Task 5 定义）
- **Review Focus**：6 条均已绑定（#1/#6→Task 4；#2→Task 5 设计+Task 7；#3→Task 3+6；#4/#5→Task 2）
- **UI 按程序展示**（spec §6.5）为独立后续项，本计划不含——用户确认后另行立项
