#!/usr/bin/env python3
"""Comment-style linter for the Oversolved codebase.

Enforces the comment conventions documented in CLAUDE.md against a set of
folders. Right now it understands TypeScript; the rule set is meant to grow.

Each rule is a function registered with the @rule decorator. The registry is
the single source of truth: it drives the --no-<rule> switches, the rule list
in --help, and the enforcement loop in check_file().

Usage:
    python lint.py [dir ...] [--filter GLOB] [--language ts] [--no-<rule>]
"""

from __future__ import annotations

import argparse
import fnmatch
import pathlib
import sys
from dataclasses import dataclass, field
from typing import Callable

EM_DASH = "\u2014"
EN_DASH = "\u2013"
BOX_DASH = "\u2500"
SEPARATORS = frozenset("-=*_#~+")

# A `/` starts a regex literal (not a division) when the previous significant
# token is one of these, so `//` inside such a regex is not a comment.
_REGEX_OPENERS = frozenset("(=,[{:;!&|?+-*%^~<>")
_REGEX_KEYWORDS = frozenset(
    {
        "await",
        "case",
        "delete",
        "do",
        "else",
        "in",
        "instanceof",
        "new",
        "of",
        "return",
        "typeof",
        "void",
        "yield",
    }
)

# Folders that are never worth scanning.
_SKIP_DIRS = frozenset(
    {
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".venv",
        "__pycache__",
        "build",
        "dist",
        "node_modules",
        "target",
    }
)

EXTENSIONS = {"ts": (".ts", ".tsx")}


@dataclass
class Comment:
    kind: str  # "line" or "block"
    line: int
    col: int
    text: str
    trailing: bool = False
    gap: int | None = None  # spaces between code and the marker, when trailing
    jsx: bool = False  # a JSX `{/* ... */}` comment, i.e. the marker directly follows `{`
    lines: list[str] = field(default_factory=list)


@dataclass
class Config:
    rules: frozenset[str]
    language: str

    def enabled(self, rule: str) -> bool:
        return rule in self.rules


@dataclass
class Rule:
    name: str
    description: str
    check: Callable[[pathlib.Path, str, list[Comment]], list[str]]


RULES: dict[str, Rule] = {}


def rule(name: str, description: str) -> Callable[[Callable], Callable]:
    """Register a rule under `name`; the registry drives the CLI and the
    enforcement loop."""

    def decorate(check: Callable) -> Callable:
        RULES[name] = Rule(name=name, description=description, check=check)
        return check

    return decorate


def _line_starts(text: str) -> list[int]:
    starts = [0]
    i = 0
    while True:
        j = text.find("\n", i)
        if j == -1:
            break
        starts.append(j + 1)
        i = j + 1
    return starts


def _line_of(line_starts: list[int], offset: int) -> int:
    """1-based line number for a byte offset."""
    lo, hi = 0, len(line_starts) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if line_starts[mid] <= offset:
            lo = mid
        else:
            hi = mid - 1
    return lo + 1


def _is_regex_start(text: str, i: int) -> bool:
    j = i - 1
    while j >= 0 and text[j] in " \t":
        j -= 1
    if j < 0:
        return True
    last = text[j]
    if last in "+-":
        k = j - 1
        while k >= 0 and text[k] in " \t":
            k -= 1
        if k >= 0 and text[k] == last:
            return False  # `++`/`--` are postfix, so `/` after them is division
    if last in _REGEX_OPENERS:
        return True
    if last.isalnum() or last == "_":
        k = j
        while k >= 0 and (text[k].isalnum() or text[k] == "_"):
            k -= 1
        return text[k + 1:j + 1] in _REGEX_KEYWORDS
    return False


def _skip_string(text: str, i: int, end: int) -> int:
    quote = text[i]
    j = i + 1
    while j < end:
        if text[j] == "\\":
            j += 2
        elif text[j] == quote:
            return j + 1
        else:
            j += 1
    return end


def _skip_regex(text: str, i: int, end: int) -> int:
    j = i + 1
    in_class = False
    while j < end:
        c = text[j]
        if c == "\\":
            j += 2
        elif c == "[":
            in_class = True
            j += 1
        elif c == "]":
            in_class = False
            j += 1
        elif c == "/" and not in_class:
            return j + 1
        else:
            j += 1
    return end


def _advance(text: str, i: int, end: int) -> int:
    """Return the index just past the token starting at i (string, template,
    regex literal or single char), so the scanner never mistakes a `//` inside
    one of those for a comment."""
    c = text[i]
    if c in "'\"":
        return _skip_string(text, i, end)
    if c == "`":
        return _skip_template(text, i, end)
    if c == "/" and i + 1 < end and _is_regex_start(text, i):
        return _skip_regex(text, i, end)
    return i + 1


def _skip_expression(text: str, i: int, end: int) -> int:
    """Skip the code between ${ and } inside a template literal."""
    j = i
    while j < end:
        c = text[j]
        if c == "{":
            j = _skip_expression(text, j + 1, end)
        elif c == "}":
            return j + 1
        elif c in "'\"`":
            j = _skip_string(text, j, end) if c != "`" else _skip_template(text, j, end)
        elif c == "/" and j + 1 < end:
            nxt = text[j + 1]
            if nxt == "/":
                k = text.find("\n", j, end)
                j = end if k == -1 else k
            elif nxt == "*":
                k = text.find("*/", j + 2, end)
                j = end if k == -1 else k + 2
            elif _is_regex_start(text, j):
                j = _skip_regex(text, j, end)
            else:
                j += 1
        else:
            j += 1
    return end


def _skip_template(text: str, i: int, end: int) -> int:
    j = i + 1
    while j < end:
        c = text[j]
        if c == "\\":
            j += 2
        elif c == "`":
            return j + 1
        elif text.startswith("${", j):
            j = _skip_expression(text, j + 2, end)
        else:
            j += 1
    return end


def scan_comments(text: str) -> list[Comment]:
    """Return every line and block comment in the file, correctly skipping
    strings, templates and regex literals."""
    line_starts = _line_starts(text)
    comments: list[Comment] = []
    i = 0
    n = len(text)
    while i < n:
        if text[i] == "/" and i + 1 < n and text[i + 1] in "/*":
            start = i
            line = _line_of(line_starts, start)
            col = start - line_starts[line - 1]
            prefix = text[line_starts[line - 1]:start]
            if text[i + 1] == "/":
                j = text.find("\n", i, n)
                if j == -1:
                    j = n
                body = text[start + 2:j]
                comments.append(
                    Comment(
                        kind="line",
                        line=line,
                        col=col,
                        text=body,
                        trailing=bool(prefix.strip()),
                        gap=(len(prefix) - len(prefix.rstrip(" \t"))) if prefix.strip() else None,
                        lines=body.split("\n"),
                    )
                )
                i = j
            else:
                j = text.find("*/", i + 2, n)
                if j == -1:
                    j = n
                block_end = j + 2
                inner = text[start + 2:j]
                k = start - 1
                while k >= 0 and text[k] in " \t":
                    k -= 1
                jsx = k >= 0 and text[k] == "{"
                comments.append(
                    Comment(
                        kind="block",
                        line=line,
                        col=col,
                        text=inner,
                        trailing=bool(prefix.strip()),
                        gap=(len(prefix) - len(prefix.rstrip(" \t"))) if prefix.strip() else None,
                        jsx=jsx,
                        lines=inner.split("\n"),
                    )
                )
                i = block_end
        else:
            i = _advance(text, i, n)
    return comments


def _dash_runs(text: str) -> list[int]:
    """Lengths of every run of the box-drawing dash in `text`."""
    runs: list[int] = []
    count = 0
    for ch in text:
        if ch == BOX_DASH:
            count += 1
        elif count:
            runs.append(count)
            count = 0
    if count:
        runs.append(count)
    return runs


def _banner_check(lines: list[str], start_line: int, errors: list[str], path: pathlib.Path, kind: str) -> None:
    for idx, raw in enumerate(lines):
        body = raw.strip()
        if not body or len(body) < 3:
            continue
        if kind == "block" and body.startswith("*"):
            body = body[1:].strip()  # JSDoc-style ` * ----` continuation lines are still banners
        if all(ch in SEPARATORS for ch in body):
            errors.append(f"{path}:{start_line + idx}:1: banner - ASCII separator line, use a `---` box-drawing divider")
            continue
        leading = 0
        while leading < len(body) and body[leading] in SEPARATORS:
            leading += 1
        trailing = 0
        while trailing < len(body) - leading and body[-1 - trailing] in SEPARATORS:
            trailing += 1
        middle = body[leading:len(body) - trailing]
        if leading >= 3 and trailing >= 3 and middle.strip():
            errors.append(f"{path}:{start_line + idx}:1: banner - ASCII divider, use a `---` box-drawing divider")


@rule(
    "inline-spacing",
    "a trailing // must be two spaces from the code, or column-aligned with a neighbour",
)
def _check_inline_spacing(path: pathlib.Path, text: str, comments: list[Comment]) -> list[str]:
    errors: list[str] = []
    cols_by_line: dict[int, set[int]] = {}
    for c in comments:
        cols_by_line.setdefault(c.line, set()).add(c.col)
    for c in comments:
        if c.trailing and c.gap != 2:
            if c.kind == "block" and c.jsx and path.suffix == ".tsx":
                continue  # `{/* ... */}` is the one JSX comment form, spacing is not our call
            aligned = c.col in cols_by_line.get(c.line - 1, set()) or c.col in cols_by_line.get(c.line + 1, set())
            if not aligned:
                errors.append(
                    f"{path}:{c.line}:{c.col}: inline-spacing - inline comment must be two spaces from code or aligned with a neighbour"
                )
    return errors


@rule("banner", "no ASCII-art divider lines; the approved divider uses box-drawing dashes")
def _check_banner(path: pathlib.Path, text: str, comments: list[Comment]) -> list[str]:
    errors: list[str] = []
    for c in comments:
        _banner_check(c.lines, c.line, errors, path, c.kind)
    return errors


@rule("emdash", "no em or en dashes inside comments; write -- or reword instead")
def _check_emdash(path: pathlib.Path, text: str, comments: list[Comment]) -> list[str]:
    errors: list[str] = []
    for c in comments:
        for idx, ln in enumerate(c.lines):
            if EM_DASH in ln or EN_DASH in ln:
                errors.append(f"{path}:{c.line + idx}:{c.col}: emdash - no em or en dashes in comments")
    return errors


@rule("block-comment", "an own-line block comment indented inside a block must be a // comment")
def _check_block_comment(path: pathlib.Path, text: str, comments: list[Comment]) -> list[str]:
    errors: list[str] = []
    for c in comments:
        if c.kind == "block" and not c.trailing and c.col > 0 and len(c.lines) == 1:
            errors.append(f"{path}:{c.line}:{c.col}: block-comment - own-line block comment inside a block, use // instead")
    return errors


@rule("flagpole", "a flag-pole divider must use exactly three box-drawing dashes per side")
def _check_flagpole(path: pathlib.Path, text: str, comments: list[Comment]) -> list[str]:
    errors: list[str] = []
    for c in comments:
        for idx, ln in enumerate(c.lines):
            stripped = ln.strip()
            if not stripped.startswith(BOX_DASH) or not stripped.endswith(BOX_DASH):
                continue  # only divider-shaped lines are flagpoles
            bad = [r for r in _dash_runs(ln) if r != 3]
            if bad:
                errors.append(f"{path}:{c.line + idx}:{c.col}: flagpole - flag-pole divider uses {bad} dashes, must be three per side")
    return errors


def check_file(path: pathlib.Path, text: str, config: Config) -> list[str]:
    errors: list[str] = []
    comments = scan_comments(text)
    for rule in RULES.values():
        if config.enabled(rule.name):
            errors.extend(rule.check(path, text, comments))
    return errors


def collect_files(folders: list[pathlib.Path], language: str, filters: list[str]) -> list[pathlib.Path]:
    exts = EXTENSIONS[language]
    includes = [f for f in filters if not f.startswith("!")]
    excludes = [f[1:] for f in filters if f.startswith("!")]
    files: list[pathlib.Path] = []
    seen: set[str] = set()
    for folder in folders:
        if not folder.exists():
            raise SystemExit(f"error: {folder}: no such directory")
        if not folder.is_dir():
            raise SystemExit(f"error: {folder}: not a directory")
        for root, dirs, names in folder.walk():
            dirs[:] = sorted(d for d in dirs if d not in _SKIP_DIRS)
            for name in sorted(names):
                path = pathlib.Path(root) / name
                if path.suffix not in exts:
                    continue
                rel = path.as_posix()
                if includes and not any(fnmatch.fnmatch(rel, pat) for pat in includes):
                    continue
                if any(fnmatch.fnmatch(rel, pat) for pat in excludes):
                    continue
                if rel in seen:
                    continue  # overlapping folder args would otherwise double-report
                seen.add(rel)
                files.append(path)
    return files


def main(argv: list[str] | None = None) -> int:
    rule_lines = "\n".join(f"  {name}: {r.description}" for name, r in RULES.items())
    parser = argparse.ArgumentParser(
        prog="lint.py",
        description=f"Oversolved comment-style linter. Enforces the comment conventions from CLAUDE.md.\n\nRules:\n{rule_lines}",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("folders", nargs="+", help="folders to scan")
    parser.add_argument("--filter", action="append", default=[], metavar="GLOB", help="only check paths matching GLOB (repeatable; prefix with ! to exclude)")
    parser.add_argument("--language", choices=sorted(EXTENSIONS), default="ts", help="comment dialect to enforce (default: ts)")
    for name in RULES:
        parser.add_argument(f"--no-{name}", action="store_true", help=f"disable the {name} rule")
    args = parser.parse_args(argv)

    enabled = {name for name in RULES if not getattr(args, f"no_{name}".replace("-", "_"))}
    config = Config(rules=frozenset(enabled), language=args.language)

    files = collect_files([pathlib.Path(d) for d in args.folders], args.language, args.filter)
    total = 0
    for path in files:
        try:
            text = path.read_text()
        except (OSError, UnicodeDecodeError) as exc:
            print(f"{path}: error reading file: {exc}", file=sys.stderr)
            total += 1
            continue
        errors = check_file(path, text, config)
        for error in errors:
            print(error)
        total += len(errors)

    if total:
        print(f"{total} violation(s) in {len(files)} file(s)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
