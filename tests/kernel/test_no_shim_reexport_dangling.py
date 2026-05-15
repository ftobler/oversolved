"""Assert that no .py file imports from removed backward-compat shim paths."""

import ast
import pathlib
import re

REPO_ROOT = pathlib.Path(__file__).parent.parent.parent

SCAN_DIRS = [
    REPO_ROOT / "oversolved",
    REPO_ROOT / "tests",
]

# Exact banned module names. A module name must equal one of these exactly
# (not just start with it) to be flagged. This prevents false positives from
# modules like geometry_tessellation or solver_features_shared.
BANNED_EXACT = {
    "oversolved.kernel.geometry",
    "oversolved.kernel.geometry_boolean",
    "oversolved.kernel.solver_features",
}


def _is_banned(module_name: str) -> bool:
    """Return True if module_name is exactly one of the banned shim paths."""
    return module_name in BANNED_EXACT


def _collect_imports(pyfile: pathlib.Path) -> list[str]:
    """Return list of module names imported at any level in a .py file."""
    try:
        tree = ast.parse(pyfile.read_text())
    except SyntaxError:
        return []
    names = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                names.append(node.module)
    return names


def test_no_banned_shim_imports():
    """No file in oversolved/ or tests/ imports from deleted shim modules."""
    violations: list[str] = []
    for scan_dir in SCAN_DIRS:
        for pyfile in sorted(scan_dir.rglob("*.py")):
            for module_name in _collect_imports(pyfile):
                if _is_banned(module_name):
                    rel = pyfile.relative_to(REPO_ROOT)
                    violations.append(f"{rel}: imports '{module_name}'")

    assert not violations, (
        "Found imports from deleted shim modules:\n" + "\n".join(violations)
    )
