"""Tests for frontend/scripts/mergeCorpus.py.

The script rewrites the frozen regression goldens (regression-baseline.json
and corpus-manifest.json), so a crash mid-write must never leave a truncated
or half-updated golden behind: the atomic temp-and-replace discipline is what
the full-doc regression test's ground truth depends on.
"""

import importlib.util
import json
import pathlib

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "frontend" / "scripts" / "mergeCorpus.py"

spec = importlib.util.spec_from_file_location("mergeCorpus", SCRIPT)
assert spec is not None and spec.loader is not None
mergeCorpus = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mergeCorpus)


def write_json(path: pathlib.Path, obj) -> None:
    path.write_text(json.dumps(obj, indent=2))


def make_fixture(tmp_path: pathlib.Path):
    """A one-case corpus: baseline entry + manifest case + matching payload."""
    payload = {
        "owned_kinds": ["extrude"],
        "entries": [
            {"label": "ex1", "feature_kind": "extrude", "query_tier": "base", "ok": True}
        ],
        "cases": [
            {"label": "ex1", "feature_kind": "extrude", "query_tier": "base", "ok": True}
        ],
    }
    baseline = [
        {
            "label": "py_old",
            "feature_kind": "box",
            "query_tier": "base",
            "ok": True,
        }
    ]
    manifest = {
        "summary": {"total": 1, "ok": 1, "by_tier": {"base": 1}},
        "coverage": {"box/base": ["py_old"]},
        "cases": {
            "py_old": {"feature_kind": "box", "query_tier": "base", "ok": True}
        },
    }
    payload_path = tmp_path / "payload.json"
    baseline_path = tmp_path / "baseline.json"
    manifest_path = tmp_path / "manifest.json"
    write_json(payload_path, payload)
    write_json(baseline_path, baseline)
    write_json(manifest_path, manifest)
    return payload_path, baseline_path, manifest_path


def read_json(path: pathlib.Path):
    return json.loads(path.read_text())


def test_merge_updates_baseline_and_manifest(tmp_path):
    payload_path, baseline_path, manifest_path = make_fixture(tmp_path)

    mergeCorpus.main([str(payload_path), str(baseline_path), str(manifest_path)])

    baseline = read_json(baseline_path)
    labels = [e["label"] for e in baseline]
    # The non-owned Python-era case is carried forward, the owned one merged.
    assert labels == ["py_old", "ex1"]

    manifest = read_json(manifest_path)
    assert set(manifest["cases"]) == {"py_old", "ex1"}
    assert manifest["summary"]["total"] == 2
    assert manifest["summary"]["ok"] == 2
    assert manifest["summary"]["by_tier"] == {"base": 2}
    assert sorted(manifest["coverage"]) == ["box/base", "extrude/base"]


def test_no_tmp_files_left_behind(tmp_path):
    payload_path, baseline_path, manifest_path = make_fixture(tmp_path)

    mergeCorpus.main([str(payload_path), str(baseline_path), str(manifest_path)])

    leftovers = [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []


def test_crash_mid_write_leaves_previous_goldens_intact(tmp_path, monkeypatch):
    """A disk-full style failure during the write itself corrupts nothing.

    The injected failure fires inside Path.write_text after writing half the
    text, simulating an interrupted write. Against the old direct-write code
    this truncated the real golden; with the temp-and-replace discipline only
    the throwaway .tmp file is damaged and both targets stay valid.
    """
    payload_path, baseline_path, manifest_path = make_fixture(tmp_path)
    original_before = baseline_path.read_text()
    manifest_before = manifest_path.read_text()

    real_write_text = pathlib.Path.write_text

    def failing_write_text(self, data, *args, **kwargs):
        # Fires on the golden targets whatever the implementation writes to:
        # "<name>.json" for the old direct-write code, "<name>.json.tmp" for
        # the temp-and-replace discipline.
        if self.name.startswith(("baseline", "manifest")):
            real_write_text(self, data[: len(data) // 2])
            raise OSError(28, "No space left on device")
        return real_write_text(self, data, *args, **kwargs)

    monkeypatch.setattr(pathlib.Path, "write_text", failing_write_text)

    try:
        mergeCorpus.main([str(payload_path), str(baseline_path), str(manifest_path)])
    except OSError:
        pass
    else:
        raise AssertionError("expected the simulated disk-full failure to raise")

    monkeypatch.undo()
    # Both goldens still parse and still hold their pre-run content: a failed
    # regen leaves nothing half-written behind.
    assert json.loads(baseline_path.read_text()) == json.loads(original_before)
    assert json.loads(manifest_path.read_text()) == json.loads(manifest_before)


def test_failure_on_the_second_write_leaves_both_goldens_old(tmp_path, monkeypatch):
    """The baseline is not replaced until the manifest's temp file exists too.

    Replacing each file as it is produced would leave a new baseline beside
    the old manifest when the second write failed; the pair is only swapped
    once both payloads are on disk.
    """
    payload_path, baseline_path, manifest_path = make_fixture(tmp_path)
    original_before = baseline_path.read_text()
    manifest_before = manifest_path.read_text()

    real_write_text = pathlib.Path.write_text

    def failing_write_text(self, data, *args, **kwargs):
        # Only the manifest temp file fails, so the baseline temp file is on
        # disk when the error is raised.
        if self.name == "manifest.json.tmp":
            raise OSError(28, "No space left on device")
        return real_write_text(self, data, *args, **kwargs)

    monkeypatch.setattr(pathlib.Path, "write_text", failing_write_text)

    try:
        mergeCorpus.main([str(payload_path), str(baseline_path), str(manifest_path)])
    except OSError:
        pass
    else:
        raise AssertionError("expected the simulated disk-full failure to raise")

    monkeypatch.undo()
    assert json.loads(baseline_path.read_text()) == json.loads(original_before)
    assert json.loads(manifest_path.read_text()) == json.loads(manifest_before)
    # The successful first temp write must not be stranded.
    assert [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")] == []


def test_owned_case_missing_from_the_payload_is_pruned(tmp_path):
    """A case whose kind the generator owns and that it stopped emitting is
    removed from both files instead of being frozen forever."""
    payload_path, baseline_path, manifest_path = make_fixture(tmp_path)
    manifest = read_json(manifest_path)
    manifest["cases"]["ex_removed"] = {"feature_kind": "extrude", "query_tier": "base", "ok": True}
    manifest["coverage"]["extrude/base"] = ["ex_removed"]
    manifest["summary"] = {"total": 2, "ok": 2, "by_tier": {"base": 2}}
    write_json(manifest_path, manifest)
    baseline = read_json(baseline_path)
    baseline.append({"label": "ex_removed", "ok": True, "error": None})
    write_json(baseline_path, baseline)

    mergeCorpus.main([str(payload_path), str(baseline_path), str(manifest_path)])

    merged = read_json(baseline_path)
    assert "ex_removed" not in [entry["label"] for entry in merged]
    merged_manifest = read_json(manifest_path)
    assert "ex_removed" not in merged_manifest["cases"]
    assert merged_manifest["coverage"]["extrude/base"] == ["ex1"]
    assert merged_manifest["summary"]["total"] == 2


def test_real_doc_case_is_dropped_not_carried(tmp_path):
    """The real_doc tier moved to the folder corpus, so a stale baseline entry
    and manifest case of that tier are retired even though the kind is not
    owned by the generator."""
    payload_path, baseline_path, manifest_path = make_fixture(tmp_path)
    manifest = read_json(manifest_path)
    manifest["cases"]["real_doc_old"] = {"feature_kind": "box", "query_tier": "real_doc", "ok": True}
    manifest["coverage"]["box/real_doc"] = ["real_doc_old"]
    manifest["summary"] = {"total": 2, "ok": 2, "by_tier": {"base": 1, "real_doc": 1}}
    write_json(manifest_path, manifest)
    baseline = read_json(baseline_path)
    baseline.append({"label": "real_doc_old", "ok": True, "error": None})
    write_json(baseline_path, baseline)

    mergeCorpus.main([str(payload_path), str(baseline_path), str(manifest_path)])

    merged = read_json(baseline_path)
    assert "real_doc_old" not in [entry["label"] for entry in merged]
    merged_manifest = read_json(manifest_path)
    assert "real_doc_old" not in merged_manifest["cases"]
    assert "box/real_doc" not in merged_manifest["coverage"]
    assert merged_manifest["summary"]["by_tier"] == {"base": 2}
