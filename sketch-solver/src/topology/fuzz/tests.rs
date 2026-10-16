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
fn arc_snap_targets_the_arc_not_its_chord() {
    // A 90 degree arc: the chord midpoint of a point inside the bulge is far
    // from the curve, so the snap must project by angle. Point (5, 5) sits on
    // the chord of the quarter arc centred at the origin with r = 10; its
    // angular projection is (10 cos 45, 10 sin 45).
    let target = arc([0.0, 0.0], 10.0, 0.0, 90.0);
    let p = project_onto_entity(&target, [5.0, 5.0]).expect("quarter arc projects");
    let r = 10.0 / 2.0_f64.sqrt();
    assert!((p[0] - r).abs() < 1e-9 && (p[1] - r).abs() < 1e-9, "{p:?}");
    // Outside the sweep: clamp to the nearer end, not interpolate around.
    let start = project_onto_entity(&target, [0.0, -5.0]).expect("projects");
    assert!(
        (start[0] - 10.0).abs() < 1e-9 && start[1].abs() < 1e-9,
        "{start:?}"
    );
    let end = project_onto_entity(&target, [-5.0, 0.0]).expect("projects");
    assert!(
        end[0].abs() < 1e-9 && (end[1] - 10.0).abs() < 1e-9,
        "{end:?}"
    );
    // A line still snaps to its chord, a circle to its rim.
    let l = line([0.0, 0.0], [10.0, 0.0]);
    assert_eq!(project_onto_entity(&l, [3.0, 7.0]), Some([3.0, 0.0]));
    let c = circle([0.0, 0.0], 10.0);
    assert_eq!(project_onto_entity(&c, [0.0, 5.0]), Some([0.0, 10.0]));
}

#[test]
fn fuzz_cases_regress() {
    // Every checked-in case is a permanent regression test: the same input
    // must still produce EXACTLY the recorded violations of its class. An
    // extra pending violation of that class fails too (no silent growth: a
    // case may not hide behind the recorded lines), and a case that stops
    // violating was fixed and must be removed, so the directory never
    // accumulates stale known failures.
    let dir = fuzz_cases_dir();
    assert!(
        dir.is_dir(),
        "the fuzz case directory must exist: {}",
        dir.display()
    );
    let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("fuzz case directory reads")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    entries.sort();
    assert!(
        !entries.is_empty(),
        "the fuzz case directory must not be empty: {}",
        dir.display()
    );
    let mut checked = 0;
    let mut failures: Vec<String> = Vec::new();
    for path in entries {
        checked += 1;
        let bytes = std::fs::read(&path).expect("case reads");
        let entities = super::super::codec::decode_input(&bytes)
            .unwrap_or_else(|e| panic!("{}: {e:?}", path.display()));
        let stem = path
            .file_stem()
            .and_then(|n| n.to_str())
            .expect("case file has a stem");
        let seed = stem
            .split('-')
            .next()
            .and_then(|n| n.parse::<u32>().ok())
            .unwrap_or(0);
        // `{seed}-{class}.json` names its class; the plain `{seed}.json` is
        // the coverage minimisation (the first class the harvester writes).
        let class = stem.split_once('-').map(|(_, c)| c).unwrap_or("coverage");
        let pending: Vec<String> = check_generated(&entities, seed)
            .iter()
            .filter(|v| v.class == class)
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
                "{}: no longer violates as {class}, remove the case",
                path.display()
            ));
            continue;
        }
        if pending != recorded {
            failures.push(format!(
                "{}: the recorded {class} violations differ from the pending ones\n  \
                 recorded: {recorded:?}\n  pending: {pending:?}",
                path.display()
            ));
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

/// One seed's known failure classes: the PR range's contract. The
/// sweep fails when a seed fails with a class outside its entry, when a
/// catalogued seed goes clean (delete its entry and cases), and when a clean
/// seed starts failing. `classes` is sorted and deduplicated.
///
/// Coverage, structure and euler entries additionally carry a minimised
/// fixture in `fuzz_cases/`, which `fuzz_cases_regress` replays and pins.
/// Stability and order are catalogue-only on purpose: they are numerous, the
/// jitter and permutation streams make them the most seed-sensitive, and a
/// minimised fixture for each would be hundreds of files with little added
/// signal (the sweep already replays the generated input in full). A fixture
/// class must not be silently accepted without one.
struct KnownSeed {
    seed: u32,
    classes: &'static [&'static str],
}

/// Classes whose catalogue entry must be backed by a minimised fixture.
const REQUIRES_CASE: &[&str] = &["coverage", "structure", "euler"];

/// Every seed in the PR range that fails, with the classes it fails with.
const KNOWN_FAILING_SEEDS: &[KnownSeed] = &[
    KnownSeed {
        seed: 5,
        classes: &["coverage"],
    },
    KnownSeed {
        seed: 8,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 9,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 10,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 11,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 14,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 18,
        classes: &["stability", "structure"],
    },
    KnownSeed {
        seed: 21,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 22,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 24,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 25,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 26,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 29,
        classes: &["coverage", "stability"],
    },
    KnownSeed {
        seed: 32,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 33,
        classes: &["stability", "structure"],
    },
    KnownSeed {
        seed: 34,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 35,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 36,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 37,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 38,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 39,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 43,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 45,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 46,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 48,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 49,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 53,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 54,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 55,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 56,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 58,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 59,
        classes: &["coverage", "stability"],
    },
    KnownSeed {
        seed: 61,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 63,
        classes: &["coverage", "stability"],
    },
    KnownSeed {
        seed: 64,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 66,
        classes: &["coverage", "stability"],
    },
    KnownSeed {
        seed: 67,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 68,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 70,
        classes: &["coverage", "euler"],
    },
    KnownSeed {
        seed: 73,
        classes: &["coverage", "stability"],
    },
    KnownSeed {
        seed: 76,
        classes: &["coverage", "stability"],
    },
    KnownSeed {
        seed: 77,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 79,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 80,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 82,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 84,
        classes: &["coverage", "stability"],
    },
    KnownSeed {
        seed: 85,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 86,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 88,
        classes: &["coverage", "euler"],
    },
    KnownSeed {
        seed: 90,
        classes: &["coverage", "euler"],
    },
    KnownSeed {
        seed: 91,
        classes: &["structure"],
    },
    KnownSeed {
        seed: 92,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 93,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 96,
        classes: &["coverage", "stability"],
    },
    KnownSeed {
        seed: 97,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 98,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 99,
        classes: &["coverage", "euler"],
    },
    KnownSeed {
        seed: 100,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 101,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 102,
        classes: &["coverage", "stability"],
    },
    KnownSeed {
        seed: 103,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 104,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 105,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 106,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 107,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 109,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 110,
        classes: &["euler", "stability"],
    },
    KnownSeed {
        seed: 112,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 113,
        classes: &["coverage", "euler", "structure"],
    },
    KnownSeed {
        seed: 114,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 115,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 116,
        classes: &["coverage", "euler", "structure"],
    },
    KnownSeed {
        seed: 117,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 118,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 119,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 121,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 122,
        classes: &["euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 123,
        classes: &["coverage", "euler"],
    },
    KnownSeed {
        seed: 125,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 126,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 127,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 130,
        classes: &["coverage", "stability"],
    },
    KnownSeed {
        seed: 131,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 132,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 133,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 134,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 135,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 136,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 137,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 138,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 139,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 140,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 141,
        classes: &["coverage", "euler", "structure"],
    },
    KnownSeed {
        seed: 144,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 145,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 146,
        classes: &["coverage", "euler"],
    },
    KnownSeed {
        seed: 148,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 149,
        classes: &["coverage", "euler"],
    },
    KnownSeed {
        seed: 150,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 153,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 154,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 155,
        classes: &["euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 156,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 157,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 159,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 161,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 162,
        classes: &["euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 163,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 164,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 165,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 167,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 168,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 172,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 173,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 175,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 176,
        classes: &["euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 179,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 181,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 183,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 184,
        classes: &["coverage", "euler", "structure"],
    },
    KnownSeed {
        seed: 188,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 189,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 190,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 191,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 192,
        classes: &["coverage", "euler", "structure"],
    },
    KnownSeed {
        seed: 194,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 195,
        classes: &["coverage", "euler"],
    },
    KnownSeed {
        seed: 197,
        classes: &["coverage", "euler"],
    },
    KnownSeed {
        seed: 198,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 199,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 200,
        classes: &["coverage"],
    },
    KnownSeed {
        seed: 202,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 203,
        classes: &["coverage", "euler", "structure"],
    },
    KnownSeed {
        seed: 204,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 205,
        classes: &["euler", "stability"],
    },
    KnownSeed {
        seed: 206,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 207,
        classes: &["coverage", "euler", "order", "stability", "structure"],
    },
    KnownSeed {
        seed: 208,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 209,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 211,
        classes: &["stability", "structure"],
    },
    KnownSeed {
        seed: 212,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 213,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 214,
        classes: &["coverage"],
    },
    KnownSeed {
        seed: 215,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 216,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 218,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 219,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 220,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 222,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 223,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 224,
        classes: &["coverage", "stability"],
    },
    KnownSeed {
        seed: 225,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 226,
        classes: &["stability", "structure"],
    },
    KnownSeed {
        seed: 227,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 228,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 229,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 230,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 233,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 234,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 235,
        classes: &["euler", "stability"],
    },
    KnownSeed {
        seed: 236,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 238,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 240,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 241,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 244,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 246,
        classes: &["stability", "structure"],
    },
    KnownSeed {
        seed: 247,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 249,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 250,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 251,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 252,
        classes: &["coverage", "euler", "order"],
    },
    KnownSeed {
        seed: 253,
        classes: &["coverage", "euler"],
    },
    KnownSeed {
        seed: 254,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 255,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 257,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 258,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 259,
        classes: &["coverage", "euler"],
    },
    KnownSeed {
        seed: 261,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 262,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 263,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 264,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 265,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 266,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 267,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 268,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 269,
        classes: &["euler", "stability"],
    },
    KnownSeed {
        seed: 270,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 271,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 276,
        classes: &["euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 277,
        classes: &["coverage"],
    },
    KnownSeed {
        seed: 279,
        classes: &["euler", "stability"],
    },
    KnownSeed {
        seed: 280,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 281,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 283,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 285,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 286,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 287,
        classes: &["coverage", "euler", "structure"],
    },
    KnownSeed {
        seed: 288,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 290,
        classes: &["euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 291,
        classes: &["coverage", "euler", "stability"],
    },
    KnownSeed {
        seed: 292,
        classes: &["coverage", "stability"],
    },
    KnownSeed {
        seed: 293,
        classes: &["euler", "structure"],
    },
    KnownSeed {
        seed: 295,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 296,
        classes: &["stability"],
    },
    KnownSeed {
        seed: 297,
        classes: &["coverage", "euler", "stability", "structure"],
    },
    KnownSeed {
        seed: 298,
        classes: &["coverage", "stability"],
    },
    KnownSeed {
        seed: 299,
        classes: &["coverage"],
    },
];

fn catalogue_for(seed: u32) -> Option<&'static [&'static str]> {
    KNOWN_FAILING_SEEDS
        .iter()
        .find(|k| k.seed == seed)
        .map(|k| k.classes)
}

/// The classes of one run, sorted and deduplicated: the catalogue's key
/// order.
fn pending_classes(violations: &[Violation]) -> Vec<&'static str> {
    let mut classes: Vec<&'static str> = violations.iter().map(|v| v.class).collect();
    classes.sort_unstable();
    classes.dedup();
    classes
}

/// One sweep over `from..=to` judged against the catalogue. Returns the
/// failure reports and how many seeds match their entry. `write` minimises
/// each new failure into `fuzz_cases/` (the harvesting sweep) and prints the
/// catalogue entries to add; without it the report is the raw violation list,
/// which keeps the PR sweep cheap (minimisation evaluates the predicate
/// hundreds of times per failing seed).
type SweepResult = (Vec<String>, usize);

/// Every catalogue entry that names a fixture class must be backed by its
/// minimised case, in the same tree, so the acceptance can never be vacuous.
/// Checked over the whole catalogue rather than only the seeds one sweep
/// visits: a harvest that failed to write its case must not be papered over
/// by a narrower range.
fn missing_case_failures(entries: &[KnownSeed]) -> Vec<String> {
    let mut failures = Vec::new();
    for k in entries {
        for class in k.classes.iter().filter(|c| REQUIRES_CASE.contains(c)) {
            let path = case_path(k.seed, class);
            if !path.exists() {
                failures.push(format!(
                    "seed {}: class {class} has no fixture at {}",
                    k.seed,
                    path.display()
                ));
            }
        }
    }
    failures
}

fn sweep(from: u32, to: u32, write: bool) -> SweepResult {
    let mut failures = missing_case_failures(KNOWN_FAILING_SEEDS);
    let mut covered = 0usize;
    for seed in from..=to {
        let gen = generate(seed);
        let violations = check_generated(&gen.entities, seed);
        let classes = pending_classes(&violations);
        let known = catalogue_for(seed);
        if known == Some(&classes[..]) {
            covered += 1;
            continue;
        }
        if known.is_none() && classes.is_empty() {
            continue;
        }
        let kinds: Vec<String> = gen.kinds.iter().map(|k| format!("{k:?}")).collect();
        let mut report = format!(
            "seed {seed} ({} entities, {:?}):",
            gen.entities.len(),
            kinds
        );
        match known {
            Some(expected) => {
                report.push_str(&format!(
                    "\n  catalogue says {expected:?}, the sweep found {classes:?}"
                ));
                for v in &violations {
                    report.push_str(&format!("\n  {}", v.render()));
                }
            }
            None => {
                if write {
                    for (class, entities, texts) in minimise_seed(&gen, seed, &violations) {
                        report.push_str(&format!("\n  {class}: {}", texts.join(" | ")));
                        if REQUIRES_CASE.contains(&class.as_str()) {
                            report.push_str(&format!(
                                "\n  minimised input:\n{}",
                                String::from_utf8_lossy(&input_json(&entities))
                            ));
                            write_case(seed, &class, &entities, &texts);
                        }
                    }
                    report.push_str(&format!(
                        "\n  new catalogue entry: KnownSeed {{ seed: {seed}, classes: &{classes:?} }},"
                    ));
                } else {
                    for v in &violations {
                        report.push_str(&format!("\n  {}", v.render()));
                    }
                }
            }
        }
        failures.push(report);
    }
    (failures, covered)
}

#[test]
fn a_catalogue_entry_without_its_fixture_fails_the_check() {
    // The check is catalogue-wide and must catch a missing file in either
    // naming form: seed 3000000 (coverage, `<seed>.json`) and seed 3000001
    // (euler, `<seed>-<class>.json`) cannot have fixtures, while every real
    // fixture entry must be backed.
    let phantom = [
        KnownSeed {
            seed: 3000000,
            classes: &["coverage", "stability"],
        },
        KnownSeed {
            seed: 3000001,
            classes: &["euler"],
        },
    ];
    let failures = missing_case_failures(&phantom);
    assert_eq!(failures.len(), 2, "{failures:?}");
    assert!(
        failures.iter().any(|f| f.contains("3000000.json")),
        "{failures:?}"
    );
    assert!(
        failures.iter().any(|f| f.contains("3000001-euler.json")),
        "{failures:?}"
    );
    assert!(
        missing_case_failures(KNOWN_FAILING_SEEDS).is_empty(),
        "the catalogue's fixtures are incomplete: {:?}",
        missing_case_failures(KNOWN_FAILING_SEEDS)
    );
}

#[test]
fn fuzz_seeds_0_300() {
    // The PR gate: 300 seeds, each either clean or exactly the classes its
    // catalogue entry names, with a minimised fixture behind every coverage,
    // structure and euler entry.
    let (failures, covered) = sweep(0, 299, false);
    eprintln!("fuzz_seeds_0_300: {covered} seed(s) match the catalogue");
    assert!(
        failures.is_empty(),
        "sweep disagreements (rerun with SKETCH_FUZZ_WRITE=1 to harvest):\n{}",
        failures.join("\n")
    );
}

#[test]
#[ignore]
fn fuzz_range_from_env() {
    // The long sweep. `just sketch-fuzz <from> <to>` sets the range, writes a
    // minimised fixture for every new coverage/structure/euler failure into
    // fuzz_cases/, and prints the catalogue entries to add to
    // KNOWN_FAILING_SEEDS for review; a run that finds nothing prints the
    // range it covered.
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
        "sketch fuzz {from}..{to}: {} disagreement(s), {covered} seed(s) match the catalogue, \
         harvest mode: {write}",
        failures.len()
    );
    for f in &failures {
        eprintln!("{f}");
    }
    assert!(
        failures.is_empty() || write,
        "{} disagreement(s); rerun with SKETCH_FUZZ_WRITE=1 to harvest cases and entries",
        failures.len()
    );
}
