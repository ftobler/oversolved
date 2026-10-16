use super::*;
use crate::radians;
use crate::tolerance::tangent_gap_tol;
use crate::topology::codec;
use crate::topology::dcel::{detect_topology, InputEntity};
use crate::topology::profile_loops::Vec2;
use crate::topology::TOL_TOPOLOGY_EPS as EPS;
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
    out.push(("miss_side_circle_pair", {
        // The dcel test's `circle_pair_offset_by`, gap within the
        // miss-side tangency budget: two standalone disks. The budget comes
        // from the tolerance ladder, so this fixture tracks a change to it.
        let r = 5.0;
        let gap = 0.5 * tangent_gap_tol(r, MERGE);
        vec![
            ("A".into(), circle([0.0, 0.0], r)),
            ("B".into(), circle([2.0 * r + gap, 0.0], r)),
        ]
    }));
    out.push(("three_circles_a_hair_apart", {
        let r: f64 = 2.61391544342041;
        let s = 2.0 * r + 1e-7;
        vec![
            ("A".into(), circle([0.0, 0.0], r)),
            ("B".into(), circle([s, 0.0], r)),
            ("C".into(), circle([s / 2.0, 3.0f64.sqrt() * s / 2.0], r)),
        ]
    }));
    out.push(("off_segment_foot_crossing", {
        // From `a_crossing_survives_a_foot_that_lies_off_the_segment`: the
        // line's perpendicular foot is off its own segment while the real
        // crossing stays.
        let r: f64 = 100.0;
        let y = r - 1e-3;
        let half = (r * r - y * y).sqrt();
        vec![
            ("A".into(), circle([0.0, 0.0], r)),
            ("H".into(), line([0.1, y], [half + 0.5, y])),
        ]
    }));
    out.push(("near_miss_off_segment_foot", {
        // The miss side of the same branch: within the tangency budget, but
        // the contact would fall beyond the segment's end.
        let r: f64 = 100.0;
        vec![
            ("A".into(), circle([0.0, 0.0], r)),
            ("H".into(), line([5.0, r + 1e-4], [40.0, r + 1e-4])),
        ]
    }));
    out.push(("huge_angle_arc", {
        // From `arc_with_huge_decoded_angles_completes...`: the hostile arc
        // must not stall the oracle either, and the square must survive it.
        let mut geom = square(2.0);
        geom.push(("bad".into(), arc([50.0, 50.0], 1.0, 3e38, 3e38)));
        geom
    }));
    out.push(("spline_chord_half_edge", {
        // From `full_open_spline_half_edge_preserves_its_control_points`: an
        // open spline plus its chord, no crossing.
        let start = [0.0, 0.0];
        let end = [2.0, 0.0];
        vec![
            ("s0".into(), spline_open(start, [0.5, 2.0], [1.5, 2.0], end)),
            ("l0".into(), line(end, start)),
        ]
    }));
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
    // oracle before it is trusted to judge generated input. The counts are
    // exact so a fixture cannot be dropped silently; adding one means bumping
    // the number deliberately.
    let hand = hand_fixtures();
    // The JSON scenarios' raw names overlap the hand names (`square`,
    // `standalone_circle`), so they are namespaced here to keep the failure
    // output unambiguous.
    let json: Vec<(String, Vec<(String, InputEntity)>)> = json_fixture_inputs()
        .into_iter()
        .map(|(n, g)| (format!("json:{n}"), g))
        .collect();
    assert_eq!(hand.len(), 26, "the named fixture list changed");
    assert_eq!(json.len(), 9, "the JSON scenario fixture list changed");
    let mut names: Vec<&str> = hand.iter().map(|(n, _)| *n).collect();
    names.extend(json.iter().map(|(n, _)| n.as_str()));
    let unique: std::collections::BTreeSet<&str> = names.iter().copied().collect();
    assert_eq!(unique.len(), names.len(), "fixture names must be unique");
    let mut failures: Vec<String> = Vec::new();
    let fixtures = hand
        .into_iter()
        .map(|(n, g)| (n.to_string(), g))
        .chain(json);
    for (name, geom) in fixtures {
        let out = detect_topology(&geom);
        for v in pending(&check_topology(&geom, &out)) {
            failures.push(format!("{name}: {v}"));
        }
        for v in check_determinism(&geom) {
            failures.push(format!("{name}: {}", v.render()));
        }
    }
    assert!(
        failures.is_empty(),
        "oracle false positives:\n{}",
        failures.join("\n")
    );
}

#[test]
fn a_failed_match_names_the_field() {
    // 252-order's areas matched and its hole list differed, yet the old
    // message just said "has no match". Both fields that can be the culprit
    // must be named, and a centroid failure must report the drift against
    // its (thickness-scaled) budget.
    let face = |area: f64, holes: Vec<f64>, centroid: Vec2, thickness: f64| FaceSummary {
        area,
        holes,
        centroid,
        thickness,
    };
    let a = vec![face(10.0, vec![1.0], [0.0, 0.0], 1.0)];
    let holes_differ = vec![face(10.0, vec![2.0], [0.0, 0.0], 1.0)];
    let v = compare_face_multisets(
        "order",
        "entity permutation",
        &a,
        &holes_differ,
        1e-9,
        1e-9,
        1e-7,
        MERGE,
    );
    assert_eq!(v.len(), 1, "{v:?}");
    assert!(v[0].reason.contains("hole list differs"), "{}", v[0].reason);
    let centroid_moved = vec![face(10.0, vec![1.0], [5.0, 0.0], 1.0)];
    let v = compare_face_multisets(
        "stability",
        "vertex jitter",
        &a,
        &centroid_moved,
        1e-6,
        1e-6,
        2e-6,
        4e-6,
    );
    assert_eq!(v.len(), 1, "{v:?}");
    assert!(v[0].reason.contains("centroid"), "{}", v[0].reason);
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
fn a_sub_cell_corner_gap_is_not_a_lost_area() {
    // The reviewer's repro: a 100x100 square whose (0,0) corner is left open.
    // Under MERGE the builder fuses the two ends and the square closes; at or
    // over MERGE the chain stays open, detect_topology returns no surface, and
    // the interior is reachable through the opening, so no face is expected.
    // The opening is far below one grid cell (the grid is span/200), which is
    // the resolution the old band corridor missed: the tunnel has to carry
    // the reachability decision at MERGE resolution.
    for scale in [1.0, 1500.0] {
        let s = 100.0 * scale;
        let square = |gap: f64| {
            vec![
                ("bottom".into(), line([gap, 0.0], [s, 0.0])),
                ("right".into(), line([s, 0.0], [s, s])),
                ("top".into(), line([s, s], [0.0, s])),
                ("left".into(), line([0.0, s], [0.0, 0.0])),
            ]
        };
        // Under MERGE: one fused contour, one face, and the oracle accepts it.
        let closed = square(MERGE / 2.0);
        let out = detect_topology(&closed);
        assert_eq!(
            out.surfaces.len(),
            1,
            "scale {scale}: a sub-merge gap must close the contour"
        );
        assert!(
            pending(&check_topology(&closed, &out)).is_empty(),
            "scale {scale}: the closed square must pass"
        );
        // At MERGE (the builder's merge is strict `<`) and at 2x MERGE (the
        // reviewer's 2e-5 at scale 1): open chain, no surface, no lost area.
        // The wider gaps are the reviewer's scan range (0.8 at scale 1,
        // 1..21 mm at scale 1500): openings several cells wide whose corner
        // still cannot be crossed by a cell-wide step.
        let wide: &[f64] = if scale < 2.0 { &[0.8, 2.0] } else { &[21.0] };
        for gap in [MERGE, 2.0 * MERGE].iter().chain(wide.iter()).copied() {
            let geom = square(gap);
            let out = detect_topology(&geom);
            assert!(
                out.surfaces.is_empty(),
                "scale {scale} gap {gap:e}: a gap at or over MERGE leaves the chain open"
            );
            let v = pending(&check_topology(&geom, &out));
            assert!(
                v.is_empty(),
                "scale {scale} gap {gap:e}: false lost area: {v:?}"
            );
        }
    }
}

#[test]
fn a_sub_cell_channel_between_two_arcs_is_not_a_lost_area() {
    // Seed 18's minimisation: two open arcs crossing once, leaving a
    // half-cell-wide channel between them that is open at the (3.5, 0) end.
    // No surface is expected (the channel is reachable around the opening),
    // and neither the grid's cell steps nor its corner steps can traverse the
    // channel's thin diagonal; the fill must still not read it as a lost
    // area.
    let geom = vec![
        ("a0".into(), arc([3.5, 2.5], 2.5, -90.0, 90.0)),
        ("a1".into(), arc([3.5, 1.0], 1.5, -90.0, 0.0)),
    ];
    let out = detect_topology(&geom);
    assert!(out.surfaces.is_empty(), "the open arcs bound no face");
    let v = pending(&check_topology(&geom, &out));
    assert!(v.is_empty(), "false lost area: {v:?}");
}

/// A 40x100 pocket whose two bottom corners are open line ends landing on a
/// base line's interior at distance `gap`. The sides are 100 long, so the
/// builder's intersector window for each end is `EPS * 100 = 1e-7`.
fn t_junction_pocket(gap: f64) -> Vec<(String, InputEntity)> {
    vec![
        ("base".into(), line([-50.0, 0.0], [50.0, 0.0])),
        ("left".into(), line([0.0, gap], [0.0, 100.0])),
        ("top".into(), line([0.0, 100.0], [40.0, 100.0])),
        ("right".into(), line([40.0, 100.0], [40.0, gap])),
    ]
}

#[test]
fn a_t_junction_opening_closes_only_inside_the_intersector_window() {
    // The builder lands an interior contact only inside its intersector
    // window: a line end's parameter must stay within `EPS`, so a 100-long
    // side fuses with the base only at a gap below `EPS * 100 = 1e-7`. The
    // old seal at `d < MERGE` claimed a fusion the builder never made and
    // reported this deliberately open pocket as a lost area for every gap in
    // (1e-7, MERGE).
    let window = 100.0 * EPS;
    // Inside the window the builder closes the chain: one face, and the
    // oracle must agree (the seal keeps the pocket bounded and judged).
    for gap in [window / 4.0, window / 2.0] {
        let geom = t_junction_pocket(gap);
        let out = detect_topology(&geom);
        assert_eq!(
            out.surfaces.len(),
            1,
            "gap {gap:e}: the builder fuses the T junctions"
        );
        let v = pending(&check_topology(&geom, &out));
        assert!(v.is_empty(), "gap {gap:e}: false report: {v:?}");
    }
    // The seal must keep judging, not merely stay silent: with the face
    // dropped, a window gap is a lost area again.
    let geom = t_junction_pocket(window / 4.0);
    let mut out = detect_topology(&geom);
    out.surfaces.clear();
    let v = pending(&check_topology(&geom, &out));
    assert!(
        v.iter().any(|x| x.contains("coverage (lost area)")),
        "a dropped face behind a sealed T junction must report: {v:?}"
    );
    // Above the window and below MERGE the builder leaves the pocket open:
    // the oracle must not seal, so the tunnel skips the cells behind the
    // openings instead of reporting a lost area.
    for gap in [3e-7, 1e-6, 5e-6, 9e-6] {
        assert!(
            gap > window && gap < MERGE,
            "gap {gap:e} is in the probe range"
        );
        let geom = t_junction_pocket(gap);
        let out = detect_topology(&geom);
        assert!(
            out.surfaces.is_empty(),
            "gap {gap:e}: the builder leaves the T junctions open"
        );
        let v = pending(&check_topology(&geom, &out));
        assert!(v.is_empty(), "gap {gap:e}: false lost area: {v:?}");
    }
    // At and above MERGE the pocket is still open and still not reported:
    // the behaviour that was already correct.
    for gap in [MERGE, 2.0 * MERGE] {
        let geom = t_junction_pocket(gap);
        let out = detect_topology(&geom);
        assert!(
            out.surfaces.is_empty(),
            "gap {gap:e}: open at MERGE and beyond"
        );
        let v = pending(&check_topology(&geom, &out));
        assert!(v.is_empty(), "gap {gap:e}: false lost area: {v:?}");
    }
}

#[test]
fn a_spline_end_on_a_line_interior_does_not_fuse() {
    // `register_hit` drops a spline contact that lands at or past its own
    // end, so even a gap far below MERGE leaves the chain open; sealing there
    // would invent a lost area for the deliberately open pocket.
    for gap in [1e-8, 5e-7, 2e-5] {
        let geom = vec![
            ("base".into(), line([-50.0, 0.0], [50.0, 0.0])),
            (
                "left".into(),
                spline_open([0.0, gap], [0.0, 33.0], [0.0, 66.0], [0.0, 100.0]),
            ),
            ("top".into(), line([0.0, 100.0], [40.0, 100.0])),
            ("right".into(), line([40.0, 100.0], [40.0, gap])),
        ];
        let out = detect_topology(&geom);
        assert!(
            out.surfaces.is_empty(),
            "gap {gap:e}: the spline end does not fuse"
        );
        let v = pending(&check_topology(&geom, &out));
        assert!(v.is_empty(), "gap {gap:e}: false lost area: {v:?}");
    }
}

#[test]
fn the_verified_lost_areas_still_report() {
    // Seeds 141 and 303: lost areas the reviewer verified with an independent
    // point-in-face test. Their boundaries are closed at MERGE resolution, so
    // there is no end-to-barrier opening to tunnel through and the coverage
    // check must keep reporting them.
    for name in ["141", "303"] {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("src/topology/dcel/tests/fuzz_cases/{name}.json"));
        let bytes = std::fs::read(&path)
            .unwrap_or_else(|e| panic!("{}: {e} (run the fuzz harvester?)", path.display()));
        let geom = codec::decode_input(&bytes).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let v = pending(&check_input(&geom));
        assert!(
            v.iter().any(|x| x.contains("coverage (lost area)")),
            "{name}: the verified lost area is gone: {v:?}"
        );
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
