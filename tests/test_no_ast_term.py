"""Ratchet: the part document is not an "AST".

The codebase used to call the part document an abstract syntax tree, a name
that promised a FeatureScript-style program the design deliberately is not.
The word for it is "document"; identifiers say `doc`, matching the existing
`PartDoc`, `loadPartDoc` and `usePartDoc`. See docs/document.md for what the
document actually is.

Case matters. The uppercase term is banned across the scanned surface because
it is the spelling that survives in prose and UI strings. The lowercase
spelling is banned in TypeScript and Rust source, where it would signal a
revived `report.ast` or a variable named after the old term. Python is exempt
from the lowercase check: `import ast` is the standard library parser used by
tests/test_import_boundary.py, not a statement about the document.
"""

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent

# The authored surface. docs/ was cleaned when docs/ast.md became
# docs/document.md; this ratchet keeps it clean.
TREES = (
    "frontend/src",
    "frontend/scripts",
    "docs",
    "sketch-solver",
    "mate-solver",
    "solver-core",
)
FLAT_FILES = ("README.md", "code_guideline.md", "AGENTS.md")

# Vendored, built or generated trees. A hit in one of these is not a statement
# about the document, and the WASM glue is rewritten by `just wasm` anyway.
EXCLUDED_DIRS = frozenset({
    "node_modules",
    "dist",
    "target",
    "pkg",
    "pkg-node",
    "wasm",
    "__pycache__",
})

UPPER_RE = re.compile(r"\bAST\b")
LOWER_RE = re.compile(r"\bast\b", re.IGNORECASE)

# Where a bare `ast` could come back as an identifier.
LOWER_SUFFIXES = (".ts", ".tsx", ".rs")

HINT = "the document is not an AST, see docs/document.md"


def _scanned_files() -> list[pathlib.Path]:
    found: list[pathlib.Path] = []
    for tree in TREES:
        base = ROOT / tree
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            if any(part in EXCLUDED_DIRS for part in path.relative_to(ROOT).parts):
                continue
            found.append(path)
    for name in FLAT_FILES:
        path = ROOT / name
        if path.is_file():
            found.append(path)
    return found


def _is_binary(path: pathlib.Path) -> bool:
    return b"\x00" in path.read_bytes()[:8192]


def _hits(path: pathlib.Path, pattern: re.Pattern[str]) -> list[str]:
    rel = path.relative_to(ROOT).as_posix()
    hits: list[str] = []
    text = path.read_text(encoding="utf-8", errors="replace")
    for lineno, line in enumerate(text.splitlines(), 1):
        if pattern.search(line):
            hits.append(f"{rel}:{lineno}: {line.strip()}")
    return hits


def test_the_document_is_not_called_an_ast() -> None:
    hits: list[str] = []
    for path in _scanned_files():
        if _is_binary(path):
            continue
        # The case-insensitive pattern subsumes the uppercase one in the
        # source suffixes, so each line is reported once.
        pattern = LOWER_RE if path.suffix in LOWER_SUFFIXES else UPPER_RE
        hits += _hits(path, pattern)
    assert not hits, (
        f"{len(hits)} mention(s) of the retired name; {HINT}:\n  " + "\n  ".join(hits)
    )


def test_scanned_trees_exist() -> None:
    """A renamed or deleted tree must not turn the ratchet green by scanning
    nothing; the hit grows silently until someone notices the empty scan."""
    missing = [tree for tree in TREES if not (ROOT / tree).is_dir()]
    missing += [name for name in FLAT_FILES if not (ROOT / name).is_file()]
    assert not missing, "ratchet surface moved; update tests/test_no_ast_term.py:\n  " + "\n  ".join(missing)
