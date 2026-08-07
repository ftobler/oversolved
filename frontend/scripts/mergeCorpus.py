#!/usr/bin/env python3
"""Merge the regen payload into the frozen baseline + coverage manifest.

The TS generator (scripts/regenCorpus.ts) solves the new/changed corpus cases
through the live kernel and writes scripts/corpus-regen.json. This script merges
those entries into regression-baseline.json and corpus-manifest.json using the
same format the original generator used, so unchanged entries round-trip
byte-identically and a regen diffs only the real data changes. The manifest
keeps its original key order (summary, coverage, cases) and gains the new cases
in place; summary counts are recomputed from the cases map so they never drift.

Run from frontend/:  python3 scripts/mergeCorpus.py
"""

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
BASELINE = ROOT.parent / "src" / "wasm-kernel" / "regression-baseline.json"
MANIFEST = ROOT.parent / "src" / "wasm-kernel" / "corpus-manifest.json"
PAYLOAD = ROOT / "corpus-regen.json"


def dump(obj, path: pathlib.Path) -> None:
    # No trailing newline: the original file (also produced by json.dump) has none.
    path.write_text(json.dumps(obj, indent=2, sort_keys=True))


def main() -> None:
    payload = json.loads(PAYLOAD.read_text())
    new_entries = payload["entries"]
    new_cases = payload["cases"]

    baseline = json.loads(BASELINE.read_text())
    by_label = {e["label"]: e for e in baseline}
    for entry in new_entries:
        by_label[entry["label"]] = entry
    merged = []
    for entry in baseline:
        merged.append(by_label.pop(entry["label"]))
    for entry in by_label.values():
        merged.append(entry)
    dump(merged, BASELINE)

    manifest = json.loads(MANIFEST.read_text())
    for case in new_cases:
        manifest["cases"][case["label"]] = {
            "feature_kind": case["feature_kind"],
            "query_tier": case["query_tier"],
            "ok": True,
        }
        key = f"{case['feature_kind']}/{case['query_tier']}"
        if key not in manifest["coverage"]:
            manifest["coverage"][key] = []
        if case["label"] not in manifest["coverage"][key]:
            manifest["coverage"][key].append(case["label"])
    by_tier = {}
    for case in manifest["cases"].values():
        by_tier[case["query_tier"]] = by_tier.get(case["query_tier"], 0) + 1
    by_tier = {tier: by_tier[tier] for tier in sorted(by_tier)}
    total = len(manifest["cases"])
    manifest["summary"]["total"] = total
    manifest["summary"]["ok"] = total
    manifest["summary"]["by_tier"] = by_tier
    # The manifest preserves its original key order (summary, coverage, cases);
    # sort_keys would reorder the top level and churn the whole file.
    MANIFEST.write_text(json.dumps(manifest, indent=2))

    print(f"baseline: {len(merged)} entries")
    print(f"manifest: {total} cases, by_tier={json.dumps(by_tier)}")


if __name__ == "__main__":
    main()
