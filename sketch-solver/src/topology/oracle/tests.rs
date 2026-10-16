use super::*;
use crate::radians;
use crate::topology::codec;
use crate::topology::dcel::{detect_topology, InputEntity};
use crate::topology::profile_loops::Vec2;
use crate::topology::TOL_TOPOLOGY_MERGE as MERGE;

// ─── hand fixtures (the geometries the dcel tests pin) ───

fn line(p0: Vec2, p1: Vec2) -> InputEntity {
    InputEntity {
        start: Some(p0),
        end: Some(p1),
        ..Default::default()
    }
}

fn circle(c: Vec2, r: f64) -> InputEntity {
    InputEntity {
        center: Some(c),
        radius: Some(r),
        ..Default::default()
    }
}

fn arc(c: Vec2, r: f64, a0: f64, a1: f64) -> InputEntity {
    let at = |deg: f64| {
        let a = radians(deg);
        [c[0] + r * a.cos(), c[1] + r * a.sin()]
    };
    InputEntity {
        center: Some(c),
        radius: Some(r),
        start: Some(at(a0)),
        end: Some(at(a1)),
        angle_start: Some(a0),
        angle_end: Some(a1),
        ..Default::default()
    }
}

fn ellipse(c: Vec2, a: f64, b: f64, theta: f64) -> InputEntity {
    InputEntity {
        kind: Some("ellipse".into()),
        center: Some(c),
        a: Some(a),
        b: Some(b),
        theta: Some(theta),
        ..Default::default()
    }
}

fn spline_open(p0: Vec2, c1: Vec2, c2: Vec2, p3: Vec2) -> InputEntity {
    InputEntity {
        kind: Some("spline".into()),
        start: Some(p0),
        end: Some(p3),
        c1: Some(c1),
        c2: Some(c2),
        ..Default::default()
    }
}

fn spline_closed(p0: Vec2, c1: Vec2, c2: Vec2) -> InputEntity {
    spline_open(p0, c1, c2, p0)
}

fn square(side: f64) -> Vec<(String, InputEntity)> {
    vec![
        ("a".into(), line([0.0, 0.0], [side, 0.0])),
        ("b".into(), line([side, 0.0], [side, side])),
        ("c".into(), line([side, side], [0.0, side])),
        ("d".into(), line([0.0, side], [0.0, 0.0])),
    ]
}

fn outline(pts: &[[f64; 2]], prefix: &str) -> Vec<(String, InputEntity)> {
    (0..pts.len())
        .map(|i| {
            (
                format!("{prefix}{i}"),
                line(pts[i], pts[(i + 1) % pts.len()]),
            )
        })
        .collect()
}

fn stadium(gap: f64) -> Vec<(String, InputEntity)> {
    let (a, b, half_width): (f64, f64, f64) = (5.0, 2.0, 6.0);
    vec![
        ("e0".into(), ellipse([0.0, 0.0], a, b, 0.0)),
        (
            "top".into(),
            line([-half_width, b + gap], [half_width, b + gap]),
        ),
        (
            "bottom".into(),
            line([half_width, -b - gap], [-half_width, -b - gap]),
        ),
        (
            "right".into(),
            line([half_width, b + gap], [half_width, -b - gap]),
        ),
        (
            "left".into(),
            line([-half_width, -b - gap], [-half_width, b + gap]),
        ),
    ]
}

/// The geometries the dcel tests pin, each name matching its test.
fn hand_fixtures() -> Vec<(&'static str, Vec<(String, InputEntity)>)> {
    let mut out: Vec<(&'static str, Vec<(String, InputEntity)>)> = Vec::new();
    out.push(("square", square(2.0)));
    out.push((
        "standalone_circle",
        vec![("c0".into(), circle([0.0, 0.0], 1.0))],
    ));
    out.push((
        "concentric_circles",
        vec![
            ("outer".into(), circle([0.0, 0.0], 2.0)),
            ("inner".into(), circle([0.0, 0.0], 1.0)),
        ],
    ));
    out.push((
        "two_crossing_lines",
        vec![
            ("h".into(), line([-1.0, 0.0], [1.0, 0.0])),
            ("v".into(), line([0.0, -1.0], [0.0, 1.0])),
        ],
    ));
    out.push((
        "line_slashes_circle",
        vec![
            ("c0".into(), circle([0.0, 0.0], 1.0)),
            ("l0".into(), line([-2.0, 0.0], [2.0, 0.0])),
        ],
    ));
    out.push((
        "venn_with_chord",
        vec![
            (
                "A".into(),
                circle(
                    [-49.890132904052734, -0.0206315740942955],
                    23.889873504638672,
                ),
            ),
            (
                "B".into(),
                circle(
                    [-28.857667922973633, 3.3534867763519287],
                    23.889873504638672,
                ),
            ),
            (
                "L".into(),
                line(
                    [-42.76115417480469, 22.780765533447266],
                    [-35.98664855957031, -19.44791030883789],
                ),
            ),
        ],
    ));
    out.push((
        "centre_to_centre_line",
        vec![
            ("A".into(), circle([0.0, 0.0], 9.5)),
            ("B".into(), circle([0.0, 10.0], 4.0)),
            ("V".into(), line([0.0, 10.0], [0.0, 0.0])),
        ],
    ));
    out.push((
        "three_mutually_tangent_circles",
        vec![
            ("A".into(), circle([0.0, 0.0], 2.61391544342041)),
            (
                "B".into(),
                circle([-5.223526954650879, -0.21208451688289642], 2.61391544342041),
            ),
            (
                "C".into(),
                circle([-2.4280929565429688, -4.629749298095703], 2.61391544342041),
            ),
        ],
    ));
    out.push((
        "near_tangent_circles_standalone",
        vec![
            ("cA".into(), circle([0.0, 0.0], 5.0)),
            ("cB".into(), circle([10.0 - 1e-6, 0.0], 5.0)),
        ],
    ));
    out.push(("near_tangent_lines_at_the_circle_seam", {
        let r: f64 = 50.0;
        let gap: f64 = 1e-6;
        let delta: f64 = 5e-8;
        let tangent_line = |theta: f64| {
            let n: Vec2 = [theta.cos(), theta.sin()];
            let d: Vec2 = [-theta.sin(), theta.cos()];
            let p = [r * n[0] + gap * n[0], r * n[1] + gap * n[1]];
            line([p[0] - d[0], p[1] - d[1]], [p[0] + d[0], p[1] + d[1]])
        };
        vec![
            ("c0".into(), circle([0.0, 0.0], r)),
            ("l1".into(), tangent_line(std::f64::consts::PI - delta)),
            ("l2".into(), tangent_line(-std::f64::consts::PI + delta)),
        ]
    }));
    out.push(("near_tangent_lines_at_the_ellipse_seam", {
        let (a, b): (f64, f64) = (50.0, 10.0);
        let g: f64 = 2e-14;
        let delta: f64 = 4e-7;
        let tangent_line = |phi: f64| {
            let p = [(1.0 - g) * a * phi.cos(), (1.0 - g) * b * phi.sin()];
            let d = [-a * phi.sin(), b * phi.cos()];
            line([p[0] - d[0], p[1] - d[1]], [p[0] + d[0], p[1] + d[1]])
        };
        vec![
            ("e0".into(), ellipse([0.0, 0.0], a, b, 0.0)),
            ("l1".into(), tangent_line(delta)),
            ("l2".into(), tangent_line(-delta)),
        ]
    }));
    out.push(("stadium_near_tangent", stadium(1e-7)));
    out.push(("stadium_open", stadium(1e-2)));
    out.push(("c_shape_nesting", {
        let mut geom = outline(
            &[
                [0.0, 0.0],
                [0.0, 12.0],
                [12.0, 12.0],
                [12.0, 8.0],
                [4.0, 8.0],
                [4.0, 4.0],
                [12.0, 4.0],
                [12.0, 0.0],
            ],
            "big",
        );
        geom.extend(outline(
            &[
                [1.5, 1.0],
                [1.5, 11.0],
                [10.5, 11.0],
                [10.5, 9.0],
                [3.5, 9.0],
                [3.5, 3.0],
                [10.5, 3.0],
                [10.5, 1.0],
            ],
            "small",
        ));
        geom.push(("disc".into(), circle([8.0, 6.0], 1.0)));
        geom
    }));
    out.push(("slot_corner", {
        let r: f64 = 2.0;
        let end_deg = 90.0;
        let end_rad = radians(end_deg);
        vec![
            (
                "arc".into(),
                InputEntity {
                    center: Some([0.0, 0.0]),
                    radius: Some(r),
                    start: Some([r, 0.0]),
                    end: Some([r * end_rad.cos(), r * end_rad.sin()]),
                    angle_start: Some(0.0),
                    angle_end: Some(end_deg),
                    ..Default::default()
                },
            ),
            ("tangent".into(), line([-3.0, r], [3.0, r])),
            ("close".into(), line([r, 0.0], [r, r])),
        ]
    }));
    out.push((
        "quarter_arc_split_by_a_bezier",
        vec![
            ("a0".into(), arc([0.0, 0.0], 1.0, 0.0, 90.0)),
            ("l0".into(), line([1.0, 0.0], [0.0, 0.0])),
            ("l1".into(), line([0.0, 0.0], [0.0, 1.0])),
            (
                "s0".into(),
                spline_open([-1.0, 0.8], [-0.3, 0.8], [0.3, 0.8], [1.0, 0.8]),
            ),
        ],
    ));
    out.push((
        "closed_spline_and_chord",
        vec![
            (
                "s0".into(),
                spline_closed([0.0, 0.0], [1.0, 2.0], [-1.0, 2.0]),
            ),
            ("l0".into(), line([-2.0, 1.0], [2.0, 1.0])),
        ],
    ));
    out.push((
        "standalone_ellipse",
        vec![("e0".into(), ellipse([0.0, 0.0], 4.0, 2.0, 30.0))],
    ));
    out.push((
        "ellipse_split_by_a_center_line",
        vec![
            ("e0".into(), ellipse([0.0, 0.0], 4.0, 2.0, 0.0)),
            ("l0".into(), line([0.0, -3.0], [0.0, 3.0])),
        ],
    ));
    out.push((
        "tangent_line_between_two_circles",
        vec![
            ("A".into(), circle([0.0, 0.0], 9.5)),
            ("B".into(), circle([0.0, 10.0], 4.0)),
            (
                "L".into(),
                line([3.340658664703369, 12.2], [7.9340643882751465, 5.225]),
            ),
        ],
    ));
    out
}

/// The Python-parity fixture the TS suite pins, fed through the same JSON
/// boundary the WASM entry point uses.
fn json_fixture_inputs() -> Vec<(String, Vec<(String, InputEntity)>)> {
    let raw = include_str!("../../../../frontend/src/kernel/occ/__fixtures__/topology.json");
    let parsed: serde_json::Value = serde_json::from_str(raw).expect("fixture parses");
    let mut out = Vec::new();
    for (name, scenario) in parsed.as_object().expect("fixture is an object") {
        let geometry = scenario.get("geometry").expect("scenario has geometry");
        let entries: Vec<(String, serde_json::Value)> = geometry
            .as_object()
            .expect("geometry is an object")
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let payload = serde_json::to_vec(&entries).expect("geometry encodes");
        let decoded = codec::decode_input(&payload).expect("geometry decodes");
        out.push((name.clone(), decoded));
    }
    out
}

fn pending(violations: &[Violation]) -> Vec<String> {
    violations
        .iter()
        .filter(|v| v.is_pending())
        .map(|v| v.render())
        .collect()
}

#[test]
fn oracle_accepts_hand_fixtures() {
    // No false positives: every fixture the dcel tests pin must pass the
    // oracle before it is trusted to judge generated input.
    let mut failures: Vec<String> = Vec::new();
    let mut count = 0;
    let fixtures = hand_fixtures()
        .into_iter()
        .map(|(n, g)| (n.to_string(), g))
        .chain(json_fixture_inputs());
    for (name, geom) in fixtures {
        count += 1;
        let out = detect_topology(&geom);
        for v in pending(&check_topology(&geom, &out)) {
            failures.push(format!("{name}: {v}"));
        }
        for v in check_determinism(&geom) {
            failures.push(format!("{name}: {}", v.render()));
        }
    }
    assert!(
        count > 20,
        "the fixture list should stay broad, got {count}"
    );
    assert!(
        failures.is_empty(),
        "oracle false positives:\n{}",
        failures.join("\n")
    );
}

#[test]
#[ignore]
fn probe_tangent_fixture() {
    let geom = vec![
        ("A".into(), circle([0.0, 0.0], 9.5)),
        ("B".into(), circle([0.0, 10.0], 4.0)),
        (
            "L".into(),
            line([3.340658664703369, 12.2], [7.9340643882751465, 5.225]),
        ),
    ];
    let out = detect_topology(&geom);
    let chords = chord_tol_for(22.0);
    let _ = &chords;
    eprintln!("chord tol {chords:?}");
    for (si, s) in out.surfaces.iter().enumerate() {
        let poly = loop_polygon(&s.boundary, chords, FACE_POLY_MAX_PTS);
        let (area, centroid) = loop_area_centroid(&s.boundary);
        let p = [3.873185, 8.555931];
        eprintln!(
                "surface {si}: sides {} poly {} area {area:.6} centroid ({:.3},{:.3}) contains {p:?} = {}",
                s.boundary.len(),
                poly.len(),
                centroid[0],
                centroid[1],
                point_in_polygon(p, &poly)
            );
        for b in &s.boundary {
            eprintln!(
                "    {:?} {:?} -> {:?}  start {:?} end {:?} geom {:?}",
                b.id,
                b.start_vertex,
                b.end_vertex,
                b.geom.start(),
                edge_end(&b.geom),
                b.geom
            );
        }
        if si == 1 {
            for (k, b) in s.boundary.iter().enumerate() {
                let chain = edge_polyline(&b.geom, chords);
                eprintln!(
                    "      side {k}: n={} first {:?} last {:?}",
                    chain.pts.len(),
                    chain.pts.first(),
                    chain.pts.last()
                );
            }
        }
    }
}

#[test]
fn oracle_rejects_a_mutilated_topology() {
    // Drop a face: its region is then bounded but in no face.
    let geom = square(2.0);
    let mut out = detect_topology(&geom);
    out.surfaces.clear();
    let v = check_topology(&geom, &out);
    assert!(
        v.iter().any(|x| x.class == "coverage" && x.is_pending()),
        "dropping the only face must read as a lost area: {v:?}"
    );

    // Reverse one cycle: the loop stops closing vertex-to-vertex.
    let mut out = detect_topology(&geom);
    out.surfaces[0].boundary.reverse();
    let v = check_topology(&geom, &out);
    assert!(
        v.iter().any(|x| x.class == "structure" && x.is_pending()),
        "reversing a cycle must read as a structural break: {v:?}"
    );

    // Swap a hole: the annulus loop becomes a hole of the inner disk, so
    // the disk's cells fall out of every face.
    let geom = vec![
        ("outer".into(), circle([0.0, 0.0], 2.0)),
        ("inner".into(), circle([0.0, 0.0], 1.0)),
    ];
    let mut out = detect_topology(&geom);
    let outer = out
        .surfaces
        .iter()
        .position(|s| !s.holes.is_empty())
        .expect("the outer circle carries the hole");
    let inner = (outer + 1) % out.surfaces.len();
    let outer_loop = out.surfaces[outer].boundary.clone();
    out.surfaces[inner].holes.push(outer_loop);
    let v = check_topology(&geom, &out);
    assert!(
        v.iter().any(|x| x.class == "coverage" && x.is_pending()),
        "a misplaced hole must read as a coverage break: {v:?}"
    );
}

#[test]
fn a_self_intersecting_spline_is_tagged_known() {
    // The held-out limitation: a cubic whose loop crosses itself. The
    // detector must see it, and the geometry-consistency classes it can
    // poison must carry the slug instead of counting as failures.
    let geom = vec![(
        "s0".into(),
        spline_open([0.0, 0.0], [4.0, 3.0], [-4.0, 3.0], [1.0, 0.0]),
    )];
    assert_eq!(known_slugs(&geom), vec![KNOWN_SELF_INTERSECTING_SPLINE]);
    for v in check_input(&geom) {
        assert_eq!(v.known, Some(KNOWN_SELF_INTERSECTING_SPLINE), "{v:?}");
    }
}

#[test]
fn a_line_across_a_washer_is_tagged_known() {
    let geom = vec![
        ("outer".into(), circle([0.0, 0.0], 2.0)),
        ("inner".into(), circle([0.0, 0.0], 1.0)),
        ("slice".into(), line([-3.0, 0.0], [3.0, 0.0])),
    ];
    assert_eq!(known_slugs(&geom), vec![KNOWN_DONUT_SLICED_ACROSS_RINGS]);
    for v in check_input(&geom) {
        assert_eq!(v.known, Some(KNOWN_DONUT_SLICED_ACROSS_RINGS), "{v:?}");
    }
}

#[test]
fn order_independence_and_stability_hold_on_a_hand_fixture() {
    let mut geom = square(4.0);
    geom.push(("cross".into(), line([-1.0, 2.0], [5.0, 2.0])));
    geom.push(("disc".into(), circle([2.0, 2.0], 1.0)));

    // A fixed permutation (reverse plus a rotation) is enough to smoke the
    // order dependence; the fuzz drives random ones.
    let perm: Vec<usize> = vec![5, 2, 4, 0, 3, 1];
    let violations = check_order_independence(&geom, &perm);
    assert!(violations.is_empty(), "{violations:?}");

    // Every vertex may move up to MERGE/10; face count and areas must hold.
    let delta = MERGE / 10.0;
    let deltas: Vec<Vec2> = (0..geom.len())
        .map(|i| {
            let a = i as f64 * 1.7;
            [delta * a.cos(), delta * a.sin()]
        })
        .collect();
    let jittered = jitter_input(&geom, &deltas);
    let violations = check_stability(&geom, &jittered);
    assert!(violations.is_empty(), "{violations:?}");
}
