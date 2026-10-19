# 白名单重建开销优化 + Call 指令插桩 RISC-V 适配 — 设计文档

日期：2026-10-19
范围：性能优化报告 3.1 第一项（白名单重建开销）+ 3.2 第二项（无差别插桩，含 RISC-V 适配）

## 1. 意图与背景

性能报告实验 B 实测：组切换占总调试开销 96%，其中"重建白名单"一步占组切换的 56.7%
（303 次切换共 172.2s，平均每次 830~946ms）。每次"内核→用户"切换都完整执行
`ardb-gen-whitelist → ardb-update-whitelist → ardb-load-whitelist → ardb-trace-user-crate`
四连命令，期间整个虚拟机冻结。

设计讨论与审查中确认的关键事实：

1. **四连大部分是冗余劳动**。`ardb-restore-trace-state` 本身就会恢复白名单集合
   （`whitelist_exact/prefix`）并按保存的 `poll_entries` 重装所有入口断点
   （`runtime_trace.py:1765-1772`、`1827-1851`）。四连在"切回已保存过状态的组"时，
   其产出与 restore 几乎完全重复。
2. **地址表被无谓作废**。同一进程存活期间基址不变，但 restore 强制清空地址表
   （`_WHITELIST_ADDR_READY=False`），下一次 poll 命中时用 N 次 GDB 查询从零重建
   （`_build_whitelist_addr_map_if_needed`，每符号一次 `gdb.lookup_global_symbol`，
   失败再 `info address`）。
3. **组切换后 CallSiteBP 不会被重装**。restore 只重装入口断点（PollEntryBP），
   并把 `_CALLSITE_INSTALLED_FOR_FN` 恢复为保存值，导致切换后 poll 命中时跳过重扫——
   call 断点在首次切换后永久消失。OS 模式的调用链记录只在首次进入用户组的窗口有效。
4. **RISC-V 的 callsite 覆盖存在缺口，直接决定补充完善**（不设前置确认）。`CALL_MNEMONIC_RE`
   匹配 `call` 开头的助记符；binutils 的 RISC-V 反汇编默认显示伪指令，`call` 正是
   `auipc ra + jalr ra` 对的伪指令名——直接调用可能已在工作，也可能没有。无论哪种
   情况，**把 `jal`/`jalr`（及压缩形式）与对应解析分支补齐**，保证覆盖完整；
   实现时在调试机上用真实反汇编输出校准正则精确格式。
5. **实验 A 未加载白名单**（日志只有 `ardb-trace minimal::block_on`），122 次停顿中的
   8 次有效调用来自无白名单的 poll-ish 名字启发式；其 14.8ms poll_entry 尖峰来自
   首次 callsite 反汇编扫描，与地址表无关。

## 2. 目标

- OS 模式：把每次"切回用户组"的白名单重建开销从 ~830-946ms 降到接近零（只付必要的最小工作）。
- 补齐 RISC-V 上缺失的调用插桩（重点是 `jalr` 间接调用；直接调用是否缺失以真机确认为准）。
- 精准插桩：直接调用在安装时做过滤（白名单/启发式判定与命中时完全一致），从源头减少无效停顿。
- 修复组切换后 CallSiteBP 消失的问题，使 OS 模式调用链记录持续有效。

## 3. 非目标 / 反目标

**非目标**（本次不做，报告其他项）：
- 符号表加载/卸载优化（3.1 第二条）、特权级单步优化（3.1 第四条）
- 断点 enable/disable 替代删插（3.1 第三条）、日志与 IO 清理（3.2 第三条）
- callsite 命中时的 `asm+resolve` 前置缓存（3.2 第一条，与本次部分相关但独立立项）

**反目标**（做了反而算失败）：
- 为速度牺牲正确性：地址表/callsite 复用必须有校验（锚点 delta==0），不能盲信缓存
- 破坏 launch 模式现有行为（minimal 测试用例输出必须保持与现状一致）
- 破坏 saved state 兼容性导致跟踪状态错乱（GDB 15 RISC-V 有已知孤儿断点坑，改动重装逻辑时勿破坏现有 sweep）

## 4. 约束（代码事实）

- 组切换顺序（`breakpointGroups.ts`）：save → 删断点 → 卸/载符号 → 重插断点 →
  restore → [四连] → continue。四连仅在 `filesToAdd.length > 0` 时执行（即切回用户组）。
- `_SAVED_STATES` 按组名保存，已含 `whitelist_exact/prefix/addr_map/addr_ready`
  （`runtime_trace.py:1703-1725`）；restore 用 `pop` 取走（一次性）。
- 地址表只对精确符号（EXACT）构建；`*` 前缀匹配从不进地址表，命中判定靠名字兜底
  （`_pick_interesting_callee` 的 fallback 路径）。无白名单时走 poll-ish 名字启发式。
- 地址表懒构建发生在 `PollEntryBP.stop()` 开头（`:1008`），先于 callsite_install——
  安装时过滤可以依赖已就绪的地址表。
- OS 模式用户程序为 musl 静态链接（无 PLT 惰性绑定，间接调用基本只剩 vtable 分发）。
- 调试机为 Linux 服务器，GDB 与 TS 扩展同机，temp 文件本地可读。
- 磁盘上只有一份 `poll_functions_grouped.json`，gen 会覆盖它——多用户组（hello_world/
  pipetest）交替时，一份 JSON 无法同时服务两个 ELF。

## 5. 已拍板的决定（用户拍板）

1. **间接调用全部照插**（`call *%reg` / `call *disp(...)` / `jalr` / `blr`），命中时再判断是否记录。
2. **直接调用在安装时过滤**（x86 `call 0x...` / RISC-V `call` 伪指令/`jal`）：解析目标地址 →
   与白名单比对（地址表命中 + 名字兜底两段式）→ 不感兴趣就不插。
3. **RISC-V 适配**：助记符与解析分支以真机反汇编输出为准；重点补齐 `jalr` 间接调用。
4. 本次范围 = 白名单重建优化 + callsite 插桩 RISC-V 适配（含安装时过滤）。
5. **组切换后 CallSiteBP 恢复**：save 时保存 callsite 地址表，restore 时直接重装
   （锚点校验 delta==0 才复用，校验失败回退重扫）。
6. **无白名单时也过滤直接调用**：判定与命中时完全一致（无白名单 → poll-ish 启发式），
   输出内容不变（被过滤的停顿本来就不记录任何东西），实验 A 验收口径不变。
7. **call 插桩直接加上，不加开关**（默认开启，与 launch 模式一致）。

## 6. 方案（分三层，标注我的提议）

### 6.1 第一层：切换链条瘦身【我的 call，优先实现】

**机制**：TS 侧维护 `initializedGroups: Set<string>`，记录已完成首次初始化的组。

- 首次进入某用户组（不在集合中）：跑完整四连（现状），**验证成功后才**加入集合
  （解析 MI 命令输出中的成功标志，如 `whitelist updated: N crates`、
  `trace-user-crate ...: N async symbols traced`；任一步失败则不标记，下次重试）。
- 后续切回该组：**跳过四连**，仅依赖 restore-trace-state（已恢复白名单 + 重装入口断点）。
- **dirty 为全局标记**（不按组）：用户在 UI 改过 enabled crates → 置 dirty；
  下一次组切换（无论切到哪个用户组）跑 `update + load`（不跑 gen），跑完清 dirty。
  update/load 用**当前组的 per-ELF JSON**（见 6.3），保证符号归属正确。
- `ardb-reset` / `ardb-reset-trace-state` 时清空 `initializedGroups` 与 dirty。
- `gen` 只在首次进入（或 per-ELF 缓存缺失）时执行。

**预期收益**：303 次切换中约 301 次的四连被消掉，whitelist_rebuild 步骤总耗时
从 172.2s 降到仅剩首次进入的成本（~2 次 × 0.9s）。

### 6.2 第二层：地址表复用 + 锚点校验【我的 call】

**机制**：`_SAVED_STATES` 已保存 `whitelist_addr_map`，restore 时不再无条件清空：

1. 从保存状态取出缓存的地址表（若有）。
2. **锚点校验**：重新解析白名单中 1 个符号（如第一个 EXACT 符号）的当前地址（1 次 GDB 查询）：
   - 与缓存中该符号地址一致 → 进程未变、基址未变 → **整表直接复用**，`ADDR_READY=True`；
   - 不一致 → 计算 `delta = 新锚点 - 旧锚点`，**整表平移 delta**（覆盖同一 ELF 换基址的情况）；
   - 锚点解析失败 → 回退到现状（懒构建全量重建）。
3. **多 objfile 检测**：白名单符号若来自多个 objfile（如同时启用用户 crate 与内核 crate 符号），
   统一平移会改错另一侧地址——此时**放弃复用**，回退全量重建（安全兜底，不影响正确性）。

**预期收益**：消掉每次切回用户组后第一次 poll 命中时的 N 次 GDB 查询
（OS 模式下每次切换后第一次 poll 命中停顿的重要组成）。

### 6.3 第三层：grouped JSON 按符号组合缓存【我的 call，提升为核心层】

多用户组交替时单份 JSON 会被互相覆盖（约束 §4 末条），链条瘦身跳过 gen 后
update/trace-user-crate 会读到别的 ELF 的 JSON——因此本层**不是可选的增强项，
是第一层的正确性前提**。

**机制**：`ardb-gen-whitelist` 生成的 grouped JSON 按**参与扫描的全部 objfile 的
(路径, mtime) 列表**为键，缓存到 `temp/whitelist_cache/`。gen 时先查缓存，命中则
跳过 `info functions` 全量扫描直接复用；任一 objfile 变化（含内核 ELF 重新编译）
则缓存失效重扫。`ardb-update-whitelist` / `ardb-trace-user-crate` 增加参数，
指定使用哪个符号组合的 JSON（TS 侧按当前组名传入对应缓存键）。

**预期收益**：首次进入的 ~0.9s 也砍掉大半；跨调试会话有效；多用户组各持其 JSON，互不覆盖。

### 6.4 RISC-V callsite 适配 + 安装时过滤 + callsite 重装

**助记符（直接补充完善，不设前置确认）**：`CALL_MNEMONIC_RE` 覆盖全部调用形式——
x86 `call`、RISC-V `call` 伪指令/`jal`/`jalr`/压缩形式 `c.jalr`/`c.j`（防御性包含）、
AArch64 `bl`/`blr`；排除返回类（`ret`/`c.jr`）；tail call 不记录（与 x86 `jmp` 现状一致）。
实现时在调试机上用真实反汇编输出校准正则的精确格式（立即数写法、括号与偏移格式）。

**目标解析** `_resolve_call_target_from_asm`：RISC-V `call`/`jal` 走直接调用分支
（抠立即数，安装时可判）；`jalr rd, off(reg)` 走间接分支（命中时读 `reg + off`）。

**安装时过滤**（`_collect_call_sites` 改造，含用户拍板 2/6）：
- 循环中保留 asm 文本（现在被丢弃）；
- 直接调用：立即数目标 → 查 `_WHITELIST_ADDR_MAP` → 命中则插；未命中走名字兜底
  （1 次 GDB 查询"地址→名字"，每 callsite 一次性）→ 判定与命中时
  `_pick_interesting_callee` 的三路径完全一致（含无白名单的 poll-ish 启发式）；
- 间接调用：全部照插（用户拍板 1）；
- **名字兜底不可省略**：`*` 前缀符号不进地址表，缺兜底则前缀白名单全部失效。

**callsite 保存/重装**（含用户拍板 5）：
- save 时把 `{函数名: [callsite 地址...]}` 存入 saved state；
- restore 时：锚点校验 delta==0 → 按保存地址直接重装 CallSiteBP（免反汇编重扫）；
  校验失败/多 objfile → 清空 `_CALLSITE_INSTALLED_FOR_FN` 回退"下次 poll 重扫"；
- `ardb-update-whitelist` 时：清空 `_CALLSITE_INSTALLED_FOR_FN` **并删除现有
  CallSiteBP**（防止重扫时向同一地址重复插桩）。

**预期副作用**：若真机确认直接调用已通过 `call` 伪指令在插桩，则 OS 模式 call
停顿早已存在，适配新增的只有 `jalr` 间接调用部分；launch 模式 122 次停顿
→ 约 8 次有效停顿（无白名单跑法同样成立）。

## 7. 实现顺序建议

1. 第一层（链条瘦身）+ 第三层（per-ELF JSON 缓存，作为瘦身前提）→ 实验 B 复测
2. 第二层（地址表复用）+ callsite 保存/重装（同在 saved state 上改动，一起做）→ 实验 B 复测
3. 助记符补齐 + 安装时过滤 → 实验 A 复测（launch）+ OS 模式实测
4. 验收复测 + 记录新开销数据

每层独立可验证、独立可回滚。

## 8. 验收标准（提议目标，可调整）

- OS 模式：whitelist_rebuild 步骤总耗时 172.2s → 期望 <5s；单次切换总耗时平均
  795ms → 期望 <250ms
- launch 模式（minimal）：call_site 停顿 122 次 → 显著下降（有效调用 8 次量级，
  无白名单跑法同样成立）；poll_entry 稳定期无 >5ms 尖峰（排除每函数首次扫描/重装）
- 功能回归：hello_world/pipetest 的跟踪记录完整性与现状一致或更好（RISC-V 间接
  调用记录从无到有）；minimal 测试输出一致
- 真机验证项：RISC-V 反汇编格式、jalr 偏移格式、锚点符号选取（选必能解析的符号）

## 9. 风险清单

- saved state 序列化格式变更的兼容性（`_SAVED_STATES` 增删字段）
- GDB 15 RISC-V 孤儿断点坑（现有 sweep 逻辑勿破坏）
- dirty 标记遗漏 → 用户改 crates 后不生效（回归测试点）
- launch 模式动态链接程序 `call *disp(%rip)` 数量大 → 间接调用全插的成本
  （可接受，命中时判断兜底）
- 锚点符号若被优化掉/重命名 → 校验失败回退全量重建（安全兜底，不致命）
- RISC-V 正则若与真实反汇编格式有出入 → 实现时以调试机输出校准（已决定直接补充完善，
  校准属于实现细节，不是前置裁决门）
