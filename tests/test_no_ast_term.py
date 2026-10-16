"""Ratchet: the part document is not an "AST".

The codebase used to call the part document an abstract syntax tree, a name
that promised a FeatureScript-style program the design deliberately is not.
The word for it is "document"; identifiers say `doc`, matching the existing
`PartDoc`, `loadPartDoc` and `usePartDoc`. See docs/document.md for what the
document actually is.

Case matters, and the name can hide inside a bigger token. The case-sensitive
pattern has no trailing boundary, so it also catches the plural and compound
spellings ("ASTs", "AST-based") that a word-bounded search misses. TypeScript
and Rust source additionally ban `ast` at the start of an identifier, in any
casing (`report.ast`, `astPosById`); the lookarounds leave ordinary words
alone (`last`, `fast`, `asterisk`). Python is exempt from the identifier
check: `import ast` is the standard library parser used by
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

# The term, suffixable: catches "AST" and compounds such as the plural "ASTs".
# Nothing may precede it but a word boundary, so FAST, LAST and CONTRAST stay
# green; those have a letter where this needs the boundary.
TERM_RE = re.compile(r"\bAST")

# Source only: `ast` at the start of an identifier, in any casing (`report.ast`,
# `astPosById`). Uppercase, digits, underscores and non-word characters may
# follow, but not a lowercase continuation (that marks an ordinary word such as
# `asterisk`), and a preceding letter marks the tail of one (`last`, `fast`).
IDENT_RE = re.compile(r"(?<![A-Za-z])(?i:ast)(?![a-z])")

# Source only: a capital spelling inside a camelCase identifier (`myAstValue`,
# `getASTPos`). English words never switch case mid-word, and the lowercase
# tail is excluded, so references such as `$lineAstart` stay green (their
# `ast` is lowercase and continues the word).
CAMEL_RE = re.compile(r"(?<=[a-z])(?:Ast|AST)(?![a-z])")

SOURCE_PATTERNS = (TERM_RE, IDENT_RE, CAMEL_RE)
TEXT_PATTERNS = (TERM_RE,)

# Where an identifier could revive the old name.
SOURCE_SUFFIXES = (".ts", ".tsx", ".rs")

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


def _patterns(path: pathlib.Path) -> tuple[re.Pattern[str], ...]:
    return SOURCE_PATTERNS if path.suffix in SOURCE_SUFFIXES else TEXT_PATTERNS


def _hits(path: pathlib.Path) -> list[str]:
    rel = path.relative_to(ROOT).as_posix()
    patterns = _patterns(path)
    hits: list[str] = []
    text = path.read_text(encoding="utf-8", errors="replace")
    for lineno, line in enumerate(text.splitlines(), 1):
        if any(p.search(line) for p in patterns):
            hits.append(f"{rel}:{lineno}: {line.strip()}")
    return hits


def test_the_document_is_not_called_an_ast() -> None:
    hits: list[str] = []
    for path in _scanned_files():
        if _is_binary(path):
            continue
        hits += _hits(path)
    assert not hits, (
        f"{len(hits)} mention(s) of the retired name; {HINT}:\n  " + "\n  ".join(hits)
    )


def test_patterns_catch_compounds_and_identifiers_only() -> None:
    """Pin the pattern shapes. Both survivor classes must trip the source
    check, while ordinary words that merely contain the three letters stay
    green; a future loosening that starts flagging `last` or `asterisk` fails
    here rather than flooding the ratchet with false hits."""
    should_match = (
        "the AST lives in main-thread JS",
        "the ASTs are byte-identical",
        "an AST-based replay",
        "sections.push('## AST')",
        "if (report.ast !== undefined) {",
        "const astPosById = new Map(",
        "const myAstValue = 1",
        "getASTPos()",
    )
    should_not_match = (
        "FAST",
        "CONTRAST",
        "asterisk",
        "last",
        "fast",
        "past",
        "cast",
        "blast",
        "contrast",
        "master",
        "astronomy",
        "asthma",
        "a: '$lineAstart'",
    )
    missed = [s for s in should_match if not any(p.search(s) for p in SOURCE_PATTERNS)]
    false_hits = [s for s in should_not_match if any(p.search(s) for p in SOURCE_PATTERNS)]
    assert not missed, "patterns miss the term in:\n  " + "\n  ".join(missed)
    assert not false_hits, "patterns flag ordinary words:\n  " + "\n  ".join(false_hits)
    # The plain-text pass must catch the plural too, without the source pattern.
    assert any(p.search("the ASTs are byte-identical") for p in TEXT_PATTERNS)


def test_scanned_trees_exist() -> None:
    """A renamed or deleted tree must not turn the ratchet green by scanning
    nothing; the hit grows silently until someone notices the empty scan."""
    missing = [tree for tree in TREES if not (ROOT / tree).is_dir()]
    missing += [name for name in FLAT_FILES if not (ROOT / name).is_file()]
    assert not missing, "ratchet surface moved; update tests/test_no_ast_term.py:\n  " + "\n  ".join(missing)
