#!/usr/bin/env python3
"""State-driven K3 BootROM-to-StarryOS Golden Flow.

The UART is the board-state authority. Host fastboot commands are issued only after
the corresponding UART state or an actual fastboot readiness probe has succeeded.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import os
import re
import select
import shutil
import stat
import subprocess
import sys
import termios
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional, Sequence


TIOCEXCL = 0x540C
TIOCNXCL = 0x540D
ANSI_RE = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
ANSI_INCOMPLETE_RE = re.compile(rb"\x1b(?:\[[0-?]*[ -/]*)?$")
INVALID_FASTBOOT_SERIALS = {
    "",
    "(null)",
    "<unknown>",
    "n/a",
    "none",
    "null",
    "unknown",
}


class FlowError(RuntimeError):
    def __init__(self, message: str, expected: str = "") -> None:
        super().__init__(message)
        self.expected = expected or message


class WaitTimeout(FlowError):
    pass


class HostLog:
    def __init__(self, path: Path) -> None:
        self._file = path.open("a", encoding="utf-8", buffering=1)
        self._lock = threading.Lock()

    def close(self) -> None:
        self._file.close()

    def emit(self, message: str = "") -> None:
        line = f"[{dt.datetime.now().isoformat(timespec='seconds')}] {message}"
        with self._lock:
            print(line, flush=True)
            self._file.write(line + "\n")

    def command(self, argv: Sequence[str]) -> None:
        self.emit("[HOST] " + " ".join(shell_quote(arg) for arg in argv))

    def command_output(self, output: str) -> None:
        if not output:
            return
        with self._lock:
            sys.stdout.write(output)
            if not output.endswith("\n"):
                sys.stdout.write("\n")
            sys.stdout.flush()
            self._file.write(output)
            if not output.endswith("\n"):
                self._file.write("\n")

    def state(self, name: str) -> None:
        self.emit(f"[STATE] {name}")


def shell_quote(value: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_./:=+-]+", value):
        return value
    return "'" + value.replace("'", "'\"'\"'") + "'"


def usable_fastboot_serial(serial: str) -> bool:
    """Return whether a `fastboot devices` identifier is safe for `-s`."""
    value = serial.strip()
    if value.lower() in INVALID_FASTBOOT_SERIALS:
        return False
    if re.fullmatch(r"\?+", value):
        return False
    return not any(character.isspace() for character in value)


def fastboot_argv(selector: Optional[str], args: Sequence[str]) -> list[str]:
    """Build a command without ever passing an invalid serial to `fastboot -s`."""
    argv = ["fastboot"]
    if selector and usable_fastboot_serial(selector):
        argv.extend(["-s", selector])
    argv.extend(args)
    return argv


def strip_ansi_chunk(chunk: bytes, pending: bytes = b"") -> tuple[bytes, bytes]:
    """Strip complete ANSI CSI sequences and retain a trailing partial sequence."""
    data = pending + chunk
    incomplete = ANSI_INCOMPLETE_RE.search(data)
    if incomplete:
        data, pending = data[: incomplete.start()], data[incomplete.start() :]
    else:
        pending = b""
    return ANSI_RE.sub(b"", data), pending


def find_uart_text_end(data: bytearray, needle: bytes, start: int) -> Optional[int]:
    """Find visible UART text and map its end back to the raw byte position."""
    raw = bytes(data[start:])
    cleaned = bytearray()
    raw_ends: list[int] = []
    cursor = 0
    for match in ANSI_RE.finditer(raw):
        cleaned.extend(raw[cursor : match.start()])
        raw_ends.extend(range(cursor + 1, match.start() + 1))
        cursor = match.end()
    cleaned.extend(raw[cursor:])
    raw_ends.extend(range(cursor + 1, len(raw) + 1))

    found = cleaned.find(needle)
    if found < 0:
        return None
    return start + raw_ends[found + len(needle) - 1]


class ExclusiveUart:
    """Continuously capture UART bytes while providing cursor-based waits."""

    def __init__(self, device: Path, baud: int, raw_log: Path) -> None:
        self.device = device
        self.baud = baud
        self.raw_log_path = raw_log
        self.fd: Optional[int] = None
        self._saved_termios: Optional[list] = None
        self._raw_file = None
        self._data = bytearray()
        self._condition = threading.Condition()
        self._stop = threading.Event()
        self._reader: Optional[threading.Thread] = None
        self._reader_error: Optional[BaseException] = None

    def open(self) -> None:
        try:
            fd = os.open(self.device, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        except OSError as exc:
            raise FlowError(
                f"cannot open UART {self.device}: {exc}",
                f"exclusive access to UART {self.device}",
            ) from exc

        self.fd = fd
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.ioctl(fd, TIOCEXCL)
            other_users = find_other_device_users(self.device, os.getpid())
            if other_users:
                raise FlowError(
                    f"UART {self.device} is already open by PID(s): {', '.join(other_users)}",
                    f"exclusive access to UART {self.device}; close minicom and other serial tools",
                )
            self._saved_termios = termios.tcgetattr(fd)
            attrs = termios.tcgetattr(fd)
            attrs[0] = 0
            attrs[1] = 0
            attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
            attrs[3] = 0
            speed = baud_constant(self.baud)
            attrs[4] = speed
            attrs[5] = speed
            attrs[6][termios.VMIN] = 0
            attrs[6][termios.VTIME] = 0
            termios.tcsetattr(fd, termios.TCSANOW, attrs)
            self._raw_file = self.raw_log_path.open("ab", buffering=0)
        except BaseException:
            self.close()
            raise

        self._reader = threading.Thread(target=self._read_loop, name="k3-uart-reader", daemon=True)
        self._reader.start()

    def close(self) -> None:
        self._stop.set()
        if self._reader is not None:
            self._reader.join()
            self._reader = None
        if self._raw_file is not None:
            self._raw_file.flush()
            self._raw_file.close()
            self._raw_file = None
        if self.fd is not None:
            if self._saved_termios is not None:
                try:
                    termios.tcsetattr(self.fd, termios.TCSANOW, self._saved_termios)
                except OSError:
                    pass
                self._saved_termios = None
            try:
                fcntl.ioctl(self.fd, TIOCNXCL)
            except OSError:
                pass
            try:
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            except OSError:
                pass
            os.close(self.fd)
            self.fd = None

    def _read_loop(self) -> None:
        assert self.fd is not None
        try:
            while not self._stop.is_set():
                readable, _, _ = select.select([self.fd], [], [], 0.2)
                if not readable:
                    continue
                try:
                    chunk = os.read(self.fd, 4096)
                except BlockingIOError:
                    continue
                if not chunk:
                    continue
                with self._condition:
                    assert self._raw_file is not None
                    self._raw_file.write(chunk)
                    self._raw_file.flush()  # Make this chunk visible before terminal output.
                    self._data.extend(chunk)
                    self._condition.notify_all()
                sys.stdout.write(chunk.decode("utf-8", errors="replace"))
                sys.stdout.flush()
        except BaseException as exc:
            with self._condition:
                self._reader_error = exc
                self._condition.notify_all()

    def mark(self) -> int:
        with self._condition:
            self._check_reader()
            return len(self._data)

    def write_command(self, command: str) -> int:
        boundary = self.mark()
        self._write_command(command)
        return boundary

    def write_command_with_raw_boundary(self, command: str) -> int:
        """Record an on-disk boundary and send a command before the reader can append."""
        assert self.fd is not None
        with self._condition:
            self._check_reader()
            assert self._raw_file is not None
            self._raw_file.flush()
            raw_offset = os.fstat(self._raw_file.fileno()).st_size
            self._write_command(command)
            return raw_offset

    def _write_command(self, command: str) -> None:
        assert self.fd is not None
        payload = (command + "\r").encode("ascii")
        total = 0
        deadline = time.monotonic() + 5.0
        while total < len(payload):
            try:
                total += os.write(self.fd, payload[total:])
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise FlowError("UART write timed out", f"UART echo of {command!r}")
                select.select([], [self.fd], [], 0.1)

    def wait_raw_log_for(
        self,
        needle: bytes,
        start_offset: int,
        timeout: float,
        description: str,
    ) -> None:
        """Scan bytes appended to the raw UART log after an absolute file offset."""
        deadline = time.monotonic() + timeout
        tail = b""
        ansi_pending = b""
        overlap = max(0, len(needle) - 1)
        with self.raw_log_path.open("rb", buffering=0) as raw_log:
            raw_log.seek(start_offset)
            while True:
                chunk = raw_log.read(4096)
                if chunk:
                    cleaned_chunk, ansi_pending = strip_ansi_chunk(chunk, ansi_pending)
                    window = tail + cleaned_chunk
                    if needle in window:
                        return
                    tail = window[-overlap:] if overlap else b""
                    continue
                with self._condition:
                    self._check_reader()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise WaitTimeout(f"UART timeout after {timeout:.0f}s", description)
                time.sleep(min(0.05, remaining))

    def wait_for(self, needle: bytes, start: int, timeout: float, description: str) -> int:
        deadline = time.monotonic() + timeout
        cursor = start
        with self._condition:
            while True:
                self._check_reader()
                found_end = find_uart_text_end(self._data, needle, cursor)
                if found_end is not None:
                    return found_end
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise WaitTimeout(f"UART timeout after {timeout:.0f}s", description)
                self._condition.wait(timeout=min(remaining, 0.5))

    def wait_sequence(
        self,
        needles: Iterable[tuple[bytes, str]],
        start: int,
        timeout: float,
    ) -> int:
        deadline = time.monotonic() + timeout
        cursor = start
        for needle, description in needles:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise WaitTimeout(f"UART timeout after {timeout:.0f}s", description)
            cursor = self.wait_for(needle, cursor, remaining, description)
        return cursor

    def recent(self, limit: int = 2000) -> str:
        with self._condition:
            data = bytes(self._data[-limit:])
        text = data.decode("utf-8", errors="replace")
        return text.replace("\x00", "\\0")

    def _check_reader(self) -> None:
        if self._reader_error is not None:
            raise FlowError(
                f"UART reader failed: {self._reader_error}",
                f"readable UART {self.device}",
            )


def baud_constant(baud: int) -> int:
    value = getattr(termios, f"B{baud}", None)
    if value is None:
        raise FlowError(f"unsupported UART baud: {baud}", "a termios-supported baud rate")
    return value


def find_other_device_users(device: Path, own_pid: int) -> list[str]:
    """Return PIDs that already have the same character device open."""
    try:
        target_rdev = device.stat().st_rdev
    except OSError:
        return []
    users: list[str] = []
    for process in Path("/proc").iterdir():
        if not process.name.isdigit() or int(process.name) == own_pid:
            continue
        try:
            descriptors = list((process / "fd").iterdir())
        except OSError:
            continue
        for descriptor in descriptors:
            try:
                info = descriptor.stat()
            except OSError:
                continue
            if stat.S_ISCHR(info.st_mode) and info.st_rdev == target_rdev:
                users.append(process.name)
                break
    return users


def current_process_holds_device(device: Path) -> bool:
    return str(os.getpid()) in find_other_device_users(device, own_pid=-1)


@dataclass(frozen=True)
class Artifacts:
    fsbl: Path
    fit: Path
    kernel: Path
    dtb: Path
    verify_script: Path


@dataclass(frozen=True)
class Timeouts:
    bootrom: float
    spl_uart: float
    reenumeration: float
    full_uboot: float
    uboot_command: float
    transfer: float
    starryos: float
    probe_command: float
    poll_interval: float


class GoldenBoot:
    def __init__(
        self,
        artifacts: Artifacts,
        uart: ExclusiveUart,
        log: HostLog,
        timeouts: Timeouts,
    ) -> None:
        self.artifacts = artifacts
        self.uart = uart
        self.log = log
        self.timeouts = timeouts
        self.state = "PREFLIGHT"

    def run(self) -> None:
        self._preflight()
        self.uart.open()
        self.log.emit(f"[UART] device={self.uart.device} baud={self.uart.baud}")
        self.log.emit(f"[UART] raw_log={self.uart.raw_log_path}")

        self.state = "BOOTROM_READY"
        bootrom_selector, _ = self._wait_fastboot(
            timeout=self.timeouts.bootrom,
            variable="version-brom",
            expected=re.compile(r"version-brom:\s*1\.0(?:\s|$)"),
            expected_text="exactly one fastboot device with version-brom: 1.0",
        )
        self._set_state("BOOTROM_READY")

        self.state = "SPL_READY"
        self._fastboot_once(bootrom_selector, ["stage", str(self.artifacts.fsbl)], self.timeouts.transfer)
        spl_boundary = self.uart.mark()
        self._fastboot_continue_once(bootrom_selector)

        self._wait_uart_sequence(
            [
                (b"U-Boot SPL 2022.10-dirty", "U-Boot SPL 2022.10-dirty"),
                (b"Debug JTAG enabled on MMC1 pins", "Debug JTAG enabled on MMC1 pins"),
            ],
            spl_boundary,
            self.timeouts.spl_uart,
        )
        spl_selector, _ = self._wait_fastboot(
            timeout=self.timeouts.reenumeration,
            variable="version",
            expected=re.compile(r"version:\s*0\.4(?:\s|$)"),
            expected_text="re-enumerated SPL fastboot gadget with version: 0.4",
        )
        self._set_state("SPL_READY")

        self.state = "FULL_UBOOT_READY"
        self._fastboot_once(spl_selector, ["stage", str(self.artifacts.fit)], self.timeouts.transfer)
        uboot_banner_boundary = self.uart.mark()
        self._fastboot_continue_once(spl_selector)
        self._wait_uart_sequence(
            [
                (b"U-Boot 2022.10", "Full U-Boot 2022.10 banner"),
            ],
            uboot_banner_boundary,
            self.timeouts.full_uboot,
        )
        full_uboot_selector, _ = self._wait_fastboot(
            timeout=self.timeouts.reenumeration,
            variable="version",
            expected=re.compile(r"version:\s*\S+"),
            expected_text="re-enumerated Full U-Boot fastboot gadget",
        )
        uboot_prompt_boundary = self.uart.mark()
        self._fastboot_continue_once(full_uboot_selector)
        self.log.emit(
            f"[WAIT] UART: a new Full U-Boot => prompt after fastboot continue; "
            f"timeout={self.timeouts.uboot_command:.0f}s"
        )
        self.uart.wait_for(
            b"=>",
            uboot_prompt_boundary,
            self.timeouts.uboot_command,
            "a new Full U-Boot => prompt after fastboot continue",
        )
        self._set_state("FULL_UBOOT_READY")

        self.state = "UFS_READY"
        scsi_cursor = self._send_uboot_command("scsi scan")
        self._wait_uart_sequence(
            [
                (b"KINGSTON", "KINGSTON UFS device after scsi scan"),
                (b"=>", "a new => prompt after scsi scan"),
            ],
            scsi_cursor,
            self.timeouts.uboot_command,
        )
        self._set_state("UFS_READY")

        self.state = "KERNEL_LOADED"
        self._enter_uboot_fastboot("fastboot -l 0x140000000 -s 0x02000000 usb 0")
        kernel_selector, _ = self._wait_fastboot(
            timeout=self.timeouts.reenumeration,
            variable="version",
            expected=re.compile(r"version:\s*\S+"),
            expected_text="Full U-Boot fastboot gadget for kernel load",
        )
        self._fastboot_once(kernel_selector, ["stage", str(self.artifacts.kernel)], self.timeouts.transfer)
        kernel_prompt_boundary = self.uart.mark()
        self._fastboot_continue_once(kernel_selector)
        self.uart.wait_for(
            b"=>",
            kernel_prompt_boundary,
            self.timeouts.uboot_command,
            "a new => prompt after kernel fastboot continue",
        )
        self._set_state("KERNEL_LOADED")

        self.state = "DTB_LOADED"
        self._enter_uboot_fastboot("fastboot -l 0x138000000 -s 0x00800000 usb 0")
        dtb_selector, _ = self._wait_fastboot(
            timeout=self.timeouts.reenumeration,
            variable="version",
            expected=re.compile(r"version:\s*\S+"),
            expected_text="Full U-Boot fastboot gadget for DTB load",
        )
        self._fastboot_once(dtb_selector, ["stage", str(self.artifacts.dtb)], self.timeouts.transfer)
        dtb_prompt_boundary = self.uart.mark()
        self._fastboot_continue_once(dtb_selector)
        self.uart.wait_for(
            b"=>",
            dtb_prompt_boundary,
            self.timeouts.uboot_command,
            "a new => prompt after DTB fastboot continue",
        )
        self._set_state("DTB_LOADED")

        self.state = "STARRYOS_READY"
        booti_command = "booti 0x140000000 - 0x138000000"
        self.log.emit(f"[UART->] {booti_command}")
        raw_log_offset = self.uart.write_command_with_raw_boundary(booti_command)
        self.uart.wait_raw_log_for(
            b"Welcome to Starry OS!",
            raw_log_offset,
            self.timeouts.starryos,
            "Welcome to Starry OS! after booti",
        )
        self._set_state("STARRYOS_READY")
        self.log.emit("[UART] handing over to minicom")

    def _preflight(self) -> None:
        for command in ("fastboot", "sudo", "minicom"):
            if shutil.which(command) is None:
                raise FlowError(f"{command} not found in PATH", f"{command} executable")
        if not self.uart.device.exists():
            raise FlowError(f"UART device does not exist: {self.uart.device}", str(self.uart.device))
        try:
            mode = self.uart.device.stat().st_mode
        except OSError as exc:
            raise FlowError(f"cannot stat UART {self.uart.device}: {exc}", str(self.uart.device)) from exc
        if not stat.S_ISCHR(mode):
            raise FlowError(f"UART path is not a character device: {self.uart.device}", "UART character device")

        for artifact in (
            self.artifacts.fsbl,
            self.artifacts.fit,
            self.artifacts.kernel,
            self.artifacts.dtb,
            self.artifacts.verify_script,
        ):
            if not artifact.is_file():
                raise FlowError(f"required frozen artifact is missing: {artifact}", str(artifact))

        self.log.emit(f"[BASELINE] {self.artifacts.fsbl.parents[2]}")
        result = self._run([str(self.artifacts.verify_script)], timeout=120.0)
        if result.returncode:
            raise FlowError("frozen artifact checksum verification failed", "all frozen artifact checksums OK")

    def _set_state(self, state: str) -> None:
        self.state = state
        self.log.state(state)

    def _wait_uart_sequence(
        self,
        needles: Iterable[tuple[bytes, str]],
        start: int,
        timeout: float,
    ) -> int:
        sequence = list(needles)
        descriptions = [description for _, description in sequence]
        self.log.emit(f"[WAIT] UART: {' -> '.join(descriptions)}; timeout={timeout:.0f}s")
        return self.uart.wait_sequence(sequence, start, timeout)

    def _send_uboot_command(self, command: str) -> int:
        self.log.emit(f"[UART->] {command}")
        boundary = self.uart.write_command(command)
        return self.uart.wait_for(
            command.encode("ascii"),
            boundary,
            self.timeouts.uboot_command,
            f"UART echo of {command!r}",
        )

    def _enter_uboot_fastboot(self, command: str) -> None:
        self._send_uboot_command(command)
        self.log.emit("[WAIT] U-Boot command accepted; probing for a newly ready USB fastboot gadget")

    def _list_fastboot_devices(self) -> list[str]:
        result = self._run(["fastboot", "devices"], timeout=self.timeouts.probe_command, quiet=True)
        if result.returncode:
            return []
        devices: list[str] = []
        for line in result.output.splitlines():
            fields = line.split()
            if fields:
                devices.append(fields[0])
        return devices

    def _wait_fastboot(
        self,
        timeout: float,
        variable: str,
        expected: re.Pattern[str],
        expected_text: str,
    ) -> tuple[Optional[str], str]:
        deadline = time.monotonic() + timeout
        last_observation = "no fastboot device"
        self.log.emit(f"[WAIT] fastboot: {expected_text}; timeout={timeout:.0f}s")
        while time.monotonic() < deadline:
            try:
                devices = self._list_fastboot_devices()
            except FlowError as exc:
                last_observation = str(exc)
                devices = []
            if len(devices) > 1:
                raise FlowError(
                    f"multiple fastboot devices detected: {', '.join(devices)}",
                    "exactly one fastboot device",
                )
            if len(devices) == 1:
                observed_serial = devices[0]
                selector = observed_serial if usable_fastboot_serial(observed_serial) else None
                getvar_argv = fastboot_argv(selector, ["getvar", variable])
                try:
                    result = self._run(
                        getvar_argv,
                        timeout=self.timeouts.probe_command,
                        quiet=True,
                    )
                except FlowError as exc:
                    last_observation = str(exc)
                else:
                    last_observation = result.output.strip() or f"getvar {variable} returned {result.returncode}"
                    if result.returncode == 0 and expected.search(result.output):
                        selector_text = selector if selector is not None else "<none; invalid serial>"
                        self.log.emit(
                            f"[FASTBOOT] observed_serial={observed_serial} "
                            f"selector={selector_text} {expected_text}"
                        )
                        self.log.command_output(result.output)
                        return selector, result.output
            remaining = deadline - time.monotonic()
            if remaining > 0:
                time.sleep(min(self.timeouts.poll_interval, remaining))
        raise FlowError(
            f"fastboot readiness timeout; last observation: {last_observation}",
            expected_text,
        )

    def _fastboot_once(
        self,
        selector: Optional[str],
        args: Sequence[str],
        timeout: float,
    ) -> None:
        argv = fastboot_argv(selector, args)
        result = self._run(argv, timeout=timeout)
        if result.returncode:
            raise FlowError(
                f"fastboot command failed with exit {result.returncode}",
                "successful " + " ".join(args),
            )

    def _fastboot_continue_once(self, selector: Optional[str]) -> None:
        argv = fastboot_argv(selector, ["continue"])
        try:
            result = self._run(argv, timeout=self.timeouts.uboot_command)
        except FlowError as exc:
            raise FlowError(
                f"fastboot continue outcome is unknown and was not retried: {exc}",
                "one successful fastboot continue",
            ) from exc
        if result.returncode:
            raise FlowError(
                f"fastboot continue failed with exit {result.returncode}; it was not retried",
                "one successful fastboot continue",
            )

    def _run(self, argv: Sequence[str], timeout: float, quiet: bool = False) -> "CommandResult":
        if not quiet:
            self.log.command(argv)
        try:
            completed = subprocess.run(
                list(argv),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            output = exc.stdout or ""
            if isinstance(output, bytes):
                output = output.decode("utf-8", errors="replace")
            self.log.command_output(output)
            raise FlowError(
                f"host command timed out after {timeout:.1f}s: {' '.join(argv)}",
                "host command completion",
            ) from exc
        if not quiet:
            self.log.command_output(completed.stdout)
        return CommandResult(completed.returncode, completed.stdout)


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    output: str


def env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        parsed = float(value)
    except ValueError as exc:
        raise FlowError(f"invalid {name}: {value}", f"positive numeric {name}") from exc
    if parsed <= 0:
        raise FlowError(f"invalid {name}: {value}", f"positive numeric {name}")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Automatically boot K3 from BootROM USB Recovery to StarryOS",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--uart", default=os.environ.get("K3_UART_DEVICE", "/dev/ttyUSB0"))
    parser.add_argument("--baud", type=int, default=int(os.environ.get("K3_UART_BAUD", "115200")))
    parser.add_argument(
        "--log-dir",
        default=os.environ.get(
            "K3_AUTO_BOOT_LOG_DIR",
            str(Path(__file__).resolve().parent / "logs"),
        ),
    )
    parser.add_argument("--bootrom-timeout", type=float, default=env_float("K3_BOOTROM_TIMEOUT", 120))
    parser.add_argument("--spl-timeout", type=float, default=env_float("K3_SPL_TIMEOUT", 60))
    parser.add_argument("--usb-timeout", type=float, default=env_float("K3_USB_TIMEOUT", 60))
    parser.add_argument("--uboot-timeout", type=float, default=env_float("K3_UBOOT_TIMEOUT", 90))
    parser.add_argument("--command-timeout", type=float, default=env_float("K3_COMMAND_TIMEOUT", 30))
    parser.add_argument("--transfer-timeout", type=float, default=env_float("K3_TRANSFER_TIMEOUT", 300))
    parser.add_argument("--starryos-timeout", type=float, default=env_float("K3_STARRYOS_TIMEOUT", 180))
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    baseline_value = os.environ.get("K3_DWARF_BASELINE")
    if not baseline_value:
        print("[FAILED] state=PREFLIGHT", file=sys.stderr)
        print("[FAILED] expected=K3_DWARF_BASELINE from baseline.env", file=sys.stderr)
        print("[FAILED] recent_uart=<UART not opened>", file=sys.stderr)
        return 2

    baseline = Path(baseline_value).resolve()
    log_dir = Path(args.log_dir).resolve()
    log_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    host_log_path = log_dir / f"k3_auto_boot_{stamp}.host.log"
    uart_log_path = log_dir / f"k3_auto_boot_{stamp}.uart.log"
    log = HostLog(host_log_path)
    uart = ExclusiveUart(Path(args.uart), args.baud, uart_log_path)
    artifacts = Artifacts(
        fsbl=baseline / "artifacts/fsbl/FSBL.bin",
        fit=baseline / "artifacts/u-boot/k3-jtag-ram-opensbi-uboot.itb",
        kernel=baseline / "artifacts/starryos/starryos_host_dwarf_release.bin",
        dtb=baseline / "artifacts/starryos/spacemit-k3-com260-ifx.dtb",
        verify_script=baseline / "tools/verify_artifacts.sh",
    )
    timeouts = Timeouts(
        bootrom=args.bootrom_timeout,
        spl_uart=args.spl_timeout,
        reenumeration=args.usb_timeout,
        full_uboot=args.uboot_timeout,
        uboot_command=args.command_timeout,
        transfer=args.transfer_timeout,
        starryos=args.starryos_timeout,
        probe_command=5.0,
        poll_interval=0.5,
    )
    flow = GoldenBoot(artifacts, uart, log, timeouts)
    exit_code = 0
    handoff_to_minicom = False
    try:
        log.emit(f"[LOG] host={host_log_path}")
        log.emit(f"[LOG] uart={uart_log_path}")
        flow.run()
        uart.close()
        if (
            uart.fd is not None
            or uart._reader is not None
            or uart._raw_file is not None
            or current_process_holds_device(uart.device)
        ):
            raise FlowError(
                "UART resources remain open after close",
                "complete UART release before starting minicom",
            )
        handoff_to_minicom = True
    except (FlowError, OSError, ValueError) as exc:
        expected = exc.expected if isinstance(exc, FlowError) else str(exc)
        recent = uart.recent() if uart.fd is not None else "<UART not opened>"
        log.emit(f"[FAILED] state={flow.state}")
        log.emit(f"[FAILED] expected={expected}")
        log.emit(f"[FAILED] error={exc}")
        log.emit("[FAILED] recent_uart=" + recent)
        exit_code = 1
    except KeyboardInterrupt:
        recent = uart.recent() if uart.fd is not None else "<UART not opened>"
        log.emit(f"[FAILED] state={flow.state}")
        log.emit("[FAILED] expected=uninterrupted boot-phase completion")
        log.emit("[FAILED] error=interrupted by operator")
        log.emit("[FAILED] recent_uart=" + recent)
        exit_code = 130
    finally:
        if not handoff_to_minicom:
            uart.close()

    log.emit(f"[LOG] host={host_log_path}")
    log.emit(f"[LOG] uart={uart_log_path}")
    if not handoff_to_minicom:
        log.close()
        return exit_code

    minicom_argv = ["sudo", "minicom", "-o", "-D", str(uart.device), "-b", str(uart.baud)]
    log.command(minicom_argv)
    log.close()
    try:
        os.execvp("sudo", minicom_argv)
    except OSError as exc:
        print(f"[FAILED] state=MINICOM_HANDOFF", file=sys.stderr)
        print(f"[FAILED] expected=exec sudo minicom on {uart.device}", file=sys.stderr)
        print(f"[FAILED] error={exc}", file=sys.stderr)
        return 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
