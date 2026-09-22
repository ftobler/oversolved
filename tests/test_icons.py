"""Guard the icon set's registry in oversolved/icons.py.

Importing icons.py runs every `@icon` decorator against icon_cairo's
module-level registry. `just icons` walks that registry to write the SVGs, so a
duplicate output path would mean one icon silently overwrites another's file.
This is the cheap invariant; per-icon pixel goldens would just pin the art.

Mirrors the build invocation (`python oversolved/icons.py`) by putting
oversolved/ on sys.path: icons.py imports icon_cairo as a top-level module.
"""

import pathlib
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _load(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "oversolved"))
    import icon_cairo
    import icons

    return icons, icon_cairo


def test_icon_registry_output_paths_are_unique(monkeypatch):
    _icons, icon_cairo = _load(monkeypatch)
    paths = [entry[0] for entry in icon_cairo._registry]
    assert paths, "importing icons must register at least one icon"

    duplicates = sorted(p for p, n in Counter(paths).items() if n > 1)
    assert not duplicates, f"duplicate icon output paths: {duplicates}"


def test_draw_all_renders_each_registry_entry(tmp_path, monkeypatch):
    _icons, icon_cairo = _load(monkeypatch)
    monkeypatch.setattr(icon_cairo, "_registry", [])

    targets = [tmp_path / "first.svg", tmp_path / "second.svg"]

    def draw(ctx):
        ctx.move_to(0.2, 0.2)
        ctx.line_to(0.8, 0.8)
        icon_cairo.stroke(ctx, 1.5)

    for target in targets:
        icon_cairo.icon(str(target))(draw)

    icon_cairo.draw_all()

    for target in targets:
        assert target.exists(), f"{target.name} was not rendered"
        assert "<svg" in target.read_text()
