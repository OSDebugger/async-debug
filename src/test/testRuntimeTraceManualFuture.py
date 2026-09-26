"""Offline tests for Snapshot V1 manual Future DWARF type recovery."""

import ast
from pathlib import Path
import re
import unittest
from unittest.mock import Mock


SOURCE = Path(__file__).resolve().parents[2] / "async_rust_debugger/runtime_trace.py"
POLL_SYMBOL = "example::{impl#1}::poll"
FUTURE_TYPE = "example::ManualFuture"
FUTURE_ADDRESS = 0x1234_5000


class FakeType:
    def __init__(self, name, code, target=None):
        self.name = name
        self.code = code
        self._target = target

    def strip_typedefs(self):
        return self

    def target(self):
        if self._target is None:
            raise RuntimeError("type has no target")
        return self._target

    def pointer(self):
        return FakeType(f"*mut {self.name}", FakeGdb.TYPE_CODE_PTR, self)

    def fields(self):
        return []

    def __str__(self):
        return self.name


class FakeValue:
    def __init__(self, value_type, raw=0, fields=None):
        self.type = value_type
        self.raw = raw
        self._fields = dict(fields or {})

    def __getitem__(self, name):
        if name not in self._fields:
            raise RuntimeError(f"There is no member named {name}")
        return self._fields[name]

    def __int__(self):
        return self.raw


class FakeAddressValue:
    def __init__(self, gdb):
        self.gdb = gdb

    def cast(self, _pointer_type):
        return self

    def dereference(self):
        return self.gdb.memory_value


class FakeFrame:
    def __init__(self, name, self_value=None, self_error=None):
        self._name = name
        self._self_value = self_value
        self._self_error = self_error

    def name(self):
        return self._name

    def read_var(self, name):
        if name != "self":
            raise RuntimeError(f"unknown variable {name}")
        if self._self_error is not None:
            raise self._self_error
        return self._self_value


class FakeGdb:
    TYPE_CODE_PTR = 1
    TYPE_CODE_REF = 2
    TYPE_CODE_RVALUE_REF = 3
    TYPE_CODE_STRUCT = 4
    TYPE_CODE_INT = 5

    def __init__(self):
        self.frame = None
        self.types = {}
        self.memory_value = None

    def selected_frame(self):
        if self.frame is None:
            raise RuntimeError("no selected frame")
        return self.frame

    def lookup_type(self, name):
        if name not in self.types:
            raise RuntimeError(f"No type named {name}")
        return self.types[name]

    def Value(self, _address):
        return FakeAddressValue(self)


class RuntimeTraceManualFutureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
        function_names = {
            "_normalize_addr",
            "_normalize_sym_name",
            "_pollsym_to_envtype",
            "_iter_known_pointer_wrapper_fields",
            "_extract_raw_ptr",
            "_state_read_failure_status",
            "_future_state_metadata",
            "_log_future_type_recovery_failure",
            "_runtime_child_type",
        }
        nodes = []
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name)
                and target.id == "_POINTER_WRAPPER_FIELD_NAMES"
                for target in node.targets
            ):
                nodes.append(node)
            elif isinstance(node, ast.FunctionDef) and node.name in function_names:
                nodes.append(node)
        cls.code = compile(
            ast.Module(body=nodes, type_ignores=[]),
            str(SOURCE),
            "exec",
        )

    def setUp(self):
        self.gdb = FakeGdb()
        self.log = Mock()
        self.scope = {
            "gdb": self.gdb,
            "re": re,
            "_log_ard": self.log,
            "_ptr_size": lambda: 8,
        }
        exec(self.code, self.scope)

    def configure_manual_future(self, pointer_field, address=FUTURE_ADDRESS):
        concrete_type = FakeType(FUTURE_TYPE, FakeGdb.TYPE_CODE_STRUCT)
        pointer_type = FakeType(
            f"&mut {FUTURE_TYPE}",
            FakeGdb.TYPE_CODE_REF,
            concrete_type,
        )
        pointer_value = FakeValue(pointer_type, raw=address)
        pin_type = FakeType(
            f"core::pin::Pin<&mut {FUTURE_TYPE}>",
            FakeGdb.TYPE_CODE_STRUCT,
        )
        self_value = FakeValue(pin_type, fields={pointer_field: pointer_value})
        self.gdb.frame = FakeFrame(POLL_SYMBOL, self_value=self_value)
        self.gdb.types[FUTURE_TYPE] = concrete_type
        return concrete_type

    def test_compiler_async_fn_type_and_state_path_is_unchanged(self):
        poll_symbol = "example::work::{async_fn#0}"
        env_name = "example::work::{async_fn_env#0}"
        env_type = FakeType(env_name, FakeGdb.TYPE_CODE_STRUCT)
        state_type = FakeType("u8", FakeGdb.TYPE_CODE_INT)
        self.gdb.types[env_name] = env_type
        self.gdb.memory_value = FakeValue(
            env_type,
            fields={"__state": FakeValue(state_type, raw=2)},
        )

        result = self.scope["_future_state_metadata"](poll_symbol, FUTURE_ADDRESS)

        self.assertEqual(result["future_type"], env_name)
        self.assertEqual(result["future_type_source"], "dwarf")
        self.assertEqual(result["state"], 2)
        self.assertEqual(result["status"], "ok")

    def test_manual_future_accepts_dunder_pointer_field(self):
        self.configure_manual_future("__pointer")

        result = self.scope["_runtime_child_type"](
            POLL_SYMBOL,
            expected_address=FUTURE_ADDRESS,
        )

        self.assertEqual(result, FUTURE_TYPE)

    def test_manual_future_accepts_pointer_field(self):
        self.configure_manual_future("pointer")

        result = self.scope["_runtime_child_type"](
            POLL_SYMBOL,
            expected_address=FUTURE_ADDRESS,
        )

        self.assertEqual(result, FUTURE_TYPE)

    def test_manual_future_rejects_expected_address_mismatch(self):
        self.configure_manual_future("pointer")

        result = self.scope["_runtime_child_type"](
            POLL_SYMBOL,
            expected_address=FUTURE_ADDRESS + 8,
        )

        self.assertEqual(result, "")
        self.assertIn("self address mismatch", self.log.call_args.args[0])

    def test_manual_future_without_state_keeps_type_and_reports_unsupported_state(self):
        concrete_type = self.configure_manual_future("pointer")
        self.gdb.memory_value = FakeValue(concrete_type)

        result = self.scope["_future_state_metadata"](
            POLL_SYMBOL,
            FUTURE_ADDRESS,
        )

        self.assertEqual(result["future_type"], FUTURE_TYPE)
        self.assertEqual(result["future_type_source"], "dwarf")
        self.assertIsNone(result["state"])
        self.assertEqual(result["status"], "unsupported")
        self.assertIn("no member named __state", result["error"].lower())

    def test_failure_diagnostics_distinguish_frame_self_type_and_unwrap(self):
        recover = self.scope["_runtime_child_type"]

        self.gdb.frame = FakeFrame("example::other")
        self.assertEqual(recover(POLL_SYMBOL, FUTURE_ADDRESS), "")
        self.assertIn("no matching poll frame", self.log.call_args.args[0])

        self.gdb.frame = FakeFrame(
            POLL_SYMBOL,
            self_error=RuntimeError("optimized out"),
        )
        self.assertEqual(recover(POLL_SYMBOL, FUTURE_ADDRESS), "")
        self.assertIn("self unavailable / optimized out", self.log.call_args.args[0])

        plain_type = FakeType(FUTURE_TYPE, FakeGdb.TYPE_CODE_STRUCT)
        self.gdb.frame = FakeFrame(POLL_SYMBOL, FakeValue(plain_type))
        self.assertEqual(recover(POLL_SYMBOL, FUTURE_ADDRESS), "")
        self.assertIn("unsupported self type", self.log.call_args.args[0])

        pin_type = FakeType(
            f"core::pin::Pin<&mut {FUTURE_TYPE}>",
            FakeGdb.TYPE_CODE_STRUCT,
        )
        self.gdb.frame = FakeFrame(POLL_SYMBOL, FakeValue(pin_type))
        self.assertEqual(recover(POLL_SYMBOL, FUTURE_ADDRESS), "")
        self.assertIn("Pin pointer unwrap failed", self.log.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
