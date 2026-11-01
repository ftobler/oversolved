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

The payload's cases are the intended label set, and the merge refuses a short
one: every existing non-`real_doc` case must appear in the payload, so a stale
gitignored corpus-regen.json cannot silently delete the cases it omits. The
generator owns every kind in the corpus (regenCorpus re-solves all 55 baseline
specs, not a slice), so kind ownership cannot excuse an omission. A
non-`real_doc` case is removed only when its label is named with --prune, the
deliberate path for a case retired from the corpus. The `real_doc` tier is
never carried: it moved to the folder corpus (`frontend/regressions/`), and a
stale payload naming one is dropped rather than re-inserted. summary.ok is
counted from the per-case ok flags, never assumed to equal total.

Run from frontend/:
  python3 scripts/mergeCorpus.py [--prune LABEL ...] [payload baseline manifest]
The optional positional paths point a dry run at copies without touching the
frozen files.
"""

import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
BASELINE = ROOT.parent / "src" / "wasm-kernel" / "regression-baseline.json"
MANIFEST = ROOT.parent / "src" / "wasm-kernel" / "corpus-manifest.json"
PAYLOAD = ROOT / "corpus-regen.json"


def write_pair(files: list[tuple[pathlib.Path, str]]) -> None:
    # Both goldens are written to temp files first and only then renamed into
    # place: a crash while producing the second payload (Ctrl-C, OOM, disk
    # full) must leave BOTH previous files intact. Replacing as we go would
    # leave a new baseline beside an old manifest, a pair that describes two
    # different corpora.
    written: list[tuple[pathlib.Path, pathlib.Path]] = []
    try:
        for path, text in files:
            tmp = path.with_name(path.name + ".tmp")
            written.append((tmp, path))
            tmp.write_text(text)
        for tmp, path in written:
            os.replace(tmp, path)
    except BaseException:
        # A partial write must not strand a temp file next to the goldens.
        for tmp, _ in written:
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass
        raise


def case_record(case: dict) -> dict:
    # The manifest keys each case by label, so drop the payload's redundant field.
    return {
        "feature_kind": case["feature_kind"],
        "query_tier": case["query_tier"],
        "ok": case["ok"],
    }


def parse_args(argv: list[str]) -> tuple[list[str], set[str]]:
    """Split the repeatable --prune option from the positional paths."""
    positional: list[str] = []
    prune: set[str] = set()
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--prune":
            if i + 1 >= len(argv):
                raise SystemExit("error: --prune needs a case label")
            prune.add(argv[i + 1])
            i += 2
        elif arg.startswith("--prune="):
            prune.add(arg.split("=", 1)[1])
            i += 1
        else:
            positional.append(arg)
            i += 1
    return positional, prune


def main(argv: list[str] | None = None) -> None:
    args, prune = parse_args(list(argv) if argv is not None else sys.argv[1:])
    payload_path = pathlib.Path(args[0]) if args else PAYLOAD
    baseline_path = pathlib.Path(args[1]) if len(args) > 1 else BASELINE
    manifest_path = pathlib.Path(args[2]) if len(args) > 2 else MANIFEST

    payload = json.loads(payload_path.read_text())
    # A payload carrying a real_doc case is stale: that tier moved to the folder
    # corpus and must never re-enter either golden, even if a hand-made payload
    # names it. Filter it here as well as in the manifest branch below.
    stale_payload_real_docs = sorted(
        c["label"] for c in payload["cases"] if c.get("query_tier") == "real_doc"
    )
    new_cases = {
        c["label"]: c for c in payload["cases"]
        if c.get("query_tier") != "real_doc"
    }
    new_entries = {e["label"]: e for e in payload["entries"] if e["label"] in new_cases}
    for label in stale_payload_real_docs:
        print(f"ignored stale real_doc payload case: {label}", file=sys.stderr)

    manifest = json.loads(manifest_path.read_text())
    old_cases = manifest["cases"]

    # Completeness: a short payload is a stale or partial regen, not an
    # instruction to delete the rest of the corpus. Kind ownership cannot excuse
    # an omission (the generator owns every kind), and the deliberate removal
    # path names each label in --prune.
    unknown_prunes = sorted(label for label in prune if label not in old_cases)
    if unknown_prunes:
        raise SystemExit(f"error: --prune names unknown case(s): {', '.join(unknown_prunes)}")
    missing = sorted(
        label
        for label, case in old_cases.items()
        if label not in new_cases
        and case.get("query_tier") != "real_doc"
        and label not in prune
    )
    if missing:
        raise SystemExit(
            "error: payload omits case(s): "
            + ", ".join(missing)
            + ". A stale or partial payload must not delete them; pass --prune <label> for each intended removal."
        )

    # The intended case set = the payload's cases plus every existing case that
    # is deliberately retired. real_doc moved to the folder corpus; a --prune
    # label is the explicit removal the completeness check accepted above.
    intended = {}
    for label, case in old_cases.items():
        if label in new_cases:
            intended[label] = case_record(new_cases[label])
        elif case.get("query_tier") == "real_doc" or label in prune:
            continue
        else:
            # Completeness refused every other omission; this is defensive so a
            # future hole cannot silently carry a case the payload forgot.
            raise SystemExit(f"error: payload omits case(s): {label}")
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
    # sort_keys would reorder the top level and churn the whole file. No
    # trailing newline: the original file (also produced by json.dump) has none.
    write_pair([
        (baseline_path, json.dumps(merged, indent=2, sort_keys=True)),
        (manifest_path, json.dumps(manifest, indent=2)),
    ])

    print(f"baseline: {len(merged)} entries")
    print(f"manifest: {total} cases, {ok_count} ok, by_tier={json.dumps(by_tier)}")


if __name__ == "__main__":
    main()
