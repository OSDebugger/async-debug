# K3 开发记录 02:async-os-original 的 K3 平台移植

- **日期**:2026-11-03
- **状态**:✅ **上板跑通**(coroutine_test 全部输出,正常 shutdown)
- **分支**:async-os-original 仓库 `feat/k3-port`(基线 6cd803c + 团队本地调试修改保留)

## 决策记录

| 决策 | 结论 | 理由 |
| --- | --- | --- |
| 用哪个仓库 | **async-os-original**(AsyncModules/async-os @ 6cd803c) | async-os(rosy233333 fork)= original + 39 提交,但 fork 用户态跑不起来;async-debug 工具链是在 original+SMP=2 上验证的 |
| 跑几个核 | 先 SMP=1 上板,通了改 SMP=2 | 副核靠 SBI HSM 拉起,若失败主核永远等待(表现为"死机"),单核可区分"内核起不来"vs"多核拉起失败";SMP=2 是 async-debug 的验证基线 |
| 移植参考 | tgoskits `feat/k3-board-support`(ArceOS K3 板级支持) | pxa_uart、riscv_aplic 驱动、dtb/dts 都有现成参考 |
| 控制台/时钟 | 第一阶段 SBI 控制台 + SBI 定时器 | qemu-virt 同款零成本;板载 OpenSBI 支持(Linux earlycon=sbi 为证) |

## 平台接口调研结论(async-os-original 的移植面)

平台适配只涉及 4 个文件 + 2 个新目录:

```
platforms/riscv64-k3.toml                        ← 新建:地址配置(axconfig 生成常量)
modules/axhal/build.rs                           ← 改:BUILTIN_PLATFORMS 两个数组加 "riscv64-k3"
modules/axhal/src/platform/mod.rs                ← 改:加 cfg 分支(platform_family 匹配)
modules/axhal/src/platform/riscv64_k3/*.rs       ← 新建:console/time/mem/misc/irq + mod.rs
modules/arch_boot/build.rs                       ← 改:同上两个数组
modules/arch_boot/src/platform/mod.rs            ← 改:加 cfg 分支
modules/arch_boot/src/platform/riscv64_k3/*.rs   ← 新建:mod.rs/boot.rs/mp.rs(启动入口)
```

axconfig 机制(Starry-OS/axconfig crate):Makefile 的 `PLATFORM=riscv64-k3` → 读 `platforms/<name>.toml` → 与 crate 内 defconfig.toml 合并(缺失字段补 0 默认值)→ 生成常量(字符串能解析成数字就输出 usize)。链接脚本 `linker.lds.S` 由 axhal/build.rs 用 KERNEL_BASE_VADDR 实例化。

## K3 地址表(全部来自 spacemit-k3-com260-ifx.dts)

| 项 | 值 | 来源 |
| --- | --- | --- |
| DRAM | 8GB @ 0x100000000,可用从 0x102000000 起(底部 32MB 固件保留) | dts memory@102000000: `reg = <0x01 0x2000000 0x01 0xfe000000>` |
| 内核加载地址 | 0x140000000 | 前人 fastboot 流程 + tgoskits FIT 加载地址 |
| DTB 加载地址 | 0x138000000 | 前人 fastboot 流程 |
| UART0 | 0xd4017000(0x100 区,reg-shift=2,PXA/xscale 兼容) | dts serial@d4017000 |
| CLINT | 0xe081c000(0x4000) | dts clint@e081c000 |
| APLIC | 0xe0804000(0x4000,0x200 源,msi-parent=IMSIC) | dts interrupt-controller@e0804000 |
| IMSIC | 0xe0400000(0x400000) | dts interrupt-controller@e0400000 |
| timebase | 24MHz | dts /cpus timebase-frequency = 0x16e3600 |
| CPU | rv64imafdcvh + smaia/ssaia/sstc/svpbmt/zicbom,sv39 | dts cpu@1 |

## 关键设计点

### 1. phys-virt-offset 沿用 0xffff_ffc0_0000_0000(与 qemu-virt 相同)

这是 2^32 的倍数,有个精妙特性:**MMU 关闭阶段,PC-relative 寻址(la/auipc)在 32 位算术里自动回绕**——虚拟地址符号 - 物理 PC = offset ≡ 0 (mod 2^32),hi20/lo12 计算出来全是 0,`la` 得到的就是物理地址。所以 `.text.boot` 和 boot 栈虽然链接在虚拟地址上,MMU 开之前一切照常工作。K3 直接沿用,链接脚本零改动。

### 2. 启动页表(boot.rs 与 qemu-virt 唯一的实质差异)

qemu 硬编码映射 0x80000000 1G 块;K3 改为按 KERNEL_BASE_PADDR 推导:

```rust
let kernel_idx = (KERNEL_BASE_PADDR >> 30) & 0x1ff; // 0x140000000 -> 5
let dtb_idx = kernel_idx - 1;                       // 0x100000000 -> 4(DTB @ 0x138000000)
let vbase = (PHYS_VIRT_OFFSET >> 30) & 0x1ff;       // -> 0x100
BOOT_PT_SV39[kernel_idx] = ((kernel_idx as u64) << 28) | 0xef; // 恒等映射 1G 块
BOOT_PT_SV39[dtb_idx]    = ((dtb_idx as u64) << 28) | 0x9f;
BOOT_PT_SV39[vbase + kernel_idx] = ...;             // 虚拟地址映射
BOOT_PT_SV39[vbase + dtb_idx]    = ...;
```

(entry = PPN2 << 28 | flags;PPN2 = phys >> 30。恒等映射保证 MMU 刚开、PC 还是物理地址时能续命;DTB 块恒等映射保证 `of` crate 用物理指针读 DTB 不页错误。)

### 3. 中断:第一阶段不需要 APLIC

SBI 定时器中断是核内通路(S_TIMER),不经过 APLIC;控制台是轮询/SBI。K3 用的是新版 AIA(APLIC+IMSIC,CPU 有 ssaia),不是 qemu-virt 的 PLIC——irq.rs 里 S_EXT 留 TODO,等 UART 等外设需要中断时再实现。

### 4. 不需要设备树之外的任何前置

time.rs 从 DTB 读 timebase-frequency;DTB 直接用板载 Bianbu 的 `/boot/spacemit/6.18.3-generic/k3_com260_ifx.dtb`(adb pull 即可,不用自己编译 dts)。

## 构建结果(2026-11-03)

```
make build A=apps/coroutine_test PLATFORM=riscv64-k3 ARCH=riscv64 MODE=release SMP=1 LOG=info
```

- 网络:第一次构建被 kill——cargo 绕开镜像直连 crates.io(Fastly,~110kbps);带 `CARGO_HTTP_PROXY=http://127.0.0.1:12450` 重启后 30 秒完成
- 产物:
  - `apps/coroutine_test/coroutine_test_riscv64-k3.bin`(916KB,rust-objcopy 剥离符号)
  - `apps/coroutine_test/coroutine_test_riscv64-k3.elf`(30.5MB,debuginfo=full,Host-DWARF 用)
- ELF 验证:`Entry point 0xffffffc140000000` = PHYS_VIRT_OFFSET(0xffff_ffc0_0000_0000)+ KERNEL_BASE_PADDR(0x1_4000_0000)✓;LOAD 段均落在 0xffffffc140000000 起 ✓

## 上板启动流程(实测可用)

```
1. adb push 内核 bin 到板端 /boot/asyncos.bin
2. 重启并在 U-Boot 5 秒窗口内用 s 键风暴打断(先挂风暴再 adb reboot,见记录 01)
3. U-Boot:
   load scsi 0:2 0x140000000 asyncos.bin  # 加载内核
   load scsi 0:2 0x138000000 k3.dtb       # 加载 DTB
   booti 0x140000000 - 0x138000000        # 启动
4. 串口输出:LOGO → 平台初始化 → app 输出 → 正常 shutdown
```

## 上板调试全过程(2026-11-03,踩坑全记录)

### 坑 1:U-Boot booti 拒绝裸 bin —— Linux RISCV Image 头

`booti` 检查镜像 0x38 处 magic `0x05435352`("RSC\x05")与 0x10 处 image_size(非零),裸 bin 报 "Bad Linux RISCV Image magic!"。

**方案演进**:
- 初版:python 脚本给 bin 前置 64 字节头(scripts/k3_image.py)
- 教训 1:U-Boot `mw.q` 手写头 text_offset 少敲一个零(0x3e00000),内核被搬到 0x105e00000
- 教训 2(⚠️ 2026-11-03 更正:此条当时归因错误,详见坑 5 与记录 03 坑 1 复盘):外部前置头让内核整体后移 64B,当时归因于"PC-relative 寻址错位"——**事后反汇编证实启动代码全是 `auipc+jalr/addi` 纯相对寻址,整体平移时目标随 PC 同步平移,跳转不受影响**;改成内嵌头后死在同一个 A→B 区间,真凶是坑 5 的页表 mmio_idx 错误。内嵌头仍是正确方案(入口约定、头字段与链接布局一致),但"64B 错位致挂死"的因果不成立
- 终版:**头内嵌进 `_start` 函数开头**(`.text.boot` 段内),头参与链接布局,链接地址=运行时地址

### 坑 2:头内 code0 被汇编器压缩

`jal x0, 64` 在 riscv64gc(C 扩展)下被压缩成 2 字节 `c.j`,后续字段整体前移 2B、magic 错位。**必须用 `.word 0x0400006f` 直接写机器码**(0x0400006f 就是 jal x0,+64 的编码)。

头部字段(text_offset 用 const 表达式 `KERNEL_BASE_PADDR - PHYS_MEMORY_BASE`):

```
.word 0x0400006f      // 0x00 code0: jal x0, +64
.word 0               // 0x04 code1
.dword text_offset    // 0x08 重定位目标 = DRAM 起点 + text_offset → 恰为加载地址(不搬移)
.dword 0x00100000     // 0x10 image_size: booti 只要求非零
.dword 1              // 0x18 flags: 小端
.word 0; .word 0      // 0x20 version; 0x24 res1
.dword 0              // 0x28 res2
.dword 0x56534952...  // 0x30 "RISCV\0\0\0"(LE)
.word 0x05435352      // 0x38 magic "RSC\x05"
.word 0               // 0x3c res4
```

### 坑 3:U-Boot 重定位 fdt + SBI legacy console 已移除 → 启动完全静默

- U-Boot 把 fdt 从 0x138000000 移到 0x2fbd5a000(靠近自身)。time.rs 早期读 dtb 指针直接页错误(此时启动页表未映射该地址,且发生在 axlog 之前——无任何输出)
- 2026 OpenSBI 已移除 legacy console 扩展,ecall 静默无效
- 修复:time.rs 不读 DTB 直接用 24MHz 常量;console.rs 改 UART0 轮询(0xd4017000,reg-shift=2,16550 布局);启动页表加 UART MMIO 块映射

### 坑 4:UART 验证方法(U-Boot 内直写寄存器)

怀疑过 UART 驱动错误,在 U-Boot 里验证硬件:`md.b 0xd4017014 1` → 0x20(THRE 置位),`mw.b 0xd4017000 0x4b` → 串口出现 'K'。**UART 硬件与寄存器布局正确,问题在内核执行本身**。

### 坑 5:探针定位死点 → 启动页表 mmio_idx 算错(1G 块 vs 64M 块)

在 _start 加 'A'(MMU 关,物理地址写 UART)/'B'(MMU 开,虚拟地址写 UART)探针二分:A 出现、B 不出现 → 死在 MMU 开启后首次虚拟访问。

真凶:**SV39 顶级页表是 1G 块**(`>>30`),当初却按 64MB 块算 mmio_idx(`0xd4000000 / 0x4000000 = 0x35`,应为 `0xd4017000 >> 30 = 3`)。虚拟 UART 地址 VPN2=0x103 无映射 → 页错误 → stvec=0 挂死。修复:`let mmio_idx = (0xd401_7000 >> 30) & 0x1ff;`

### 坑 6:bitmap page allocator 窗口溢出 —— 必须开 64g 档

跑到"Initialize global memory allocator"时 panic:`assertion failed: end <= Self::CAP`(bitmap-allocator for_range)。链路:axalloc → allocator crate → BitmapPageAllocator,窗口 `base = align_down(start, 1GB)`,end = start_idx + total_pages。

- 默认 `page-alloc-256m` 档 CAP=65536 页=256MB 窗口;qemu-virt 恰好 128MB 内存不炸
- K3:内核 0x140000000 对齐到 0x100000000,start_idx≈1.6 万页 + 7.4GB 空闲≈183 万页 → end≈185 万 ≫ 65536
- 修复:patch allocator crate 到本地 `modules/allocator`,default 改 `page-alloc-64g`(BitAlloc16M,64GB 窗口)。代价:.bss 增大 2.4MB(静态 bitmap 段树),镜像不变(NOBITS 不进 bin)

### 坑 7:bin 不含 .bss,U-Boot 加载后 DRAM 残留非零

objcopy -O binary 不输出 NOBITS 段 → U-Boot 加载的镜像不含 .bss → 全局变量依赖的零初始化无保障。修复:_start 里 MMU 开启前加 .bss 清零循环(_sbss.._ebss,sd zero)。

### 串口传输备注

- kermit(sb/loadb)与 BSP U-Boot 不兼容("Timeout on pathname");**xmodem(sx/loadx)可用**(929984 字节成功)
- 后台 cat 捕获串口会抢读字节破坏传输协议,传输前必须停掉捕获进程
- 后来改用 adb push 到 /boot + U-Boot `load scsi`,不再需要 xmodem

## 下一步

- [x] 工具链 nightly-2025-07-01 安装(rsproxy 镜像)
- [x] `make build ... SMP=1` 构建通过(带代理,30s)
- [x] 产物检查:bin 916KB / elf 30.5MB,入口地址验证 ✓
- [x] 上板跑通(coroutine_test 全部输出 + 正常 shutdown)
- [x] 干净版(去探针)上板复验 ✓(2026-11-03 19:40)
- [ ] 改 SMP=2 再验证(async-debug 的验证基线)
- [ ] 通过后把 `feat/k3-port` 提交(注意:不署 AI 名)
