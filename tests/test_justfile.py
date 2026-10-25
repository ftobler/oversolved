"""Pin the justfile's `just --list` descriptions.

`just` takes the single comment line directly above a recipe (attributes may sit
between) as its description. A long explanation written straight above a
recipe therefore leaks its last line into the listing ("# suite skips
silently."), so every recipe keeps its explanation in a separate block and a
one-line summary of its own.
"""

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent

# A recipe header starts at column 0; `name := value` assignments and `set`
# lines are not recipes.
RECIPE = re.compile(r"^([a-z][a-z0-9-]*)(?: [^:]*)?:(?!=)")


def recipe_docs() -> dict[str, list[str]]:
    """Map each recipe to the comment block directly above it."""
    lines = (ROOT / "justfile").read_text().splitlines()
    docs: dict[str, list[str]] = {}
    for i, line in enumerate(lines):
        match = RECIPE.match(line)
        if not match or line.startswith("set "):
            continue
        j = i - 1
        while j >= 0 and lines[j].startswith("["):
            j -= 1
        block: list[str] = []
        while j >= 0 and lines[j].startswith("#"):
            block.insert(0, lines[j])
            j -= 1
        docs[match.group(1)] = block
    return docs


def test_recipes_are_found() -> None:
    # Guards the parser itself: a regex that matched nothing would pass the
    # description test vacuously.
    docs = recipe_docs()
    assert {"dev", "python", "frontend", "wasm", "install", "fuzz"} <= docs.keys()


def test_every_recipe_has_a_one_line_summary() -> None:
    bad = []
    for name, block in recipe_docs().items():
        if len(block) != 1:
            bad.append(f"{name}: {len(block)} comment lines directly above it")
            continue
        text = block[0].removeprefix("# ")
        if not (text[:1].isupper() and text.endswith(".")):
            bad.append(f"{name}: {text!r} is not a sentence")
    assert not bad, (
        "each recipe needs exactly one summary comment line, a sentence, with any "
        "longer explanation in its own block above a blank line:\n" + "\n".join(bad)
    )


def test_fuzz_recipe_is_the_full_main_gate_suite() -> None:
    """`just fuzz` is the one entry point the main gate calls.

    Its body pins the three long sweeps and their main-gate sizes, so renaming
    or resizing a sub-recipe cannot silently drop one from the suite.
    """
    lines = (ROOT / "justfile").read_text().splitlines()
    start = lines.index("fuzz:")
    body: list[str] = []
    for line in lines[start + 1:]:
        if not line.strip():
            break
        body.append(line)
    text = "\n".join(body)
    for command in ("just fuzz-session 200 40", "just action-matrix", "just fuzz-geometry 1500 4"):
        assert command in text, f"`just fuzz` no longer runs `{command}`"
