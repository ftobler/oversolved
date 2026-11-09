//! Declared contacts: the area builder trusts the author's coincident and
//! tangent rows instead of the solver's realised numerics.
//!
//! Every test first asserts its precondition (the gap the builder would
//! otherwise miss, or the pair of roots the closed form really returns), so a
//! test that silently stops exercising the defect fails.

use crate::tolerance::{tangent_gap_tol, verdict_tol};
use crate::topology::dcel::contacts::contact_scale;
use crate::topology::dcel::{
    detect_topology, Contact, ContactKind, ContactRef, InputEntity, TopologyOut,
};
use crate::topology::oracle::loop_area_centroid;
use crate::topology::profile_loops::Vec2;
use crate::topology::TOL_TOPOLOGY_MERGE as MERGE;

use super::helpers::{circle, line, topo};

fn join(id: &str, a: (&str, &str), b: (&str, &str)) -> Contact {
    Contact {
        id: id.into(),
        kind: ContactKind::Join,
        a: ContactRef {
            entity: a.0.into(),
            point: Some(a.1.into()),
        },
        b: ContactRef {
            entity: b.0.into(),
            point: Some(b.1.into()),
        },
    }
}

fn on(id: &str, endpoint: (&str, &str), host: &str) -> Contact {
    Contact {
        id: id.into(),
        kind: ContactKind::On,
        a: ContactRef {
            entity: endpoint.0.into(),
            point: Some(endpoint.1.into()),
        },
        b: ContactRef {
            entity: host.into(),
            point: None,
        },
    }
}

fn tangent(id: &str, a: &str, b: &str, join: bool) -> Contact {
    Contact {
        id: id.into(),
        kind: ContactKind::Tangent { join },
        a: ContactRef {
            entity: a.into(),
            point: None,
        },
        b: ContactRef {
            entity: b.into(),
            point: None,
        },
    }
}

fn area(surface: &crate::topology::dcel::SurfaceOut) -> f64 {
    loop_area_centroid(&surface.boundary).0.abs()
}

fn vertex_near(t: &TopologyOut, p: Vec2, tol: f64) -> bool {
    t.vertices
        .iter()
        .any(|(_, v)| (v[0] - p[0]).hypot(v[1] - p[1]) <= tol)
}

/// A 1000 mm triangle whose three joints are a declared join each, 4e-5 apart:
/// wider than the absolute merge, inside the sketch's verdict width.
fn gapped_triangle(gap: f64) -> Vec<(String, InputEntity)> {
    vec![
        ("ab".into(), line([gap, 0.0], [1000.0, 0.0])),
        ("bc".into(), line([1000.0, gap], [0.0, 1000.0 + gap])),
        ("ca".into(), line([0.0, 1000.0], [0.0, 0.0])),
    ]
}

fn triangle_joins() -> Vec<Contact> {
    vec![
        join("j1", ("ab", "end"), ("bc", "start")),
        join("j2", ("bc", "end"), ("ca", "start")),
        join("j3", ("ca", "end"), ("ab", "start")),
    ]
}

#[test]
fn declared_join_welds_beyond_the_merge() {
    let geometry = gapped_triangle(4e-5);
    let scale = contact_scale(&geometry);
    let cap = verdict_tol(scale);
    assert!(
        4e-5 > MERGE && 4e-5 < cap,
        "the gap must sit between the merge {MERGE} and the cap {cap}"
    );

    // The precondition's other half: with no declaration the builder misses the
    // joints, because 4e-5 is past its absolute merge.
    let plain = detect_topology(&geometry, &[]);
    assert!(
        plain.surfaces.is_empty(),
        "the undeclared loop must not close today: {}",
        plain.surfaces.len()
    );

    let declared = detect_topology(&geometry, &triangle_joins());
    assert_eq!(declared.surfaces.len(), 1, "the declared joins close it");
    let a = area(&declared.surfaces[0]);
    assert!(
        (a - 500_000.0).abs() < 1.0,
        "the welded triangle's area: {a}"
    );
    assert!(declared.unmet_contacts.is_empty());
}

#[test]
fn free_declared_tangent_is_one_contact() {
    // r = 1, line at y = 1 - 2e-10: two real roots about 4e-5 apart, past the
    // merge, so today's builder splits the circle at two distinct vertices and
    // traces the chord's sliver. (At 1e-6 the roots fuse into one vertex, so
    // the defect is not visible; the separation has to clear MERGE.)
    let d = 1.0 - 2e-10;
    let geometry: Vec<(String, InputEntity)> = vec![
        ("c".into(), circle([0.0, 0.0], 1.0)),
        ("l".into(), line([-2.0, d], [2.0, d])),
    ];
    let roots = super::super::intersect::intersect(
        &topo(geometry[0].1.clone()),
        &topo(geometry[1].1.clone()),
    );
    assert_eq!(roots.len(), 2, "today's closed form finds both roots");
    let sep = (roots[0].2[0] - roots[1].2[0]).hypot(roots[0].2[1] - roots[1].2[1]);
    assert!(
        sep > MERGE && sep < 1e-4,
        "the roots really are distinct vertices: {sep}"
    );

    let plain = detect_topology(&geometry, &[]);
    let uses_chord = plain
        .surfaces
        .iter()
        .any(|s| s.boundary.iter().any(|e| e.id.as_deref() == Some("l")));
    assert!(
        uses_chord,
        "without a declared tangent the two roots make the chord part of the face"
    );

    let declared = detect_topology(&geometry, &[tangent("t", "l", "c", false)]);
    assert_eq!(
        declared.surfaces.len(),
        1,
        "one declared contact leaves the circle's own face and no sliver"
    );
    assert!(
        declared.surfaces[0]
            .boundary
            .iter()
            .all(|e| e.id.as_deref() == Some("c")),
        "the declared tangency keeps the whole circle, not the chord's segment"
    );
    let a = area(&declared.surfaces[0]);
    assert!((a - std::f64::consts::PI).abs() < 1e-6, "area {a}");
    assert!(
        declared.surfaces.iter().all(|s| area(s) > 1.0),
        "no phantom sliver was traced"
    );
}

/// A line joined to a huge arc and declared tangent there, but aimed a hair
/// inside the circle: the closed form still finds a second crossing a few
/// units from the joint. (Two arcs cannot show this: the analytic pair's own
/// collapse band is 100x the gap budget, so the second root is already folded
/// into the foot before the joint rule sees it. A line/arc pair has no such
/// analytic collapse, which is exactly where the declared joint has to act.)
fn near_tangent_line_arc() -> (Vec<(String, InputEntity)>, Vec2, Vec2) {
    let r = 1e6;
    let p = [0.0, -r];
    let delta = 2.5e-6_f64;
    // The second circle intersection along a ray from P at angle delta off the
    // tangent is 2 r sin(delta) ~ 5 units from the joint.
    let t = 2.0 * r * delta.sin();
    let q = [t * delta.cos(), -r + t * delta.sin()];
    let line_end = [r * delta.cos(), -r + r * delta.sin()];
    let a = InputEntity {
        center: Some([0.0, 0.0]),
        radius: Some(r),
        start: Some(p),
        end: Some([r, 0.0]),
        angle_start: Some(-90.0),
        angle_end: Some(0.0),
        ..Default::default()
    };
    let geometry = vec![
        ("a".into(), a),
        ("l".into(), line(p, line_end)),
        ("close".into(), line(line_end, [r, 0.0])),
        // A crossing far from the joint: x = 500000 meets the r = 1e6 arc at
        // (500000, -866025).
        (
            "far".into(),
            line([500_000.0, -900_000.0], [500_000.0, -800_000.0]),
        ),
    ];
    (geometry, p, q)
}

#[test]
fn tangent_at_join_drops_near_joint_crossings() {
    let (geometry, p, q) = near_tangent_line_arc();
    let pq = (q[0] - p[0]).hypot(q[1] - p[1]);
    let budget = tangent_gap_tol(1e6, MERGE);
    assert!(
        pq > MERGE && pq < budget,
        "the second crossing sits past the merge and inside the gap budget: {pq} vs {budget}"
    );

    let plain = detect_topology(&geometry, &[]);
    assert!(
        vertex_near(&plain, q, MERGE),
        "today's builder registers the near-joint crossing"
    );
    let far = [500_000.0, -866_025.403_784_443_4];
    assert!(
        vertex_near(&plain, far, 1e-3),
        "today's builder registers the far crossing"
    );

    let contacts = vec![
        join("j", ("a", "start"), ("l", "start")),
        tangent("t", "a", "l", true),
    ];
    let declared = detect_topology(&geometry, &contacts);
    assert!(
        !vertex_near(&declared, q, MERGE),
        "the near-joint crossing is dropped"
    );
    assert!(
        vertex_near(&declared, far, 1e-3),
        "a crossing far from the joint is kept"
    );
    assert_eq!(
        declared.surfaces.len(),
        plain.surfaces.len().saturating_sub(1),
        "the sliver lens the near crossing closed is gone"
    );
    assert!(
        declared.surfaces.iter().all(|s| area(s) > 1.0),
        "no phantom sliver remains"
    );
}

#[test]
fn declared_on_contact_splits_the_host() {
    let geometry: Vec<(String, InputEntity)> = vec![
        ("c".into(), circle([0.0, 0.0], 1000.0)),
        // The radial line ends 2e-5 outside the rim.
        ("t".into(), line([0.0, 2000.0], [0.0, 1000.0 + 2e-5])),
        // A real crossing elsewhere so the circle is a DCEL loop (its boundary
        // edges then carry vertex ids) rather than a standalone pair.
        ("x".into(), line([-2000.0, 0.0], [2000.0, 0.0])),
    ];
    let scale = contact_scale(&geometry);
    let cap = verdict_tol(scale);
    assert!(
        2e-5 > MERGE && 2e-5 < cap,
        "the on-contact gap sits between the merge and the cap: {cap}"
    );

    let end_pos = [0.0, 1000.0 + 2e-5];
    let has_endpoint_vertex = |t: &TopologyOut| {
        t.surfaces.iter().any(|s| {
            s.boundary.iter().any(|e| {
                e.id.as_deref() == Some("c")
                    && [e.start_vertex.as_deref(), e.end_vertex.as_deref()]
                        .into_iter()
                        .flatten()
                        .any(|vid| {
                            t.vertices.iter().any(|(k, v)| {
                                k == vid && (v[0] - end_pos[0]).hypot(v[1] - end_pos[1]) <= 1e-9
                            })
                        })
            })
        })
    };
    let plain = detect_topology(&geometry, &[]);
    assert!(
        !has_endpoint_vertex(&plain),
        "without the on contact the circle never takes the off-rim endpoint"
    );

    let declared = detect_topology(&geometry, &[on("o", ("t", "end"), "c")]);
    // The welded vertex keeps the ENDPOINT's position (the free end moved onto
    // the host only at the handoff), so a circle boundary side naming that
    // vertex proves the split took the endpoint's id.
    assert!(
        has_endpoint_vertex(&declared),
        "the circle split at the foot and took the endpoint's vertex"
    );
}

#[test]
fn unmet_contact_is_reported_not_welded() {
    let gap = 2e-4;
    let geometry = gapped_triangle(gap);
    // Only the first joint is declared, and its gap is above the cap.
    let cap = verdict_tol(contact_scale(&geometry));
    assert!(gap > cap, "the unmet gap must exceed the cap {cap}");

    let t = detect_topology(&geometry, &[join("j1", ("ab", "end"), ("bc", "start"))]);
    assert!(t.surfaces.is_empty(), "an unmet join welds nothing");
    assert_eq!(t.unmet_contacts.len(), 1);
    assert_eq!(t.unmet_contacts[0].id, "j1");
    assert!((t.unmet_contacts[0].gap - gap).abs() < 1e-9);
}

#[test]
fn a_payload_without_contacts_decodes_as_today() {
    use crate::topology::codec::{decode_payload, encode_output};
    use serde_json::json;

    let legacy = json!([
        ["a", {"start": [0.0, 0.0], "end": [2.0, 0.0]}],
        ["b", {"start": [2.0, 0.0], "end": [2.0, 2.0]}],
        ["c", {"start": [2.0, 2.0], "end": [0.0, 2.0]}],
        ["d", {"start": [0.0, 2.0], "end": [0.0, 0.0]}],
    ]);
    let legacy_bytes = serde_json::to_vec(&legacy).unwrap();
    let decoded = decode_payload(&legacy_bytes).expect("legacy payload decodes");
    assert_eq!(decoded.entities.len(), 4);
    assert!(decoded.contacts.is_empty());

    // The object form with no contacts decodes to the same input and the same
    // output bytes.
    let object = json!({ "entities": legacy, "contacts": [] });
    let object_bytes = serde_json::to_vec(&object).unwrap();
    let from_object = decode_payload(&object_bytes).expect("object payload decodes");
    assert!(from_object.contacts.is_empty());
    assert_eq!(from_object.entities.len(), decoded.entities.len());
    let a = encode_output(&detect_topology(&decoded.entities, &[])).unwrap();
    let b = encode_output(&detect_topology(&from_object.entities, &[])).unwrap();
    assert_eq!(a, b);

    // A contact payload carries its rows.
    let with = json!({
        "entities": legacy,
        "contacts": [
            {"id": "j", "kind": "join", "a": {"entity": "a", "point": "end"}, "b": {"entity": "b", "point": "start"}},
            {"id": "t", "kind": "tangent", "a": {"entity": "a"}, "b": {"entity": "c"}, "join": true},
        ],
    });
    let decoded = decode_payload(&serde_json::to_vec(&with).unwrap()).expect("contact payload");
    assert_eq!(decoded.contacts.len(), 2);
    assert_eq!(decoded.contacts[0].kind, ContactKind::Join);
    assert_eq!(
        decoded.contacts[1].kind,
        ContactKind::Tangent { join: true }
    );
}
