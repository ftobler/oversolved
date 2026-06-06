"""Real-document parity anchors for the WASM full-doc gate (phase 4b.5).

Best-effort loader for real app-exported PartDoc YAMLs (the "other-PC" docs).
They live gitignored under ``oversolved_corpus/`` at the repo root -- opportunistic
local signal, not committed deterministic fixtures (the backend they parity
against is slated for deletion in 4d, which makes this obsolete anyway). When the
directory is absent the loader returns nothing, so CI/`just parity` stay green.

Normalization: real docs always carry the builtin `origin` + Top/Front/Right
`plane` features, both in ``UNPORTED_KINDS``, which would make the TS router skip
the whole doc. The TS kernel seeds those builtins implicitly (initGlobalRepo +
BUILTIN_PLANE_RESULTS), and the docs reference the builtin plane *elements*
(`@builtin_plane_top`), never the feature ids, so stripping the builtin features
is geometry-preserving and makes every otherwise-ported doc measurable.

Skip-on-failure is layered: a YAML that fails to parse is skipped here; a doc the
Python kernel cannot build is marked ok=False by ``run_specs`` and skipped by the
harness; the diffs themselves are treated as a soft (warn-not-fail) tier so an
opportunistic real doc that hits an accepted divergence never breaks the gate.
"""

from __future__ import annotations

import glob
import os
from typing import Any

import yaml

_BUILTIN_FEATURE_KINDS = {"origin", "plane"}

# Docs that HANG the TS kernel (sync infinite loop -> cannot be skipped at runtime,
# since JS can't interrupt synchronous code; including them blocks the whole gate).
# Quarantined here with the finding; remove a stem once the kernel bug is fixed.
#   (translate: FIXED. The hang was a circular_array whose edge-query axis failed
#    to resolve in the TS kernel -- the builder never registered B-rep face/edge/
#    vertex ancestry into the *live* repo during the feature loop (Python's
#    _register_body_faces was unported, builder.ts had a TODO), so the axis query
#    fell back to the world Z origin and the degenerate overlapping rotated copies
#    hung ShapeUpgrade_UnifySameDomain. Wiring _registerBodyFaces into the loop
#    resolves the axis to Python's edge and the fuse completes.)
_QUARANTINE_STEMS: set[str] = set()
_CORPUS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "oversolved_corpus",
)


def _strip_builtins(features: list[dict]) -> list[dict]:
    """Drop the builtin origin/plane features the TS kernel provides implicitly."""
    return [f for f in features if f.get("kind") not in _BUILTIN_FEATURE_KINDS]


def real_doc_fixtures(corpus_dir: str | None = None) -> list[dict[str, Any]]:
    """Return tagged fixtures for each loadable real doc, or [] when none present."""
    corpus_dir = corpus_dir or _CORPUS_DIR
    if not os.path.isdir(corpus_dir):
        return []
    out: list[dict[str, Any]] = []
    for path in sorted(glob.glob(os.path.join(corpus_dir, "*.yaml"))):
        stem = os.path.splitext(os.path.basename(path))[0]
        if stem in _QUARANTINE_STEMS:
            continue  # would hang the TS kernel; see _QUARANTINE_STEMS
        try:
            doc = yaml.safe_load(open(path))
        except Exception:
            continue  # best-effort: skip an unparseable doc
        if not isinstance(doc, dict) or "features" not in doc:
            continue
        label = "real_" + stem.replace(" ", "_").replace("(", "").replace(")", "")
        spec = {
            "version": doc.get("version", 1),
            "kind": "part",
            "features": _strip_builtins(doc.get("features", [])),
        }
        out.append({
            "label": label,
            "spec": spec,
            "tags": {"feature_kind": "real", "query_tier": "real_doc"},
            "soft": True,
        })
    return out
