#!/usr/bin/env bash
#
# k3-jtag-boot.sh — K3 JTAG 调试模式第一层引导脚本
#
# 功能：从断电上电到 OpenOCD 就绪的完整状态机。
# 范围：只覆盖第一层（JTAG 引导）。第二层（TFTP、booti）由同学自助。
# 依据：K3远程调试接入需求.md 第 5 节 (1) 冻结时序。
#
# 用法：./k3-jtag-boot.sh
# 退出码：0 = 就绪，1 = 引导失败（重试耗尽）
#
# 平台集成：解析 stdout 的 "[READY]" 行作为就绪信号。
# 引导期间串口由本脚本独占，就绪后平台转交同学终端。

set -euo pipefail

# ============================================================
# 配置项（平台按实际硬件填写）
# ============================================================

SERIAL_DEV="${K3_SERIAL_DEV:-/dev/ttyUSB0}"
SERIAL_BAUD="${K3_SERIAL_BAUD:-115200}"

# 电源控制命令（平台自定义，脚本调用时不传参）
POWER_ON_CMD="${K3_POWER_ON_CMD:-echo 'TODO: power on'}"
POWER_OFF_CMD="${K3_POWER_OFF_CMD:-echo 'TODO: power off'}"

FASTBOOT="${K3_FASTBOOT:-fastboot}"
FIRMWARE_DIR="${K3_FIRMWARE_DIR:-/srv/k3-debug/firmware}"
FSBL_FILE="$FIRMWARE_DIR/FSBL.bin"
ITB_FILE="$FIRMWARE_DIR/k3-jtag-ram-opensbi-uboot.itb"

OPENOCD_BIN="${K3_OPENOCD_BIN:-openocd}"
OPENOCD_CFG_DIR="${K3_OPENOCD_CFG_DIR:-/srv/k3-debug/openocd}"
OPENOCD_IF_CFG="$OPENOCD_CFG_DIR/interface/jlink.cfg"
OPENOCD_TARGET_CFG="$OPENOCD_CFG_DIR/target/spacemit-k3.cfg"

# USB 恢复命令（J-Link 掉线时用，可选）
USB_RECOVERY_CMD="${K3_USB_RECOVERY_CMD:-}"

MAX_RETRY="${K3_MAX_RETRY:-3}"
STEP_TIMEOUT="${K3_STEP_TIMEOUT:-30}"

# 日志文件
LOG_DIR="${K3_LOG_DIR:-/tmp/k3-boot}"
SERIAL_LOG="$LOG_DIR/serial.log"
BOOT_LOG="$LOG_DIR/boot.log"

# ============================================================
# 内部变量
# ============================================================

SERIAL_CAT_PID=""
OPENOCD_PID=""
ATTEMPT=0

# ============================================================
# 工具函数
# ============================================================

log() {
    local msg="[$(date '+%H:%M:%S')] $*"
    echo "$msg" | tee -a "$BOOT_LOG"
}

die() {
    log "[FATAL] $*"
    cleanup
    exit 1
}

cleanup() {
    # 停串口读取
    if [[ -n "$SERIAL_CAT_PID" ]] && kill -0 "$SERIAL_CAT_PID" 2>/dev/null; then
        kill "$SERIAL_CAT_PID" 2>/dev/null || true
        wait "$SERIAL_CAT_PID" 2>/dev/null || true
    fi
    # 停 OpenOCD（必须 kill -9，不响应 SIGTERM）
    stop_openocd
}

trap cleanup EXIT

# ============================================================
# 电源控制
# ============================================================

power_off() {
    log "断电"
    eval "$POWER_OFF_CMD"
    sleep 2
}

power_on() {
    log "上电"
    eval "$POWER_ON_CMD"
}

# ============================================================
# 串口监控
# ============================================================

start_serial_monitor() {
    mkdir -p "$LOG_DIR"
    : > "$SERIAL_LOG"

    # 配置串口
    stty -F "$SERIAL_DEV" "$SERIAL_BAUD" raw -echo -echoe -echok -echoctl -echoke

    # 后台持续读取串口到日志
    cat "$SERIAL_DEV" >> "$SERIAL_LOG" &
    SERIAL_CAT_PID=$!
    log "串口监控已启动: $SERIAL_DEV @ $SERIAL_BAUD (PID $SERIAL_CAT_PID)"
}

# 等待串口日志中出现指定字符串
# 用法：wait_serial_marker "U-Boot SPL 2022.10" [超时秒数]
wait_serial_marker() {
    local marker="$1"
    local timeout="${2:-$STEP_TIMEOUT}"
    local elapsed=0

    log "等待串口标志: \"$marker\" (超时 ${timeout}s)"
    while (( elapsed < timeout )); do
        if grep -qF "$marker" "$SERIAL_LOG" 2>/dev/null; then
            log "串口标志命中: \"$marker\" (${elapsed}s)"
            return 0
        fi
        sleep 0.5
        elapsed=$(( elapsed + 1 ))
    done

    log "[TIMEOUT] 串口标志未出现: \"$marker\""
    return 1
}

# 清空串口日志（用于阶段切换后重新检测）
reset_serial_log() {
    : > "$SERIAL_LOG"
}

# ============================================================
# fastboot 设备检测
# ============================================================

# 等待 fastboot 设备出现
wait_fastboot_device() {
    local timeout="${1:-$STEP_TIMEOUT}"
    local elapsed=0

    log "等待 fastboot 设备 (超时 ${timeout}s)"
    while (( elapsed < timeout )); do
        if "$FASTBOOT" devices 2>/dev/null | grep -q "fastboot"; then
            local dev
            dev=$("$FASTBOOT" devices 2>/dev/null | head -1)
            log "fastboot 设备就绪: $dev (${elapsed}s)"
            return 0
        fi
        sleep 0.5
        elapsed=$(( elapsed + 1 ))
    done

    log "[TIMEOUT] fastboot 设备未出现"
    return 1
}

# 等待 fastboot 设备消失（USB 重枚举前的断开）
wait_fastboot_gone() {
    local timeout="${1:-10}"
    local elapsed=0

    while (( elapsed < timeout )); do
        if ! "$FASTBOOT" devices 2>/dev/null | grep -q "fastboot"; then
            return 0
        fi
        sleep 0.5
        elapsed=$(( elapsed + 1 ))
    done
    # 没消失也继续，可能枚举很快
    return 0
}

# 执行 fastboot 命令并检查返回值
fb_cmd() {
    log "fastboot $*"
    if ! "$FASTBOOT" "$@" 2>&1 | tee -a "$BOOT_LOG"; then
        log "[ERROR] fastboot $* 失败"
        return 1
    fi
}

# ============================================================
# OpenOCD 管理
# ============================================================

stop_openocd() {
    if [[ -n "$OPENOCD_PID" ]] && kill -0 "$OPENOCD_PID" 2>/dev/null; then
        log "停止 OpenOCD (kill -9, PID $OPENOCD_PID)"
        kill -9 "$OPENOCD_PID" 2>/dev/null || true
        wait "$OPENOCD_PID" 2>/dev/null || true
        OPENOCD_PID=""
    fi
    # 清理可能的残留实例
    pkill -9 -f "openocd.*spacemit-k3" 2>/dev/null || true
}

start_openocd() {
    stop_openocd

    log "启动 OpenOCD"
    "$OPENOCD_BIN" -f "$OPENOCD_IF_CFG" -f "$OPENOCD_TARGET_CFG" \
        >> "$LOG_DIR/openocd.log" 2>&1 &
    OPENOCD_PID=$!

    # 等待 JTAG 扫描成功
    local timeout=15
    local elapsed=0
    while (( elapsed < timeout )); do
        if grep -q "Examined RISC-V core" "$LOG_DIR/openocd.log" 2>/dev/null; then
            log "OpenOCD 就绪 (PID $OPENOCD_PID): JTAG 扫描成功"
            return 0
        fi
        # 检查进程是否还活着
        if ! kill -0 "$OPENOCD_PID" 2>/dev/null; then
            log "[ERROR] OpenOCD 进程退出，日志:"
            tail -5 "$LOG_DIR/openocd.log" | tee -a "$BOOT_LOG"
            return 1
        fi
        sleep 1
        elapsed=$(( elapsed + 1 ))
    done

    log "[ERROR] OpenOCD 启动超时，日志:"
    tail -10 "$LOG_DIR/openocd.log" | tee -a "$BOOT_LOG"
    stop_openocd
    return 1
}

# ============================================================
# USB 恢复（J-Link 掉线时）
# ============================================================

recover_usb() {
    if [[ -z "$USB_RECOVERY_CMD" ]]; then
        log "[WARN] USB_RECOVERY_CMD 未配置，跳过 USB 恢复"
        return 1
    fi
    log "执行 USB 恢复: $USB_RECOVERY_CMD"
    eval "$USB_RECOVERY_CMD"
    sleep 3
}

# ============================================================
# 固件校验
# ============================================================

verify_firmware() {
    log "校验固件哈希"

    local fsbl_md5 itb_md5
    fsbl_md5=$(md5sum "$FSBL_FILE" | awk '{print $1}')
    itb_md5=$(md5sum "$ITB_FILE" | awk '{print $1}')

    if [[ "$fsbl_md5" != "60f212d0ed3cc73791a3c70e7b959baa" ]]; then
        die "FSBL.bin 哈希不匹配: $fsbl_md5"
    fi
    if [[ "$itb_md5" != "685d6f9f115c82844104d3d788d071e8" ]]; then
        die "ITB 哈希不匹配: $itb_md5"
    fi

    log "固件哈希校验通过"
}

# ============================================================
# 第一层引导状态机（9 步）
# ============================================================

boot_sequence() {
    log "========== 开始第一层引导 (尝试 $ATTEMPT/$MAX_RETRY) =========="

    # 确保 OpenOCD 不在跑
    stop_openocd

    # 步骤 1：断电 → 上电
    # FORCE_RECOVERY 已永久短接，上电即进下载模式
    power_off
    reset_serial_log
    power_on

    # 步骤 2：等 BootROM fastboot 设备出现
    wait_fastboot_device "$STEP_TIMEOUT" || return 1

    # 步骤 3：stage FSBL → continue
    fb_cmd stage "$FSBL_FILE" || return 1
    fb_cmd continue || return 1

    # 步骤 4：等 SPL 串口标志 + SPL fastboot 设备重新枚举
    wait_serial_marker "U-Boot SPL 2022.10" "$STEP_TIMEOUT" || return 1
    wait_fastboot_gone 5
    wait_fastboot_device "$STEP_TIMEOUT" || return 1

    # 步骤 5：stage ITB → continue
    fb_cmd stage "$ITB_FILE" || return 1
    fb_cmd continue || return 1

    # 步骤 6：等 Full U-Boot 串口标志 + fastboot 设备重新枚举
    wait_serial_marker "U-Boot 2022.10" "$STEP_TIMEOUT" || return 1
    wait_fastboot_gone 5
    wait_fastboot_device "$STEP_TIMEOUT" || return 1

    # 步骤 7：continue → 等 U-Boot 命令行提示符
    fb_cmd continue || return 1
    wait_serial_marker "=>" "$STEP_TIMEOUT" || return 1

    log "U-Boot 命令行就绪"

    # 步骤 8：起 OpenOCD，确认 JTAG 扫描
    start_openocd || return 1

    # 步骤 9：就绪
    log "========== 第一层引导完成 =========="
    return 0
}

# ============================================================
# 主入口
# ============================================================

main() {
    mkdir -p "$LOG_DIR"
    : > "$BOOT_LOG"

    log "K3 JTAG 引导脚本启动"
    log "串口: $SERIAL_DEV | 固件: $FIRMWARE_DIR | 重试上限: $MAX_RETRY"

    # 前置检查
    command -v "$FASTBOOT" >/dev/null 2>&1 || die "fastboot 未找到: $FASTBOOT"
    [[ -f "$FSBL_FILE" ]] || die "FSBL 文件不存在: $FSBL_FILE"
    [[ -f "$ITB_FILE" ]] || die "ITB 文件不存在: $ITB_FILE"
    [[ -f "$OPENOCD_IF_CFG" ]] || die "OpenOCD interface 配置不存在: $OPENOCD_IF_CFG"
    [[ -f "$OPENOCD_TARGET_CFG" ]] || die "OpenOCD target 配置不存在: $OPENOCD_TARGET_CFG"
    [[ -c "$SERIAL_DEV" ]] || die "串口设备不存在: $SERIAL_DEV"

    verify_firmware
    start_serial_monitor

    # 重试循环
    while (( ATTEMPT < MAX_RETRY )); do
        ATTEMPT=$(( ATTEMPT + 1 ))

        if boot_sequence; then
            # 就绪信号（平台解析此行）
            echo "[READY] serial=$SERIAL_DEV gdb_port=3333 openocd_pid=$OPENOCD_PID"
            log "串口日志: $SERIAL_LOG"
            log "OpenOCD 日志: $LOG_DIR/openocd.log"
            log "引导日志: $BOOT_LOG"
            # 注意：不清理 OpenOCD，它要保持运行供同学 GDB attach
            # 只停串口监控，串口交给平台/同学
            if [[ -n "$SERIAL_CAT_PID" ]]; then
                kill "$SERIAL_CAT_PID" 2>/dev/null || true
                wait "$SERIAL_CAT_PID" 2>/dev/null || true
                SERIAL_CAT_PID=""
            fi
            trap - EXIT
            exit 0
        fi

        log "[RETRY] 第 $ATTEMPT 次引导失败"
        if (( ATTEMPT < MAX_RETRY )); then
            log "断电后重试..."
            power_off
            sleep 3
        fi
    done

    die "引导失败，已重试 $MAX_RETRY 次。请检查硬件连接和固件。"
}

main "$@"