//! Golden replay for the profile-loop family.
//!
//! The fixture is generated from the TypeScript implementation that used to
//! live in `frontend/src/kernel/profileLoops.ts` (see
//! `frontend/src/kernel/__tests__/profileLoopsGolden.test.ts` for the generator
//! and the case list). It covers every edge kind, the concave containment
//! probe, and every surface of the frozen Python-parity topology fixture, so
//! the corpus is real builder output rather than hand-built shapes only.
//!
//! Each case replays its ops through the real wire codec, so a decoder drift
//! fails here as well as in the TS facade test.

use geom_core::profile_loops::{EdgeGeom, LoopEdge, Vec2};
use geom_core::wire::{
    profile_loops_bytes, OP_ARC_SAMPLES, OP_CENTROID, OP_CONTAINMENT, OP_ELLIPSE_ARC_SAMPLES,
    OP_ELLIPSE_SAMPLES, OP_FIT_SPLINE_SAMPLES, OP_LOOP_PTS, OP_POINT_IN_LOOP, OP_SIGNED_AREA,
    OP_SPLINE_SAMPLES, OP_SUBDIVIDE,
};
use serde_json::{json, Value};
use solver_core::bytes::{Reader, Writer};

const FIXTURE: &str = include_str!("fixtures/profile_loops.json");

fn as_point(v: &Value) -> Vec2 {
    [v[0].as_f64().unwrap(), v[1].as_f64().unwrap()]
}

fn opt_point(v: &Value) -> Option<Vec2> {
    if v.is_null() {
        None
    } else {
        Some(as_point(v))
    }
}

fn as_num(v: &Value) -> f64 {
    v.as_f64().unwrap()
}

fn edge_from_json(v: &Value) -> LoopEdge {
    let kind = v["kind"].as_str().unwrap();
    let start = opt_point(&v["start"]);
    let geom = match kind {
        "line" => EdgeGeom::Line {
            start: as_point(&v["start"]),
            end: as_point(&v["end"]),
        },
        "arc" => EdgeGeom::Arc {
            center: as_point(&v["center"]),
            radius: as_num(&v["radius"]),
            angle_start_deg: as_num(&v["angle_start_deg"]),
            angle_end_deg: as_num(&v["angle_end_deg"]),
            ccw: v["ccw"].as_bool().unwrap_or(true),
            start: as_point(&v["start"]),
            end: as_point(&v["end"]),
        },
        "ellipse_arc" => EdgeGeom::EllipseArc {
            center: as_point(&v["center"]),
            a: as_num(&v["a"]),
            b: as_num(&v["b"]),
            theta: as_num(&v["theta"]),
            angle_start_deg: as_num(&v["angle_start_deg"]),
            angle_end_deg: as_num(&v["angle_end_deg"]),
            ccw: v["ccw"].as_bool().unwrap_or(true),
            start: as_point(&v["start"]),
            end: as_point(&v["end"]),
        },
        "spline" => EdgeGeom::Spline {
            start: as_point(&v["start"]),
            c1: as_point(&v["c1"]),
            c2: as_point(&v["c2"]),
            end: as_point(&v["end"]),
        },
        "fit_spline" => EdgeGeom::FitSpline {
            poles: v["poles"]
                .as_array()
                .unwrap()
                .iter()
                .map(as_point)
                .collect(),
            knots: v["knots"].as_array().unwrap().iter().map(as_num).collect(),
        },
        "ellipse" => EdgeGeom::Ellipse {
            center: as_point(&v["center"]),
            a: as_num(&v["a"]),
            b: as_num(&v["b"]),
            theta: as_num(&v["theta"]),
        },
        other => panic!("fixture edge kind {other}"),
    };
    LoopEdge { geom, start }
}

fn write_point(w: &mut Writer, p: Vec2) {
    w.f64(p[0]);
    w.f64(p[1]);
}

fn write_edge(w: &mut Writer, e: &LoopEdge) {
    match &e.geom {
        EdgeGeom::Line { start, end } => {
            w.u8(0);
            write_point(w, *start);
            write_point(w, *end);
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
            w.u8(1);
            write_point(w, *center);
            w.f64(*radius);
            w.f64(*angle_start_deg);
            w.f64(*angle_end_deg);
            w.u8(u8::from(*ccw));
            write_point(w, *start);
            write_point(w, *end);
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
            w.u8(2);
            write_point(w, *center);
            w.f64(*a);
            w.f64(*b);
            w.f64(*theta);
            w.f64(*angle_start_deg);
            w.f64(*angle_end_deg);
            w.u8(u8::from(*ccw));
            write_point(w, *start);
            write_point(w, *end);
        }
        EdgeGeom::Spline { start, c1, c2, end } => {
            w.u8(3);
            for p in [start, c1, c2, end] {
                write_point(w, *p);
            }
        }
        EdgeGeom::FitSpline { poles, knots } => {
            w.u8(4);
            w.u32(poles.len() as u32);
            for p in poles {
                write_point(w, *p);
            }
            w.u32(knots.len() as u32);
            for k in knots {
                w.f64(*k);
            }
        }
        EdgeGeom::Ellipse {
            center,
            a,
            b,
            theta,
        } => {
            w.u8(5);
            write_point(w, *center);
            w.f64(*a);
            w.f64(*b);
            w.f64(*theta);
        }
    }
    // The dict's explicit start, trailing every kind.
    w.u8(u8::from(e.start.is_some()));
    if let Some(s) = e.start {
        write_point(w, s);
    }
}

fn encode(op: u8, aux: u32, point: Option<Vec2>, loops: &[Vec<LoopEdge>]) -> Vec<u8> {
    let mut w = Writer::default();
    w.u32(0x314c_5047);
    w.u8(geom_core::wire::VERSION);
    w.u8(op);
    w.u32(aux);
    if let Some(p) = point {
        write_point(&mut w, p);
    }
    w.u32(loops.len() as u32);
    for l in loops {
        w.u32(l.len() as u32);
        for e in l {
            write_edge(&mut w, e);
        }
    }
    w.into_bytes()
}

fn reply(input: Vec<u8>) -> Reader<'static> {
    // The codec copies into a fresh buffer; leaking it here gives the test a
    // 'static reader without a lifetime dance, and the process ends right after.
    let bytes: &'static [u8] = Box::leak(profile_loops_bytes(&input).unwrap().into_boxed_slice());
    let mut r = Reader::new(bytes);
    assert_eq!(r.u32().unwrap(), 0x3152_5047, "output magic");
    assert_eq!(r.u8().unwrap(), geom_core::wire::VERSION);
    r
}

fn read_points(r: &mut Reader<'_>) -> Value {
    let n = r.u32().unwrap() as usize;
    Value::Array(
        (0..n)
            .map(|_| json!([r.f64().unwrap(), r.f64().unwrap()]))
            .collect(),
    )
}

fn read_op(op: &str, op_code: u8, aux: u32, point: Option<Vec2>, loops: &[Vec<LoopEdge>]) -> Value {
    let mut r = reply(encode(op_code, aux, point, loops));
    match op {
        "loopPts" | "sampler" => read_points(&mut r),
        "signedArea" => json!(r.f64().unwrap()),
        "pointInLoop" => json!(r.u8().unwrap() != 0),
        "centroid" => json!([r.f64().unwrap(), r.f64().unwrap()]),
        "containment" => {
            let n = r.u32().unwrap() as usize;
            let mut depth = Vec::with_capacity(n);
            let mut container = Vec::with_capacity(n);
            for _ in 0..n {
                depth.push(json!(r.u32().unwrap()));
                let c = r.u32().unwrap();
                container.push(json!(if c == u32::MAX { -1 } else { c as i64 }));
            }
            json!({ "depth": depth, "container": container })
        }
        "subdivide" => {
            let n = r.u32().unwrap() as usize;
            Value::Array(
                (0..n)
                    .map(|_| {
                        let outer = r.u32().unwrap();
                        let holes = r.u32().unwrap() as usize;
                        let holes: Vec<Value> =
                            (0..holes).map(|_| json!(r.u32().unwrap())).collect();
                        json!([outer, holes])
                    })
                    .collect(),
            )
        }
        other => panic!("fixture op {other}"),
    }
}

fn assert_close(got: &Value, want: &Value, path: &str) {
    match (got, want) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            let scale = a.abs().max(b.abs()).max(1.0);
            assert!(
                (a - b).abs() <= 1e-12 * scale,
                "{path}: {a} != {b} (delta {})",
                (a - b).abs()
            );
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: length");
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                assert_close(x, y, &format!("{path}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: object keys");
            for (k, y) in b {
                let x = a.get(k).unwrap_or_else(|| panic!("{path}.{k} missing"));
                assert_close(x, y, &format!("{path}.{k}"));
            }
        }
        _ => assert_eq!(got, want, "{path}"),
    }
}

#[test]
fn every_golden_case_replays_on_the_rust_core() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture parses");
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 10, "the fixture lost cases");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let loops: Vec<Vec<LoopEdge>> = case["loops"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l.as_array().unwrap().iter().map(edge_from_json).collect())
            .collect();
        for op in case["ops"].as_array().unwrap() {
            let kind = op["op"].as_str().unwrap();
            let loop_index = op["loop"].as_u64().unwrap_or(0) as usize;
            let aux = if kind == "sampler" {
                op["n"].as_u64().unwrap_or(0) as u32
            } else {
                op["arcSamples"].as_u64().unwrap_or(0) as u32
            };
            let point = op["point"].as_array().map(|_| as_point(&op["point"]));
            let selected: Vec<Vec<LoopEdge>> = if matches!(
                kind,
                "loopPts" | "signedArea" | "centroid" | "pointInLoop" | "sampler"
            ) {
                vec![loops[loop_index].clone()]
            } else {
                loops.clone()
            };
            let op_code = match kind {
                "loopPts" => OP_LOOP_PTS,
                "signedArea" => OP_SIGNED_AREA,
                "pointInLoop" => OP_POINT_IN_LOOP,
                "centroid" => OP_CENTROID,
                "containment" => OP_CONTAINMENT,
                "subdivide" => OP_SUBDIVIDE,
                "sampler" => match op["value"].as_str().unwrap() {
                    "arc" => OP_ARC_SAMPLES,
                    "ellipseArc" => OP_ELLIPSE_ARC_SAMPLES,
                    "spline" => OP_SPLINE_SAMPLES,
                    "fitSpline" => OP_FIT_SPLINE_SAMPLES,
                    "ellipse" => OP_ELLIPSE_SAMPLES,
                    other => panic!("{name}: sampler {other}"),
                },
                other => panic!("{name}: op {other}"),
            };
            let got = read_op(kind, op_code, aux, point, &selected);
            assert_close(&got, &op["expected"], &format!("{name}: {kind}"));
        }
    }
}
