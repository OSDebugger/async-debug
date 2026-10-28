import copy
import hashlib
import importlib.util
import json
import argparse
import contextlib
import io
import os
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("k3_verify", ROOT / "testcases/k3-starryos/verify_n_workspace.py")
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)
with patch.dict(sys.modules, {"verify_n_workspace": VERIFY}):
    BOOT_SPEC = importlib.util.spec_from_file_location("k3_boot_delegate", ROOT / "testcases/k3-starryos/k3_boot_state_machine.py")
    BOOT = importlib.util.module_from_spec(BOOT_SPEC)
    BOOT_SPEC.loader.exec_module(BOOT)


class WorkspaceChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / "temp")
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        self.config = json.loads((ROOT / "testcases/k3-starryos/config/n-host-dwarf.json").read_text())
        self.config["workspace"] = str(self.workspace)
        self.config["openocd_launcher"] = str(self.workspace / "openocd.sh")
        files = {self.config["elf"]: b"mock ELF", self.config["poll_source"]: b"mock source",
                 self.config["boot_script"]: b"NEVER EXECUTE", "openocd.sh": b"NEVER EXECUTE"}
        for name, data in files.items():
            path = self.workspace / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o755)
        artifact = {"path": str(self.workspace / self.config["elf"]), "size": 8,
                    "sha256": hashlib.sha256(b"mock ELF").hexdigest()}
        self.write("artifact_manifest", {"starryos.elf": artifact})
        self.write("build_manifest", {"workspace": str(self.workspace), "source_head": "fixture-head", "artifacts": {"starryos.elf": artifact},
                                     "poll_source": str(self.workspace / self.config["poll_source"])})
        self.write("source_manifest", [{"path": self.config["poll_source"],
                                       "sha256": hashlib.sha256(b"mock source").hexdigest()}])
        self.sections = ".debug_info .debug_abbrev .debug_line .debug_str "
        self.info = "Compilation Unit @ offset 0:\nDW_AT_name : ax_task\nDW_AT_comp_dir : " + str(self.workspace / "source")

    def write(self, key, data):
        path = self.workspace / self.config[key]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))

    def run_check(self):
        def offline(*args):
            return self.sections if args[0] == "-SW" else self.info
        # Any unexpected process execution (boot/OpenOCD/GDB) fails this test.
        with patch.object(VERIFY, "source_head", return_value="fixture-head"), patch.object(VERIFY, "readelf", side_effect=offline), patch.object(VERIFY.subprocess, "run", side_effect=AssertionError("unexpected process")):
            return VERIFY.verify(copy.deepcopy(self.config))

    def assert_failed(self, name):
        result = self.run_check()
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(any(c["name"] == name and c["status"] == "FAIL" for c in result["checks"]))
        self.assertTrue(all(result["stages"][s]["automation_status"] == "PENDING" for s in "BCDEFG"))

    def test_valid_host_check_keeps_board_pending(self):
        result = self.run_check()
        self.assertEqual(result["stages"]["A"]["automation_status"], "PASS")
        self.assertEqual(result["status"], "PENDING")
        self.assertFalse(result["hardware_access"])
        self.assertTrue(all(result["stages"][s]["automation_status"] == "PENDING" for s in "BCDEFG"))

    def test_wrong_gdb_ports(self):
        for port in (4444, 6666):
            with self.subTest(port=port):
                self.config["gdb_remote"] = f"localhost:{port}"
                self.assert_failed("ports")

    def test_hash_mismatch(self):
        (self.workspace / self.config["elf"]).write_bytes(b"bad ELF!")
        self.assert_failed("elf_hash")

    def test_manifest_disagreement(self):
        path = self.workspace / self.config["build_manifest"]
        data = json.loads(path.read_text())
        data["artifacts"]["starryos.elf"]["sha256"] = "0" * 64
        self.write("build_manifest", data)
        self.assert_failed("elf_hash")

    def test_missing_dwarf(self):
        self.sections = ".text .symtab "
        self.assert_failed("dwarf_sections")

    def test_old_source_root(self):
        self.info = "Compilation Unit @ offset 0:\nDW_AT_name : ax_task\nDW_AT_comp_dir : /old/n-host-dwarf/source"
        self.assert_failed("dwarf_source_root")

    def test_unrelated_compilation_unit_cannot_supply_source_root(self):
        self.info = "Compilation Unit @ offset 0:\nDW_AT_name : ax_task\nDW_AT_comp_dir : /old/source\nCompilation Unit @ offset 1:\nDW_AT_name : other\nDW_AT_comp_dir : " + str(self.workspace / "source")
        self.assert_failed("dwarf_source_root")

    def test_source_changed(self):
        (self.workspace / self.config["poll_source"]).write_bytes(b"changed")
        self.assert_failed("poll_source")

    def test_missing_elf(self):
        (self.workspace / self.config["elf"]).unlink()
        self.assert_failed("elf_exists")

    def test_no_workspace_escape(self):
        self.config["elf"] = "../outside.elf"
        self.assert_failed("preflight_error")

    def test_missing_manifest(self):
        (self.workspace / self.config["source_manifest"]).unlink()
        self.assert_failed("preflight_error")


    def test_revision_mismatch(self):
        path = self.workspace / self.config["build_manifest"]
        data = json.loads(path.read_text())
        data["source_head"] = "other-revision"
        self.write("build_manifest", data)
        self.assert_failed("source_revision")

    def test_relocated_workspace_requires_explicit_map(self):
        old = "/original/N-workspace"
        for key in ("artifact_manifest", "build_manifest"):
            path = self.workspace / self.config[key]
            path.write_text(path.read_text().replace(str(self.workspace), old))
        self.info = "Compilation Unit @ offset 0:\nDW_AT_name : ax_task\nDW_AT_comp_dir : " + old + "/source"
        self.assert_failed("manifest_paths")
        self.config["source_prefix_maps"] = [[old, str(self.workspace)]]
        self.assertEqual(self.run_check()["stages"]["A"]["automation_status"], "PASS")

    def test_configuration_precedence_and_missing_dependencies(self):
        parser = argparse.ArgumentParser()
        with patch.dict(os.environ, {"STARRYOS_WORKSPACE": str(self.workspace),
                                     "K3_OPENOCD_LAUNCHER": str(self.workspace / "openocd.sh")}):
            VERIFY.add_config_arguments(parser)
            args = parser.parse_args([])
            self.assertEqual(VERIFY.load_config(args)["workspace"], str(self.workspace))
            args = parser.parse_args(["--workspace", "/explicit/N"])
            self.assertEqual(VERIFY.load_config(args)["workspace"], "/explicit/N")
        args.workspace = None
        args.openocd_launcher = None
        with self.assertRaisesRegex(ValueError, "STARRYOS_WORKSPACE"):
            VERIFY.load_config(args)
        args.workspace = str(self.workspace)
        with self.assertRaisesRegex(ValueError, "K3_OPENOCD_LAUNCHER"):
            VERIFY.load_config(args)

    def test_bad_source_mapping_is_rejected(self):
        parser = argparse.ArgumentParser()
        VERIFY.add_config_arguments(parser)
        args = parser.parse_args(["--workspace", str(self.workspace),
                                 "--openocd-launcher", str(self.workspace / "openocd.sh"),
                                 "--source-prefix-map", "relative=/absolute"])
        with self.assertRaisesRegex(ValueError, "absolute"):
            VERIFY.load_config(args)

    def test_default_boot_delegates_exact_N_argv(self):
        config = copy.deepcopy(self.config)
        config["openocd_launcher"] = None  # boot itself must not depend on OpenOCD
        with patch.object(BOOT, "load_config", return_value=config), patch.object(BOOT, "verify", side_effect=AssertionError("boot must not duplicate N preflight")), patch.object(BOOT.os, "execv", side_effect=SystemExit(37)) as execute, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as caught:
                BOOT.main([])
            self.assertEqual(caught.exception.code, 37)
            command = [str(self.workspace / "boot_n_candidate.sh"), "--image", "host-dwarf"]
            execute.assert_called_once_with(command[0], command)

    def test_check_never_executes_launcher(self):
        result = {"status": "PENDING", "stages": {"A": {"automation_status": "PASS"}}}
        with patch.object(BOOT, "load_config", return_value=self.config), patch.object(BOOT, "verify", return_value=result), patch.object(BOOT.os, "execv", side_effect=AssertionError("must not execute")), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(BOOT.main(["--check"]), 0)

    def test_openocd_forwards_no_jtag_overrides(self):
        with patch.object(BOOT, "load_config", return_value=self.config), patch.object(BOOT.os, "execv", side_effect=SystemExit(0)) as execute, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                BOOT.main(["--operation", "openocd"])
            command = [self.config["openocd_launcher"]]
            execute.assert_called_once_with(command[0], command)

    def test_missing_launcher_stops_before_exec(self):
        (self.workspace / "boot_n_candidate.sh").unlink()
        with patch.object(BOOT, "load_config", return_value=self.config), patch.object(BOOT.os, "execv", side_effect=AssertionError("must not execute")), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(BOOT.main([]), 2)

    def test_failed_check_stops_before_exec(self):
        with patch.object(BOOT, "load_config", return_value=self.config), patch.object(BOOT, "verify", return_value={"status": "FAIL"}), patch.object(BOOT.os, "execv", side_effect=AssertionError("must not execute")), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(BOOT.main(["--check"]), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
