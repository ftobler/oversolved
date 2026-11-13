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

use super::dcel::{Contact, ContactKind, ContactRef, InputEntity, TopologyOut, UnmetContact};
use super::profile_loops::{BoundaryEdge, EdgeGeom, Vec2};
use crate::fit_spline::{fit_spline_error_message, FitSpline};

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
    /// the flat codec's `CodecError::NonFinite` as the backstop. The entity
    /// id is carried when the gate can attribute the value to one: an
    /// unattributed `NonFinite` left the user unable to find the cause.
    NonFinite {
        entity: Option<String>,
    },
    /// More entities than `MAX_ENTITIES`. Mirrors the flat codec's capacity
    /// philosophy: counts are untrusted, and here the cost of believing them
    /// is quadratic downstream, so the refusal happens at decode.
    TooManyEntities,
    /// More declared contacts than `MAX_ENTITIES`. The area builder resolves
    /// each against the entity list, so the same untrusted-count rule applies.
    TooManyContacts,
    /// A `fit_spline` whose point list cannot be interpolated (coincident
    /// consecutive points, too few or too many). The message names the entity
    /// and the points, the same refusal the authoring sugar surfaces.
    DegenerateFitSpline(String),
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

/// The boundary message the Worker turns into the sketch exception. The
/// non-finite arm names the entity whenever the gate could attribute the value:
/// the whole sketch used to fail with a bare `NonFinite` and no clue which
/// curve poisoned it.
impl std::fmt::Display for TopologyCodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TopologyCodecError::Json(e) => write!(f, "invalid JSON: {e}"),
            TopologyCodecError::NonFinite { entity: Some(eid) } => {
                write!(f, "non-finite value from entity '{eid}'")
            }
            TopologyCodecError::NonFinite { entity: None } => {
                write!(f, "non-finite value not attributable to one entity")
            }
            TopologyCodecError::TooManyEntities => {
                write!(f, "more than {MAX_ENTITIES} entities")
            }
            TopologyCodecError::TooManyContacts => {
                write!(f, "more than {MAX_ENTITIES} contacts")
            }
            TopologyCodecError::DegenerateFitSpline(message) => f.write_str(message),
        }
    }
}

/// Attribute a non-finite value to the entity it came from, when the gate can.
fn non_finite(entity: Option<&str>) -> TopologyCodecError {
    TopologyCodecError::NonFinite {
        entity: entity.map(str::to_string),
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
    /// Fit-spline input (`kind: "fit_spline"`): the fit points in order and the
    /// optional handles as absolute points.
    #[serde(default)]
    points: Option<Vec<Vec2>>,
    #[serde(default)]
    handle_start: Option<Vec2>,
    #[serde(default)]
    handle_end: Option<Vec2>,
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
            points: g.points,
            handle_start: g.handle_start,
            handle_end: g.handle_end,
        }
    }
}

/// Gate every f64 payload slot against NaN and +-infinity. The flat codec
/// checks its floats at the byte reader; the JSON path needs the equivalent
/// after deserialization as a backstop against serde_json versions or
/// features that map overflowing literals to +-infinity instead of erroring.
fn reject_non_finite(raw: &[(String, RawGeom)]) -> Result<(), TopologyCodecError> {
    for (eid, g) in raw {
        let pts = [
            g.start,
            g.end,
            g.center,
            g.c1,
            g.c2,
            g.handle_start,
            g.handle_end,
        ];
        if pts
            .into_iter()
            .flatten()
            .any(|p| p.iter().any(|x| !x.is_finite()))
        {
            return Err(non_finite(Some(eid)));
        }
        if let Some(points) = &g.points {
            if points.iter().flatten().any(|x| !x.is_finite()) {
                return Err(non_finite(Some(eid)));
            }
        }
        let scalars = [g.radius, g.angle_start, g.angle_end, g.a, g.b, g.theta];
        if scalars.into_iter().flatten().any(|x| !x.is_finite()) {
            return Err(non_finite(Some(eid)));
        }
    }
    Ok(())
}

/// A declared contact on the wire: the authored constraint id, its kind, and
/// its two operands.
#[derive(Clone, Debug, Deserialize)]
struct RawContact {
    #[serde(default)]
    id: String,
    kind: String,
    a: RawRef,
    b: RawRef,
    #[serde(default)]
    join: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct RawRef {
    entity: String,
    #[serde(default)]
    point: Option<String>,
}

impl From<RawContact> for Contact {
    fn from(c: RawContact) -> Self {
        let kind = match c.kind.as_str() {
            "on" => ContactKind::On,
            "tangent" => ContactKind::Tangent { join: c.join },
            _ => ContactKind::Join,
        };
        Contact {
            id: c.id,
            kind,
            a: ContactRef {
                entity: c.a.entity,
                point: c.a.point,
            },
            b: ContactRef {
                entity: c.b.entity,
                point: c.b.point,
            },
        }
    }
}

/// The decoded topology payload: the ordered entity list plus the declared
/// contacts (empty for the legacy array form and for every pre-contact
/// caller).
#[derive(Debug, Default)]
pub struct DecodedTopology {
    pub entities: Vec<(String, InputEntity)>,
    pub contacts: Vec<Contact>,
}

/// The v2 object form, `{"entities": [...], "contacts": [...]}`. Kept separate
/// from the legacy bare array so a payload without contacts decodes exactly as
/// it always did.
#[derive(Deserialize)]
struct ObjectPayload {
    entities: Vec<(String, RawGeom)>,
    #[serde(default)]
    contacts: Vec<RawContact>,
}

/// Decode either payload form. The bare array is the original ordered
/// `[[eid, geom], ...]` form and carries no contacts.
pub fn decode_payload(bytes: &[u8]) -> Result<DecodedTopology, TopologyCodecError> {
    let value: Value = serde_json::from_slice(bytes)?;
    let (raw, contacts) = if value.is_array() {
        (
            serde_json::from_value::<Vec<(String, RawGeom)>>(value)?,
            Vec::new(),
        )
    } else {
        let payload: ObjectPayload = serde_json::from_value(value)?;
        (payload.entities, payload.contacts)
    };
    if raw.len() > MAX_ENTITIES {
        return Err(TopologyCodecError::TooManyEntities);
    }
    if contacts.len() > MAX_ENTITIES {
        return Err(TopologyCodecError::TooManyContacts);
    }
    reject_non_finite(&raw)?;
    // A fit spline whose points cannot be interpolated is refused here, with the
    // entity id, rather than dropped silently: the user authored a curve, and a
    // coincident pair is an authoring mistake the UI must report.
    for (eid, geom) in &raw {
        if geom.kind.as_deref() != Some("fit_spline") {
            continue;
        }
        let Some(points) = &geom.points else {
            continue;
        };
        if let Err(error) = FitSpline::new(points, geom.handle_start, geom.handle_end) {
            return Err(TopologyCodecError::DegenerateFitSpline(
                fit_spline_error_message(&error, eid),
            ));
        }
    }
    Ok(DecodedTopology {
        entities: raw.into_iter().map(|(eid, g)| (eid, g.into())).collect(),
        contacts: contacts.into_iter().map(Contact::from).collect(),
    })
}

/// Decode the ordered `[[eid, geom], ...]` payload into classified-ready input.
/// Test-only now that the WASM entry decodes the full payload: it intentionally
/// ignores the contacts of an object-form payload, so the fixtures that need
/// only geometry keep their old contract.
#[cfg(test)]
pub fn decode_input(bytes: &[u8]) -> Result<Vec<(String, InputEntity)>, TopologyCodecError> {
    Ok(decode_payload(bytes)?.entities)
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
        EdgeGeom::FitSpline {
            ref poles,
            ref knots,
        } => poles.iter().all(pt_ok) && knots.iter().all(|u| u.is_finite()),
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
    // Registered points carry no entity of their own: they are minted where two
    // entities meet, so there is nothing to name.
    if out.intersection_points.iter().any(|(_, p)| !pt_ok(p))
        || out.vertices.iter().any(|(_, p)| !pt_ok(p))
    {
        return Err(non_finite(None));
    }
    if let Some(e) = out.edges.iter().find(|e| !geom_is_finite(&e.geom)) {
        return Err(non_finite(Some(&e.entity_id)));
    }
    // A boundary edge keeps the id of the entity it came from, so a poisoned
    // surface edge can name its curve just like a whole edge does.
    let bad_boundary = out
        .surfaces
        .iter()
        .chain(out.hole_regions.iter())
        .flat_map(|s| s.boundary.iter().chain(s.holes.iter().flatten()))
        .find(|be| !geom_is_finite(&be.geom));
    if let Some(be) = bad_boundary {
        return Err(non_finite(be.id.as_deref()));
    }
    let unmet_ok = out
        .unmet_contacts
        .iter()
        .all(|c| pt_ok(&c.a) && pt_ok(&c.b) && c.gap.is_finite());
    if unmet_ok {
        Ok(())
    } else {
        Err(non_finite(None))
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
        EdgeGeom::FitSpline {
            ref poles,
            ref knots,
        } => {
            m.insert("kind".into(), json!("fit_spline"));
            m.insert("start".into(), pt(poles[0]));
            m.insert("end".into(), pt(poles[poles.len() - 1]));
            m.insert(
                "poles".into(),
                Value::Array(poles.iter().map(|p| pt(*p)).collect()),
            );
            m.insert("knots".into(), json!(knots));
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

    // The even/odd hole faces, in the same shape. The TS decorator reads only
    // `surfaces`, so these travel straight through it into the profile dump;
    // the oracle is their consumer.
    let hole_regions: Vec<Value> = out
        .hole_regions
        .iter()
        .map(|s| {
            let mut m = Map::new();
            let boundary: Vec<Value> = s.boundary.iter().map(boundary_edge_value).collect();
            m.insert("boundary".into(), Value::Array(boundary));
            m.insert("face_entity_ids".into(), json!(s.face_entity_ids));
            Value::Object(m)
        })
        .collect();

    // Declared contacts the geometry did not meet. The TS decorator carries
    // them beside the surfaces so the feature error can name the authored
    // constraint id instead of only the nearest open ends.
    let unmet_contacts: Vec<Value> = out
        .unmet_contacts
        .iter()
        .map(|c: &UnmetContact| {
            json!({
                "id": c.id,
                "a": pt(c.a),
                "b": pt(c.b),
                "gap": c.gap,
            })
        })
        .collect();

    let root = json!({
        "intersection_points": Value::Object(ip),
        "vertices": Value::Object(verts),
        "edges": edges,
        "surfaces": surfaces,
        "hole_regions": hole_regions,
        "unmet_contacts": unmet_contacts,
    });
    serde_json::to_vec(&root).map_err(TopologyCodecError::Json)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unit square's topology, the finite baseline the output-gate tests
    /// poison one slot at a time.
    fn square_topology() -> TopologyOut {
        let input = json!([
            ["a", {"start": [0.0, 0.0], "end": [2.0, 0.0]}],
            ["b", {"start": [2.0, 0.0], "end": [2.0, 2.0]}],
            ["c", {"start": [2.0, 2.0], "end": [0.0, 2.0]}],
            ["d", {"start": [0.0, 2.0], "end": [0.0, 0.0]}],
        ]);
        let bytes = serde_json::to_vec(&input).unwrap();
        super::super::detect_topology(&decode_input(&bytes).unwrap(), &[])
    }

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
        let out = super::super::detect_topology(&geom, &[]);
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
        let out = super::super::detect_topology(&geom, &[]);
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
                    Err(TopologyCodecError::NonFinite { entity: Some(ref id) }) if id == "e0"
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
        assert!(encode_output(&square_topology()).is_ok());
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
            let mut out = square_topology();
            poison(&mut out);
            assert!(
                matches!(
                    encode_output(&out),
                    Err(TopologyCodecError::NonFinite { .. })
                ),
                "{name} serialized instead of being rejected"
            );
        }
    }

    #[test]
    fn two_identical_degenerate_ellipses_build_a_finite_topology() {
        // An edge-on projected circle lowers to the ellipse [20, 0, 3, 0, 0],
        // and projecting a hole's edge together with the circle that cut it
        // puts two of them in one sketch. The b = 0 carrier made the scanned
        // hit parameter recover NaN, which the output gate refused as a bare
        // `NonFinite` and the whole sketch became an exception. A zero-area
        // carrier must never take the sketch down.
        let input = json!([
            ["e0", {"kind": "ellipse", "center": [20.0, 0.0], "a": 3.0, "b": 0.0, "theta": 0.0}],
            ["e1", {"kind": "ellipse", "center": [20.0, 0.0], "a": 3.0, "b": 0.0, "theta": 0.0}],
        ]);
        let bytes = serde_json::to_vec(&input).unwrap();
        let out = super::super::detect_topology(&decode_input(&bytes).unwrap(), &[]);
        let encoded = encode_output(&out).expect("a degenerate ellipse must not fail the sketch");
        let v: Value = serde_json::from_slice(&encoded).unwrap();
        assert!(
            v["surfaces"].as_array().unwrap().is_empty(),
            "a zero-area carrier bounds no face"
        );
        // Pinned outcome: each degenerate ellipse is still its segment (the two
        // ends of the major axis), so both entities contribute authored edges.
        // It is not treated as an incomplete entity and dropped.
        let edges = v["edges"].as_array().unwrap();
        for eid in ["e0", "e1"] {
            assert!(
                edges.iter().any(|e| e["entity_id"] == json!(eid)),
                "{eid} lost its segment edges"
            );
        }
        assert!(edges.iter().all(|e| {
            e["start"]
                .as_array()
                .is_some_and(|p| p.iter().all(|x| x.as_f64().is_some_and(f64::is_finite)))
        }));
    }

    #[test]
    fn a_fully_collapsed_ellipse_bounds_nothing_and_does_not_fail() {
        // a = b = 0 is a point, not a curve: it has no extents to intersect,
        // split or close, so it contributes no vertex, edge or face. It must
        // still decode and build rather than raising `NonFinite`.
        let input = json!([
            ["e0", {"kind": "ellipse", "center": [0.0, 0.0], "a": 0.0, "b": 0.0, "theta": 0.0}],
            ["e1", {"kind": "ellipse", "center": [0.0, 0.0], "a": 0.0, "b": 0.0, "theta": 0.0}],
        ]);
        let bytes = serde_json::to_vec(&input).unwrap();
        let out = super::super::detect_topology(&decode_input(&bytes).unwrap(), &[]);
        let encoded = encode_output(&out).expect("a collapsed ellipse must not fail the sketch");
        let v: Value = serde_json::from_slice(&encoded).unwrap();
        assert!(v["vertices"].as_object().unwrap().is_empty());
        assert!(v["edges"].as_array().unwrap().is_empty());
        assert!(v["surfaces"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_non_finite_input_value_names_the_entity_it_came_from() {
        // The user sees this message on the sketch, so "NonFinite" alone left
        // them with no way to find the curve that poisoned the build.
        let g = RawGeom {
            a: Some(f64::NAN),
            ..RawGeom::default()
        };
        let err = reject_non_finite(&[("e7".into(), g)]).unwrap_err();
        assert_eq!(err.to_string(), "non-finite value from entity 'e7'");
    }

    #[test]
    fn a_non_finite_computed_edge_names_the_entity_it_came_from() {
        let mut out = square_topology();
        if let EdgeGeom::Line { start, .. } = &mut out.edges[0].geom {
            start[0] = f64::NAN;
        }
        let err = encode_output(&out).expect_err("a NaN edge is refused");
        assert_eq!(err.to_string(), "non-finite value from entity 'a'");
    }

    #[test]
    fn a_non_finite_surface_edge_names_its_source_entity() {
        // The standalone pass copies the entity id onto the boundary edge, so a
        // poisoned surface edge names its curve the same way a whole edge does.
        let input = json!([["e0", {"kind": "ellipse", "center": [0.0, 0.0], "a": 3.0, "b": 1.0, "theta": 0.0}]]);
        let bytes = serde_json::to_vec(&input).unwrap();
        let mut out = super::super::detect_topology(&decode_input(&bytes).unwrap(), &[]);
        if let EdgeGeom::Ellipse { b, .. } = &mut out.surfaces[0].boundary[0].geom {
            *b = f64::NAN;
        }
        let err = encode_output(&out).expect_err("a NaN boundary edge is refused");
        assert_eq!(err.to_string(), "non-finite value from entity 'e0'");
    }

    #[test]
    fn a_non_finite_registered_point_is_reported_without_an_entity() {
        // A vertex is minted where two entities meet, so no single entity owns
        // it; the message says so instead of guessing one.
        let mut out = square_topology();
        out.vertices[0].1[0] = f64::INFINITY;
        let err = encode_output(&out).expect_err("a non-finite vertex is refused");
        assert_eq!(
            err.to_string(),
            "non-finite value not attributable to one entity"
        );
    }
}
