use super::*;

#[test]
fn prng_matches_the_typescript_sequence() {
    // Values recorded from `fuzzHarness.ts` `makePrng` in node. The port is
    // only useful if it is bit-exact; a drift here re-rolls every seed and
    // makes a finding unreplayable in the other harness.
    let expect = [
        (
            0u32,
            [
                0.26642920868471265,
                0.0003297457005828619,
                0.2232720274478197,
            ],
        ),
        (
            42,
            [0.6011037519201636, 0.44829055899754167, 0.8524657934904099],
        ),
        (
            123456789,
            [0.2577907438389957, 0.9707721115555614, 0.7853280142880976],
        ),
    ];
    for (seed, values) in expect {
        let mut rnd = Prng::new(seed);
        for want in values {
            assert_eq!(rnd.next_f64(), want, "seed {seed}");
        }
    }
}

#[test]
fn generator_is_deterministic() {
    for seed in 0..64u32 {
        let a = generate(seed);
        let b = generate(seed);
        assert_eq!(
            input_json(&a.entities),
            input_json(&b.entities),
            "seed {seed} is not a function of itself"
        );
        assert_eq!(a.motif_of, b.motif_of, "seed {seed} motif grouping differs");
    }
}

#[test]
fn generator_covers_the_motif_and_scale_space() {
    // A generator that silently stopped drawing a kind (or a scale) would
    // still pass the sweep, so pin the coverage over the PR range.
    let mut kinds = BTreeSet::new();
    let mut scales = BTreeSet::new();
    for seed in 0..300u32 {
        let g = generate(seed);
        let mut rnd = Prng::new(seed);
        scales.insert(SCALES[rnd.below(SCALES.len())].to_bits());
        kinds.extend(g.kinds.iter().copied());
    }
    assert_eq!(scales.len(), SCALES.len(), "every scale should appear");
    assert!(
        kinds.len() == KINDS.len(),
        "expected every motif kind, missing {:?}",
        KINDS
            .iter()
            .filter(|k| !kinds.contains(k))
            .collect::<Vec<_>>()
    );
}

#[test]
fn minimiser_keeps_the_violation() {
    // Planted "bad" input: the predicate holds exactly while both planted
    // entities are present, so a correct minimiser keeps only those.
    let gen = generate(7);
    let mut entities = gen.entities.clone();
    let motif_of = gen.motif_of.clone();
    let planted = [entities[0].0.clone(), entities[3].0.clone()];
    let fails = |cand: &[(String, InputEntity)]| -> bool {
        planted.iter().all(|p| cand.iter().any(|(id, _)| id == p))
    };
    assert!(fails(&entities));
    let minimal = minimise(&entities, &motif_of, &fails);
    let kept: Vec<String> = minimal.iter().map(|(id, _)| id.clone()).collect();
    assert_eq!(
        kept, planted,
        "the minimiser kept more than the planted pair"
    );
    // And the real path: a synthetic failure that no drop can break is
    // returned unchanged.
    let never = |_: &[(String, InputEntity)]| false;
    entities.truncate(4);
    assert_eq!(minimise(&entities, &motif_of, &never).len(), 4);
}

#[test]
fn fuzz_cases_regress() {
    // Every checked-in case is a permanent regression test: the same input
    // must still produce the recorded violations. A case that stops
    // violating was fixed and must be removed (that is the failure below),
    // so the directory never accumulates stale known failures.
    let dir = fuzz_cases_dir();
    let mut checked = 0;
    let mut failures: Vec<String> = Vec::new();
    let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|it| it.filter_map(|e| e.ok().map(|e| e.path())).collect())
        .unwrap_or_default();
    entries.sort();
    for path in entries {
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        checked += 1;
        let bytes = std::fs::read(&path).expect("case reads");
        let entities = super::super::codec::decode_input(&bytes)
            .unwrap_or_else(|e| panic!("{}: {e:?}", path.display()));
        let seed = path
            .file_stem()
            .and_then(|n| n.to_str())
            .and_then(|n| n.split(['.', '-']).next())
            .and_then(|n| n.parse::<u32>().ok())
            .unwrap_or(0);
        let violations = check_generated(&entities, seed);
        let pending: Vec<String> = violations
            .iter()
            .filter(|v| v.is_pending())
            .map(|v| v.render())
            .collect();
        let recorded = std::fs::read_to_string(path.with_extension("txt")).unwrap_or_default();
        let recorded: Vec<String> = recorded
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        if pending.is_empty() {
            failures.push(format!(
                "{}: no longer violates, remove the case",
                path.display()
            ));
            continue;
        }
        for line in &recorded {
            if !pending.contains(line) {
                failures.push(format!(
                    "{}: recorded violation is gone: {line}",
                    path.display()
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "fuzz cases regressed:\n{}",
        failures.join("\n")
    );
    // Informational: the count is visible in the log so a silent shrink of
    // the corpus is noticed.
    eprintln!("fuzz_cases_regress: {checked} case(s) checked");
}

/// Failure classes with a checked-in reproduction from the first sweep. A
/// pending violation of a listed class is accepted because the class is
/// already recorded and reported (the findings table in the plan names the
/// case); phase 4 removes an entry together with its case as it fixes the
/// class. The case file must exist, so the acceptance is never vacuous.
const ACCEPTED_CLASSES: &[(&str, &str)] = &[
    ("coverage", "29.json"),
    ("structure", "141-structure.json"),
    ("euler", "141-euler.json"),
    ("order", "252-order.json"),
    ("stability", "29-stability.json"),
];

fn accepted(class: &str) -> bool {
    ACCEPTED_CLASSES
        .iter()
        .any(|(c, case)| *c == class && fuzz_cases_dir().join(case).exists())
}

/// One sweep over `from..=to`. Returns the failure reports and how many
/// failing seeds are already covered by a checked-in case. `write`
/// minimises each failure and checks the case in; without it the report is
/// the raw violation list, which keeps the PR sweep cheap (minimisation
/// evaluates the predicate hundreds of times per failing seed).
type SweepResult = (Vec<String>, usize);

fn sweep(from: u32, to: u32, write: bool) -> SweepResult {
    let mut failures = Vec::new();
    let mut covered = 0usize;
    for seed in from..=to {
        let gen = generate(seed);
        let violations = check_generated(&gen.entities, seed);
        if !has_pending(&violations) {
            continue;
        }
        if !case_files_for(seed).is_empty() {
            covered += 1;
            continue;
        }
        let kinds: Vec<String> = gen.kinds.iter().map(|k| format!("{k:?}")).collect();
        let pending_classes: Vec<&'static str> = violations
            .iter()
            .filter(|v| v.is_pending())
            .map(|v| v.class)
            .collect();
        if !write
            && pending_classes.iter().all(|c| accepted(c))
            && std::env::var("FUZZ_TRIAGE").is_err()
        {
            covered += 1;
            continue;
        }
        let mut report = format!(
            "seed {seed} ({} entities, {:?}):",
            gen.entities.len(),
            kinds
        );
        if write {
            for (class, entities, texts) in minimise_seed(&gen, seed, &violations) {
                report.push_str(&format!("\n  {class}: {}", texts.join(" | ")));
                report.push_str(&format!(
                    "\n  minimised input:\n{}",
                    String::from_utf8_lossy(&input_json(&entities))
                ));
                write_case(seed, &class, &entities, &texts);
            }
        } else {
            for v in violations.iter().filter(|v| v.is_pending()) {
                report.push_str(&format!("\n  {}", v.render()));
            }
        }
        failures.push(report);
    }
    (failures, covered)
}

#[test]
fn fuzz_seeds_0_300() {
    // The PR gate: 300 seeds, zero untagged violations (or the failing
    // seeds checked in under fuzz_cases/ with their minimised input).
    let (failures, covered) = sweep(0, 299, false);
    eprintln!("fuzz_seeds_0_300: {covered} failing seed(s) covered by checked-in cases");
    assert!(
        failures.is_empty(),
        "untagged violations (rerun with SKETCH_FUZZ_WRITE=1 to check a case in):\n{}",
        failures.join("\n")
    );
}

#[test]
#[ignore]
fn fuzz_range_from_env() {
    // The long sweep. `just sketch-fuzz <from> <to>` sets the range and
    // writes every new minimised case into fuzz_cases/ for review; a run
    // that finds nothing prints the range it covered.
    let env_u32 = |name: &str, fallback: u32| -> u32 {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(fallback)
    };
    let from = env_u32("SKETCH_FUZZ_FROM", 300);
    let to = env_u32("SKETCH_FUZZ_TO", 599);
    let write = std::env::var("SKETCH_FUZZ_WRITE").is_ok_and(|v| v == "1");
    let (failures, covered) = sweep(from, to, write);
    eprintln!(
            "sketch fuzz {from}..{to}: {} new failure(s), {covered} already covered, cases written: {write}",
            failures.len()
        );
    for f in &failures {
        eprintln!("{f}");
    }
    assert!(
        failures.is_empty() || write,
        "{} new failure(s); rerun with SKETCH_FUZZ_WRITE=1 to check them in",
        failures.len()
    );
}
