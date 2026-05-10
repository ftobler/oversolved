"""Verify the webapp package does not import cadquery/OCP at module level."""

import ast
import pathlib


def test_webapp_no_cadquery_at_module_level():
    """Scan oversolved/ (excluding kernel/) for OCP/cadquery imports at module level.

    The kernel/ directory is exempt because it is only loaded by the solver
    daemon subprocess which always has cadquery installed.  Files outside
    kernel/ (blueprints, app.py, cli.py, etc.) must not import OCP or
    cadquery at module scope — they may only import them inside function
    bodies (runtime).
    """
    root = pathlib.Path(__file__).parent.parent / "oversolved"
    excluded = {"kernel"}
    errors = []
    for pyfile in sorted(root.rglob("*.py")):
        rel = pyfile.relative_to(root)
        if any(p.name in excluded for p in rel.parents):
            continue
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
                if module == "OCP" or module.startswith("OCP.") or module == "cadquery" or module.startswith("cadquery."):
                    names = [a.name for a in node.names]
                    errors.append(f"{rel}:{node.lineno} from {module} import {', '.join(names)}")
    assert not errors, (
        "Module-level OCP/cadquery imports found outside kernel/:\n"
        + "\n".join(errors)
    )
