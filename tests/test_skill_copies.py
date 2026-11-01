"""The mcp-practice skill exists once, copied by hand into two harnesses.

`mcp-practice` is loaded by both Claude Code (`.claude/skills/`) and OpenCode
(`.opencode/skills/`), and the harnesses read different directories, so the
tree has to be present twice. A symlink is not safe across every checkout and
harness, so the two trees are real copies: this guard keeps them byte-equal and
fails the moment an edit lands in only one of them.
"""

import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

TREES = (
    ROOT / ".claude/skills/mcp-practice",
    ROOT / ".opencode/skills/mcp-practice",
)


def _files(tree: pathlib.Path) -> dict[str, bytes]:
    return {
        path.relative_to(tree).as_posix(): path.read_bytes()
        for path in sorted(tree.rglob("*"))
        if path.is_file() and "__pycache__" not in path.parts
    }


def test_skill_copies_exist():
    for tree in TREES:
        assert tree.is_dir(), f"missing skill tree: {tree}"
        assert _files(tree), f"empty skill tree: {tree}"


def test_skill_copies_are_byte_identical():
    left, right = (_files(tree) for tree in TREES)
    assert left.keys() == right.keys(), (
        f"skill file lists differ: only in .claude: {sorted(left.keys() - right.keys())}, "
        f"only in .opencode: {sorted(right.keys() - left.keys())}"
    )
    for name in sorted(left):
        assert left[name] == right[name], f"skill file differs between harnesses: {name}"
