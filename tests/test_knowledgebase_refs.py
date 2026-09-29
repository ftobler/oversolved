"""Guard the agent knowledge base's code references against drift.

`feature/knowledgebase.agent.md` is living reference: every backticked source
file it names must still exist, or the doc sends the next reader hunting for
code that was renamed or deleted. A mention of deleted code that is still
useful context stays legal when it is marked ` (deleted)` right after the ref.

Line-number refs (`file.ts:123`) are banned outright: they rot on the next
edit to the file, so the doc names the function or symbol instead.
"""

import pathlib
import re

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
KB_AGENT = ROOT / "feature" / "knowledgebase.agent.md"

SOURCE_EXTS = (".ts", ".tsx", ".py", ".rs")

# Where source can live. The frontend root is scanned flat (config files only)
# so its node_modules and build output never enter the index.
SOURCE_TREES = (
    "frontend/src",
    "frontend/scripts",
    "sketch-solver",
    "mate-solver",
    "solver-core",
    "oversolved",
    "tests",
)
FLAT_SOURCE_DIRS = ("", "frontend")

# Build output and vendored trees: a ref that only resolves into these names a
# generated artifact, not source, so it must not count as present.
EXCLUDED_DIRS = {"node_modules", "target", "dist", ".git", "__pycache__"}

# A backticked source ref, an optional `:NNN` or `:NNN-MMM` suffix inside the
# backticks, and an optional ` (deleted)` marker right after the closing tick.
REF_RE = re.compile(r"`([\w./-]+\.(?:tsx?|py|rs))(?::[\d-]+)?`(\s*\(deleted\))?")

# Any `name.ext:NNN` line ref, backticked or not.
LINE_REF_RE = re.compile(r"[\w.-]+\.(?:tsx?|py|rs):\d+")


def _excluded(part: str) -> bool:
    return part in EXCLUDED_DIRS or part.startswith("pkg")


def _source_files() -> list[str]:
    """Every source file as a repo-relative posix path."""
    found: list[str] = []
    for tree in SOURCE_TREES:
        base = ROOT / tree
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            rel = path.relative_to(ROOT)
            if path.suffix in SOURCE_EXTS and path.is_file() and not any(_excluded(p) for p in rel.parts[:-1]):
                found.append(rel.as_posix())
    for flat in FLAT_SOURCE_DIRS:
        for path in (ROOT / flat).iterdir():
            if path.suffix in SOURCE_EXTS and path.is_file():
                found.append(path.relative_to(ROOT).as_posix())
    return found


def _resolves(ref: str, files: list[str]) -> bool:
    """A bare name must exist somewhere; a ref with a directory part must be a
    path suffix of a real file, so `utils/foo.ts` cannot match `bar/foo.ts`."""
    ref = ref.removeprefix("./")
    if "/" not in ref:
        return any(f.rsplit("/", 1)[-1] == ref for f in files)
    return any(f == ref or f.endswith("/" + ref) for f in files)


def _kb_text() -> str:
    if not KB_AGENT.is_file():
        pytest.skip("feature/knowledgebase.agent.md is absent (feature/ is a separate, gitignored repo; CI and fresh clones lack it)")
    return KB_AGENT.read_text()


def test_knowledgebase_source_refs_exist() -> None:
    text = _kb_text()
    files = _source_files()
    missing = sorted({m.group(1) for m in REF_RE.finditer(text) if not m.group(2) and not _resolves(m.group(1), files)})
    assert not missing, (
        f"{len(missing)} source ref(s) in feature/knowledgebase.agent.md name no existing file. "
        "Point them at the current file, delete the stale text, or mark a deliberate mention of deleted code with ` (deleted)`:\n  "
        + "\n  ".join(missing)
    )


def test_knowledgebase_has_no_line_number_refs() -> None:
    text = _kb_text()
    hits = sorted({m.group(0) for m in LINE_REF_RE.finditer(text)})
    assert not hits, (
        f"{len(hits)} line-number ref(s) in feature/knowledgebase.agent.md; name the function or symbol instead:\n  "
        + "\n  ".join(hits)
    )
