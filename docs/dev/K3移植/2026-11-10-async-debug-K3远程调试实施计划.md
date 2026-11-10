# async-debug K3 远程调试实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 async-debug 通过 JTAG+OpenOCD 调试 K3 真板上的 async-os(SMP=1,内核+用户态,Host-DWARF)。

**Architecture:** 链路为 async-debug(attach 模式)→ GDB MI2 → OpenOCD(localhost:3333)→ J-Link → K3 Debug Module。代码侧工作分两个仓库:async-os-original 负责冻结基线与 Host-DWARF 构建产物;async-debug 负责适配器小改(qemu 可选化)、K3 资产移植、launch 模板与校验脚本。任务 1–6 不碰硬件,任务 7–8 有硬件门槛。

**Tech Stack:** TypeScript(VS Code debug adapter)、Python3(状态机/校验脚本)、bash、GDB MI2、OpenOCD/J-Link、async-os(Rust, riscv64-k3)。

**Spec:** `docs/dev/K3移植/2026-11-10-async-debug-K3远程调试设计.md`(同一目录,实施时对照执行)

## Global Constraints

- SMP=1;真板调试必须走 golden flow(FORCE_RECOVERY + Debug FSBL),`k3flash.sh` 只用于非调试启动。
- 固件二进制(*.bin/*.itb/*.elf/*.dtb)不进 git(沿用前人 .gitignore 约定)。
- 提交**不带任何 AI 署名**(async-os-original 与 async-debug 一致,用户既有约定)。
- 验收口径:任意异步函数 Trace 出 History/Snapshot 即算通过;范围含用户态(K→U)。
- 运行位置:全部在这台 Linux 机,J-Link 调试时插上。
- 不破坏现有 qemu 调试路径(Task 2/6 回归兜底)。

## Review Focus

1. attach 配置**没有** qemuPath/qemuArgs → 不报 103 错误、不启动 QEMU 终端、直接连远程桩 —— Task 2 测试①。
2. attach 配置**有** qemuPath/qemuArgs → 行为与改动前完全一致(终端启动 + 1s 延迟后 launchGDB)—— Task 2 测试②。
3. 构建后源文件被改动(脏树)→ 校验脚本必须 FAIL 并指明是哪个文件,不得静默通过 —— Task 5 篡改测试。
4. K3 内核停在复位向量区(0x0 附近)不得被误判为正常停靠 —— kernel_memory_ranges 下限 0xffffffc000000000 天然排除;b73508b 修复由 Task 6 回归守住。
5. launch 配置缺 user_memory_ranges 时状态机不崩(默认空数组)—— Task 4 模板含 U 区,Task 6 现有 testOSDebugFlow 覆盖默认路径。

---

### Task 1: 冻结 async-os-original 基线 + Host-DWARF 构建脚本

**仓库:** `/home/iris/data/async-os-original`(分支 `feat/k3-port`,当前工作区脏)

**Files:**
- Commit: 现有未提交改动(K3 移植 + 调度器修复等,见 `git status`)
- Create: `scripts/k3_host_dwarf_build.sh`
- Create(构建产物): `artifacts/k3-host-dwarf/asyncos.elf`、`asyncos.bin`、`manifest.json`

**Interfaces:**
- Produces: `manifest.json` 字段 — `commit`(git 提交哈希)、`elf_sha256`、`bin_sha256`、`source_files`(`{相对路径: sha256}`,取自 `git ls-files` 中 K3 平台相关文件)。Task 5 依赖此格式。

- [ ] **Step 1: 冻结提交**
```bash
git add -A
git commit -m "feat(k3): 冻结 K3 移植基线(上板跑通 coroutine_test,SMP=1)"
```
commit message 不带 AI 署名(本仓库约定)。

- [ ] **Step 2: 写 `scripts/k3_host_dwarf_build.sh`**

脚本行为(顺序固定):① `export CARGO_PROFILE_RELEASE_DEBUG=true`(保证 release ELF 带 DWARF);② `make build A=apps/coroutine_test PLATFORM=riscv64-k3 ARCH=riscv64 MODE=release SMP=1 LOG=info`;③ 从 cargo 输出/`apps/coroutine_test/` 定位 ELF 与 bin,`objcopy` 输出到 `artifacts/k3-host-dwarf/asyncos.elf`、`asyncos.bin`;④ 生成 `manifest.json`(字段见 Interfaces;`source_files` 覆盖 `platforms/riscv64-k3.toml`、`linker_riscv64-k3.lds`、`modules/arch_boot/src/platform/riscv64_k3/`、`modules/axhal/src/platform/riscv64_k3/` 下的文件)。

- [ ] **Step 3: 运行并验证产物**
```bash
bash scripts/k3_host_dwarf_build.sh
readelf -S artifacts/k3-host-dwarf/asyncos.elf | grep -q debug_   # 有 DWARF 段
cat artifacts/k3-host-dwarf/manifest.json                          # 四字段齐全
```
Expected: 构建成功;grep 命中(ELF 带调试信息);manifest 字段齐全。

- [ ] **Step 4: 提交脚本**
```bash
git add scripts/k3_host_dwarf_build.sh
git commit -m "feat(k3): Host-DWARF 构建脚本(一次构建产出 bin+elf+manifest)"
```

---

### Task 2: 适配器小改——attach 时 QEMU 启动可选化

**Files:**
- Modify: `src/gdbDebugSession.ts:265-268`(删除硬错误)、`:420-437`(QEMU 终端启动包进条件)
- Modify: `package.json:49`(`required` 从 `["target","cwd","qemuPath","qemuArgs"]` 改为 `["target","cwd"]`)
- Test: `src/test/testAttachNoQemu.ts`(新建,mock harness 参照 `src/test/testOSDebugFlow.ts`)

**Interfaces:**
- Consumes: `attachRequest(response, args)` 现状;`launchGDB(config)`;`runInTerminalRequest(...)`
- Produces: attach 语义变更 — `qemuPath`/`qemuArgs` 缺省时跳过 QEMU 终端、直接 `launchGDB(config)`;提供时行为不变。

- [ ] **Step 1: 写失败测试 `testAttachNoQemu.ts`**

断言①:config 不含 qemuPath/qemuArgs → `attachRequest` 完成后:未调用 `sendErrorResponse`、未调用 `runInTerminalRequest`、调用了 `launchGDB`。
断言②:config 含 qemuPath+qemuArgs → 调用了 `runInTerminalRequest`(参数含 QEMU 路径),不直接调用 `launchGDB`。

- [ ] **Step 2: 运行测试确认失败**
```bash
npm run compile && node out/test/testAttachNoQemu.js
```
Expected: FAIL(当前代码在 gdbDebugSession.ts:265 直接报 103 错误返回)。

- [ ] **Step 3: 实现**

gdbDebugSession.ts:265-268 删除整段硬错误;:420-437 改为 `if (config.qemuPath && config.qemuArgs?.length) { ...现有终端启动逻辑... } else { this.launchGDB(config); }`;package.json:49 required 改 `["target","cwd"]`。

- [ ] **Step 4: 重跑测试**
```bash
npm run compile && node out/test/testAttachNoQemu.js
```
Expected: PASS(两条断言)。

- [ ] **Step 5: 提交**
```bash
git add src/gdbDebugSession.ts package.json src/test/testAttachNoQemu.ts
git commit -m "feat: attach 模式 QEMU 启动可选化——连外部远程桩无需 QEMU"
```

---

### Task 3: K3 调试资产移植到 `testcases/k3-async-os/`

**Files:**
- Create: `testcases/k3-async-os/openocd/interface/jlink.cfg`(原样取自 `638f7a9`)
- Create: `testcases/k3-async-os/openocd/target/spacemit-k3.cfg`(原样取自 `638f7a9`)
- Create: `testcases/k3-async-os/start_openocd.sh`(取自 `638f7a9`,路径占位符改 async-os 工作区)
- Create: `testcases/k3-async-os/k3_boot_state_machine.py`(**取 `638f7a9` 真版**,不要 async-integration HEAD 的委托空壳)
- Create: `testcases/k3-async-os/boot_golden_flow.sh`(同取真版)
- Create: `testcases/k3-async-os/.gitignore`

**Interfaces:**
- Produces: 状态机默认产物路径 `artifacts/k3-host-dwarf/asyncos.bin`、DTB `artifacts/k3-host-dwarf/k3.dtb`;fastboot 上传地址与 booti 命令保持 `638f7a9` 原值(`0x140000000`/`0x138000000`,已核对与 async-os 一致)。

- [ ] **Step 1: 落盘资产**
```bash
git show 638f7a9:testcases/k3-starryos/openocd/interface/jlink.cfg > testcases/k3-async-os/openocd/interface/jlink.cfg
git show 638f7a9:testcases/k3-starryos/openocd/target/spacemit-k3.cfg > testcases/k3-async-os/openocd/target/spacemit-k3.cfg
git show 638f7a9:testcases/k3-starryos/k3_boot_state_machine.py > testcases/k3-async-os/k3_boot_state_machine.py
git show 638f7a9:testcases/k3-starryos/boot_golden_flow.sh > testcases/k3-async-os/boot_golden_flow.sh
git show 638f7a9:testcases/k3-starryos/start_openocd.sh > testcases/k3-async-os/start_openocd.sh
git show 638f7a9:testcases/k3-starryos/.gitignore > testcases/k3-async-os/.gitignore
```

- [ ] **Step 2: async-os 化改造**

状态机中 `starryos` 相关(约 10 处):产物路径 `artifacts/starryos/*.bin` → `artifacts/k3-host-dwarf/asyncos.bin`;DTB → `artifacts/k3-host-dwarf/k3.dtb`;超时参数名/环境变量 `K3_STARRYOS_TIMEOUT` → `K3_ASYNCHOS_TIMEOUT`(数值不变)。`start_openocd.sh` 中 StarryOS 工作区占位符改为 async-os-original 工作区。fastboot/booti 命令与地址**不动**。

- [ ] **Step 3: 离线验证**
```bash
python3 testcases/k3-async-os/k3_boot_state_machine.py --help
```
Expected: 帮助输出正常、无导入错误;`--check`/离线路径(如有)无硬件可跑通。

- [ ] **Step 4: 提交**
```bash
git add testcases/k3-async-os
git commit -m "feat: 移植 K3 调试资产(OpenOCD 配置 + golden flow 状态机)并 async-os 化"
```

---

### Task 4: K3 launch 配置模板

**Files:**
- Create: `testcases/k3-async-os/launch.json.example`

**Interfaces:**
- Produces: 模板全部字段,Task 8 会话直接复制使用。

- [ ] **Step 1: 确认边界函数名**

从 async-os-original 源码确认:K→U = `user_return`(来源:async-debug 提交 ad02117 提交说明);U→K = trampoline 陷阱入口函数(从 `modules/trampoline/src/lib.rs` 与 `modules/taskctx/src/arch/riscv/mod.rs` 确认实际符号名)。两个名字填入 border_breakpoints 的 function 字段,direction 分别 `kernel_to_user`/`user_to_kernel`。

- [ ] **Step 2: 写模板**

`type: "ardb"`、`request: "attach"`、`target: "localhost:3333"`、`gdbpath: "gdb-multiarch"`、`executable: "${env:ASYNC_OS_WORKSPACE}/artifacts/k3-host-dwarf/asyncos.elf"`、`cwd: "${env:ASYNC_OS_WORKSPACE}"`、`program_counter_id: 32`、`first_breakpoint_group: "kernel"`、`second_breakpoint_group: "user"`、`kernel_memory_ranges: [["0xffffffc000000000","0xffffffffffffffff"]]`、`user_memory_ranges: [["0x0000000000000000","0x0000000040000000"]]`(K3 用户区 heap 0x3FA00000/stack 0x3FE00000/trampoline 0x40000000,取自 riscv64-k3.toml)、border_breakpoints(Step 1 的函数名)。**不含 qemuPath/qemuArgs**(验证 Task 2 成果)。

- [ ] **Step 3: 核对**

对照设计文档第七节地址表逐项核对 ranges;JSON 语法校验(`python3 -m json.tool`)。

- [ ] **Step 4: 提交**
```bash
git add testcases/k3-async-os/launch.json.example
git commit -m "docs: K3 attach launch 配置模板(单核、含 K→U 边界)"
```

---

### Task 5: Host-DWARF 校验脚本

**Files:**
- Create: `testcases/k3-async-os/verify_k3_workspace.py`

**Interfaces:**
- Consumes: Task 1 的 `manifest.json` 格式;参数 `--workspace`(async-os-original 路径)。

- [ ] **Step 1: 写脚本**

检查顺序:① elf/bin/manifest 存在;② `elf_sha256`/`bin_sha256` 与实际文件一致;③ `git rev-parse HEAD` 与 `manifest.commit` 一致且 `git status --porcelain` 为空(脏树 → FAIL 并提示先冻结);④ `source_files` 每个文件重新 sha256 比对,不一致 → FAIL 并打印该文件路径。全部通过输出 `PASS`。

- [ ] **Step 2: 真构建验证**
```bash
python3 testcases/k3-async-os/verify_k3_workspace.py --workspace /home/iris/data/async-os-original
```
Expected: PASS(对 Task 1 的真实产物)。

- [ ] **Step 3: 篡改测试**

改 manifest 中任一 `source_files` 的哈希值 → 重跑 → Expected: FAIL 且报错指明该文件;还原 manifest。

- [ ] **Step 4: 提交**
```bash
git add testcases/k3-async-os/verify_k3_workspace.py
git commit -m "feat: Host-DWARF 工作区离线校验脚本(身份对齐)"
```

---

### Task 6: 回归 + 收尾

- [ ] **Step 1: TS 测试套件全绿**
```bash
npm run compile
for f in out/test/test*.js; do node "$f" || exit 1; done
```
Expected: 全部 PASS(重点:testAttachNoQemu、testOSDebugFlow、testOSStateMachine、testBreakpointGroupsTraceState)。

- [ ] **Step 2: Python GDB 测试(能跑则跑)**

按每个 `src/test/test_*.py` 文件头注释的 `gdb -batch` 方式运行;无法运行的记录原因(本计划不修改 Python 侧,结果仅作基线参考)。

- [ ] **Step 3: 提交(如有遗漏文件)**

`git status` 检查,确保 testcases/k3-async-os 与 src 改动全部入库;补充提交。

---

### Task 7(门槛:固件文件已收到 + J-Link 已插入) 硬件链打通

- [ ] **Step 1:** 固件放入约定目录(FSBL.bin、k3-jtag-ram-opensbi-uboot.itb)。
- [ ] **Step 2:** FORCE_RECOVERY 上电,跑 `boot_golden_flow.sh`。Expected: 串口出现 `Debug JTAG enabled on MMC1 pins` 与 U-Boot 横幅。
- [ ] **Step 3:** `start_openocd.sh` 启动 OpenOCD(SECJTAG `irscan 0x98` 解锁)。Expected: OpenOCD 监听 3333/4444/6666。
- [ ] **Step 4:** `gdb-multiarch -ex "target remote localhost:3333" -ex "info registers"`。Expected: 读出寄存器 = 硬件链打通。
- 全程陪用户实操(J-Link 接线、串口权限、断电重来节奏)。

### Task 8(门槛:Task 7 通过) 真板端到端

- [ ] **Step 1:** 状态机启动 Host-DWARF 构建的 async-os(用户态程序按《K3开发记录-05》打包传输)。
- [ ] **Step 2:** VS Code 扩展开发宿主 + Task 4 launch 模板(填 ASYNC_OS_WORKSPACE)→ attach。
- [ ] **Step 3:** Gen Whitelist → Apply → Trace 任意异步函数 → 板上触发 → History/Snapshot 出结果(内核态)。
- [ ] **Step 4:** 用户态跟进:K→U border 断点、用户程序 ELF 符号,同一流程验证。
- [ ] **Step 5:** 每会话前后按前人 RUN_DIR 习惯归档 before/after 证据文件。
- [ ] **Step 6:** 回写文档:验证结果更新进 docs/dev/K3移植/。
