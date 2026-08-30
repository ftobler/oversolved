"""Verify the surviving Python tree stays build-time-only tooling.

The app is browser-only: the CAD kernel runs as WASM in the browser and
persistence is IndexedDB, so no Python executes at runtime. All that is left of
the `oversolved` package is the icon generator (`icons.py` + `icon_cairo.py`),
which `just icons` runs at build time against pycairo alone.

Two boundaries used to be enforced separately and are now one rule. The old
one, from phase 4d, was that the Flask package must never import OCP/cadquery
because CAD moved to the browser. The new one is that the server itself is gone
and must not grow back here. Both reduce to: this package imports nothing from
the CAD kernel or the deleted server stack.
"""

import ast
import pathlib

# Every dependency the teardown removed from pyproject's runtime list, plus the
# CAD kernel that was never allowed here. An import of any of these means either
# a server is being rebuilt inside build-time tooling, or CAD work is leaking
# back out of the browser.
FORBIDDEN_ROOTS = frozenset({
    "OCP",
    "cadquery",
    "flask",
    "flask_sock",
    "waitress",
    "gunicorn",
    "gevent",
    "psycopg2",
    "croniter",
    "websockets",
    "PIL",
    "yaml",
})


def _root(dotted: str) -> str:
    return dotted.split(".", 1)[0]


def test_icon_tooling_imports_no_kernel_or_server_packages():
    root = pathlib.Path(__file__).parent.parent / "oversolved"
    errors = []
    for pyfile in sorted(root.rglob("*.py")):
        rel = pyfile.relative_to(root)
        tree = ast.parse(pyfile.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if _root(alias.name) in FORBIDDEN_ROOTS:
                        errors.append(f"{rel}:{node.lineno} imports {alias.name}")
            elif isinstance(node, ast.ImportFrom):
                # Relative imports have no module of their own to classify.
                if node.level == 0 and _root(node.module or "") in FORBIDDEN_ROOTS:
                    names = ", ".join(a.name for a in node.names)
                    errors.append(f"{rel}:{node.lineno} from {node.module} import {names}")
    assert not errors, (
        "oversolved/ is build-time icon tooling; kernel/server imports found:\n"
        + "\n".join(errors)
    )


def test_no_runtime_dependencies_are_declared():
    """pyproject must keep an empty runtime dependency list.

    A dependency added outside the `dev` extra is the signal that something is
    expected to run in production, which for a browser-only app means a server
    crept back in. Guarding the manifest catches that before any import does.
    """
    import tomllib

    pyproject = pathlib.Path(__file__).parent.parent / "pyproject.toml"
    with open(pyproject, "rb") as f:
        data = tomllib.load(f)
    assert data["project"]["dependencies"] == [], (
        "the browser-only app has no Python runtime; put build/test tooling in "
        "the [dev] extra instead"
    )
