# K3 开发记录 01:进入官方 U-Boot 控制台

- **日期**:2026-11-03
- **结论**:✅ 官方 U-Boot 的 5 秒 autoboot 倒计时真实存在,打断键是字母 **`s`**(不是回车/ESC/Ctrl-C)
- **现状**:板子停留 U-Boot 命令行 `=>` 已验证;`boot` 命令可恢复正常启动 Bianbu

## 固件与软件基线(重要背景)

**板载固件全部是官方 BSP**(香蕉派 BPI-SM10 / 进迭 SpacemiT 官方 Bianbu 镜像烧录,我们没有烧过任何固件):

| 组件 | 来源 | 说明/证据 |
| --- | --- | --- |
| BootROM | 官方(芯片内置,不可改) | 上电先试 TF 卡,失败走 QSPI NOR 链 |
| NOR Flash gd25lq64c 8MiB | 官方烧录 | 分区:bootinfo/fsbl/env/esos/opensbi/uboot(env 区存 U-Boot 环境变量) |
| FSBL/OpenSBI | 官方(NOR 内) | 启动日志可见 "OpenSBI" banner |
| U-Boot | **官方 BSP 构建** | 2022.10,"Build: jenkins-BSP-build-bsp-deb-361"(Apr 30 2026);env 里有 flash 菜单、fastboot 命令;打断键 `s` 是 BSP 定制 |
| Bianbu 4.0 | 官方(UFS 上出厂预装) | SpacemiT 官方 Debian 发行版,内核 6.18.3-generic;串口登录密码未知,用 `adb shell`(直接 root) |

**前人的资产**(来自 k3gdb 博客和 async-integration 真状态机 638f7a9,**目前尚未获得源码/二进制**):

- `FSBL.bin`(artifacts/fsbl/FSBL.bin)—— JTAG 调试用的 RAM 版 FSBL
- `k3-jtag-ram-opensbi-uboot.itb` —— JTAG 调试链用的 RAM 版 OpenSBI+U-Boot FIT 镜像
- ⚠️ 这两个只在 JTAG 调试阶段才需要;**当前启动链阶段只用官方固件,不需要自备固件**

**主机/软件工具链**:

- fastboot、adb、minicom、gdb-multiarch、OpenOCD、J-Link(调试探针);`riscv64-unknown-elf-objcopy` 系统自带
- Rust `nightly-2025-07-01`(async-os-original 的 rust-toolchain.toml 要求,2026-11-03 安装)
- **网络/代理**(2026-11-03 实测):本机代理客户端("core" 进程)监听 `127.0.0.1:12450`,git 已全局配置走它(877KB/s);rustup 用 rsproxy 镜像(`RUSTUP_DIST_SERVER=https://rsproxy.cn`,600KB/s~2.6MB/s);cargo 已配 rsproxy 稀疏索引(`~/.cargo/config.toml`);官方源直连仅 13KB/s,勿直连
- `async-os-original`(AsyncModules/async-os @ `6cd803c`,2025-03-25)+ 团队本地调试修改(release 关 LTO、保留符号——Host-DWARF 方案需要)
- `async-os`(rosy233333 fork)= original + 39 个团队提交(vdso-test 分支),**用户态当前跑不起来**,暂不用
- 参考实现:tgoskits 仓库 `feat/k3-board-support` 分支(pxa_uart、riscv_aplic 驱动、spacemit-k3-com260-ifx.dts/.dtb)

## 问题

官方 U-Boot 启动时打印 "Autoboot in 5 seconds",但三次尝试(无按键、回车风暴 60ms/次、ESC/Ctrl-C 风暴 30ms/次)均无法打断自动启动,直接进了 Bianbu。环境变量里明明有 `bootdelay=5`,却没有观察到 5 秒停顿,一度怀疑倒计时失效。

## 排查过程与发现

### 1. 倒计时其实一直都在(误判修正)

第一次分析时被 bootlogo 加载误导。完整时序(第四次启动日志,板端 U-Boot 自己的时间戳):

```
[   2.213] load env_k3.txt from bootfs successful
[   2.219] Autoboot in 5 seconds
[   7.242] Try to boot from scsi0 ...
```

2.219 + 5 = 7.242,**整整 5 秒**。之前看到 [1.697] "bootlogo loaded from ufs_fs" 以为是启动动作,其实那只是给 LCD 加载开机图,发生在 banner 阶段。

### 2. 打断键是 `s`(源码证据)

提示语 "Autoboot in 5 seconds" 非标准 U-Boot 文本(标准是 "Hit any key to stop autoboot"),说明 BSP 改过 autoboot 逻辑。克隆官方仓库 `spacemit-com/uboot-2022.10` 查到:

```ini
# configs/k1_defconfig(K3 的姊妹芯片配置)
CONFIG_BOOTDELAY=0
CONFIG_AUTOBOOT_KEYED=y
CONFIG_AUTOBOOT_STOP_STR="s"
```

- `CONFIG_AUTOBOOT_KEYED=y` 开启"密码"协议:倒计时期间每 10ms 轮询串口(`common/autoboot.c` 的 `abortboot_keyed`),收到的字符序列尾部匹配到停止字符串才中止启动
- 停止字符串 = `"s"`,所以**只有字母 s 有效**,回车/ESC/Ctrl-C 全部无效
- env 的 `bootdelay=5` 覆盖了 defconfig 的 `BOOTDELAY=0`,所以显示 5 秒
- 之前看到的"55 次 ^M 按键回显"是误读——那是日志每行结尾的 CRLF 换行符,并非按键回显

### 3. 实测验证(第四次启动)

主机侧脚本在 90 秒内每 200ms 往 `/dev/ttyUSB0` 写一个 `s`:

```bash
for i in $(seq 1 450); do printf 's' > /dev/ttyUSB0 2>/dev/null; sleep 0.2; done
```

用户断电重启后,原始字节序列(hexdump 验证):

```
"Autoboot in 5 seconds\r\n"   ← 倒计时开始 [2.219]
"=> "                         ← U-Boot 命令行提示符出现!
"[   2.231] sssssss..."       ← 后续 s 被 CLI 回显
```

倒计时开始后 12ms 即被打断。随后 Ctrl-C 清掉残留输入,执行 `version`:

```
=> version
U-Boot 2022.10 (Apr 30 2026 - 11:07:27 +0800), Build: jenkins-BSP-build-bsp-deb-361
gcc (Bianbu 15.2.0-16ubuntu1bb2) 15.2.0
GNU ld (GNU Binutils for Bianbu) 2.46
=>
```

## 可复用操作步骤

### 进入 U-Boot 控制台

1. 串口已接好(115200 8N1),主机上启动按键风暴脚本(90 秒窗口)
2. 给板子断电 → 上电
3. U-Boot 在 ~2.2 秒处进入倒计时,`s` 一到即停,出现 `=>`

### 恢复正常启动

在 `=>` 提示符敲 `boot`(即执行 bootcmd = `run autoboot`),板子正常进 Bianbu。

### 注意事项

- 板端 WDT 60 秒超时,U-Boot 空闲时自己喂狗,停在命令行无风险
- 主机侧可同时跑 `cat /dev/ttyUSB0 > log` 捕获 + 另一个进程写命令:读不冲突写,可以直接用「写 /dev/ttyUSB0 → 读日志尾部」的方式远程操作 U-Boot
- 串口进入 Bianbu 后 login 密码未知(root/root、bianbu/bianbu 都不对),改用 `adb shell`(直接 root)

## 顺带发现

- U-Boot 环境变量有两层:NOR 的 mtdENV + **bootfs 上的 `env_k3.txt` 覆盖层**(227 字节,只含 knl_name/ramdisk_name/dtb_dir/ramdisk_addr/loglevel/commonargs,不覆盖 bootdelay)
- env 里有完整 bootmenu(bootmenu_0..10:Nor/Nand/MMC/UFS/Autoboot/Flash 等选项,bootmenu_delay=5),但 defconfig 未开 `CONFIG_AUTOBOOT_MENU_SHOW`,菜单不会自动弹出
- k1_defconfig 是 K3 的姊妹配置,K3 自身 defconfig 未公开,autoboot 行为与 k1 一致(已实测)
