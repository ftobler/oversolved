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


# ─── scanner edge cases ───


def test_empty_file_is_clean(tmp_path):
    assert_clean(run_lint(tmp_path, ""))


def test_division_after_postfix_increment_still_detects_comment(tmp_path):
    source = "const x = i++ / 2 // halve it\n"
    assert_violation(run_lint(tmp_path, source), "inline-spacing")


def test_division_after_postfix_decrement_still_detects_comment(tmp_path):
    source = "const x = i-- / 2 // halve it\n"
    assert_violation(run_lint(tmp_path, source), "inline-spacing")


def test_division_after_close_paren_still_detects_comment(tmp_path):
    source = "const r = (a + b) / c // ratio\n"
    assert_violation(run_lint(tmp_path, source), "inline-spacing")


def test_regex_char_class_slash_is_not_a_comment(tmp_path):
    source = "const RE = /[/]/; const ok = 1  // fine\n"
    assert_clean(run_lint(tmp_path, source))


def test_regex_after_arrow_is_scanned_correctly(tmp_path):
    source = "const f = (x) => /a\\/b/.test(x)  // fine\n"
    assert_clean(run_lint(tmp_path, source))


def test_slash_slash_inside_string_is_not_a_comment(tmp_path):
    source = 'const url = "http://x"; const ok = 1  // fine\n'
    assert_clean(run_lint(tmp_path, source))


def test_nested_template_literal_is_scanned_correctly(tmp_path):
    source = "const s = `${`${x}`}`; const ok = 1  // fine\n"
    assert_clean(run_lint(tmp_path, source))


# ─── banner rule ───


def test_dunder_prose_is_not_a_banner(tmp_path):
    source = "// __init__\n"
    assert_clean(run_lint(tmp_path, source))


def test_emphasized_prose_is_not_a_banner(tmp_path):
    source = "// ** emphasized **\n"
    assert_clean(run_lint(tmp_path, source))


def test_symbol_wrapped_prose_is_not_a_banner(tmp_path):
    source = "// ++ note ++\n"
    assert_clean(run_lint(tmp_path, source))


def test_jsdoc_style_separator_inside_block_comment_is_flagged(tmp_path):
    source = "/*\n * ---------------------\n * Section\n */\nconst a = 1\n"
    assert_violation(run_lint(tmp_path, source), "banner")


def test_jsdoc_style_divider_with_text_is_flagged(tmp_path):
    source = "/*\n * ---- Section ----\n */\nconst a = 1\n"
    assert_violation(run_lint(tmp_path, source), "banner")


# ─── flagpole rule ───


def test_box_dashes_in_prose_are_not_flagpole(tmp_path):
    source = "// prose with \u2500\u2500 two \u2500\u2500 here\n"
    assert_clean(run_lint(tmp_path, source))


def test_single_box_dash_in_prose_is_not_flagpole(tmp_path):
    source = "// a \u2500 b\n"
    assert_clean(run_lint(tmp_path, source))


# ─── jsx rule ───


def test_spaced_jsx_comment_is_clean(tmp_path):
    target = tmp_path / "sample.tsx"
    target.write_text("const view = <div>{ /* spaced */ }</div>\n")
    proc = subprocess.run(
        [sys.executable, str(LINT_PY), str(tmp_path)],
        capture_output=True,
        text=True,
    )
    assert_clean(proc)


# ─── emdash rule ───


def test_em_dash_in_multiline_block_reports_the_offending_line(tmp_path):
    source = "/*\n * first line\n * bad \u2014 dash here\n */\n"
    proc = run_lint(tmp_path, source)
    assert_violation(proc, "emdash")
    assert "sample.ts:3" in proc.stdout


def test_en_dash_in_comment_is_flagged(tmp_path):
    source = "// use \u2013 ranges carefully\n"
    assert_violation(run_lint(tmp_path, source), "emdash")


# ─── CLI behaviour ───


def test_duplicate_folders_do_not_double_report(tmp_path):
    (tmp_path / "sample.ts").write_text("const a = 1 // one space\n")
    proc = subprocess.run(
        [sys.executable, str(LINT_PY), str(tmp_path), str(tmp_path)],
        capture_output=True,
        text=True,
    )
    assert_violation(proc, "inline-spacing")
    assert proc.stdout.count("inline-spacing") == 1


def test_filter_exclusion_skips_matching_files(tmp_path):
    (tmp_path / "keep.ts").write_text("const a = 1 // one space\n")
    (tmp_path / "skip.ts").write_text("const b = 2 // one space\n")
    proc = subprocess.run(
        [
            sys.executable,
            str(LINT_PY),
            str(tmp_path),
            "--filter",
            "*keep.ts",
            "--filter",
            "!*skip.ts",
        ],
        capture_output=True,
        text=True,
    )
    assert_violation(proc, "inline-spacing")
    assert "skip.ts" not in proc.stdout


def test_block_comment_rule_can_be_disabled(tmp_path):
    source = "interface MeshResult {\n  /** Total sub-shapes. */\n  generated: number\n}\n"
    proc = run_lint(tmp_path, source, "--no-block-comment")
    assert_clean(proc)
