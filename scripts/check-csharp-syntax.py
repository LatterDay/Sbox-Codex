#!/usr/bin/env python3
"""Pre-sync C# syntax gate for the bridge addon.

Parses every .cs file in sbox-bridge-addon/Editor with tree-sitter and fails on
any ERROR/MISSING node — catching truncated files, unbalanced braces, and broken
interpolated-string escaping BEFORE the code is synced into a live s&box editor
(where a failed addon compile takes the whole bridge down and the file-watcher
will not retry until a manual restart).

Usage:  python3 scripts/check-csharp-syntax.py [files...]
        (no args = all .cs under sbox-bridge-addon/Editor)
Requires: pip install tree-sitter tree-sitter-c-sharp

Known false positive: tree-sitter mis-flags the $@-template region inside
CreateSaveSystemHandler (the verbatim interpolated string that holds the
generated C# scaffold). The real Roslyn compiler accepts this without issue.
Treat any ERROR report on that region as advisory -- do not block a sync on it.
"""
import sys
import glob
from pathlib import Path

import tree_sitter_c_sharp as tscs
from tree_sitter import Language, Parser

LANG = Language(tscs.language())
parser = Parser(LANG)


def check(path: str) -> list[str]:
    src = Path(path).read_bytes()
    tree = parser.parse(src)
    problems = []

    def walk(node):
        if node.type == "ERROR" or node.is_missing:
            line = node.start_point[0] + 1
            snippet = src[node.start_byte:node.start_byte + 60].decode("utf-8", "replace").split("\n")[0]
            kind = "MISSING " + node.type if node.is_missing else "ERROR"
            problems.append(f"{path}:{line}: {kind} near: {snippet!r}")
            return  # don't descend into an error subtree
        if node.has_error:
            for c in node.children:
                walk(c)

    walk(tree.root_node)

    # Truncation tell: file must end with '}' as its last non-whitespace char.
    tail = src.decode("utf-8", "replace").rstrip()
    if tail and not tail.endswith("}"):
        problems.append(f"{path}: file does not end with '}}' — likely truncated (ends: {tail[-50:]!r})")
    return problems


def main() -> int:
    files = sys.argv[1:] or sorted(glob.glob("sbox-bridge-addon/Editor/*.cs"))
    all_problems = []
    for f in files:
        all_problems += check(f)
    if all_problems:
        print(f"FAIL — {len(all_problems)} syntax problem(s):")
        for p in all_problems[:40]:
            print("  " + p)
        return 1
    print(f"PASS — {len(files)} file(s) parse clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
