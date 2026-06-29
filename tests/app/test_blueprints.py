"""Tests for blueprint registration and structure."""

from pathlib import Path


class TestBlueprintRegistration:
    """Verify all expected blueprints are registered with correct prefixes."""

    EXPECTED_PREFIXES = [
        "/api/auth",
        "/api/users/me",
        "/api/documents",
        "/api/upload",
        "/api/admin",
        "/api/bug-report",
        "/api/docs",
    ]

    def test_all_blueprints_registered(self, app):
        """All expected URL prefixes are accessible."""
        rules = [rule.rule for rule in app.url_map.iter_rules()]
        for prefix in self.EXPECTED_PREFIXES:
            assert any(r.startswith(prefix) for r in rules), f"Missing prefix: {prefix}"

    def test_no_duplicate_routes(self, app):
        """No endpoint has more than the expected number of HTTP methods."""
        from collections import Counter
        rules = [(rule.rule, tuple(sorted(rule.methods - {"OPTIONS", "HEAD"}))) for rule in app.url_map.iter_rules()]
        counts = Counter(rule for rule, _ in rules)
        dupes = {r: c for r, c in counts.items() if c > 5}
        assert not dupes, f"Routes with excessive duplicates: {dupes}"

    def test_auth_routes_registered(self, app):
        """Auth blueprint routes exist."""
        rules = [rule.rule for rule in app.url_map.iter_rules()]
        assert "/api/auth/login" in rules
        assert "/api/auth/logout" in rules
        assert "/api/auth/me" in rules

    def test_document_routes_registered(self, app):
        """Document blueprint routes exist."""
        rules = [rule.rule for rule in app.url_map.iter_rules()]
        assert "/api/documents" in rules
        assert "/api/documents/<uuid>" in rules
        assert "/api/documents/<uuid>/share" in rules
        assert "/api/documents/trash" in rules
        assert "/api/documents/<uuid>/recover" in rules

    def test_admin_routes_registered(self, app):
        """Admin blueprint routes exist."""
        rules = [rule.rule for rule in app.url_map.iter_rules()]
        assert "/api/admin/users" in rules
        assert "/api/admin/backup" in rules
        assert "/api/admin/periodic-tasks" in rules
        assert "/api/admin/periodic-tasks/<task_key>/run" in rules

    def test_rebuild_stats_route_registered(self, app):
        """Rebuild stats route exists on documents blueprint."""
        rules = [rule.rule for rule in app.url_map.iter_rules()]
        assert "/api/documents/<doc_id>/rebuild-stats" in rules

    def test_upload_route_registered(self, app):
        """Upload blueprint route exists."""
        rules = [rule.rule for rule in app.url_map.iter_rules()]
        assert "/api/upload" in rules

    def test_export_routes_absent(self, app):
        """STEP/STL export runs in the browser WASM solver, not the backend.
        The backend export routes were vestigial 503 stubs left over from the
        old Python solver daemon (commit 5f3bfc66) and must not come back."""
        rules = [rule.rule for rule in app.url_map.iter_rules()]
        assert "/api/export/step" not in rules
        assert "/api/export/stl" not in rules

    def test_docs_routes_registered(self, app):
        """Documentation blueprint routes exist."""
        rules = [rule.rule for rule in app.url_map.iter_rules()]
        assert "/api/docs" in rules
        assert "/api/docs/<doc_name>" in rules

    def test_user_profile_routes_registered(self, app):
        """User profile blueprint routes exist."""
        rules = [rule.rule for rule in app.url_map.iter_rules()]
        assert "/api/users/me" in rules
        assert "/api/users/me/preferences" in rules


class TestFileSizeCompliance:
    """Verify all files are under 1000 lines."""

    BP_DIR = Path(__file__).parent.parent.parent / "oversolved" / "blueprints"

    def test_app_py_under_1k_lines(self):
        app_py = Path(__file__).parent.parent.parent / "oversolved" / "app.py"
        lines = len(app_py.read_text().splitlines())
        assert lines < 1000, f"app.py has {lines} lines"

    def test_blueprint_files_under_1k_lines(self):
        for bp_file in sorted(self.BP_DIR.glob("*.py")):
            if bp_file.name == "__init__.py":
                continue
            lines = len(bp_file.read_text().splitlines())
            assert lines < 1000, f"{bp_file.name} has {lines} lines"
