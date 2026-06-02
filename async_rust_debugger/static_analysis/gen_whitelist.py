import os
import re
import gdb

KNOWN_FRAMEWORK_CRATES: set[str] = {
    "core",
    "std",
    "alloc",
    "futures",
    "futures_util",
    "cortex_m",
    "cortex_m_rt",
}

def _extract_crate_name(symbol: str) -> str:
    s = symbol.strip()
    if not s:
        return ""

    if s.startswith("<"):
        s = s[1:]
        s = s.split(" as ", 1)[0].strip()

    return s.split("::", 1)[0].strip()

def parse_info_functions(output: str):
    functions = []
    current_file = None
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue

        if line.startswith("File "):
            current_file = line[len("File "):].rstrip(":")
            continue

        # Expect: "<lineno>: <signature>;"
        if current_file and ":" in line:
            parts = line.split(":", 1)
            try:
                line_num = int(parts[0].strip())
            except ValueError:
                continue
            signature = parts[1].strip()

            # Return type
            return_type = None
            if " -> " in signature:
                return_type = signature.split(" -> ", 1)[1].rstrip(";")

            functions.append({
                "file": current_file,
                "line": line_num,
                "signature": signature,
                "return_type": return_type,
            })
    return functions

def _extract_symbol_name(signature: str) -> str | None:
    """
    Signature examples (Rust in GDB):
      static fn minimal::nonleaf::{async_fn#0}() -> core::task::poll::Poll<i32>;
      static fn minimal::{impl#0}::poll(core::pin::Pin<&mut minimal::Manual>, *mut core::task::wake::Context) -> core::task::poll::Poll<i32>;
    We want:
      minimal::nonleaf::{async_fn#0}
      minimal::{impl#0}::poll
    """
    s = signature.strip().rstrip(";")
    # remove leading "static fn " or "fn "
    s = re.sub(r"^(static\s+)?fn\s+", "", s)
    # take up to first "("
    i = s.find("(")
    if i < 0:
        return None
    return s[:i].strip()

def gen_poll_whitelist(out_path: str):
    output = gdb.execute("info functions", to_string=True)
    funcs = parse_info_functions(output)

    syms = []
    for f in funcs:
        rt = f.get("return_type") or ""
        if "core::task::poll::Poll<" not in rt:
            continue
        sym = _extract_symbol_name(f["signature"])
        if sym:
            syms.append(sym)

    # de-dup & stable order
    seen = set()
    uniq = []
    for s in syms:
        if s not in seen:
            uniq.append(s)
            seen.add(s)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fp:
        for i, s in enumerate(uniq):
            fp.write(f"{i} {s}\n")

    gdb.write(f"[ARD] wrote whitelist: {len(uniq)} symbols -> {out_path}\n")

def gen_default_whitelist():
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        raise RuntimeError("ASYNC_RUST_DEBUGGER_TEMP_DIR is not set")
    cwd = os.getcwd()
    out_dir = os.path.join(cwd, temp_dir)
    out_path = os.path.join(out_dir, "poll_functions.txt")
    gen_poll_whitelist(out_path)

def gen_grouped_whitelist(out_path: str):
    import json

    output = gdb.execute("info functions", to_string=True)
    funcs = parse_info_functions(output)

    grouped = {
        "crates": {},
    }

    seen = set()
    for f in funcs:
        rt = f.get("return_type") or ""
        if "core::task::poll::Poll<" not in rt:
            continue

        sym = _extract_symbol_name(f["signature"])
        if not sym or sym in seen:
            continue
        seen.add(sym)

        crate_name = _extract_crate_name(sym)
        is_framework = crate_name in KNOWN_FRAMEWORK_CRATES
        kind = "async" if ("{async_fn#" in sym or "{async_block#" in sym) else "poll"

        crate_info = grouped["crates"].setdefault(crate_name, {
            "name": crate_name,
            "is_framework": is_framework,
            "is_user_crate": not is_framework,
            "symbols": [],
        })
        crate_info["symbols"].append({
            "name": sym,
            "kind": kind,
            "file": f.get("file"),
            "line": f.get("line"),
            "return_type": rt,
        })

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fp:
        json.dump(grouped, fp, indent=2, sort_keys=True)
        fp.write("\n")

    symbol_count = sum(len(c["symbols"]) for c in grouped["crates"].values())
    gdb.write(f"[ARD] wrote grouped whitelist: {symbol_count} symbols -> {out_path}\n")
