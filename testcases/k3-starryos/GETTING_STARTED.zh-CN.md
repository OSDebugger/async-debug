# ARD + K3 StarryOS N Host-DWARF 完整上手教程

本教程面向第一次使用 ARD、StarryOS 和 K3 COM260 的开发者：从启动已有 OS，到用 `sleep 1` 触发定时 Future，再读取历史与暂停快照。唯一 OS 基线是 **N Host-DWARF**。ARD 仓库不提供完整固件、rootfs 或 N 工作区；请先准备已在自己的板卡上验证过的启动环境。

本文按当前工作区的脚本和 UI 编写。**本次文档工作只做源码、ELF 和离线校验，没有启动真板或连接 GDB/OpenOCD。** 下文“应看到”是读者操作时的检查目标；历史记录与本次运行结果分开说明。启动成功、白名单加载成功、运行事件产生、关系验证通过是四件不同的事。

## 0. 准备环境与终端

需要 Linux 主机、K3 COM260、已验证的 J-Link/JTAG/UART 连接、匹配的 N Host-DWARF 工作区，以及 VS Code（项目要求 >= 1.80）、Node.js/npm、Python 3.10+、Git、GNU readelf 和支持 RISC-V/Python 的 `gdb-multiarch`。外部 N 入口还依赖其配置指定的固件、BIN/FIT/DTB、fastboot、mkimage、minicom 和已准备的 UFS rootfs；ARD 不下载或生成这些资产。

目录示意（两个工作区不能混淆）：

```text
任意主机目录/
├── async-debug/                         ← ARD 仓库，VS Code 窗口 A
│   ├── .vscode/launch.json              ← 启动扩展开发宿主
│   ├── src/、async_rust_debugger/
│   └── testcases/k3-starryos/
└── K3_COM260_StarryOS_N_HOST_DWARF/      ← N 工作区，VS Code 窗口 B
    ├── .vscode/launch.json              ← 第 4 步创建，启动 ARD 调试会话
    ├── boot_n_candidate.sh
    ├── scripts/、configs/candidate.json
    ├── artifacts/starryos.elf、manifest.json
    ├── source/                         ← 与 ELF 匹配的 OS 和依赖源码
    └── temp/                           ← 构建记录、白名单、ARD 日志与快照
```

操作链与各窗口职责：

```text
主机终端 T1：启动 N → UART 输出 → minicom / StarryOS Shell → sleep 1
主机终端 T2：已验证 OpenOCD → J-Link → K3 JTAG
VS Code A：ARD 仓库 → F5 → Extension Development Host（窗口 B）
VS Code B：打开 N 工作区 → launch.json → ARD → GDB → localhost:3333
          → Gen Whitelist → Apply Whitelist → Trace → 用户断点 → Continue
          → UART sleep 1 → DAP stopped → Observer / History JSON / Snapshot
```

| 端口 | 服务 | 本教程中的用途 |
| --- | --- | --- |
| `3333` | GDB remote | **ARD 的 `remote` 必须是 `localhost:3333`** |
| `4444` | OpenOCD Telnet | OpenOCD 管理接口，不是 GDB remote |
| `6666` | OpenOCD Tcl | Tcl 接口，不是 GDB remote |

先在主机终端设置真实路径，后续示例中的占位路径必须替换：

```bash
export ARD_REPO=/absolute/path/to/async-debug
export STARRYOS_WORKSPACE=/absolute/path/to/K3_COM260_StarryOS_N_HOST_DWARF
export K3_OPENOCD_LAUNCHER=/absolute/path/to/existing-verified/start_openocd.sh
cd "$ARD_REPO"
command -v gdb-multiarch
python3 testcases/k3-starryos/verify_n_workspace.py \
  --workspace "$STARRYOS_WORKSPACE" \
  --openocd-launcher "$K3_OPENOCD_LAUNCHER"
```

此主机检查只读 ELF、manifest 和源码身份，输出 JSON；A 失败时先解决不匹配。即使 A 为 PASS，B–G 和整体状态仍是 PENDING，不能据此宣布真板调试通过。完整文件契约见 [K3 README](README.md)。改变工作区路径不会自动迁移 `candidate.json` 内部的绝对路径、固件依赖和板卡身份约束。

每次实际调试前，在主机终端创建独立记录目录，并保存旧的会话文件，避免生成白名单或 Snapshot 覆盖唯一证据：

```bash
cd "$ARD_REPO"
mkdir -p "$ARD_REPO/temp"
RUN_DIR=$(mktemp -d "$ARD_REPO/temp/k3-n-debug-XXXXXXXX")
mkdir -p "$RUN_DIR/before" "$RUN_DIR/after"
for item in poll_functions.txt poll_functions_grouped.json ardb.log ardb_snapshot.json debug; do
  if [ -e "$STARRYOS_WORKSPACE/temp/$item" ]; then
    cp -a "$STARRYOS_WORKSPACE/temp/$item" "$RUN_DIR/before/"
  fi
done
printf '本次记录目录：%s\n' "$RUN_DIR"
```

`RUN_DIR` 是主机归档目录，和 OS 工作区里由 ARD 使用的 `temp/` 不同。后者包含持续追加的日志及会被更新的最新快照；分析时必须区分旧事件和本次新增事件。

## 1. 启动 StarryOS（终端 T1）

按已经验证的板卡流程进入 BootROM Recovery，保证 UART 未被其他串口程序占用。在前台交互终端、ARD 仓库根目录使用 [boot_golden_flow.sh](boot_golden_flow.sh)：

```bash
sudo ./testcases/k3-starryos/boot_golden_flow.sh \
  --workspace /absolute/path/to/K3_COM260_StarryOS_N_HOST_DWARF
```

真实调用链是：

```text
boot_golden_flow.sh
  → k3_boot_state_machine.py --operation boot
  → <N工作区>/boot_n_candidate.sh --image host-dwarf
  → <N工作区>/scripts/candidate.py
```

包装器使用 `exec` 交接进程，保留外部入口的终端和退出状态，不复制启动状态机，也不追加 `--boot`、串口或超时参数。当前 N 入口不显式指定模式时默认启动、从 bootrom 开始并启用控制台；显式添加 `--boot` 会改变默认起点，因此不要自行补上它。

也可以直接使用 N 的权威入口，下面是**作者当前机器路径示例**；其他开发者必须替换为自己的工作区：

```bash
sudo /home/user/ARD_Deploy/K3_COM260_StarryOS_N_HOST_DWARF/boot_n_candidate.sh \
  --image host-dwarf
```

两种入口选一种执行。成功流程应出现固件/U-Boot、StarryOS 启动 UART 输出，最终检测 Shell 提示符并记录 `N_SHELL_READY`。当前外部入口默认在 N 工作区 `logs/<独立运行目录>/` 保存 UART 和 `boot-result.json`；随后关闭脚本的 UART 句柄，交给前台 minicom，日志提示：

```text
[CONSOLE] UART released; minicom foreground. Press Enter for a fresh Shell prompt; Ctrl-A Q exits without reset.
```

此时按 Enter 确认新 Shell 提示符。T1 仍在 minicom 内，命令未回到主机 Bash 是正常交接；不要另开第二个串口读取器。退出 minicom 使用 Ctrl-A 后 Q。若停在 `[FAILED]` 或未出现 Shell，查看该次 `host.log`、`failure.json`、`uart.raw` 和控制台交接记录，先处理启动问题。

N 启动可能写入正常可写 rootfs；本教程沿用准备好的启动资产和外部入口，不提供重新刷写/构建替代流程。Shell 可用仅说明 OS 已启动，尚未证明 ARD、事件采集或异步关系成功。

## 2. 启动 OpenOCD（独立终端 T2）

在 T2 重新设置路径（T1 的 shell 环境不会自动传到另一终端），运行 [start_openocd.sh](start_openocd.sh)：

```bash
export STARRYOS_WORKSPACE=/absolute/path/to/K3_COM260_StarryOS_N_HOST_DWARF
export K3_OPENOCD_LAUNCHER=/absolute/path/to/existing-verified/start_openocd.sh
cd /absolute/path/to/async-debug
./testcases/k3-starryos/start_openocd.sh
```

当前包装器实际支持的等价显式写法是：

```bash
./testcases/k3-starryos/start_openocd.sh \
  --workspace /absolute/path/to/K3_COM260_StarryOS_N_HOST_DWARF \
  --openocd-launcher /absolute/path/to/existing-verified/start_openocd.sh
```

Python 参数优先于环境变量，再取配置 JSON。两个 shell 包装器还会先加载 `K3_CONFIG_FILE` 指定文件（默认 `config/baseline.env`，若存在）；该文件的赋值可能覆盖先前 export。可由 [baseline.env.example](config/baseline.env.example) 准备本地配置，但要核对实际值。

`K3_OPENOCD_LAUNCHER` 必须是一个存在且可执行的外部启动文件，不能是带参数的命令字符串，不能指回 ARD 包装器。当前包装器以单元素 argv 执行它，**不透传额外 OpenOCD 参数**。复用已经验证的 K3/J-Link 配置（当前示例约束为 cluster 0/core 0、100 kHz），其 OpenOCD 可执行文件和 Tcl 依赖也须准备好。仓库 `openocd/` 下配置只是参考，并非包装器自动选择的配置。

检查该入口的实际输出或日志，确认 J-Link/目标初始化成功且出现类似下列监听信息；出现一行端口信息不代表全部初始化完成：

```text
Listening on port 3333 for gdb connections
Listening on port 4444 for telnet connections
Listening on port 6666 for tcl connections
```

保留服务进程，不要同时运行多个会争抢 J-Link 的 OpenOCD 实例。ARD 后续会启动自己的 GDB，同一目标不要再接第二个独立 GDB 客户端。若外部入口要求权限，按已验证入口的使用方式处理；使用 sudo 时注意环境变量可能被清除，可使用上述显式路径参数。

## 3. 打开 ARD 双窗口环境

在主机上进入 ARD 仓库：

```bash
cd /absolute/path/to/async-debug
npm install
npm run compile
code .
```

1. **窗口 A**打开的是 ARD 仓库。在“运行和调试”中选 **Extension Development Host**，按 F5。仓库 [.vscode/launch.json](../../.vscode/launch.json) 会通过 `npm: compile` 编译，并以 `--extensionDevelopmentPath=${workspaceFolder}` 加载此仓库扩展。
2. 出现 **Extension Development Host** 新窗口 B 后，在 B 内用“文件 → 打开文件夹”打开 N Host-DWARF 工作区根目录。
3. 确认 B 仍是 Extension Development Host。可在命令面板运行 VS Code 的 `Developer: Show Running Extensions`，检查 **Async Rust Debugger**；命令面板应有 **Open Async Inspector**。调试配置类型应识别 `ardb`。如果 B 变成普通窗口，回到 A 重新启动开发宿主，不要把已安装的旧版扩展当作本次代码。

A 的 launch 配置启动“扩展开发宿主”，B 的 launch 配置启动“OS 调试会话”，两者职责不同。下面使用 `${workspaceFolder}`，它必须指向 B 当前打开的 OS 工作区。把 OS 的 `.vscode/launch.json` 放在其他目录、N 的 `source/` 下，或误覆盖 A 的配置，都无法得到本教程的路径解析结果。

## 4. 在 OS 工作区根目录创建 `.vscode/launch.json`

在窗口 B 的资源管理器根目录下创建目录 `.vscode`，在其中创建文件 `launch.json`；只创建一个空 `.vscode` 文件夹不会产生调试配置。若文件已经存在，先备份，然后合并配置，不要覆盖已有条目。

以下完整 JSON 对照了 [launch.json.example](launch.json.example) 和当前扩展 [package.json](../../package.json) 的 launch schema。示例用 `${workspaceFolder}` 替代仓库示例中的环境变量：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "K3 StarryOS N Host-DWARF ARD",
      "type": "ardb",
      "request": "launch",
      "program": "${workspaceFolder}/artifacts/starryos.elf",
      "cwd": "${workspaceFolder}",
      "remote": "localhost:3333",
      "gdbPath": "/usr/bin/gdb-multiarch",
      "enableOsDebug": false
    }
  ]
}
```

| 字段 | 用途与检查 |
| --- | --- |
| `type` | ARD 注册名 `ardb`，不是其他 GDB 扩展的类型 |
| `request` | `launch` 启动 ARD 管理的 GDB 进程，并连接已运行的 remote |
| `program` | N 的 Host-DWARF ELF；必须匹配板上镜像与源码，不能用 BIN/FIT 替代 |
| `cwd` | 当前 N 工作区；扩展工厂还以会话工作区的 `temp/` 存放白名单等文件 |
| `remote` | `localhost:3333`，OpenOCD 必须已就绪 |
| `gdbPath` | 用 `command -v gdb-multiarch` 的结果替换；PATH 可靠时也可写 `gdb-multiarch`，注意大写 P |
| `enableOsDebug` | 保持 `false`，本流程不启用额外 OSStateMachine/地址空间切换配置 |

仓库示例还含 `stopOnEntry: false`，但当前 launch schema 未声明此字段，remote launch 路径也不消费它；因此这里省略，不能依靠它控制远端停止行为。此配置没有启动 OS/OpenOCD 的 preLaunchTask，ARD 的 launch **不会自动启动 StarryOS 或 OpenOCD**。

在 B 的“运行和调试”选择 **K3 StarryOS N Host-DWARF ARD** 后 F5。检查 Debug Console 没有连接错误、GDB Python 出现 `[ARD] installed. Commands: ...`，Call Stack/线程可用，Inspector 自动打开；未打开时用 **Open Async Inspector**。远端初次停止可能在 idle、汇编或缺少源码的固件位置，不能要求一连接就停在 Rust Future；后续定时 Future 用户断点必须能映射到匹配的 Rust 源码。

配置和读取快照时让目标处于暂停状态；若仍在运行，用 B 的 Pause。迁移工作区后若 DWARF 仍记录旧路径，在 **B 的 Debug Console** 中设置匹配映射，例如：

```gdb
set substitute-path /original/workspace/source /absolute/path/to/K3_COM260_StarryOS_N_HOST_DWARF/source
```

这只修正路径，不修复 ELF/源码版本差异。依赖 crate 的旧路径可能也需要映射。当前 `launchRequest` 没有将 `autorun` 转交给 remote 启动流程，故本教程直接使用 Debug Console，不依赖在 launch JSON 中加入 `autorun`。主机 checker 的 `--source-prefix-map` 同样不会替你设置 GDB。

## 5. 生成、筛选并加载异步白名单

### 5.1 按真实 Inspector UI 操作

在 B 的暂停会话中点击 **Gen Whitelist**。实际调用为 `ardb-gen-whitelist`：读取当前 ELF 在 GDB 中的函数信息，生成 N 工作区下的：

- `temp/poll_functions_grouped.json`：按 crate 分组，含 `name`、`file`、`line`、`kind` 等元数据。
- `temp/poll_functions.txt`：实际用于运行时白名单匹配的平面列表；Gen 默认写入空白名单，必须继续选择 crate 并 Apply。

在 Whitelist 区展开 `ax_task`（可能归在 Your Crates 或 Framework / Library，按名称找）。取消其他 crate 的勾选，勾选 `ax_task`，勾选 **Async only**，点击 **Apply Whitelist**。Async only 在点击 Apply 时才生效，按 `kind == "async"` 筛选；它不会即时隐藏列表中的 Sync 条目。每个符号有 **Trace**、**Locate**，没有逐函数启用复选框。Apply 是 crate 级筛选，通常得到多于两项的结果。

通知 `Whitelist updated: 1 crate(s) enabled` 只表示 UI 请求完成。还要在 Debug Console 检查 `[ARD] whitelist updated: ... symbols, observers=...`，并打开实际 `poll_functions.txt` 检查内容及日志中的安装错误。手写 Future 的 `poll` 依赖 grouped 中的 async 元数据分类，因此不要删除 grouped 文件。

### 5.2 收敛为已知两符号场景

先使用下面两个完整 GDB 符号，目标是观察定时等待：

```text
ax_task::future::time::sleep_until::{async_fn#0}
ax_task::future::time::{impl#1}::poll
```

```text
sleep_until::{async_fn#0}
    → TimerFuture::poll
```

为了真正只跟踪这两项，在暂停状态、备份刚生成的 flat/grouped 文件后，用 B 编辑 `temp/poll_functions.txt`，将内容设为上面两行（无编号、无额外引号）。保持 grouped 元数据。再在 **B 的 Debug Console** 输入以下原生 GDB 命令，不需要 `-exec` 前缀：

```gdb
ardb-load-whitelist
```

文件 watcher 可能已自动重载，显式命令便于核对结果。最小配置应报告 `exact=2 prefix=0 observers=2`，文件路径应在当前 N 工作区。安装数量还需结合后续实际命中检查，pending/未解析位置不能算有效采集。改为两行后，不要再次点击 Apply 或 Gen，否则会重新生成更大范围的白名单。

可以在主机终端核对：

```bash
cat "$STARRYOS_WORKSPACE/temp/poll_functions.txt"
rg -n 'whitelist runtime observer install failed|unmatched quote' \
  "$STARRYOS_WORKSPACE/temp/ardb.log"
```

`rg` 没有匹配时退出码 1 是正常结果。保留全名中的 `{async_fn#0}`、`{impl#1}` 及泛型参数；不要用显示简称 `TimerFuture::poll` 替代实际符号，也不要擅自删除嵌套泛型内容。

当前解析链有实际限制：grouped 生成器对复杂函数指针泛型可能截断，flat 读取器对“数字编号 + 含空格符号”会按空白拆词。历史 grouped 中就有 `starry_kernel::syscall::task::schedule::sleep_impl<fn` 这样的截断项。发生 `unmatched quote`、函数找不到或 `whitelist runtime observer install failed` 时，先比对 grouped/flat 与 GDB `info functions`，恢复可解析的完整符号；含空格符号使用无编号整行格式。若当前 GDB 无法确认，不将该项列为成功观测。本教程两项不含这种泛型空格问题。

### 5.3 `task` 命名空间检查与证据边界

N 源码中的睡眠路径为：

```text
sys_nanosleep / sys_clock_nanosleep           同步 syscall 入口
  → sleep_impl                              同步函数
    → block_on(interruptible(sleep(dur)))
      → ax_task::future::time::sleep          async fn
        → sleep_until                        async fn
          → TimerFuture(key).await           手写 Future::poll
```

具体用户态 `sleep` 走哪一个 syscall，取决于 rootfs 中的程序；新一轮 `sleep 1` 必须用实际停点/事件确认。当前检索结果如下（路径相对 N 工作区）：

| 候选 | 源码与选择判断 |
| --- | --- |
| `ax_task::future::time::sleep_until::{async_fn#0}` | `source/os/arceos/modules/axtask/src/future/time.rs` 中的 `pub async fn sleep_until`；源码显式 await TimerFuture，历史 N 日志有该完整符号的 poll-entry 事件，选为 Trace Root |
| `ax_task::future::time::{impl#1}::poll` | 同文件 `impl Future for TimerFuture`；历史 grouped 标为 async，历史 RuntimeEvent/Snapshot 有记录，选为观测子节点 |
| `starry_kernel::syscall::task::schedule::sys_clock_nanosleep` | `source/os/StarryOS/kernel/src/syscall/task/schedule.rs`，普通 `pub fn`，ELF 中存在，但不是异步函数 |
| `starry_kernel::syscall::task::schedule::sleep_impl::<fn() -> core::time::Duration>` | 同文件普通 `fn sleep_impl`；这里给出的是 `nm -C` 的完整解码名，不保证等于 GDB 可直接接受的命名；不能把它说成 async |
| 源码 `starry_kernel::task::wait_on_pollset<T>` | `source/os/StarryOS/kernel/src/task/mod.rs` 的 `pub async fn`，用于 PollSet 等待；未确认它是 `sleep 1` 的定时路径，未得到适合本例的独立完整 GDB async 符号，因此不推荐替换上述两项 |

本次只读核对的 N ELF SHA256 为 `c1e2904f86f0540a8f955dbdaf764e7938b86eaf83672a3262055e855edc486e`。`nm -C` 与 `addr2line` 静态确认 TimerFuture poll 位于 `0xffffffff802d8506`，DWARF 指向 `time.rs:119`；sleep_until closure 位于 `0xffffffff8022983a`，指向 `time.rs:136`。这些是该 ELF 的映射，不是任何重编译版本都适用的断点地址。`nm` 显示的 `{closure#0}` 与 GDB/grouped 的 `{async_fn#0}` 命名不同，白名单以当前 GDB 生成结果为准。

历史材料：2026-10-12 N 工作区 `temp/ardb.log` 有这两类事件及关联 admission `ALLOW`，`temp/debug/last_snapshot_v1_envelope.json` 有 TimerFuture 非空快照；已有阶段记录还包含人工报告的初步 History/Observer 观察。它们支持选择定时场景，不能证明本次已执行 `sleep 1`、全部关系可信，或所有进入/退出计数完整。当前未确认 `starry_kernel::...::task` 下另一个由本例触发的异步目标；不要用同步函数或未触发的候选凑数。

## 6. 选择 Trace Root 并准备停点

1. 在 Whitelist 中找到完整 `ax_task::future::time::sleep_until::{async_fn#0}`，点击它右侧 **Trace**。
2. 右侧 Trace Root 区应显示该全名；成功请求后通知 `Trace root: ...`，Debug Console 应有 `[ARD] trace root: ...`。重复选择可能显示 `trace root already selected`。
3. 若出现 `warning: root not in whitelist`，回第 5 步检查 flat。Trace 是显示根选择，**不会替代白名单安装探针**，也不会恢复目标执行。
4. 在 Debug Console 检查状态和内部断点：

   ```gdb
   ardb-trace-status
   maint info breakpoints
   ```

   前者 JSON 的 `data.roots` 应包含所选根，`runtime_probe_count` 应非零；后者可查看含内部断点的位置/启用情况。普通 VS Code Breakpoints 列表或 `info breakpoints` 可能不展示内部断点。`enabled` 属于另一套 machine trace 控制状态，不能单靠该布尔值判定 UI Trace 成功或失败；以白名单加载、有效探针及真实事件为准。
5. 安装一个用户可见断点后，再按 B 的 Continue/F5 恢复目标。

**为何推荐用户断点：** 当前白名单 `RuntimeEventBP` 是 `internal=True`，命中后采集事实通常返回 False 自动继续。等待观测点可以得到事件，但通常不会触发可见的 DAP stopped。若已有用户停点可直接等待；否则按下一步设置用户源码断点，不要无限等待内部观测断点替你停住。

## 7. UART 执行 `sleep 1`，等待用户断点

先在 B 的暂停会话中，用 TimerFuture 条目的 **Locate** 定位源码。在 `source/os/arceos/modules/axtask/src/future/time.rs` 的 `TimerFuture::poll` 函数体设置断点，优先选择 `with_current(|r| r.poll(&self.0, cx))` 所在可执行行。以当前 ELF 的 DWARF 映射为准，不硬套文件行号；本次静态核对的函数入口映射是 119 行。

也可在 **B 的 Debug Console** 查询并设置完整符号断点：

```gdb
info line 'ax_task::future::time::{impl#1}::poll'
break 'ax_task::future::time::{impl#1}::poll'
info breakpoints
```

这里 GDB `break` 使用单引号保护 Rust 符号；flat 文件里不加这些引号。若源码断点显示未验证/空心，先解决符号、路径或地址映射问题。随后在 B 按 Continue/F5，再去 **T1 的 StarryOS UART Shell** 输入：

```sh
sleep 1
```

不要在主机 Bash 或 Debug Console 输入 `sleep 1`，否则没有触发板上用户进程。B 负责控制执行和采集，T1 负责板上命令交互。停在用户断点时板上 Shell 暂时没有返回提示符是正常的；调试开销和暂停也会使墙钟时间远大于一秒。

命中后逐项核对：

- B 的线程/调用栈显示暂停，用户断点高亮；这是前端收到停止通知的可见表现。需要协议证据时另外保留 DAP `stopped` 记录，不能把截图当作原始协议记录。
- 在 Debug Console 输入 `p/x $pc`、`info line *$pc`、`bt`、`info threads`，保存 PC、源码和物理调用栈；应落在目标函数或与其一致的源码映射。
- Inspector 可打开；查看 N 的 `temp/ardb.log` 新增段，查找目标符号的 `runtime_event create`、`classify result`、`admission result={'action': 'ALLOW', ...}`，并与 `ardb-get-history-tree` 的本次事件对应。不是日志里任意一个 ALLOW 都有效。
- 核对事件的函数、thread_id、cid、Future 地址以及当前调用栈。GDB thread_id 不自动等于 OS task ID；日志无法提供任务归属时记录“任务上下文未确认”，不能仅凭函数名断言来自这一次 sleep。

若用户断点太早，入口采集尚未提供需要的上下文，保留当前证据，再按受控的 Continue/下一次命中流程采集；不要把空快照改写成成功。要比较完整 enter/exit，必须允许相应 poll 返回；一直停在入口不可能凭空产生 exit。

没有命中时按顺序检查：`3333` 连接 → 目标是否已 Continue、UART 是否真执行了命令 → flat 两个完整符号/grouped 元数据 → Trace Root → 内部探针安装和用户断点实际地址。仅内部探针自动继续而未停止，不是连接失败。

## 8. 查看 History、Observer Tree 和 Snapshot

当前工具栏真实按钮为 **Gen Whitelist、Snapshot、Observer、Clear History**。**没有独立 History 按钮，也没有事件/计数详情表或通用导出按钮。** 旧版“点击 History 刷新”不适用于此代码。Observer 是累计 History Store 按 Trace Root 选择的树；完整 History 通过现有 GDB 命令读取。下列命令均在 B 的 Debug Console、目标暂停时执行。

### 8.1 History：累计执行事实

```gdb
ardb-get-history-tree
```

返回的 JSON 为 `type: history_tree`、`graph_kind: call_graph`。检查 `nodes`、`edges`、`roots`、`events`、`counts`，以及节点的 `enter_count`、`exit_count`、`first_enter_event`/`last_enter_event` 等字段。这里记录白名单允许的真实执行事实，函数级合并的节点不等同于单个 Future 实例的生命周期。

查找 sleep_until 与 TimerFuture 两个节点及其边；事件中保留父子关联来源、入场/退场和证据，别仅看树形缩进。将输出复制到本次 `RUN_DIR/after/history-1.json`，保存实际完整 JSON，不包括 GDB 提示符。允许 poll 返回后再次在 T1 执行 `sleep 1`，重新暂停、再读取保存为 `history-2.json`，对比相同节点的 enter/exit 计数和事件范围。长会话事件列表有保留上限，累计计数不一定等于当前可见事件条数。

不要在两次对比之间点击 **Clear History**：当前实现清空累计图并清除 Trace Root，随后 Observer 会为空，须重新 Trace。它不是刷新按钮，也不等价于卸载全部观测断点。

### 8.2 Observer Tree：选择根后的累计子树

点击 **Observer** 切换并刷新；Observer 模式下非 entry 的停止也会自动刷新。返回根由 `observer_root` 指明，只有已在 History 中出现的实际命中节点能组成树。没有事件时仅选 Trace Root 可以仍然是空树。

UI 显示 ASYNC/SYNC、函数名和层级，点击节点尝试跳转源码。当前 UI 不直接展示地址、enter/exit 计数或完整关系证据，使用：

```gdb
ardb-get-observer-tree
```

对照 `observer_root`、`roots[].children`、节点 `source` 和 `relation_annotations`；父节点与执行关系的详细来源继续查 History `edges/events`。把输出另存为本次 `observer-1.json`。看到了 `sleep_until → TimerFuture::poll` 只支持“此累计执行树存在这条关联”；例如来源 `recent_root_thread` 的 `call_edge_accepted` 是执行关联，不能据此宣称 Future 身份验证完整、当前 await 关系已可信成立。关系证据不足时保留 unknown/未验证。

### 8.3 Snapshot：当前暂停时刻

保持目标暂停，点击 **Snapshot** 手动采集并切换为快照树；不会因为停点变化就自动重新采集 Snapshot。继续运行后旧图可能还在，下一次停止必须再点 Snapshot。该操作不把当前快照写入累计 History。

在 Debug Console 获取可核对字段：

```gdb
ardb-get-snapshot
```

读取 envelope 的 `ok`、`data.empty`、`data.thread_id`、`data.generation` 和 `data.async_path`。每个节点检查 `function`、`future_address`、`future_type`、`source`、`active`、`poll` 和 `relation_from_parent`。与当前 PC/物理帧及任务上下文核对；非空、非空地址和类型只是各自的事实，不是关系验证的替代证据。当前 UI 只展示树，详细值从 JSON 查看。点击快照节点定位的是该次采集记录的源码，不保证是之后的新停止位置。

`poll.status: "unsupported"` 与 `empty: true` 不同。TimerFuture 是手写 Future，没有编译器生成的 `__state` 字段，历史快照因此出现 `There is no member named __state.`；仍可同时有 `empty=false`、正确 Future 类型/地址、源码和 active 信息。不要把 unsupported 写成 Ready/Pending，也不要直接判断整个 Snapshot 失败。类型为 unknown/null、缺地址或 empty 则需分别排查停点、优化/DWARF、符号与上下文。

ARD 会更新 OS 工作区的 `temp/ardb_snapshot.json` 和 `temp/debug/last_snapshot_v1_envelope.json` 等最新诊断文件；它们不能替代 History/Observer 导出。读取命令本身也会更新快照，因此连续采集应分别归档。结束本轮后，在保存 `RUN_DIR` 变量的主机终端复制最新文件（只做一次；下一轮另建目录）：

```bash
for item in poll_functions.txt poll_functions_grouped.json ardb.log ardb_snapshot.json debug; do
  if [ -e "$STARRYOS_WORKSPACE/temp/$item" ]; then
    cp -a "$STARRYOS_WORKSPACE/temp/$item" "$RUN_DIR/after/"
  fi
done
```

另保存启动运行目录、OpenOCD 日志引用、ELF SHA、PC/栈输出、History/Observer JSON 和断点/停止证据。对各检查项分别写成功、失败或待确认，不用单张截图概括全部成功。

## 9. 常见问题：现象 → 检查位置 → 处理方法

| 现象 | 检查位置 | 处理方法 |
| --- | --- | --- |
| remote 连接失败或协议异常 | B 的 launch `remote`、T2 监听日志 | 改为 `localhost:3333`；4444/6666 不能作为 GDB 端口；确认已验证 OpenOCD 服务就绪 |
| UART 没有 Shell，启动后“卡住” | T1、N 本次 `host.log/failure.json/boot-result.json`、minicom 交接输出 | 区分启动失败和前台 minicom；交接成功后按 Enter；排除其他串口占用，按外部已验证流程处理，不重复并发启动 |
| B 无 `ardb` 类型/Inspector，UI 与本文不同 | B 标题、Running Extensions、A 编译输出 | 从 A 的 Extension Development Host 配置重启 B，确认加载当前仓库而非旧安装版 |
| 找不到调试配置或 ELF | B 打开的根目录与 `.vscode/launch.json` | 将文件放在 N 工作区根目录的 `.vscode/` 内，校验 `${workspaceFolder}/artifacts/starryos.elf` |
| 停点只见汇编、源码找不到或行号不符 | `info line *$pc`、manifest、ELF SHA、source HEAD、checker | 初次 idle 停止可无 Rust 源；目标停点仍失败则检查身份；仅路径迁移用 `set substitute-path`，版本不匹配应换回匹配资产 |
| 白名单全名被截断、`unmatched quote` | grouped/flat、`info functions`、`temp/ardb.log` 安装失败行 | 恢复完整 GDB 名称；检查泛型/函数指针和编号拆词限制；最小两行无编号；重新 `ardb-load-whitelist` 后验证探针 |
| Trace Root 已显示但无 RuntimeEvent | Debug Console 的加载摘要、trace-status、内部断点和本次日志段 | Trace 只是选根；补齐白名单/元数据和探针，Continue 后在 UART 触发，确认 admission 与实际函数命中 |
| 程序继续运行却不暂停 | 用户断点列表、内部断点属性 | 内部观察通常自动继续；增加有效源码/完整符号用户断点，再执行 sleep |
| 同步函数加入白名单却不进 History | grouped `kind`、Async only、完整名称、同步探针上下文 | 先确认未被过滤、实际调用和安装成功；当前同步采集有上下文约束，不能保证任意同步函数成为独立历史根；本教程用两项已知异步目标 |
| History 非空而 Observer 无预期关系 | `observer_root` 与 History 的精确函数名、edges/events | 重新选正确 Trace Root；检查父子关联是否实际产生，保存缺边证据；不要把节点存在等同于 await 验证成功 |
| Snapshot 为空或 Future 类型不可用 | 暂停位置、async_path、DWARF、Future 指针和实际任务上下文 | 在目标 poll 停点重新采集；区分无可用 Future、类型解析失败和源码错配，不伪造类型/关系 |
| Snapshot 仅 poll state unsupported | `poll.status/error` 与 `empty/future_type/source` | 手写 TimerFuture 无 `__state` 是已知限制；保留其他可用字段及 unsupported，不改报采集失败或 Ready/Pending |
| GDB 被其他客户端占用、J-Link 打不开 | 现有终端、OpenOCD 连接/设备日志 | 确认并结束自己重复的客户端/服务，保留一个 OpenOCD 和一个 ARD 管理的 GDB；不要盲目杀进程 |
| History 计数没有按预期增加 | 两次输出事件范围、是否 Clear History、是否停在入口 | 让 poll 返回并重复板上 sleep；区分累计函数计数与单个 task/Future，未观测到 exit 就如实记录 |

## 10. 按顺序复现检查表

- [ ] 已准备且验证 N Host-DWARF 工作区、板卡连接、外部启动依赖和 OpenOCD 入口。
- [ ] 主机 checker 的 A 检查通过，理解 B–G 仍待本轮验证；已记录 ELF/源码身份。
- [ ] 新建本轮记录目录，备份已有白名单、日志和最新快照。
- [ ] T1 经 N 启动入口到达 StarryOS Shell，minicom 交接正常。
- [ ] T2 唯一 OpenOCD 初始化完成，3333/4444/6666 角色正确。
- [ ] A 打开 ARD 仓库、编译并 F5；B 确认是加载当前扩展的开发宿主。
- [ ] B 打开 N 根目录，在其 `.vscode/launch.json` 填写可解析配置和实际 GDB 路径。
- [ ] ARD 连接 `localhost:3333`，会话可暂停，Inspector 可打开。
- [ ] Gen Whitelist → 选 ax_task → Async only → Apply；核对 grouped 元数据。
- [ ] 将 flat 收敛为两行完整符号，显式 load，核对 observers 与安装错误。
- [ ] Trace 选 sleep_until，检查根与内部探针；另设可见用户断点。
- [ ] B Continue；T1 的板上 Shell 执行 `sleep 1`。
- [ ] 用户断点命中，保留 PC/Rust 源码映射、暂停证据和实际上下文。
- [ ] 本轮出现对应 RuntimeEvent 和 ALLOW，不混用旧日志或只看 Trace 通知。
- [ ] 读取 History JSON、点击 Observer 并读取其 JSON，检查实际父子关联及证据边界。
- [ ] 需要计数对比时允许 poll 返回并重复 sleep，分别保存前后 enter/exit。
- [ ] 暂停时点击 Snapshot，检查地址/类型/源码/active，将 unsupported 与空快照分开记录。
- [ ] 分别保存启动、连接、事件、历史、Observer、Snapshot 证据及失败/待确认项；不把这些步骤自动升级为完整 await 验证通过。

## 实现依据

读者无需预先阅读内部报告即可按上文操作；需要核对行为时可查以下仓库源码：

- [启动委托与参数解析](k3_boot_state_machine.py)、[工作区配置解析与主机校验](verify_n_workspace.py)。
- [扩展开发启动配置](../../.vscode/launch.json)、[调试 schema](../../package.json)、[扩展入口及 watcher](../../src/extension.ts)。
- [Inspector 按钮和请求](../../src/webview/asyncInspectorPanel.ts)、[crate/Async only/Trace 前端](../../src/webview/asyncInspector.js)。
- [会话工作区 temp 路径](../../src/debugAdapter.ts)、[remote launch、Debug Console 与 DAP](../../src/gdbDebugSession.ts)。
- [白名单生成](../../async_rust_debugger/static_analysis/gen_whitelist.py)、[白名单/探针/Trace/History/Observer/Snapshot 实现](../../async_rust_debugger/runtime_trace.py)。
