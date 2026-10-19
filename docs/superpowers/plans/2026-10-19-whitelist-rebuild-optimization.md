# 白名单重建优化 + Callsite RISC-V 适配 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 OS 模式每次"内核→用户"切换的白名单重建开销从 ~830-946ms 降到接近零，并补齐 RISC-V 调用插桩（jal/jalr）+ 修复组切换后 CallSiteBP 消失的问题。

**Architecture:** 四层改动：① Python 侧 grouped JSON 按"当前加载的符号文件组合"缓存，跳过重复的 `info functions` 全量扫描；② TS 侧组切换流程瘦身，跳过冗余的 gen→update→load→trace-user-crate 四连（仅首次/白名单变更时执行）；③ saved state 扩展：地址表带锚点校验复用、callsite 地址表保存并重装；④ 助记符扩展到 RISC-V，安装时对直接调用做白名单/启发式过滤。

**Tech Stack:** TypeScript（VS Code 扩展 + MI2）、Python 3（GDB 内运行，无新依赖）、测试在真实 GDB 内执行（本机或调试机）。

**Spec:** `docs/superpowers/specs/2026-10-19-whitelist-rebuild-optimization-design.md`

## Global Constraints

- saved state 序列化向后兼容：新增字段必须有默认值，旧格式的保存状态仍可恢复
- launch 模式（x86-64 minimal 测试用例）的记录输出与现状完全一致，只减停顿、不减记录
- 不引入宿主侧 ELF 解析依赖（不用 pyelftools）
- 每层独立可验证、独立可回滚；OS 模式用户程序为 musl 静态链接 RISC-V
- 白名单相关文件路径：`temp/poll_functions.txt`、`temp/poll_functions_grouped.json`（固定路径，UI 依赖）、新增缓存目录 `temp/whitelist_cache/`
- 提交信息用中文，风格参照现有历史（如"fix：计时插桩bug"）；每条提交末尾加 `Co-Authored-By: Claude Code <noreply@anthropic.com>`

## Review Focus

| # | 输入/条件 | 期望行为 | 归属任务 |
|---|---|---|---|
| 1 | 用户在 UI 修改 enabled crates 后发生组切换 | 新选择生效（dirty 路径触发 update+load），且 dirty 被清除 | Task 2 |
| 2 | restore 时锚点符号解析失败（被优化掉/未加载） | 安全回退到懒构建全量重建，不崩溃、不产生错误地址 | Task 3 |
| 3 | 白名单含多个 objfile 的符号（同时启用用户 crate 与内核 crate） | 放弃地址表复用，回退重建，不得用统一 delta 改错另一侧地址 | Task 3 |
| 4 | 组切换后同一函数再次 poll 命中 | CallSiteBP 已按保存地址重装，call 记录持续存在 | Task 4 |
| 5 | 无白名单的 launch 模式（`ardb-trace` 直接使用） | 输出内容不变；直接调用安装时按 poll-ish 启发式过滤，停顿数下降 | Task 5 |
| 6 | `ardb-update-whitelist` 后再次 poll 命中 | 旧 CallSiteBP 已删除，重扫不产生重复断点 | Task 4 |

---

## 文件结构

| 文件 | 改动 | 职责 |
|---|---|---|
| `async_rust_debugger/static_analysis/gen_whitelist.py` | Modify | 新增 objfile 键计算 + grouped JSON 缓存读写 |
| `async_rust_debugger/runtime_trace.py` | Modify | 命令按键定位 JSON；restore 锚点校验复用；callsite 保存/重装；助记符扩展；安装时过滤 |
| `src/gdbDebugSession.ts` | Modify | `whitelistInitializedGroups`/`whitelistDirty` 状态及接口；`sendCliCommandAndGetOutput`；reset 联动 |
| `src/breakpointGroups.ts` | Modify | 组切换 5.5 步重写（首次/dirty 分支，跳过冗余四连） |
| `src/test/test_whitelist_cache.py` | Create | Task 1/3 的 GDB 内测试 |
| `src/test/test_callsite_restore.py` | Create | Task 4 的 GDB 内测试 |
| `src/test/test_callsite_filter.py` | Create | Task 5 的 GDB 内测试 |

测试执行方式（沿用 `src/test/test_trace_state_save_restore.py` 的模式，在有 GDB 的机器上——调试机 Linux 服务器或本地）：

```sh
gdb -batch -ex "source async_rust_debugger/__init__.py" -ex "source src/test/test_xxx.py"
```

TS 侧无测试框架：验证 = `npm run compile` + 调试机真实会话（每任务注明）。

---

### Task 1: grouped JSON 按符号组合缓存（Python）

**Files:**
- Modify: `async_rust_debugger/static_analysis/gen_whitelist.py`
- Modify: `async_rust_debugger/runtime_trace.py`（`ARDGenWhitelistCommand`、`ARDUpdateWhitelistCommand`、`ARDTraceUserCrateCommand`、`ARDGetGroupedWhitelistCommand`）
- Test: `src/test/test_whitelist_cache.py`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces（Task 2/4/5 依赖的行为契约，非函数调用）:
  - `gen_whitelist._current_objfile_key() -> tuple[tuple[str, int], ...]` — 当前加载的全部 objfile 的 `(filename, mtime)` 元组，按 filename 排序；mtime 取自 `os.stat`，取不到用 0
  - `gen_whitelist._cache_file_for_key(key) -> str` — `temp/whitelist_cache/<sha1(key).hexdigest()[:16]>.json`（`temp` 目录由 `ASYNC_RUST_DEBUGGER_TEMP_DIR` + `os.getcwd()` 推出，与现有文件同目录）
  - `gen_whitelist._try_load_cached_grouped(key, grouped_path) -> bool` — 缓存命中则把缓存内容写入 `grouped_path` 并返回 True
  - `gen_whitelist._cache_grouped(key, grouped_data, grouped_path)` — 写缓存副本
  - 行为契约：`ardb-gen-whitelist` 重复执行时，第二次跳过 `info functions` 扫描（控制台输出 "cache hit" 标志）；`ardb-update-whitelist`/`ardb-trace-user-crate`/`ardb-get-whitelist-grouped` 按**当前 objfile 键**定位 JSON 文件（缓存文件或固定路径，见下），不再无条件读固定路径
  - 实现方式说明（对设计文档 §6.3 的细化）：键由 **Python 侧自动按当前 objfile 计算**，而非 TS 传参——gen/update/trace-user-crate 在同一组切换流程内先后执行，objfile 集合一致，自动计算免去新增 TS→Python 参数
  - 固定路径 `poll_functions_grouped.json` 仍由 gen 写入（UI 的 `ardb-get-whitelist-grouped` 和 launch 模式继续可用）；update/trace-user-crate 优先按键读缓存文件，键对应缓存不存在时回退固定路径

- [ ] **Step 1: 写测试** `src/test/test_whitelist_cache.py`

```python
def test_objfile_key_stable_and_sorted():
    # 连续两次调用返回相同键；键为 (path, mtime) 元组且按 path 排序
    k1 = gen_whitelist._current_objfile_key(); k2 = gen_whitelist._current_objfile_key()
    assert k1 == k2 and list(k1) == sorted(k1)

def test_cache_roundtrip(tmp):
    # 用假键写缓存 → try_load 命中并复制到 grouped_path → 内容一致
    key = (("/fake/a.elf", 1), ("/fake/b.elf", 2))
    data = {"version": 2, "crates": {"test_crate": {"is_user_crate": True, "symbols": []}}}
    gen_whitelist._cache_grouped(key, data, tmp)
    # 清空 grouped_path 后 try_load 应恢复内容
    assert gen_whitelist._try_load_cached_grouped(key, tmp) is True
```

（测试函数体写入文件时按 GDB 内可运行的形式：模块级函数 + 末尾自检输出 PASS/FAIL，参照 `test_trace_state_save_restore.py` 的写法。）

- [ ] **Step 2: 运行确认失败**

Run: `gdb -batch -ex "source async_rust_debugger/__init__.py" -ex "source src/test/test_whitelist_cache.py"`（在有 GDB 的机器上）
Expected: FAIL（`gen_whitelist` 无 `_current_objfile_key`）

- [ ] **Step 3: 实现缓存函数**（`gen_whitelist.py`）

`_current_objfile_key` 用 `gdb.objfiles()` 收集 `objfile.filename`，`os.stat` 取 mtime；`_cache_file_for_key` 用 `hashlib.sha1(repr(key).encode())`；`gen_default_whitelist()` 开头计算键、尝试 `_try_load_cached_grouped`，命中则跳过 `info functions` 扫描并打印 `[ARD] whitelist cache hit -> <path>`；未命中按原流程生成并在结尾 `_cache_grouped`。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2
Expected: PASS

- [ ] **Step 5: 命令改用键定位 JSON**（`runtime_trace.py`）

`ARDUpdateWhitelistCommand`/`ARDTraceUserCrateCommand` 内：读 JSON 的路径 = `_cache_file_for_key(_current_objfile_key())`，该文件不存在时回退 `poll_functions_grouped.json`（逻辑抽成 `runtime_trace._grouped_json_path() -> str`）。`ARDGenWhitelistCommand` 行为不变（gen_whitelist 内部已缓存化）。

- [ ] **Step 6: 真机冒烟**

Run: 调试机上 `gdb -batch` 内连续执行两次 `ardb-gen-whitelist`，检查第二次输出含 `cache hit` 且耗时显著低于第一次
Expected: 第二次输出含 `[ARD] whitelist cache hit`，无第二次 `wrote grouped whitelist`

- [ ] **Step 7: Commit**

```bash
git add async_rust_debugger/static_analysis/gen_whitelist.py async_rust_debugger/runtime_trace.py src/test/test_whitelist_cache.py
git commit -m "feat：grouped 白名单按符号组合缓存"
```

---

### Task 2: 组切换链条瘦身（TS）

**Files:**
- Modify: `src/gdbDebugSession.ts`（状态字段 + session 接口，参照 `getWhitelistEnabledCrates` 的既有 pattern，位于 `:336` 附近；`handleArdUpdateWhitelist` 与 `handleArdReset`）
- Modify: `src/breakpointGroups.ts:340-372`（5.5 步重写）

**Interfaces:**
- Consumes: Task 1 的行为契约（gen 幂等缓存、update/trace-user-crate 按当前 objfile 键读 JSON）
- Produces:
  - `gdbDebugSession` 新状态：`private whitelistInitializedGroups: Set<string> = new Set()`、`private whitelistDirty: boolean = false`
  - session 接口新增（与 `getWhitelistEnabledCrates` 同处）：
    - `getWhitelistInitializedGroups(): Set<string>`
    - `markWhitelistGroupInitialized(group: string): void`
    - `isWhitelistDirty(): boolean`
    - `clearWhitelistDirty(): void`
  - `sendCliCommandAndGetOutput(command: string): Promise<string>` — 包装 `miDebugger.sendCliCommand` + 现有 `getConsoleOutput`，返回命令的控制台文本
  - 成功标志（解析用，字符串取自 `runtime_trace.py` 现有输出）：
    - gen：`[ARD] wrote grouped whitelist:` 或 `[ARD] whitelist cache hit`
    - update：`[ARD] whitelist updated:`
    - trace-user-crate：`[ARD] trace-user-crate `
  - `handleArdUpdateWhitelist` 内：置 `whitelistDirty = true`；`handleArdReset` 内：清空 `whitelistInitializedGroups` 与 `whitelistDirty`

- [ ] **Step 1: 实现 session 状态与接口**（`gdbDebugSession.ts`）

按 Interfaces 定义实现。`sendCliCommandAndGetOutput` 在 `miDebugger` 为空时返回 `""`。

- [ ] **Step 2: 编译验证**

Run: `npm run compile`
Expected: 无类型错误

- [ ] **Step 3: 重写 breakpointGroups.ts 5.5 步**

新逻辑（替换 `:340-368` 的 `filesToAdd.length === 0` 检查之后的部分）：

```
const firstEnter = !session.getWhitelistInitializedGroups().has(newGroupName);
const dirty = session.isWhitelistDirty();
if (!firstEnter && !dirty) { return; }   // 后续切回：跳过四连

// firstEnter: gen → update → load → trace-user-crate
// dirty 且已初始化: 跳过 gen，update → load → trace-user-crate <newGroupName>
// 每步用 sendCliCommandAndGetOutput 检查成功标志，全部成功才
// markWhitelistGroupInitialized(newGroupName) + clearWhitelistDirty()；
// 任一步失败则不标记（下次切换重试），沿用现有 best-effort 的 continue 保障
```

保持 `osProfiler.markStep(profCtx, 'whitelist_rebuild')` 与 continue 逻辑不变。dirty 路径的 `trace-user-crate <newGroupName>` 是幂等的（restore 已装的会被 `_ACTIVE_ROOTS` 跳过）；新启用的非本组 crate 的入口断点，在其对应组下次进入（首次或 dirty）时补装——接受该行为，不额外处理。

- [ ] **Step 4: 编译验证**

Run: `npm run compile`
Expected: 无类型错误

- [ ] **Step 5: 调试机 OS 实测（Review Focus #1）**

Run: 调试机以 ardb 调试 async-os（hello_world），观察 osProfiler 输出
Expected: `whitelist_rebuild` 仅在首次进入用户组时 >0，后续切换为 ~0ms；`restore_state` 正常；调试中途在 UI 改 enabled crates 后下一次切换出现一次 update/load 且 `whitelist_rebuild` 有值，之后恢复为 ~0

- [ ] **Step 6: Commit**

```bash
git add src/gdbDebugSession.ts src/breakpointGroups.ts
git commit -m "feat：组切换跳过冗余白名单重建四连"
```

---

### Task 3: 地址表复用 + 锚点校验（Python）

**Files:**
- Modify: `async_rust_debugger/runtime_trace.py`（`_build_whitelist_addr_map_if_needed`、`ARDSaveTraceStateCommand`、`ARDRestoreTraceStateCommand`）
- Test: 扩展 `src/test/test_whitelist_cache.py`（或新文件 `src/test/test_addr_map_reuse.py`）

**Interfaces:**
- Consumes: Task 1 的键/缓存函数（无直接调用关系；同文件内共存）
- Produces:
  - `runtime_trace._shift_addr_map(addr_map: dict, delta: int) -> dict` — 返回 `{a + delta: name for a, name in addr_map.items()}`（纯函数）
  - `runtime_trace._resolve_anchor_delta(cached_map: dict) -> int | None` — 取 cached_map 中最小地址的符号为锚点，用现有 `_try_addr_by_lookup_global_symbol`/`_try_addr_by_info_address` 解析当前地址；`None` = 放弃复用；否则返回 `新锚点 - 旧锚点`
  - `runtime_trace._whitelist_objfile_names() -> set[str]` — 对 `_WHITELIST_EXACT` 逐个 `gdb.lookup_global_symbol`，收集 `sym.symtab.objfile.filename` 的集合（复用已有解析路径，N 次查询可接受——它本身就是重建成本的一部分）
  - save state 新增字段：`"whitelist_objfile_names": list[str]`（保存时计算）；`"callsite_addrs_by_fn"` 见 Task 4
  - restore 新逻辑（替换 `:1765-1772` 的白名单恢复段）：`state["whitelist_exact/prefix"]` 照旧恢复；若 `state["whitelist_addr_map"]` 非空：
    1. `_resolve_anchor_delta` 返回 None → `ADDR_READY=False`（现状懒重建）
    2. delta 且 `state["whitelist_objfile_names"]` 长度 ≠ 1 → 放弃复用（多 objfile，Review Focus #3）
    3. delta==0 → 直接复用缓存 map，`ADDR_READY=True`
    4. delta≠0 → `_shift_addr_map` 平移后使用，`ADDR_READY=True`

- [ ] **Step 1: 写测试**（GDB 内，含 Review Focus #2/#3）

```python
def test_shift_addr_map():
    assert runtime_trace._shift_addr_map({0x1000: "a", 0x2000: "b"}, 0x100) == {0x1100: "a", 0x2100: "b"}

def test_anchor_delta_none_when_unresolvable():
    # 喂一个不可能解析的锚点（如 0x1 上的 "no_such_symbol_xyz"）
    assert runtime_trace._resolve_anchor_delta({0x1: "no_such_symbol_xyz"}) is None

def test_restore_reuses_map_on_delta_zero():
    # 构造 saved state（addr_map 含一个真实可解析符号的当前地址）→ ardb-restore-trace-state
    # → 断言 _WHITELIST_ADDR_READY == True 且 map 原样复用

def test_restore_drops_reuse_for_multi_objfile():
    # state["whitelist_objfile_names"] 长度 2 → restore 后 ADDR_READY == False
```

- [ ] **Step 2: 运行确认失败**

Run: `gdb -batch -ex "source async_rust_debugger/__init__.py" -ex "source src/test/test_addr_map_reuse.py"`
Expected: FAIL（`_shift_addr_map` 不存在）

- [ ] **Step 3: 实现纯函数与锚点校验**

按 Interfaces 实现；save 命令中填充 `whitelist_objfile_names`（取 `_whitelist_objfile_names()`，若 EXACT 为空则空列表）；restore 按 4 分支逻辑重写白名单恢复段，`_DIAG_LOG` 记录走了哪个分支。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add async_rust_debugger/runtime_trace.py src/test/test_addr_map_reuse.py
git commit -m "feat：地址表带锚点校验复用，免每次切换重建"
```

---

### Task 4: callsite 保存/重装（Python）

**Files:**
- Modify: `async_rust_debugger/runtime_trace.py`（`PollEntryBP.stop` 的 callsite_install 段 `:1040-1059`、`ARDSaveTraceStateCommand`、`ARDRestoreTraceStateCommand`、`ARDUpdateWhitelistCommand`）
- Test: `src/test/test_callsite_restore.py`

**Interfaces:**
- Consumes: Task 3 的 `_resolve_anchor_delta`（restore 内先于 callsite 重装调用）
- Produces:
  - `runtime_trace._CALLSITE_ADDRS_BY_FN: dict[str, list[int]]` — 函数名 → 已装 callsite 地址列表；callsite_install 时填充（`_CALLSITE_INSTALLED_FOR_FN.add(fn)` 处同步 `_CALLSITE_ADDRS_BY_FN[fn] = call_sites`）
  - save state 新增字段：`"callsite_addrs_by_fn": {str: [int, ...]}`；同时保留 `"callsite_installed"`（旧字段兼容）
  - restore 在重装 PollEntryBP 之后新增：
    - 锚点 delta==0（复用 Task 3 的结果）→ 对 `callsite_addrs_by_fn` 每个地址 `CallSiteBP(addr)` 重装；`_CALLSITE_INSTALLED_FOR_FN` 照旧恢复（stop() 因此跳过重扫，因为断点已装回）
    - delta≠0 / 锚点失败 / 多 objfile → 清空 `_CALLSITE_INSTALLED_FOR_FN` 与 `_CALLSITE_ADDRS_BY_FN`（下次 poll 重扫重装）
  - `ARDUpdateWhitelistCommand` 在 reload 后新增：清空 `_CALLSITE_INSTALLED_FOR_FN`/`_CALLSITE_ADDRS_BY_FN` 并删除现有 CallSiteBP（遍历 `_CREATED_BPS`，`isinstance(bp, CallSiteBP)` 则 `bp.delete()`，随后从 `_CREATED_BPS` 移除；Review Focus #6）

- [ ] **Step 1: 写测试**（GDB 内，覆盖 Review Focus #4/#6）

```python
def test_callsite_addrs_recorded_and_restored():
    # 手工造 fn→地址：直接向 _CALLSITE_ADDRS_BY_FN 与 _CALLSITE_INSTALLED_FOR_FN 注入假值并创建 2 个 CallSiteBP
    # → ardb-save-trace-state __t → 删除全部 CallSiteBP（模拟组切换）→ ardb-restore-trace-state __t
    # → 断言 _CREATED_BPS 中 CallSiteBP 数量恢复为 2 且地址一致

def test_update_whitelist_clears_callsites():
    # 注入 1 个 CallSiteBP + 已装记录 → ardb-update-whitelist {"enabled_crates": []}
    # → 断言 CallSiteBP 数量为 0、_CALLSITE_INSTALLED_FOR_FN 为空
```

- [ ] **Step 2: 运行确认失败**

Run: `gdb -batch -ex "source async_rust_debugger/__init__.py" -ex "source src/test/test_callsite_restore.py"`
Expected: FAIL（`_CALLSITE_ADDRS_BY_FN` 不存在）

- [ ] **Step 3: 实现**

按 Interfaces 实现。注意 restore 的删断点/重装顺序：callsite 重装放在现有 PollEntryBP 重装之后、continue 之前；`_CALLSITE_ADDRS_BY_FN` 在 `ARDResetCommand` 与 `_cleanup_run_scoped` 中也清空（与 `_CALLSITE_INSTALLED_FOR_FN` 同步清）。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2
Expected: PASS

- [ ] **Step 5: 调试机 OS 实测**

Run: 调试机调试 async-os，观察切换前后的 ardb.log
Expected: 每次切回用户组后，poll 命中仍产生 `call[coro#...]` 记录行（切换前后调用链不断）

- [ ] **Step 6: Commit**

```bash
git add async_rust_debugger/runtime_trace.py src/test/test_callsite_restore.py
git commit -m "feat：组切换后按保存地址重装 callsite 断点"
```

---

### Task 5: 助记符扩展 + RISC-V 解析 + 安装时过滤（Python）

**Files:**
- Modify: `async_rust_debugger/runtime_trace.py`（`CALL_MNEMONIC_RE` `:299`、`_collect_call_sites` `:416`、`_resolve_call_target_from_asm` `:445`）
- Test: `src/test/test_callsite_filter.py`

**Interfaces:**
- Consumes: 无新增跨任务接口（复用 `_WHITELIST_ADDR_MAP`、`_whitelist_allows_by_addr/name`、`_callee_candidates`、`_is_pollish_name`）
- Produces:
  - `CALL_MNEMONIC_RE = re.compile(r"^\s*(?:call|jal|jalr|c\.jalr|c\.j|bl|blr)\b", re.IGNORECASE)`（覆盖 x86 `call`、RISC-V `call` 伪指令/`jal`/`jalr`/压缩形式、AArch64 `bl`/`blr`；排除 `ret`/`c.jr`；tail call 不记录）
  - `runtime_trace._direct_call_target_from_asm(asm: str) -> int | None` — 仅对直接调用文本（含 `0x` 立即数且不含 `*`）抠立即数（纯函数；x86 `call 0x...` 与 RISC-V `jal 0x...`/`call 0x...` 共用）
  - `_resolve_call_target_from_asm` 新增 RISC-V 分支：`jalr rd, off(reg)` → `_reg_u64(reg) + off`（含压缩形式 `c.jalr rs` → `_reg_u64(rs) + 0`）；正则按调试机真实反汇编文本校准
  - `runtime_trace._should_install_callsite(target_addr: int) -> bool` — 与 `_pick_interesting_callee` 三路径完全一致：白名单启用+地址表就绪 → 地址命中 True，未命中名字兜底（`_callee_candidates` + `_normalize_sym_name` + `_whitelist_allows_by_name`）；白名单未启用 → 名字兜底 + `_is_pollish_name`
  - `_collect_call_sites()` 返回值语义不变（`list[int]`），内部改造：循环保留 `asm` 文本；直接调用（`_direct_call_target_from_asm` 非 None）→ `_should_install_callsite` 为 False 则不装；间接调用（`call *...`/`jalr`/`blr`）→ 全装；仍受 `MAX_CALLSITES_PER_FN` 上限约束（过滤后截断）

- [ ] **Step 1: 写测试**（GDB 内，含 Review Focus #5 的判定部分）

```python
def test_mnemonic_regex_coverage():
    for s in ("call 0x1234", "callq *%rax", "jal ra, 0x8020", "jalr ra, 16(a0)",
              "c.jalr a0", "bl 0x4000", "blr x30", "callplt 0x100"):
        assert runtime_trace.CALL_MNEMONIC_RE.match(s)
    for s in ("ret", "c.jr ra", "jalr zero, 0(ra)"):   # tail/return 不匹配
        assert runtime_trace.CALL_MNEMONIC_RE.match(s) is None

def test_direct_call_target():
    assert runtime_trace._direct_call_target_from_asm("call 0x402030") == 0x402030
    assert runtime_trace._direct_call_target_from_asm("jal ra, 0x10514") == 0x10514
    assert runtime_trace._direct_call_target_from_asm("call *%rax") is None

def test_should_install_callsite_whitelist_paths():
    # 白名单启用 + 地址表就绪：命中→True；未命中+名字兜底命中→True；都未命中→False
    # 白名单未启用：poll-ish 名字→True；普通名字→False
```

- [ ] **Step 2: 运行确认失败**

Run: `gdb -batch -ex "source async_rust_debugger/__init__.py" -ex "source src/test/test_callsite_filter.py"`
Expected: FAIL（`_direct_call_target_from_asm` 不存在）

- [ ] **Step 3: 实现**

按 Interfaces 实现。`_collect_call_sites` 内对每个直接调用目标做一次名字兜底查询（`_callee_candidates` 内部已是 GDB 查询）——安装时一次性成本，可接受；实现后到调试机上用真实反汇编输出校准 `jalr`/`c.jalr` 正则格式。

- [ ] **Step 4: 运行确认通过**

Run: 同 Step 2
Expected: PASS

- [ ] **Step 5: 本地 launch 实测（Review Focus #5）**

Run: `make compile TESTCASE=minimal && make debug TESTCASE=minimal`（或用 ardb 调试 minimal）
Expected: ardb.log 中 `call[` 记录行与改动前一致；`[ARD] call-sites: N` 的 N 显著小于改动前（仅 poll-ish 目标被插）

- [ ] **Step 6: 调试机 OS 实测**

Run: 调试机调试 async-os
Expected: 首次出现 `jalr` 间接调用的 `call[coro#...]` 记录（vtable 分发可见）；轮询/调度行为无异常

- [ ] **Step 7: Commit**

```bash
git add async_rust_debugger/runtime_trace.py src/test/test_callsite_filter.py
git commit -m "feat：callsite 助记符支持 RISC-V 并安装时按白名单过滤"
```

---

### Task 6: OS 模式验收复测

**Files:** 无代码改动；复测结果追加到 `temp/实验B_跨特权级异步跟踪开销测试/结果解读.md` 的"优化后"一节

- [ ] **Step 1: 重跑实验 B 调试组**

Run: 调试机上以 ardb 调试 async-os（hello_world + pipetest，与实验 B 同流程），收集 osProfiler 输出
Expected: `whitelist_rebuild` 总耗时从 172.2s 降到 <5s（仅首次进入各用户组时 >0）；单次切换平均从 795ms 降到 <250ms

- [ ] **Step 2: 功能回归检查**

Expected: ardb.log 中 hello_world/pipetest 的 poll/call 记录完整（call 记录在全部切换后持续存在）；记录 RISC-V 间接调用新增的停顿数量作为后续优化基线

- [ ] **Step 3: 数据记录与 Commit**

```bash
git add temp/实验B_跨特权级异步跟踪开销测试/结果解读.md
git commit -m "docs：白名单重建优化后实验B复测数据"
```

---

## 自检记录

- **Spec 覆盖**：§6.1→Task 2；§6.3→Task 1；§6.2→Task 3；§6.4 助记符/过滤→Task 5；§5.5（callsite 重装）→Task 4；§7 顺序 4→Task 6；§5.6（无白名单过滤）→Task 5 的 `_should_install_callsite`；§5.7（无开关）→ 全默认开启，无额外开关代码
- **类型/命名一致性**：`_resolve_anchor_delta`（Task 3 定义，Task 4 消费）、`_shift_addr_map`（Task 3 定义）、`sendCliCommandAndGetOutput`（Task 2 定义，仅 Task 2 使用）、`_grouped_json_path`（Task 1 定义）
- **Review Focus**：6 条均已在对应任务中绑定测试/验证步骤
- **实验 A**：按用户决定，不设 launch 模式性能验收（Task 5 Step 5 只验证输出一致性）
