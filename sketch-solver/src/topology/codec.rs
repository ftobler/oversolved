//! JSON codec for the topology WASM boundary (`detect_topology_bytes`).
//!
//! Input is the enriched `richGeom` map as an ORDERED array of `[eid, geomdict]`
//! pairs (insertion order is load-bearing: it drives vertex-merge `_vN` ids and
//! the surface/edge index ordering). Output is the structural `TopologyOut`
//! shaped to match the TS `TopologyDict` MINUS the `query`/`classifiers` strings,
//! plus two decoration hints the TS layer consumes and strips: per-edge
//! `edge_type` and per-surface `face_entity_ids`.

use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::dcel::{InputEntity, TopologyOut};
use super::profile_loops::{BoundaryEdge, EdgeGeom, Vec2};

#[derive(Debug)]
pub enum TopologyCodecError {
    Json(serde_json::Error),
    /// A float decoded OR computed to NaN or +-infinity. Strict JSON has no
    /// non-finite literals and serde_json 1.0.150 rejects overflowing ones
    /// ("number out of range") at parse time, but other serde_json versions
    /// and settings have mapped such literals to +-infinity instead -- a
    /// drift like that must never hand the geometry pass a poisoned float
    /// (NaN params wedged the arc normalization walk once already), and
    /// serde_json likewise maps a non-finite COMPUTED value to JSON Null on
    /// serialize rather than failing. Both directions gate here, mirroring
    /// the flat codec's `CodecError::NonFinite` as the backstop.
    NonFinite,
    /// More entities than `MAX_ENTITIES`. Mirrors the flat codec's capacity
    /// philosophy: counts are untrusted, and here the cost of believing them
    /// is quadratic downstream, so the refusal happens at decode.
    TooManyEntities,
}

// Entity-count cap for one topology payload. Calibration: the Node bench
// tops out at 100 lines, TS regression fixtures use single digits, and real
// sketches live in the tens-to-low-hundreds -- while the passes below cost
// O(N^2) pair dispatch plus an O(V) vertex rescan per point. 4096 keeps a
// ~40x margin over the largest benchmarked sketch (worst case then a few
// million pairs, seconds not hours) while never biting legitimate work; it
// follows the same orders-of-magnitude-above-real-use house rule as
// curve_intersect's NODE_BUDGET / HIT_CAP.
pub const MAX_ENTITIES: usize = 4_096;

impl From<serde_json::Error> for TopologyCodecError {
    fn from(e: serde_json::Error) -> Self {
        TopologyCodecError::Json(e)
    }
}

// ─── Input ───

#[derive(Clone, Default, Deserialize)]
struct RawGeom {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    construction: Option<Value>,
    #[serde(default)]
    start: Option<Vec2>,
    #[serde(default)]
    end: Option<Vec2>,
    #[serde(default)]
    center: Option<Vec2>,
    #[serde(default)]
    radius: Option<f64>,
    #[serde(default)]
    angle_start: Option<f64>,
    #[serde(default)]
    angle_end: Option<f64>,
    #[serde(default)]
    a: Option<f64>,
    #[serde(default)]
    b: Option<f64>,
    #[serde(default)]
    theta: Option<f64>,
    #[serde(default)]
    c1: Option<Vec2>,
    #[serde(default)]
    c2: Option<Vec2>,
}

/// JS-style truthiness, matching `classifyEntities`' `if (ent["construction"])`.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|x| x != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Null => false,
        _ => true,
    }
}

impl From<RawGeom> for InputEntity {
    fn from(g: RawGeom) -> Self {
        InputEntity {
            kind: g.kind,
            construction: g.construction.as_ref().map(truthy).unwrap_or(false),
            start: g.start,
            end: g.end,
            center: g.center,
            radius: g.radius,
            angle_start: g.angle_start,
            angle_end: g.angle_end,
            a: g.a,
            b: g.b,
            theta: g.theta,
            c1: g.c1,
            c2: g.c2,
        }
    }
}

/// Gate every f64 payload slot against NaN and +-infinity. The flat codec
/// checks its floats at the byte reader; the JSON path needs the equivalent
/// after deserialization as a backstop against serde_json versions or
/// features that map overflowing literals to +-infinity instead of erroring.
fn reject_non_finite(raw: &[(String, RawGeom)]) -> Result<(), TopologyCodecError> {
    for (_, g) in raw {
        let pts = [g.start, g.end, g.center, g.c1, g.c2];
        if pts
            .into_iter()
            .flatten()
            .any(|p| p.iter().any(|x| !x.is_finite()))
        {
            return Err(TopologyCodecError::NonFinite);
        }
        let scalars = [g.radius, g.angle_start, g.angle_end, g.a, g.b, g.theta];
        if scalars.into_iter().flatten().any(|x| !x.is_finite()) {
            return Err(TopologyCodecError::NonFinite);
        }
    }
    Ok(())
}

/// Decode the ordered `[[eid, geom], ...]` payload into classified-ready input.
pub fn decode_input(bytes: &[u8]) -> Result<Vec<(String, InputEntity)>, TopologyCodecError> {
    let raw: Vec<(String, RawGeom)> = serde_json::from_slice(bytes)?;
    if raw.len() > MAX_ENTITIES {
        return Err(TopologyCodecError::TooManyEntities);
    }
    reject_non_finite(&raw)?;
    Ok(raw.into_iter().map(|(eid, g)| (eid, g.into())).collect())
}

// ─── Output ───

fn pt(p: Vec2) -> Value {
    json!([p[0], p[1]])
}

/// Finite check for every float one edge geometry would serialize.
fn geom_is_finite(eg: &EdgeGeom) -> bool {
    let pt_ok = |p: &Vec2| p.iter().all(|x| x.is_finite());
    match eg {
        EdgeGeom::Line { start, end } => pt_ok(start) && pt_ok(end),
        EdgeGeom::Arc {
            center,
            radius,
            angle_start_deg,
            angle_end_deg,
            start,
            end,
            ..
        } => {
            pt_ok(center)
                && radius.is_finite()
                && angle_start_deg.is_finite()
                && angle_end_deg.is_finite()
                && pt_ok(start)
                && pt_ok(end)
        }
        EdgeGeom::EllipseArc {
            center,
            a,
            b,
            theta,
            angle_start_deg,
            angle_end_deg,
            start,
            end,
            ..
        } => {
            pt_ok(center)
                && a.is_finite()
                && b.is_finite()
                && theta.is_finite()
                && angle_start_deg.is_finite()
                && angle_end_deg.is_finite()
                && pt_ok(start)
                && pt_ok(end)
        }
        EdgeGeom::Spline { start, c1, c2, end } => {
            pt_ok(start) && pt_ok(c1) && pt_ok(c2) && pt_ok(end)
        }
        EdgeGeom::Ellipse {
            center,
            a,
            b,
            theta,
        } => pt_ok(center) && a.is_finite() && b.is_finite() && theta.is_finite(),
    }
}

/// Gate every COMPUTED float against NaN and +-infinity before serialization.
/// The input gate guarantees finite inputs, but derived values (intersection
/// solves, split points, arc endpoints from extreme angles) are produced in
/// f64 and can still overflow or divide their way to a non-finite value.
/// serde_json maps either to JSON Null instead of failing, which would hand
/// the TS decorator a silently broken topology; refusing loudly keeps the
/// failure at the producing step. Same treatment as `reject_non_finite`, one
/// transform downstream.
fn reject_non_finite_output(out: &TopologyOut) -> Result<(), TopologyCodecError> {
    let pt_ok = |p: &Vec2| p.iter().all(|x| x.is_finite());
    let points_ok = out.intersection_points.iter().all(|(_, p)| pt_ok(p))
        && out.vertices.iter().all(|(_, p)| pt_ok(p));
    let edges_ok = out.edges.iter().all(|e| geom_is_finite(&e.geom));
    let surfaces_ok = out.surfaces.iter().all(|s| {
        s.boundary
            .iter()
            .chain(s.holes.iter().flatten())
            .all(|be| geom_is_finite(&be.geom))
    });
    if points_ok && edges_ok && surfaces_ok {
        Ok(())
    } else {
        Err(TopologyCodecError::NonFinite)
    }
}

/// Geometry fields of one edge (kind + curve-specific keys), matching the TS eg
/// dict exactly. A full ellipse carries NO start/end (like the TS dict).
fn geom_fields(eg: &EdgeGeom, m: &mut Map<String, Value>) {
    match *eg {
        EdgeGeom::Line { start, end } => {
            m.insert("kind".into(), json!("line"));
            m.insert("start".into(), pt(start));
            m.insert("end".into(), pt(end));
        }
        EdgeGeom::Arc {
            center,
            radius,
            angle_start_deg,
            angle_end_deg,
            ccw,
            start,
            end,
        } => {
            m.insert("kind".into(), json!("arc"));
            m.insert("center".into(), pt(center));
            m.insert("radius".into(), json!(radius));
            m.insert("angle_start_deg".into(), json!(angle_start_deg));
            m.insert("angle_end_deg".into(), json!(angle_end_deg));
            m.insert("ccw".into(), json!(ccw));
            m.insert("start".into(), pt(start));
            m.insert("end".into(), pt(end));
        }
        EdgeGeom::EllipseArc {
            center,
            a,
            b,
            theta,
            angle_start_deg,
            angle_end_deg,
            ccw,
            start,
            end,
        } => {
            m.insert("kind".into(), json!("ellipse_arc"));
            m.insert("center".into(), pt(center));
            m.insert("a".into(), json!(a));
            m.insert("b".into(), json!(b));
            m.insert("theta".into(), json!(theta));
            m.insert("angle_start_deg".into(), json!(angle_start_deg));
            m.insert("angle_end_deg".into(), json!(angle_end_deg));
            m.insert("ccw".into(), json!(ccw));
            m.insert("start".into(), pt(start));
            m.insert("end".into(), pt(end));
        }
        EdgeGeom::Spline { start, c1, c2, end } => {
            m.insert("kind".into(), json!("spline"));
            m.insert("start".into(), pt(start));
            m.insert("end".into(), pt(end));
            m.insert("c1".into(), pt(c1));
            m.insert("c2".into(), pt(c2));
        }
        EdgeGeom::Ellipse {
            center,
            a,
            b,
            theta,
        } => {
            m.insert("kind".into(), json!("ellipse"));
            m.insert("center".into(), pt(center));
            m.insert("a".into(), json!(a));
            m.insert("b".into(), json!(b));
            m.insert("theta".into(), json!(theta));
        }
    }
}

fn opt_vertex(v: &Option<String>) -> Value {
    match v {
        Some(s) => json!(s),
        None => Value::Null,
    }
}

fn boundary_edge_value(be: &BoundaryEdge) -> Value {
    let mut m = Map::new();
    geom_fields(&be.geom, &mut m);
    m.insert(
        "id".into(),
        be.id.as_ref().map(|s| json!(s)).unwrap_or(Value::Null),
    );
    m.insert("start_vertex".into(), opt_vertex(&be.start_vertex));
    m.insert("end_vertex".into(), opt_vertex(&be.end_vertex));
    Value::Object(m)
}

/// Encode a `TopologyOut` to the JSON the TS decorator consumes. Fails rather
/// than serializing a non-finite computed coordinate as Null (see
/// `reject_non_finite_output`).
pub fn encode_output(out: &TopologyOut) -> Result<Vec<u8>, TopologyCodecError> {
    reject_non_finite_output(out)?;
    let mut ip = Map::new();
    for (k, v) in &out.intersection_points {
        ip.insert(k.clone(), json!({ "x": v[0], "y": v[1] }));
    }
    let mut verts = Map::new();
    for (k, v) in &out.vertices {
        verts.insert(k.clone(), json!({ "x": v[0], "y": v[1] }));
    }

    let edges: Vec<Value> = out
        .edges
        .iter()
        .map(|e| {
            let mut m = Map::new();
            geom_fields(&e.geom, &mut m);
            m.insert("entity_id".into(), json!(e.entity_id));
            m.insert("edge_index".into(), json!(e.edge_index));
            // `edge_type` is a decoration hint the TS decorator consumes and
            // strips. `buildEdgeQueries` does NOT carry start/end_vertex on edges
            // (only on surface boundary edges), so neither do we.
            m.insert("edge_type".into(), json!(e.edge_type));
            Value::Object(m)
        })
        .collect();

    let surfaces: Vec<Value> = out
        .surfaces
        .iter()
        .map(|s| {
            let mut m = Map::new();
            let boundary: Vec<Value> = s.boundary.iter().map(boundary_edge_value).collect();
            m.insert("boundary".into(), Value::Array(boundary));
            m.insert("face_entity_ids".into(), json!(s.face_entity_ids));
            if !s.holes.is_empty() {
                let holes: Vec<Value> = s
                    .holes
                    .iter()
                    .map(|h| Value::Array(h.iter().map(boundary_edge_value).collect()))
                    .collect();
                m.insert("holes".into(), Value::Array(holes));
            }
            Value::Object(m)
        })
        .collect();

    let root = json!({
        "intersection_points": Value::Object(ip),
        "vertices": Value::Object(verts),
        "edges": edges,
        "surfaces": surfaces,
    });
    serde_json::to_vec(&root).map_err(TopologyCodecError::Json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_single_square() {
        let input = json!([
            ["a", {"start": [0.0, 0.0], "end": [2.0, 0.0]}],
            ["b", {"start": [2.0, 0.0], "end": [2.0, 2.0]}],
            ["c", {"start": [2.0, 2.0], "end": [0.0, 2.0]}],
            ["d", {"start": [0.0, 2.0], "end": [0.0, 0.0]}],
        ]);
        let bytes = serde_json::to_vec(&input).unwrap();
        let geom = decode_input(&bytes).unwrap();
        let out = super::super::detect_topology(&geom);
        let encoded = encode_output(&out).expect("square output is finite");
        let v: Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(v["surfaces"].as_array().unwrap().len(), 1);
        assert_eq!(v["edges"].as_array().unwrap().len(), 4);
        // The first edge is a straight line -> decoration hint edge_type.
        assert_eq!(v["edges"][0]["edge_type"], json!("straightedge"));
        assert_eq!(v["edges"][0]["kind"], json!("line"));
        // The surface carries the source entity id tokens for the TS query.
        assert_eq!(
            v["surfaces"][0]["face_entity_ids"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn ellipse_boundary_has_no_start_key() {
        let input = json!([["e0", {"kind": "ellipse", "center": [0.0, 0.0], "a": 3.0, "b": 1.0, "theta": 0.0}]]);
        let bytes = serde_json::to_vec(&input).unwrap();
        let geom = decode_input(&bytes).unwrap();
        let out = super::super::detect_topology(&geom);
        let v: Value =
            serde_json::from_slice(&encode_output(&out).expect("ellipse output is finite"))
                .unwrap();
        let be = &v["surfaces"][0]["boundary"][0];
        assert_eq!(be["kind"], json!("ellipse"));
        assert!(
            be.get("start").is_none(),
            "full ellipse boundary edge must have no start"
        );
        assert!(be.get("id").is_some());
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode_input(&[0, 1, 2, 3]).is_err());
    }

    #[test]
    fn entity_list_over_the_cap_is_a_clean_error() {
        // The downstream passes cost at least O(N^2) in pair dispatch plus an
        // O(V) vertex rescan per registered point, so a hostile document with
        // tens of thousands of entities wedges the Worker for minutes to hours
        // of uninterruptible CPU. Over the cap must decode to an explicit Err.
        let doc: Vec<_> = (0..=MAX_ENTITIES)
            .map(|i| {
                (
                    format!("e{i}"),
                    serde_json::json!({"start": [0.0, 0.0], "end": [1.0, 0.0]}),
                )
            })
            .collect();
        let bytes = serde_json::to_vec(&doc).unwrap();
        assert!(matches!(
            decode_input(&bytes),
            Err(TopologyCodecError::TooManyEntities)
        ));
    }

    #[test]
    fn entity_list_just_under_the_cap_still_decodes() {
        // The cap sits far above any real sketch; a list at the boundary
        // itself must pass cleanly so the limit never bites legitimate work.
        let doc: Vec<_> = (0..MAX_ENTITIES)
            .map(|i| {
                (
                    format!("e{i}"),
                    serde_json::json!({"start": [0.0, 0.0], "end": [1.0, 0.0]}),
                )
            })
            .collect();
        let bytes = serde_json::to_vec(&doc).unwrap();
        let decoded = decode_input(&bytes).expect("at-cap list must decode");
        assert_eq!(decoded.len(), MAX_ENTITIES);
    }

    #[test]
    fn overflowing_float_literals_are_a_clean_decode_error() {
        // An overflowing literal like 1e400 must surface as an explicit Err,
        // never Ok with a poisoned float. serde_json 1.0.150 rejects the
        // literal at parse time ("number out of range"); the NonFinite gate
        // below stands behind that so a serde_json behavior drift toward
        // mapping such literals to +-infinity cannot slip one through.
        let raw = r#"[["e0", {"kind": "arc", "center": [0.0, 0.0], "radius": 1.0, "start": [1.0, 0.0], "end": [-1.0, 0.0], "angle_start": 1e400, "angle_end": 90.0}]]"#;
        assert!(decode_input(raw.as_bytes()).is_err());
    }

    #[test]
    fn nonfinite_gate_rejects_every_payload_field() {
        // One slot class per case: any single NaN or Inf reaching the geometry
        // pass poisons angle params (and used to wedge the arc normalization
        // walk), so there is no harmless field. Driven directly because strict
        // JSON cannot carry these values past serde_json's own parse gate.
        let g = RawGeom::default();
        assert!(reject_non_finite(&[("e0".into(), g)]).is_ok());
        type Setter = fn(&mut RawGeom);
        let cases: Vec<(&str, Setter)> = vec![
            ("start.x", |g: &mut RawGeom| {
                g.start = Some([f64::INFINITY, 0.0])
            }),
            ("end.y", |g: &mut RawGeom| {
                g.end = Some([0.0, f64::NEG_INFINITY])
            }),
            ("center.x", |g: &mut RawGeom| {
                g.center = Some([f64::NAN, 0.0])
            }),
            ("radius", |g: &mut RawGeom| g.radius = Some(f64::INFINITY)),
            ("angle_start", |g: &mut RawGeom| {
                g.angle_start = Some(f64::NEG_INFINITY)
            }),
            ("angle_end", |g: &mut RawGeom| g.angle_end = Some(f64::NAN)),
            ("a", |g: &mut RawGeom| g.a = Some(f64::INFINITY)),
            ("b", |g: &mut RawGeom| g.b = Some(f64::NEG_INFINITY)),
            ("theta", |g: &mut RawGeom| g.theta = Some(f64::NAN)),
            ("c1.x", |g: &mut RawGeom| g.c1 = Some([f64::NAN, 1.0])),
            ("c2.y", |g: &mut RawGeom| g.c2 = Some([1.0, f64::NAN])),
        ];
        for (name, set) in cases {
            let mut g = RawGeom::default();
            set(&mut g);
            assert!(
                matches!(
                    reject_non_finite(&[("e0".into(), g)]),
                    Err(TopologyCodecError::NonFinite)
                ),
                "{name} passed the non-finite gate"
            );
        }
    }

    #[test]
    fn nonfinite_output_gate_rejects_every_computed_slot() {
        // The input gate only sees authored floats; the encoder's values have
        // been through intersection/split/endpoint transforms since, and any
        // of them can go NaN or +-Inf even from finite inputs. serde_json
        // would serialize either as JSON Null, silently handing the decorator
        // a broken topology, so encode_output must refuse instead. Driven
        // directly on a real square topology (mirroring the input-gate test)
        // because no payload reliably drives DERIVED floats non-finite across
        // numeric refactors; one slot class per case.
        fn square() -> TopologyOut {
            let input = json!([
                ["a", {"start": [0.0, 0.0], "end": [2.0, 0.0]}],
                ["b", {"start": [2.0, 0.0], "end": [2.0, 2.0]}],
                ["c", {"start": [2.0, 2.0], "end": [0.0, 2.0]}],
                ["d", {"start": [0.0, 2.0], "end": [0.0, 0.0]}],
            ]);
            let bytes = serde_json::to_vec(&input).unwrap();
            super::super::detect_topology(&decode_input(&bytes).unwrap())
        }
        assert!(encode_output(&square()).is_ok());
        type Poison = fn(&mut TopologyOut);
        let cases: Vec<(&str, Poison)> = vec![
            ("vertex.x", |out: &mut TopologyOut| {
                out.vertices[0].1[0] = f64::NAN;
            }),
            ("intersection.y", |out: &mut TopologyOut| {
                out.intersection_points
                    .push(("p".into(), [1.0, f64::INFINITY]));
            }),
            ("edge start.x", |out: &mut TopologyOut| {
                if let EdgeGeom::Line { start, .. } = &mut out.edges[0].geom {
                    start[0] = f64::NAN;
                }
            }),
            ("boundary end.y", |out: &mut TopologyOut| {
                if let EdgeGeom::Line { end, .. } = &mut out.surfaces[0].boundary[0].geom {
                    end[1] = f64::NEG_INFINITY;
                }
            }),
            ("arc radius", |out: &mut TopologyOut| {
                out.surfaces[0].boundary.push(BoundaryEdge {
                    geom: EdgeGeom::Arc {
                        center: [0.0, 0.0],
                        radius: f64::NAN,
                        angle_start_deg: 0.0,
                        angle_end_deg: 90.0,
                        ccw: true,
                        start: [1.0, 0.0],
                        end: [0.0, 1.0],
                    },
                    id: None,
                    start_vertex: None,
                    end_vertex: None,
                });
            }),
            ("ellipse theta", |out: &mut TopologyOut| {
                out.surfaces[0].holes.push(vec![BoundaryEdge {
                    geom: EdgeGeom::Ellipse {
                        center: [0.0, 0.0],
                        a: 3.0,
                        b: 1.0,
                        theta: f64::INFINITY,
                    },
                    id: None,
                    start_vertex: None,
                    end_vertex: None,
                }]);
            }),
        ];
        for (name, poison) in cases {
            let mut out = square();
            poison(&mut out);
            assert!(
                matches!(encode_output(&out), Err(TopologyCodecError::NonFinite)),
                "{name} serialized instead of being rejected"
            );
        }
    }
}
