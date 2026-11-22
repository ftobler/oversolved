//! The wire codec for the ported profile-loop family.
//!
//! Little-endian bytes, one entry point (`profile_loops_bytes`) and one op
//! byte, because the TS facade keeps the old synchronous function signatures
//! and a single crossing keeps that surface small. The format is versioned by a
//! byte right after the magic, so a stale js/wasm pairing fails loudly instead
//! of decoding shifted offsets.
//!
//! Layout (all little-endian):
//!
//! ```text
//! in:  u32 MAGIC_IN, u8 VERSION, u8 op, u32 aux, u32 n_loops,
//!      [f64 x, f64 y    when op = PointInLoop]
//!      n_loops x (u32 n_edges, n_edges x edge)
//! out: u32 MAGIC_OUT, u8 VERSION, op-specific body
//! ```
//!
//! `aux` is the polygon sample count for the ops that take one, the interior
//! point count for the per-kind samplers, and ignored otherwise.
//!
//! Edge encoding: `u8 kind` then the fields of that kind:
//!
//! ```text
//! 0 line         start, end
//! 1 arc          center, radius, angle_start_deg, angle_end_deg, u8 ccw, start, end
//! 2 ellipse_arc  center, a, b, theta, angle_start_deg, angle_end_deg, u8 ccw, start, end
//! 3 spline       start, c1, c2, end
//! 4 fit_spline   u32 n_poles, poles, u32 n_knots, knots
//! 5 ellipse      center, a, b, theta
//! every kind     u8 has_start, [start]
//! ```
//!
//! The explicit start of a loop edge is the trailing `has_start`/start pair on
//! every kind: the polygon reader pushes the DICT's start, not the geometry's,
//! and a dict can lack the key entirely. The geometry's own start still rides
//! its kind fields (a line's endpoints, an arc's angle range); a fit-spline
//! joint snapped onto a shared vertex keeps the dict's position this way, and
//! an edge without the key pushes nothing.

use crate::profile_loops::ProfiledEdge;
use crate::profile_loops::{
    arc_sample_points, ellipse_arc_sample_points, ellipse_sample_points, fit_spline_sample_points,
    loop_centroid, loop_pts, loop_signed_area, point_in_loop, profile_loop_containment,
    spline_sample_points, subdivide_loops, EdgeGeom, LoopEdge, Vec2,
};
use solver_core::bytes::{Eof, Reader, Writer};

/// Input magic, ASCII `GPL1` on the wire.
const MAGIC_IN: u32 = 0x314c_5047;
/// Output magic, ASCII `GPR1` on the wire.
const MAGIC_OUT: u32 = 0x3152_5047;
/// Layout version. Bump BOTH sides (`frontend/src/wasm-kernel/profileLoopsCodec.ts`)
/// on any change, exactly like the sketch solver's magics.
pub const VERSION: u8 = 1;

/// One op per public facade function the TS side calls.
pub const OP_LOOP_PTS: u8 = 0;
pub const OP_SIGNED_AREA: u8 = 1;
pub const OP_POINT_IN_LOOP: u8 = 2;
pub const OP_CENTROID: u8 = 3;
pub const OP_CONTAINMENT: u8 = 4;
pub const OP_SUBDIVIDE: u8 = 5;
pub const OP_ARC_SAMPLES: u8 = 6;
pub const OP_ELLIPSE_ARC_SAMPLES: u8 = 7;
pub const OP_SPLINE_SAMPLES: u8 = 8;
pub const OP_FIT_SPLINE_SAMPLES: u8 = 9;
pub const OP_ELLIPSE_SAMPLES: u8 = 10;

/// A malformed buffer. A host bug on the wire, never a geometry verdict, so it
/// surfaces as a thrown JS error rather than an empty result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    Eof,
    BadMagic(u32),
    BadVersion(u8),
    BadOp(u8),
    BadKind(u8),
    BadFlag(u8),
    /// Trailing bytes after the payload: the sender and this decoder disagree
    /// about the layout, which is exactly the drift the version byte guards.
    Trailing(usize),
    /// An op that takes a single edge was sent more than one loop.
    NotOneLoop(usize),
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WireError::Eof => f.write_str("profile-loops wire: truncated input"),
            WireError::BadMagic(m) => write!(f, "profile-loops wire: bad magic {m:#010x}"),
            WireError::BadVersion(v) => write!(f, "profile-loops wire: unsupported version {v}"),
            WireError::BadOp(op) => write!(f, "profile-loops wire: unknown op {op}"),
            WireError::BadKind(k) => write!(f, "profile-loops wire: unknown edge kind {k}"),
            WireError::BadFlag(v) => write!(f, "profile-loops wire: bad flag byte {v}"),
            WireError::Trailing(n) => write!(f, "profile-loops wire: {n} trailing byte(s)"),
            WireError::NotOneLoop(n) => {
                write!(f, "profile-loops wire: expected one loop, got {n}")
            }
        }
    }
}

impl From<Eof> for WireError {
    fn from(_: Eof) -> Self {
        WireError::Eof
    }
}

fn read_point(r: &mut Reader<'_>) -> Result<Vec2, Eof> {
    Ok([r.f64()?, r.f64()?])
}

fn read_ccw(r: &mut Reader<'_>) -> Result<bool, WireError> {
    match r.u8()? {
        0 => Ok(false),
        1 => Ok(true),
        other => Err(WireError::BadFlag(other)),
    }
}

fn read_edge(r: &mut Reader<'_>) -> Result<LoopEdge, WireError> {
    let kind = r.u8()?;
    let geom = match kind {
        0 => EdgeGeom::Line {
            start: read_point(r)?,
            end: read_point(r)?,
        },
        1 => EdgeGeom::Arc {
            center: read_point(r)?,
            radius: r.f64()?,
            angle_start_deg: r.f64()?,
            angle_end_deg: r.f64()?,
            ccw: read_ccw(r)?,
            start: read_point(r)?,
            end: read_point(r)?,
        },
        2 => EdgeGeom::EllipseArc {
            center: read_point(r)?,
            a: r.f64()?,
            b: r.f64()?,
            theta: r.f64()?,
            angle_start_deg: r.f64()?,
            angle_end_deg: r.f64()?,
            ccw: read_ccw(r)?,
            start: read_point(r)?,
            end: read_point(r)?,
        },
        3 => EdgeGeom::Spline {
            start: read_point(r)?,
            c1: read_point(r)?,
            c2: read_point(r)?,
            end: read_point(r)?,
        },
        4 => {
            let n_poles = r.u32()? as usize;
            let mut poles = Vec::with_capacity(r.capacity_for(n_poles, 16));
            for _ in 0..n_poles {
                poles.push(read_point(r)?);
            }
            let n_knots = r.u32()? as usize;
            let mut knots = Vec::with_capacity(r.capacity_for(n_knots, 8));
            for _ in 0..n_knots {
                knots.push(r.f64()?);
            }
            EdgeGeom::FitSpline { poles, knots }
        }
        5 => EdgeGeom::Ellipse {
            center: read_point(r)?,
            a: r.f64()?,
            b: r.f64()?,
            theta: r.f64()?,
        },
        other => return Err(WireError::BadKind(other)),
    };
    // The dict's explicit start, present for every kind so a snapped joint (or
    // a dict that simply lacks the key) is reproduced exactly.
    let has_start = read_ccw(r)?;
    let start = if has_start {
        Some(read_point(r)?)
    } else {
        None
    };
    Ok(LoopEdge { geom, start })
}

fn read_loops(r: &mut Reader<'_>) -> Result<Vec<Vec<LoopEdge>>, WireError> {
    let n_loops = r.u32()? as usize;
    let mut loops = Vec::with_capacity(r.capacity_for(n_loops, 4));
    for _ in 0..n_loops {
        let n_edges = r.u32()? as usize;
        let mut edges = Vec::with_capacity(r.capacity_for(n_edges, 1));
        for _ in 0..n_edges {
            edges.push(read_edge(r)?);
        }
        loops.push(edges);
    }
    Ok(loops)
}

fn read_header(r: &mut Reader<'_>) -> Result<(u8, u32), WireError> {
    let magic = r.u32()?;
    if magic != MAGIC_IN {
        return Err(WireError::BadMagic(magic));
    }
    let version = r.u8()?;
    if version != VERSION {
        return Err(WireError::BadVersion(version));
    }
    let op = r.u8()?;
    let aux = r.u32()?;
    Ok((op, aux))
}

fn write_header(w: &mut Writer) {
    w.u32(MAGIC_OUT);
    w.u8(VERSION);
}

fn write_points(w: &mut Writer, pts: &[Vec2]) {
    w.u32(pts.len() as u32);
    for p in pts {
        w.f64(p[0]);
        w.f64(p[1]);
    }
}

/// The edge slice of a single-loop op. Zero loops is the empty polygon the TS
/// functions answered with `[]`/`0`/`[0,0]`/`false`, not an error; more than one
/// is a host bug for an op that names one loop.
fn one_loop(loops: &[Vec<LoopEdge>]) -> Result<&[LoopEdge], WireError> {
    if loops.len() > 1 {
        return Err(WireError::NotOneLoop(loops.len()));
    }
    Ok(loops.first().map(|l| l.as_slice()).unwrap_or(&[]))
}

/// Run one profile-loop op. `Ok` carries the output bytes for the host; `Err` a
/// malformed input, which is a host bug (the geometry always has an answer).
pub fn profile_loops_bytes(input: &[u8]) -> Result<Vec<u8>, WireError> {
    let mut r = Reader::new(input);
    let (op, aux) = read_header(&mut r)?;
    let point = if op == OP_POINT_IN_LOOP {
        Some(read_point(&mut r)?)
    } else {
        None
    };
    let loops = read_loops(&mut r)?;
    if r.remaining() != 0 {
        return Err(WireError::Trailing(r.remaining()));
    }

    let mut w = Writer::default();
    write_header(&mut w);
    match op {
        OP_LOOP_PTS => {
            let loop_edges = one_loop(&loops)?;
            write_points(&mut w, &loop_pts(loop_edges, aux as usize));
        }
        OP_SIGNED_AREA => {
            let loop_edges = one_loop(&loops)?;
            w.f64(loop_signed_area(loop_edges, aux as usize));
        }
        OP_POINT_IN_LOOP => {
            let loop_edges = one_loop(&loops)?;
            let pt = point.ok_or(WireError::Eof)?;
            w.u8(u8::from(point_in_loop(pt, loop_edges, aux as usize)));
        }
        OP_CENTROID => {
            let loop_edges = one_loop(&loops)?;
            let c = loop_centroid(loop_edges);
            w.f64(c[0]);
            w.f64(c[1]);
        }
        OP_CONTAINMENT => {
            let (depth, container) = profile_loop_containment(&loops, aux as usize);
            w.u32(depth.len() as u32);
            for i in 0..depth.len() {
                w.u32(depth[i] as u32);
                // -1 is the "no container" sentinel the TS classifier uses.
                w.u32(container[i].map_or(u32::MAX, |c| c as u32));
            }
        }
        OP_SUBDIVIDE => {
            let groups = subdivide_loops(&loops);
            w.u32(groups.len() as u32);
            for (outer, holes) in groups {
                w.u32(outer as u32);
                w.u32(holes.len() as u32);
                for h in holes {
                    w.u32(h as u32);
                }
            }
        }
        OP_ARC_SAMPLES
        | OP_ELLIPSE_ARC_SAMPLES
        | OP_SPLINE_SAMPLES
        | OP_FIT_SPLINE_SAMPLES
        | OP_ELLIPSE_SAMPLES => {
            let edge = one_loop(&loops)?.first().ok_or(WireError::Eof)?;
            let pts = match op {
                OP_ARC_SAMPLES => arc_sample_points(edge.geom(), aux as usize),
                OP_ELLIPSE_ARC_SAMPLES => ellipse_arc_sample_points(edge.geom(), aux as usize),
                OP_SPLINE_SAMPLES => spline_sample_points(edge.geom(), aux as usize),
                OP_FIT_SPLINE_SAMPLES => fit_spline_sample_points(edge.geom(), aux as usize),
                _ => ellipse_sample_points(edge.geom(), aux as usize),
            };
            write_points(&mut w, &pts);
        }
        other => return Err(WireError::BadOp(other)),
    }
    Ok(w.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(geom: EdgeGeom) -> LoopEdge {
        // The wire always carries the dict's start for these kinds; mirroring
        // that here keeps the round-trip comparison honest.
        let start = geom.start();
        LoopEdge { geom, start }
    }

    fn encode(op: u8, aux: u32, point: Option<Vec2>, loops: &[Vec<LoopEdge>]) -> Vec<u8> {
        let mut w = Writer::default();
        w.u32(MAGIC_IN);
        w.u8(VERSION);
        w.u8(op);
        w.u32(aux);
        if let Some(p) = point {
            w.f64(p[0]);
            w.f64(p[1]);
        }
        w.u32(loops.len() as u32);
        for l in loops {
            w.u32(l.len() as u32);
            for e in l {
                encode_edge(&mut w, e);
            }
        }
        w.into_bytes()
    }

    fn encode_edge(w: &mut Writer, e: &LoopEdge) {
        match &e.geom {
            EdgeGeom::Line { start, end } => {
                w.u8(0);
                w.f64(start[0]);
                w.f64(start[1]);
                w.f64(end[0]);
                w.f64(end[1]);
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
                for v in [
                    center[0],
                    center[1],
                    *radius,
                    *angle_start_deg,
                    *angle_end_deg,
                ] {
                    w.f64(v);
                }
                w.u8(u8::from(*ccw));
                for v in [start[0], start[1], end[0], end[1]] {
                    w.f64(v);
                }
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
                for v in [
                    center[0],
                    center[1],
                    *a,
                    *b,
                    *theta,
                    *angle_start_deg,
                    *angle_end_deg,
                ] {
                    w.f64(v);
                }
                w.u8(u8::from(*ccw));
                for v in [start[0], start[1], end[0], end[1]] {
                    w.f64(v);
                }
            }
            EdgeGeom::Spline { start, c1, c2, end } => {
                w.u8(3);
                for p in [start, c1, c2, end] {
                    w.f64(p[0]);
                    w.f64(p[1]);
                }
            }
            EdgeGeom::FitSpline { poles, knots } => {
                w.u8(4);
                w.u32(poles.len() as u32);
                for p in poles {
                    w.f64(p[0]);
                    w.f64(p[1]);
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
                for v in [center[0], center[1], *a, *b, *theta] {
                    w.f64(v);
                }
            }
        }
        // The dict's explicit start, trailing every kind.
        w.u8(u8::from(e.start.is_some()));
        if let Some(s) = e.start {
            w.f64(s[0]);
            w.f64(s[1]);
        }
    }

    fn decode_points(bytes: &[u8]) -> Vec<Vec2> {
        let mut r = Reader::new(bytes);
        assert_eq!(r.u32().unwrap(), MAGIC_OUT);
        assert_eq!(r.u8().unwrap(), VERSION);
        let n = r.u32().unwrap() as usize;
        (0..n)
            .map(|_| [r.f64().unwrap(), r.f64().unwrap()])
            .collect()
    }

    fn square() -> Vec<LoopEdge> {
        let p = [[0.0, 0.0], [2.0, 0.0], [2.0, 3.0], [0.0, 3.0]];
        (0..4)
            .map(|i| {
                edge(EdgeGeom::Line {
                    start: p[i],
                    end: p[(i + 1) % 4],
                })
            })
            .collect()
    }

    #[test]
    fn round_trips_every_edge_kind_through_the_polygon_reader() {
        let edges = vec![
            edge(EdgeGeom::Line {
                start: [0.0, 0.0],
                end: [1.0, 0.0],
            }),
            edge(EdgeGeom::Arc {
                center: [0.0, 0.0],
                radius: 1.0,
                angle_start_deg: 0.0,
                angle_end_deg: 90.0,
                ccw: true,
                start: [1.0, 0.0],
                end: [0.0, 1.0],
            }),
            edge(EdgeGeom::EllipseArc {
                center: [0.0, 0.0],
                a: 2.0,
                b: 1.0,
                theta: 30.0,
                angle_start_deg: 0.0,
                angle_end_deg: 90.0,
                ccw: false,
                start: [2.0, 0.0],
                end: [0.0, 1.0],
            }),
            edge(EdgeGeom::Spline {
                start: [0.0, 0.0],
                c1: [1.0, 2.0],
                c2: [2.0, -1.0],
                end: [3.0, 1.0],
            }),
            edge(EdgeGeom::FitSpline {
                poles: vec![[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]],
                knots: vec![0.0, 3.0],
            }),
            LoopEdge {
                geom: EdgeGeom::Ellipse {
                    center: [1.0, 2.0],
                    a: 4.0,
                    b: 2.0,
                    theta: 0.0,
                },
                start: Some([5.0, 2.0]),
            },
        ];
        let bytes = encode(OP_LOOP_PTS, 3, None, std::slice::from_ref(&edges));
        let out = profile_loops_bytes(&bytes).unwrap();
        let pts = decode_points(&out);
        // The decoded loop must sample exactly like the in-memory one, including
        // the full ellipse's explicit start.
        assert_eq!(pts, loop_pts(&edges, 3));
        assert_eq!(pts[0], [0.0, 0.0]);
        assert!(pts.contains(&[5.0, 2.0]));
    }

    #[test]
    fn every_op_answers_a_well_formed_loop() {
        let loops = vec![square()];
        let area = profile_loops_bytes(&encode(OP_SIGNED_AREA, 1, None, &loops)).unwrap();
        let mut r = Reader::new(&area);
        assert_eq!(r.u32().unwrap(), MAGIC_OUT);
        assert_eq!(r.u8().unwrap(), VERSION);
        assert!((r.f64().unwrap() - 6.0).abs() < 1e-12);

        let bytes = encode(OP_POINT_IN_LOOP, 1, Some([1.0, 1.0]), &loops);
        let inside = profile_loops_bytes(&bytes).unwrap();
        assert_eq!(inside[5], 1);
        let bytes = encode(OP_POINT_IN_LOOP, 1, Some([3.0, 1.0]), &loops);
        let outside = profile_loops_bytes(&bytes).unwrap();
        assert_eq!(outside[5], 0);

        let centroid = profile_loops_bytes(&encode(OP_CENTROID, 0, None, &loops)).unwrap();
        let mut r = Reader::new(&centroid);
        r.u32().unwrap();
        r.u8().unwrap();
        assert!((r.f64().unwrap() - 1.0).abs() < 1e-9);
        assert!((r.f64().unwrap() - 1.5).abs() < 1e-9);

        let sub = profile_loops_bytes(&encode(OP_SUBDIVIDE, 0, None, &loops)).unwrap();
        let mut r = Reader::new(&sub);
        r.u32().unwrap();
        r.u8().unwrap();
        assert_eq!(r.u32().unwrap(), 1);
        assert_eq!(r.u32().unwrap(), 0);
        assert_eq!(r.u32().unwrap(), 0);
    }

    #[test]
    fn containment_reports_the_ts_sentinel_for_an_outer_loop() {
        let big: Vec<LoopEdge> = {
            let p = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
            (0..4)
                .map(|i| {
                    edge(EdgeGeom::Line {
                        start: p[i],
                        end: p[(i + 1) % 4],
                    })
                })
                .collect()
        };
        let small: Vec<LoopEdge> = {
            let p = [[3.0, 3.0], [6.0, 3.0], [6.0, 6.0], [3.0, 6.0]];
            (0..4)
                .map(|i| {
                    edge(EdgeGeom::Line {
                        start: p[i],
                        end: p[(i + 1) % 4],
                    })
                })
                .collect()
        };
        let out = profile_loops_bytes(&encode(OP_CONTAINMENT, 1, None, &[big, small])).unwrap();
        let mut r = Reader::new(&out);
        r.u32().unwrap();
        r.u8().unwrap();
        assert_eq!(r.u32().unwrap(), 2);
        assert_eq!(r.u32().unwrap(), 0);
        assert_eq!(r.u32().unwrap(), u32::MAX);
        assert_eq!(r.u32().unwrap(), 1);
        assert_eq!(r.u32().unwrap(), 0);
    }

    #[test]
    fn an_empty_loop_is_the_empty_polygon_not_an_error() {
        // The TS functions answered an empty loop with []/0/[0,0]/false; a
        // removed loop must not turn into a thrown host bug.
        let out = profile_loops_bytes(&encode(OP_LOOP_PTS, 1, None, &[])).unwrap();
        assert!(decode_points(&out).is_empty());
        let out = profile_loops_bytes(&encode(OP_SIGNED_AREA, 1, None, &[])).unwrap();
        let mut r = Reader::new(&out);
        r.u32().unwrap();
        r.u8().unwrap();
        assert_eq!(r.f64().unwrap(), 0.0);
        let out = profile_loops_bytes(&encode(OP_CENTROID, 0, None, &[])).unwrap();
        let mut r = Reader::new(&out);
        r.u32().unwrap();
        r.u8().unwrap();
        assert_eq!((r.f64().unwrap(), r.f64().unwrap()), (0.0, 0.0));
        let out = profile_loops_bytes(&encode(OP_POINT_IN_LOOP, 1, Some([1.0, 1.0]), &[])).unwrap();
        assert_eq!(out[5], 0);
    }

    #[test]
    fn malformed_buffers_are_errors_not_geometry() {
        assert_eq!(profile_loops_bytes(&[]), Err(WireError::Eof));
        let mut bytes = encode(OP_SIGNED_AREA, 1, None, &[square()]);
        bytes[0] = 0;
        assert_eq!(
            profile_loops_bytes(&bytes),
            Err(WireError::BadMagic(0x314c_5000))
        );
        let mut bytes = encode(OP_SIGNED_AREA, 1, None, &[square()]);
        bytes[4] = 9;
        assert_eq!(profile_loops_bytes(&bytes), Err(WireError::BadVersion(9)));
        let mut bytes = encode(OP_SIGNED_AREA, 1, None, &[square()]);
        bytes[5] = 99;
        assert_eq!(profile_loops_bytes(&bytes), Err(WireError::BadOp(99)));
        let mut bytes = encode(OP_SIGNED_AREA, 1, None, &[square()]);
        bytes.push(0);
        assert_eq!(profile_loops_bytes(&bytes), Err(WireError::Trailing(1)));
        let mut bytes = encode(OP_SIGNED_AREA, 1, None, &[square()]);
        bytes[18] = 7;
        assert_eq!(profile_loops_bytes(&bytes), Err(WireError::BadKind(7)));
    }
}
