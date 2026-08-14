#!/usr/bin/env python3
"""Merge the regen payload into the frozen baseline + coverage manifest.

The TS generator (scripts/regenCorpus.ts) solves the new/changed corpus cases
through the live kernel and writes scripts/corpus-regen.json, declaring the
feature kinds it owns. This script merges those entries into
regression-baseline.json and corpus-manifest.json using the same format the
original generator used, so unchanged entries round-trip byte-identically and a
regen diffs only the real data changes. The manifest keeps its original key
order (summary, coverage, cases) and gains the new cases in place; summary
counts are recomputed from the cases map so they never drift.

The payload's cases are the intended label set. A baseline entry or manifest
case whose label is absent from the payload and whose kind the generator owns
has vanished from a spec and is pruned, so a removed case is not frozen
forever. Cases the generator does not own (the Python-era corpus it never
regenerates) are carried forward untouched, so a partial regen cannot silently
drop the rest of the corpus. summary.ok is counted from the per-case ok flags,
never assumed to equal total.

Run from frontend/:  python3 scripts/mergeCorpus.py [payload baseline manifest]
The optional positional paths point a dry run at copies without touching the
frozen files.
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
BASELINE = ROOT.parent / "src" / "wasm-kernel" / "regression-baseline.json"
MANIFEST = ROOT.parent / "src" / "wasm-kernel" / "corpus-manifest.json"
PAYLOAD = ROOT / "corpus-regen.json"


def dump(obj, path: pathlib.Path) -> None:
    # No trailing newline: the original file (also produced by json.dump) has none.
    path.write_text(json.dumps(obj, indent=2, sort_keys=True))


def case_record(case: dict) -> dict:
    # The manifest keys each case by label, so drop the payload's redundant field.
    return {
        "feature_kind": case["feature_kind"],
        "query_tier": case["query_tier"],
        "ok": case["ok"],
    }


def main(argv: list[str] | None = None) -> None:
    args = list(argv) if argv is not None else sys.argv[1:]
    payload_path = pathlib.Path(args[0]) if args else PAYLOAD
    baseline_path = pathlib.Path(args[1]) if len(args) > 1 else BASELINE
    manifest_path = pathlib.Path(args[2]) if len(args) > 2 else MANIFEST

    payload = json.loads(payload_path.read_text())
    new_entries = {e["label"]: e for e in payload["entries"]}
    new_cases = {c["label"]: c for c in payload["cases"]}
    # The generator declares the kinds it owns; older payloads imply them from
    # the cases they carry.
    owned_kinds = set(payload.get("owned_kinds") or [c["feature_kind"] for c in payload["cases"]])

    manifest = json.loads(manifest_path.read_text())
    old_cases = manifest["cases"]

    # The intended case set = the generator's fresh cases plus every existing
    # manifest case the generator does not own. An owned label missing from the
    # payload was removed from a spec and is pruned rather than frozen forever;
    # non-owned labels survive a partial regen untouched.
    intended = {}
    for label in list(old_cases):
        if label in new_cases:
            intended[label] = case_record(new_cases[label])
        elif old_cases[label]["feature_kind"] not in owned_kinds:
            intended[label] = old_cases[label]
    for label, case in new_cases.items():
        intended.setdefault(label, case_record(case))

    baseline = json.loads(baseline_path.read_text())
    by_label = {e["label"]: e for e in baseline}
    for label, entry in new_entries.items():
        by_label[label] = entry
    merged = []
    for entry in baseline:
        # pop every label so pruned ones cannot leak back through the leftovers.
        kept = by_label.pop(entry["label"])
        if entry["label"] in intended:
            merged.append(kept)
    for entry in by_label.values():
        merged.append(entry)
    dump(merged, baseline_path)

    old_cases.clear()
    old_cases.update(intended)

    coverage = manifest["coverage"]
    for key in list(coverage):
        kept = [label for label in coverage[key] if label in old_cases]
        if kept:
            coverage[key] = kept
        else:
            del coverage[key]
    for label, case in new_cases.items():
        key = f"{case['feature_kind']}/{case['query_tier']}"
        if key not in coverage:
            coverage[key] = []
        if label not in coverage[key]:
            coverage[key].append(label)

    by_tier: dict[str, int] = {}
    for case in old_cases.values():
        by_tier[case["query_tier"]] = by_tier.get(case["query_tier"], 0) + 1
    by_tier = {tier: by_tier[tier] for tier in sorted(by_tier)}
    total = len(old_cases)
    ok_count = sum(1 for case in old_cases.values() if case["ok"])
    manifest["summary"]["total"] = total
    manifest["summary"]["ok"] = ok_count
    manifest["summary"]["by_tier"] = by_tier
    # The manifest preserves its original key order (summary, coverage, cases);
    # sort_keys would reorder the top level and churn the whole file.
    manifest_path.write_text(json.dumps(manifest, indent=2))

    print(f"baseline: {len(merged)} entries")
    print(f"manifest: {total} cases, {ok_count} ok, by_tier={json.dumps(by_tier)}")


if __name__ == "__main__":
    main()
