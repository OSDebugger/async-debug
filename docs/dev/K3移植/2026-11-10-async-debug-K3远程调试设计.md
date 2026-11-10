# async-debug 远程调试 K3 真板设计文档(async-os,SMP=1)

- 日期:2026-11-10
- 状态:已确认(2026-11-10 用户拍板全部开放问题),进入实施计划

## 一、意图与背景

async-debug 目前只能调试 qemu 里的 async-os。目标:让它在 **K3 真板**上调试 async-os(SMP=1),方式为 JTAG + OpenOCD。最终链路:

```
VS Code(async-debug) → GDB(MI2,attach 模式) → OpenOCD(localhost:3333) → J-Link → K3 Debug Module → 板上内核
```

板上内核以 **release 构建**运行(不带调试信息),主机加载同一次构建的 ELF 提供符号与源码映射——即 Host-DWARF 方法。

## 二、现状盘点(已验证)

**板子侧**:async-os 已在 K3 上跑通(async-os-original 仓库 `feat/k3-port` 分支;coroutine_test 完整输出;`scripts/k3flash.sh` 一键启动,走 UFS 官方固件链,无需自备固件)。

**async-debug 侧**:`feat/k3-board-adapter` = main + 26 个提交(main 的内容一个不缺)。已有 attach/remote 能力(`mi2.ts` 的 `connect()` 走 `target-select remote`);K/U 地址判据、内存范围全部由 launch 配置驱动,无写死;多核状态机(scheduler-locking、vCPU 扫描)在 SMP=1 下基本不触发。

**前人资产**(async-integration 分支):`638f7a9` 有真版启动状态机(870 行)、OpenOCD 配置(`spacemit-k3.cfg`、`jlink.cfg`、SECJTAG `irscan 0x98` 解锁)、launch 模板、`n-host-dwarf.json`(sha256 清单身份对齐基线)。该分支后续提交把状态机改成了"委托外部 N 工作区"的壳,真版要回 `638f7a9` 取。

**硬阻塞**:Debug FSBL + `k3-jtag-ram-opensbi-uboot.itb` 固件——git 里被 `.gitignore` 排除、本机没有。这套固件是 K3 专用的(与 OS 无关),拿到即用,不用改造。它只阻塞真板阶段。

**关键事实**:对 async-debug 而言,qemu 的 gdbserver 和 OpenOCD 是同一类"远程桩"。代码侧工作可以全部先在 qemu 上验证(attach 的 target 指向 qemu 的 `:1234`)。

## 三、目标与非目标

### 目标(Goals)

- **G1 资产移植**:把前人的 K3 资产移植进 `feat/k3-board-adapter` 并 async-os 化:OpenOCD 配置、启动状态机(取 `638f7a9` 真版)、Host-DWARF 身份对齐机制。
- **G1b 适配器小改**:attach 时 qemu 启动可选化(未提供 `qemuPath` 即跳过 QEMU 终端、直接连远程桩)。
- **G2 K3 launch 配置**:新增 K3 的 launch 配置模板(attach 风格,含 K3 地址布局、border 断点)。
- **G3 测试套件全绿**:适配器改动后,仓库现有 mock 测试套件(TS/Python)全部通过——确保不破坏现有 qemu 调试路径(兜底验证,不碰 qemu)。
- **G4 硬件链打通**(需固件):OpenOCD + J-Link 能停住真板 CPU,GDB 能读寄存器/内存。
- **G5 真板端到端**(需固件):Host-DWARF 对齐 + async-debug 完整工作流在真板出 History/Snapshot(任意异步函数即可,内核态与用户态都覆盖)。

### 非目标(Non-goals)

- 不支持 SMP=2 / 多核真板调试(用户已定 SMP=1)。
- 不修改 async-os 内核功能;不刷写板载 UFS 固件。
- 不做 StarryOS 支持;不改前端 UI。
- 不把固件二进制提交进 git(沿用前人 `.gitignore` 约定)。

### 反目标(Anti-goals)

- 破坏现有 qemu 调试路径——所有改动要有回归测试兜底。
- 删除多核代码——只绕开/禁用,不删。
- 用"整体合并 async-integration"的方式引入资产——两线差异 119 个文件,整体合并会把 StarryOS 定制和 N 工作区壳一起混进来;只 cherry-pick 需要的文件。

## 四、约束(Constraints)

- **慢链路**:JTAG 100 kHz(前人验证的稳定参数);探针安装、快照读取的耗时预算未知,真板阶段首测。
- **release 镜像**:板上无 DWARF,Host-DWARF 身份对齐机制必须存在(沿用前人 sha256 清单思路)。
- **单核**:只开 cluster0 core0;SECJTAG 需 `irscan 0x98` 解锁。
- **sudo 受限**:串口 dialout 权限需用户在自己的终端处理。
- **固件外部依赖**:阻塞 G5/G6,不阻塞 G1–G4。

## 五、已决定的事项(与用户确认过)

- 在 `feat/k3-board-adapter` 上做适配,不退回 main。
- 调试方式:JTAG + OpenOCD。
- SMP=1。
- 调试范围:内核 + 用户程序一步到位(K→U 跨特权级)。
- 验收口径:任意异步函数 Trace 出 History/Snapshot 即算通过,不要求 sleep/timer 场景。
- 运行位置:板子、OpenOCD、J-Link、VS Code 全部在这台 Linux 机上(J-Link 当前未插,调试时插上)。
- async-os-original 可以提交冻结并添加 Host-DWARF 构建脚本。
- **不做 qemu 远程桩彩排,代码侧完成后直接上 K3 真板**;适配器改动以仓库现有 mock 测试套件全绿为兜底。

## 六、我定的调用(用户可推翻)

1. **launch 配置风格**:用当前分支的 attach 风格(`AttachRequestArguments`:`target=localhost:3333` + `kernel_memory_ranges`/`user_memory_ranges` + border 断点),不用前人 StarryOS 的 launch+remote 混合式(其 `enableOsDebug: false`,与本分支 OS 状态机不匹配)。理由:本分支的 OS 调试全部围绕 attach 配置实现。
2. **资产引入方式**:cherry-pick 单文件,不整体合并分支。
3. **Host-DWARF 身份对齐**:一个构建脚本同次产出三样——bin(上板)、elf(主机加载)、manifest.json(elf 的 sha256 + git commit + 关键源文件 sha256 清单);attach 前用校验脚本比对。比前人的"外部 N 工作区拷贝源文件清单"简单,因为 async-os 是单仓库单命令构建,不像 StarryOS 需要外部拼装。
4. **文档位置**:`docs/dev/K3移植/`(跟随现有整理)。
5. **构建源仓库**:async-os-original(`feat/k3-port`)——K3 平台只在那里;`async-os`(rosy fork)不参与,除非后续同步。
6. **适配器小改(qemu 可选化)**:当前 `attachRequest` 强制要求 `qemuPath`/`qemuArgs` 并拉起 QEMU 终端(gdbDebugSession.ts:265,已核实)。改为:配置未提供 qemu 时跳过启动、直接连远程桩;现有 qemu 配置不受影响,仓库 mock 测试套件兜底。

## 七、K3 地址布局(launch 配置依据,来自 riscv64-k3.toml)

| 项 | 值 |
|---|---|
| 物理内存 | 0x102000000 起,约 8GB(至 0x300000000);底部 32MB 固件保留区 |
| 内核加载物理地址 | 0x140000000 |
| 内核虚拟地址 | 0xffffffc140000000(phys-virt offset 0xffffffc000000000) |
| MMIO | UART0 0xd4017000、APLIC 0xe0804000、CLINT 0xe081c000 |
| 定时器频率 | 24 MHz |
| 用户态 | heap 0x3FA00000、stack top 0x3FE00000、signal trampoline 0x40000000 |

由此 launch 配置:K 区 `0xffffffc000000000–0xffffffffffffffff`(与 qemu 相同);U 区约 `0x0–0x40000000` 一带(与 qemu-virt 既有配置对齐后实测确认)。

## 八、阶段与里程碑(每阶段有可验证结果)

| 阶段 | 内容 | 验收 | 依赖 |
|---|---|---|---|
| 0 代码侧适配 | G1/G1b/G2/G3:cherry-pick + async-os 化 + 适配器小改 + launch 模板 + Host-DWARF 脚本;冻结 async-os-original | 资产就位、脚本 `--check` 离线校验通过、mock 测试套件全绿 | 无 |
| 1 硬件链 | G4:OpenOCD+J-Link 停住真板 CPU(SECJTAG 解锁) | GDB 读寄存器/内存成功 | **固件到位** + 阶段 0 |
| 2 真板端到端 | G5:Host-DWARF 全流程(内核态 + 用户态) | 板上触发异步任务后 History/Snapshot 出结果 | 阶段 1 |

## 九、风险与对策

| 风险 | 对策 |
|---|---|
| 固件拿不到(最大) | 阶段 0 不受影响;用户已向前人要,等发送;真到拿不到再另立 SDK 重建计划 |
| 慢链路性能未知 | 阶段 1 首测探针安装/快照耗时;启用已有白名单重建优化;最坏:降级为"少装探针" |
| release ELF 符号质量 | `fe207b6` 已有 release 调试健壮性修复;首次真板会话用小规模白名单,逐步放大 |
| 单核下多核代码副作用 | 真板首次会话直接验证(未做单核回归);若多核状态机在单核下捣乱,当场在单核路径修复 |
| 真板调试必须走 golden flow | k3gdb 博客证实:只有 FORCE_RECOVERY + Debug FSBL 才把引脚切给 JTAG,官方 UFS 启动链不行;`k3flash.sh` 只用于非调试启动。启动状态机是必做项,取 `638f7a9` 真版改造 |
| J-Link 当前未插(lsusb 未见) | 阶段 1 前确认 J-Link + Debug 扩展卡到位并插好 |

## 十、开放问题的答案(2026-11-10 与用户确认)

1. 固件:用户已向前人要相关目录文件,等待发送;本计划不在"拿不到"的前提下展开 SDK 重建——真到那一步再另立计划。
2. 调试范围:内核 + 用户程序一步到位(K→U 跨特权级)。
3. 验收口径:任意异步函数 Trace 出 History/Snapshot 即算通过,不要求 sleep/timer 场景。
4. 运行位置:全部在这台 Linux 机(已确认)。
5. async-os-original:可以提交冻结 + 加构建脚本(已确认)。
6. 验证策略:不做 qemu 远程桩彩排,直接适配 K3(已确认)。
