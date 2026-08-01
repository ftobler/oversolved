"""Verify the webapp package does not import cadquery/OCP at module level."""

import ast
import pathlib


def test_webapp_no_cadquery_at_module_level():
    """Scan oversolved/ for OCP/cadquery imports at module level.

    The CAD solver now runs entirely in the browser (WASM kernel); the Python
    kernel/daemon was removed in phase 4d. Nothing in the Flask package may
    import OCP or cadquery at module scope, and in practice nothing should
    import them at all, since the backend no longer does CAD work.
    """
    root = pathlib.Path(__file__).parent.parent / "oversolved"
    errors = []
    for pyfile in sorted(root.rglob("*.py")):
        rel = pyfile.relative_to(root)
        with open(pyfile) as f:
            tree = ast.parse(f.read())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    name = alias.name
                    if name == "OCP" or name.startswith("OCP.") or name == "cadquery" or name.startswith("cadquery."):
                        errors.append(f"{rel}:{node.lineno} imports {name}")
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                if (module == "OCP" or module.startswith("OCP.")
                        or module == "cadquery" or module.startswith("cadquery.")):
                    names = [a.name for a in node.names]
                    errors.append(f"{rel}:{node.lineno} from {module} import {', '.join(names)}")
    assert not errors, (
        "Module-level OCP/cadquery imports found outside kernel/:\n"
        + "\n".join(errors)
    )
