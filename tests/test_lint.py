"""Tests for the comment-style linter in lint.py."""

import pathlib
import subprocess
import sys

LINT_PY = pathlib.Path(__file__).resolve().parent.parent / "lint.py"


def run_lint(tmp_path: pathlib.Path, source: str, *extra_args: str) -> subprocess.CompletedProcess:
    target = tmp_path / "sample.ts"
    target.write_text(source)
    return subprocess.run(
        [sys.executable, str(LINT_PY), str(tmp_path), *extra_args],
        capture_output=True,
        text=True,
    )


def assert_violation(proc: subprocess.CompletedProcess, rule: str) -> None:
    assert proc.returncode == 1, proc.stderr
    assert f" {rule} " in proc.stdout, proc.stdout


def assert_clean(proc: subprocess.CompletedProcess) -> None:
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_inline_comment_one_space_is_flagged(tmp_path):
    proc = run_lint(tmp_path, "const a = 1 // one space\n")
    assert_violation(proc, "inline-spacing")


def test_inline_comment_two_spaces_is_clean(tmp_path):
    proc = run_lint(tmp_path, "const a = 1  // two spaces\n")
    assert_clean(proc)


def test_inline_comment_aligned_with_neighbour_is_clean(tmp_path):
    source = "const a = 1           // aligned\nconst b = 22          // aligned\n"
    assert_clean(run_lint(tmp_path, source))


def test_isolated_aligned_comment_is_flagged(tmp_path):
    source = "const a = 1          // aligned to nobody\n"
    assert_violation(run_lint(tmp_path, source), "inline-spacing")


def test_slash_slash_in_regex_is_not_a_comment(tmp_path):
    source = "const COMMENTS = [/\\/\\*[\\s\\S]*?\\*\\/\\/g, /x/]\nconst ok = 1  // fine\n"
    assert_clean(run_lint(tmp_path, source))


def test_banner_ascii_separator_is_flagged(tmp_path):
    source = "// --------\n"
    assert_violation(run_lint(tmp_path, source), "banner")


def test_ascii_divider_with_text_is_flagged(tmp_path):
    source = "// --- Section ---\n"
    assert_violation(run_lint(tmp_path, source), "banner")


def test_box_drawing_divider_is_clean(tmp_path):
    source = "// \u2500\u2500\u2500 Cube geometry \u2500\u2500\u2500\n"
    assert_clean(run_lint(tmp_path, source))


def test_ellipsis_prose_is_not_a_banner(tmp_path):
    source = "// ...and it still works -- done\n"
    assert_clean(run_lint(tmp_path, source))


def test_em_dash_in_comment_is_flagged(tmp_path):
    source = "// Host concept is absent \u2014 must never emit $ form.\n"
    assert_violation(run_lint(tmp_path, source), "emdash")


def test_no_dash_in_comment_is_clean(tmp_path):
    source = "// Host concept is absent -- use the other form.\n"
    assert_clean(run_lint(tmp_path, source))


def test_indented_own_line_block_comment_is_flagged(tmp_path):
    source = "interface MeshResult {\n  /** Total sub-shapes. */\n  generated: number\n}\n"
    assert_violation(run_lint(tmp_path, source), "block-comment")


def test_top_level_block_comment_is_clean(tmp_path):
    source = "/** File-level doc. */\nconst a = 1\n"
    assert_clean(run_lint(tmp_path, source))


def test_jsx_comment_is_clean(tmp_path):
    target = tmp_path / "sample.tsx"
    target.write_text("const view = <div>{/* indented jsx */}</div>\n")
    proc = subprocess.run(
        [sys.executable, str(LINT_PY), str(tmp_path)],
        capture_output=True,
        text=True,
    )
    assert_clean(proc)


def test_two_dash_flagpole_is_flagged(tmp_path):
    source = "// \u2500\u2500 Section \u2500\u2500\n"
    assert_violation(run_lint(tmp_path, source), "flagpole")


def test_full_width_flagpole_is_flagged(tmp_path):
    source = "// \u2500\u2500 Section \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n"
    assert_violation(run_lint(tmp_path, source), "flagpole")


def test_three_dash_flagpole_is_clean(tmp_path):
    source = "// \u2500\u2500\u2500 Cube geometry \u2500\u2500\u2500\n"
    assert_clean(run_lint(tmp_path, source))


def test_rule_can_be_disabled(tmp_path):
    source = "// --------\n"
    proc = run_lint(tmp_path, source, "--no-banner")
    assert_clean(proc)


def test_filter_limits_scan(tmp_path):
    (tmp_path / "keep.ts").write_text("const a = 1 // one space\n")
    (tmp_path / "skip.ts").write_text("const b = 2 // one space\n")
    proc = subprocess.run(
        [sys.executable, str(LINT_PY), str(tmp_path), "--filter", "*keep.ts"],
        capture_output=True,
        text=True,
    )
    assert_violation(proc, "inline-spacing")
    assert "skip.ts" not in proc.stdout


def test_empty_directory_is_clean(tmp_path):
    assert_clean(run_lint(tmp_path, "const a = 1  // fine\n"))
