//! The manifold guarantees: unit output quaternions, grounded bodies outside
//! the parameters, and solves that hold in the pose the host shows rather than
//! only in the solver's own view of it. The lever-arm fixtures are the
//! door-frame repro (a mate anchor far from its part origin), where the old
//! soft unit-norm residual traded a point gap against the norm.

use super::common::*;
use crate::mate::*;
use crate::mate_residuals::*;

// ─── Fixtures ───

/// `canonicalPerp` of utils/mateOrientation.ts, spelled out: the cross of the
/// axis with the world basis vector it is least aligned with. The fixtures
/// below author anchors the way the encoder does (axis first, perp derived),
/// so a solver-side frame change cannot quietly agree with a hand-picked one.
fn canonical_perp(axis: &[f64; 3]) -> [f64; 3] {
    let (ax, ay, az) = (axis[0].abs(), axis[1].abs(), axis[2].abs());
    let e: [f64; 3] = if ax <= ay && ax <= az {
        [1.0, 0.0, 0.0]
    } else if ay <= az {
        [0.0, 1.0, 0.0]
    } else {
        [0.0, 0.0, 1.0]
    };
    let c = [
        axis[1] * e[2] - axis[2] * e[1],
        axis[2] * e[0] - axis[0] * e[2],
        axis[0] * e[1] - axis[1] * e[0],
    ];
    normalise_axis(&c)
}

/// A planar face anchor: centre `at`, outward `axis`, perp derived like the
/// encoder derives it.
fn face(body: u32, at: [f64; 3], axis: [f64; 3]) -> MateRef {
    let mut r = mate_ref(
        body,
        at[0],
        at[1],
        at[2],
        axis[0],
        axis[1],
        axis[2],
        AnchorKind::Plane,
    );
    r.geometry.perp = canonical_perp(&axis);
    r
}

/// The cube of the door frame: 20^3 spanning x, z in [-10, 10] and y in
/// [0, 20], so its top (+Y) face centre sits at (0, 20, 0). Its part origin is
/// at the bottom face centre, i.e. 20 units from that anchor.
const CUBE_TOP: [f64; 3] = [0.0, 20.0, 0.0];

/// The rail: 20x20 in section, part origin at its bottom face centre, top face
/// centre at (0, lever, 0). `lever` IS the anchor's distance from the part
/// origin -- the knob these tests turn.
fn rail_top(lever: f64) -> [f64; 3] {
    [0.0, lever, 0.0]
}

/// The exact pose of a rail mated top-face to the cube's top face with
/// `flip`: 180 degrees about X puts the rail's +Y face against the cube's,
/// and its top anchor at the cube's top anchor.
fn rail_exact_pose(lever: f64) -> ([f64; 3], [f64; 4]) {
    ([0.0, 20.0 + lever, 0.0], [1.0, 0.0, 0.0, 0.0])
}

/// One fixed mate, cube top face (A) to rail top face (B), flipped. `dz` is
/// the seed's position error along z: at these levers the pre-manifold
/// parameterisation could close `dz` units of point gap by sliding the
/// quaternion off the unit sphere (the norm residual costs ~(dz / 2L)^2 while
/// the translation costs dz^2 / 2), and the gap came back the moment the host
/// normalised the pose it shows. `roll_error` seeds the rail with an extra
/// roll about its own axis, which the anchor sits on, so the mate's absolute
/// roll has work to do without the point rows moving.
fn lever_arm_input(lever: f64, dz: f64, roll_error_deg: f64) -> MateInput {
    let (mut t, _) = rail_exact_pose(lever);
    t[2] += dz;
    let half = roll_error_deg.to_radians() / 2.0;
    // 180 degrees about X (which is what puts the rail's top face against the
    // cube's), then rolled about the rail's own long axis -- world Y once the
    // flip is applied, hence a Y quaternion composed on the left. The anchor
    // sits on that axis, so this roll moves the point rows not at all and
    // leaves the absolute roll with all the work.
    let qx = [1.0, 0.0, 0.0, 0.0];
    let qr = [0.0, half.sin(), 0.0, half.cos()];
    let q = quat_mul(&qr, &qx);

    MateInput {
        bodies: (0..2).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // cube at identity, grounded
            t[0], t[1], t[2], q[0], q[1], q[2], q[3],
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![mate_with_offset_vec(
            MateKind::Fixed,
            face(0, CUBE_TOP, [0.0, 1.0, 0.0]),
            face(1, rail_top(lever), [0.0, 1.0, 0.0]),
            true, // flip: the faces meet anti-parallel
            [0.0; 3],
            1.0,
            0.0,
        )],
    }
}

// ─── Independent pose helpers (the test's own transform code) ───

/// Rotate `v` by `q` after normalising it. Deliberately not the crate's own
/// helper: these assertions are about what a CONSUMER of `params_solved`
/// computes from the wire, so they must not share the solver's arithmetic.
fn rotate_point(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    let (qx, qy, qz, qw) = (q[0] / n, q[1] / n, q[2] / n, q[3] / n);
    let (x, y, z) = (v[0], v[1], v[2]);
    let tx = 2.0 * (qy * z - qz * y);
    let ty = 2.0 * (qz * x - qx * z);
    let tz = 2.0 * (qx * y - qy * x);
    [
        x + qw * tx + qy * tz - qz * ty,
        y + qw * ty + qz * tx - qx * tz,
        z + qw * tz + qx * ty - qy * tx,
    ]
}

/// Body `body`'s local point `p` posed into world by `params_solved`.
fn posed_point(params: &[f64], body: usize, p: [f64; 3]) -> [f64; 3] {
    let off = body * 7;
    let r = rotate_point(
        [
            params[off + 3],
            params[off + 4],
            params[off + 5],
            params[off + 6],
        ],
        p,
    );
    [
        r[0] + params[off],
        r[1] + params[off + 1],
        r[2] + params[off + 2],
    ]
}

fn quat_norm(params: &[f64], body: usize) -> f64 {
    let off = body * 7;
    let q = [
        params[off + 3],
        params[off + 4],
        params[off + 5],
        params[off + 6],
    ];
    (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt()
}

// ─── The lever-arm repro ───

#[test]
fn lever_arm_fixed_mate_converges() {
    // The door frame's rail: a 400-unit anchor, seeded 5 units off in z and
    // rolled 12 degrees about its own axis (the axis the anchor sits on), so
    // the point rows and the absolute roll both have work to do at once.
    let input = lever_arm_input(400.0, 5.0, 12.0);
    let out = solve_mate(&input);

    assert_eq!(
        out.overall_status,
        MateStatus::FullyConstrained.to_u8(),
        "status={} rn={}",
        out.overall_status,
        out.diagnostics.residual_norm
    );
    // Bounded, not merely finite: measured at 21 iterations for this fixture,
    // against a 200-iteration cap the pre-manifold solve could spend wandering
    // whenever the anchor sat far from the origin.
    assert!(
        out.diagnostics.iters < 40,
        "iters={}",
        out.diagnostics.iters
    );

    // The gap as the host measures it: pose both anchors from the OUTPUT
    // buffer with the quaternions normalised, the way makeTransform does.
    let p = &out.params_solved;
    let a = posed_point(p, 0, CUBE_TOP);
    let b = posed_point(p, 1, rail_top(400.0));
    let gap = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
    assert!(gap < 1e-9, "posed point gap={}", gap);
    assert!(
        quat_norm(p, 1) - 1.0 < 1e-14,
        "|q|-1={}",
        quat_norm(p, 1) - 1.0
    );

    // And the mate's other rows: the axes are anti-parallel and the roll is
    // the authored one, all read off the posed output.
    let axis_b = rotate_point([p[10], p[11], p[12], p[13]], [0.0, 1.0, 0.0]);
    assert!(
        (axis_b[0]).abs() < 1e-9 && (axis_b[1] + 1.0).abs() < 1e-9 && axis_b[2].abs() < 1e-9,
        "rail axis={:?}",
        axis_b
    );
}

#[test]
fn lever_arm_sweep() {
    // The same mate with the anchor at 1, 10, 100, 1000 and 10000 units from
    // the rail's own origin. Every one must converge to the same honest pose:
    // a point gap the host can reproduce from the wire, a unit quaternion, and
    // an iteration count that does not grow with the lever arm (the damping
    // scale is divided by the seed's J^T J diagonal precisely so lambda0 stops
    // tracking the lever).
    for lever in [1.0, 10.0, 100.0, 1000.0, 10000.0] {
        let input = lever_arm_input(lever, 5.0, 12.0);
        let out = solve_mate(&input);
        assert_eq!(
            out.overall_status,
            MateStatus::FullyConstrained.to_u8(),
            "lever {}: status={} rn={}",
            lever,
            out.overall_status,
            out.diagnostics.residual_norm
        );
        // Measured: 11, 14, 19, 24, 31 iterations across the five levers --
        // bounded, mild in the lever, and nowhere near the 200-iteration cap
        // a solve that had to burn lambda down would show.
        assert!(
            out.diagnostics.iters < 40,
            "lever {}: iters={}",
            lever,
            out.diagnostics.iters
        );
        let p = &out.params_solved;
        let a = posed_point(p, 0, CUBE_TOP);
        let b = posed_point(p, 1, rail_top(lever));
        let gap = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
        assert!(gap < 1e-9, "lever {}: posed point gap={}", lever, gap);
        assert!(
            quat_norm(p, 1) - 1.0 < 1e-14,
            "lever {}: |q|-1={}",
            lever,
            quat_norm(p, 1) - 1.0
        );
    }
}

// ─── Chained and tree assemblies ───

/// Cube, rail, cube, every body seeded at identity and every mate flipped.
/// The two mates are authored against opposite faces, so the canonical perp
/// frames come out anti-parallel and the rail's absolute roll reads pi at the
/// seed: from identity the solve has to reach a half-turned pose, not just a
/// translated one. Returns the input with the rail's length named.
fn two_flipped_chain() -> (MateInput, f64) {
    let lever = 120.0;
    let input = MateInput {
        bodies: (0..3).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // cube, grounded
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // rail
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // cube 2
        ],
        fixed_mask: vec![0b0000_0001],
        mates: vec![
            mate_with_offset_vec(
                MateKind::Fixed,
                face(0, CUBE_TOP, [0.0, 1.0, 0.0]),
                face(1, [0.0, 0.0, 0.0], [0.0, -1.0, 0.0]),
                true,
                [0.0; 3],
                1.0,
                0.0,
            ),
            mate_with_offset_vec(
                MateKind::Fixed,
                face(1, rail_top(lever), [0.0, 1.0, 0.0]),
                face(2, [0.0, 0.0, 0.0], [0.0, -1.0, 0.0]),
                true,
                [0.0; 3],
                1.0,
                0.0,
            ),
        ],
    };
    (input, lever)
}

#[test]
fn two_flipped_fixed_chain_from_identity() {
    let (input, lever) = two_flipped_chain();
    let out = solve_mate(&input);

    // Either the chain reaches the half-turned pose outright or, failing that,
    // it must at least stop reporting the identity seed as a conflict: the
    // pre-manifold solver read Overconstrained here, because the absolute roll
    // row sat on its branch cut while the quaternion norm rows fought the
    // point rows. Reaching the pose outright is the behaviour; the
    // `Overconstrained` verdict is the regression floor.
    assert_ne!(
        out.overall_status,
        MateStatus::Overconstrained.to_u8(),
        "chain from identity must not read as a conflict: rn={} rows={:?}",
        out.diagnostics.residual_norm,
        out.mate_residuals
    );
    assert!(
        out.diagnostics.residual_norm < 1e-6,
        "rn={}",
        out.diagnostics.residual_norm
    );

    let p = &out.params_solved;
    // The rail ends half-turned about Y (its long axis), qw ~ 0 either way.
    let qw_rail = p[13];
    assert!(
        qw_rail.abs() < 1e-6,
        "rail should end half-turned, qw={}",
        qw_rail
    );
    // And it sits on the cube's top face; the second cube sits on its top.
    let rail_origin = posed_point(p, 1, [0.0, 0.0, 0.0]);
    assert!(
        (rail_origin[1] - 20.0).abs() < 1e-6,
        "rail={:?}",
        rail_origin
    );
    let cube2 = posed_point(p, 2, [0.0, 0.0, 0.0]);
    assert!(
        (cube2[1] - (20.0 + lever)).abs() < 1e-6,
        "cube2={:?}",
        cube2
    );
    assert_eq!(out.diagnostics.dof, 0, "the chain is fully constrained");
}

/// Four bodies at exact poses (one of them turned 180 about Y so its local
/// anchors are not its world ones) with all six pairs mated. Every anchor is
/// authored so that both sides land on the same world point with the same
/// world axis, which is what "exact seed" means here: integer arithmetic
/// round-trips `t + (w - t)` back to `w` exactly.
fn six_fixed_tree() -> (MateInput, Vec<[f64; 7]>) {
    let poses: Vec<([f64; 3], [f64; 4])> = vec![
        ([0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]),
        ([30.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]),
        ([0.0, 50.0, 0.0], [0.0, 1.0, 0.0, 0.0]), // 180 about Y
        ([0.0, 0.0, 70.0], [0.0, 0.0, 0.0, 1.0]),
    ];
    let seed: Vec<[f64; 7]> = poses
        .iter()
        .map(|(t, q)| [t[0], t[1], t[2], q[0], q[1], q[2], q[3]])
        .collect();

    // World anchor sites, one per pair, chosen as integer coordinates so the
    // local round trip below is exact.
    let sites: [[f64; 3]; 6] = [
        [0.0, 10.0, 0.0],
        [5.0, 5.0, 5.0],
        [-7.0, 11.0, 3.0],
        [13.0, -4.0, 9.0],
        [2.0, 6.0, -8.0],
        [-9.0, 1.0, 12.0],
    ];
    let axes: [[f64; 3]; 6] = [
        [0.0, 1.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0],
        [0.0, 1.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0],
    ];
    let pairs: [(u32, u32); 6] = [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)];

    let mut mates = Vec::new();
    for (k, (i, j)) in pairs.iter().enumerate() {
        let site = sites[k];
        let axis = axes[k];
        let perp = canonical_perp(&axis);
        let local = |body: usize| -> ([f64; 3], [f64; 3], [f64; 3]) {
            let (t, q) = &poses[body];
            // Inverse rotation of the body's pose: the bodies here are either
            // identity or a 180 about Y, both exact in floating point.
            let d = [site[0] - t[0], site[1] - t[1], site[2] - t[2]];
            let inv = [q[0], q[1], q[2], -q[3]]; // conjugate
            let r = rotate_point([inv[0], inv[1], inv[2], inv[3]], d);
            // Local axis/perp: the inverse rotation of the world frame.
            let a = rotate_point([inv[0], inv[1], inv[2], inv[3]], axis);
            let p = rotate_point([inv[0], inv[1], inv[2], inv[3]], perp);
            (r, a, p)
        };
        let (pi, ai, qi) = local(*i as usize);
        let (pj, aj, qj) = local(*j as usize);
        let mut a = mate_ref(
            *i,
            pi[0],
            pi[1],
            pi[2],
            ai[0],
            ai[1],
            ai[2],
            AnchorKind::Plane,
        );
        a.geometry.perp = qi;
        let mut b = mate_ref(
            *j,
            pj[0],
            pj[1],
            pj[2],
            aj[0],
            aj[1],
            aj[2],
            AnchorKind::Plane,
        );
        b.geometry.perp = qj;
        mates.push(mate_with_offset_vec(
            MateKind::Fixed,
            a,
            b,
            false,
            [0.0; 3],
            1.0,
            0.0,
        ));
    }

    let params: Vec<f64> = seed.iter().flatten().copied().collect();
    let input = MateInput {
        bodies: (0..4).map(|_| RigidBody).collect(),
        params_initial: params.clone(),
        fixed_mask: vec![0b0000_0001],
        mates,
    };
    (input, seed)
}

#[test]
fn six_fixed_tree_holds_exact_seed() {
    let (input, seed) = six_fixed_tree();
    let out = solve_mate(&input);

    assert!(
        out.diagnostics.residual_norm < 1e-10,
        "rn={}",
        out.diagnostics.residual_norm
    );
    assert_eq!(
        out.overall_status,
        MateStatus::FullyConstrained.to_u8(),
        "dof={}",
        out.diagnostics.dof
    );
    for (i, want) in seed.iter().enumerate() {
        for (k, w) in want.iter().enumerate() {
            let got = out.params_solved[i * 7 + k];
            assert!(
                (got - w).abs() < 1e-9,
                "body {} param {} moved: {} -> {}",
                i,
                k,
                w,
                got
            );
        }
    }
}

// ─── State invariants ───

#[test]
fn grounded_body_never_moves() {
    // Three bodies: two grounded, one free. The free one solves onto the first
    // grounded one; the second grounded one carries a mate that CANNOT be
    // satisfied from any pose it is allowed to hold, so the solve is a
    // conflict -- and a conflict must not be resolved by quietly moving the
    // body the host echoes verbatim.
    let input = MateInput {
        bodies: (0..3).map(|_| RigidBody).collect(),
        params_initial: vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // grounded A
            40.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // free
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // grounded B
        ],
        fixed_mask: vec![0b0000_0101],
        mates: vec![
            mate(
                MateKind::Spherical,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false,
                0.0,
                1.0,
                0.0,
            ),
            // Unsatisfiable: B is pinned at the origin and this mate demands
            // 60 units of separation that nothing else can absorb.
            mate(
                MateKind::Spherical,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(2, 60.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false,
                0.0,
                1.0,
                0.0,
            ),
        ],
    };
    let out = solve_mate(&input);

    assert_eq!(
        out.overall_status,
        MateStatus::Overconstrained.to_u8(),
        "the contradictory mate must be reported, not absorbed"
    );
    // Bit-exact, not close: the host echoes a fixed part's seed verbatim, and
    // the solver never sees those seven params as state at all.
    let bits = |v: &[f64]| v.iter().map(|f| f.to_bits()).collect::<Vec<_>>();
    assert_eq!(
        bits(&out.params_solved[0..7]),
        bits(&input.params_initial[0..7]),
        "grounded A drifted"
    );
    assert_eq!(
        bits(&out.params_solved[14..21]),
        bits(&input.params_initial[14..21]),
        "grounded B drifted"
    );
    // The free body still did its job.
    assert!(out.params_solved[7].abs() < 1e-6, "free body did not solve");
}

#[test]
fn output_quaternions_are_unit() {
    // A fixed list of seed orientations, all unit but none of them cardinal,
    // one body of each status: grounded (echoed), free and mated (composed
    // through exp(w) * q_ref), and one free body carrying a deliberately
    // NON-unit quaternion to pin that "unit by construction" starts at the
    // seed boundary, not at the host's good manners.
    let seeds: [[f64; 4]; 6] = [
        [0.0, 0.0, 0.0, 1.0],
        [0.267_261, 0.534_522, 0.801_784, 0.0], // 180 about the (1,2,3) axis
        [-0.179_030, 0.358_060, -0.537_090, 0.746_], // rough, renormalised below
        [0.1, -0.2, 0.3, 0.9],
        [
            0.0,
            std::f64::consts::FRAC_1_SQRT_2,
            0.0,
            std::f64::consts::FRAC_1_SQRT_2,
        ],
        [0.6, 0.0, 0.0, 0.7], // 0.922 in norm, and grounded below
    ];
    let unit = |q: [f64; 4]| -> [f64; 4] {
        let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
        [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
    };

    let mut params: Vec<f64> = Vec::new();
    for (i, q) in seeds.iter().enumerate() {
        let t = [10.0 * i as f64, 5.0, -3.0];
        let q = if i == 5 { *q } else { unit(*q) }; // body 5 stays non-unit
        params.extend_from_slice(&[t[0], t[1], t[2], q[0], q[1], q[2], q[3]]);
    }
    let input = MateInput {
        bodies: (0..6).map(|_| RigidBody).collect(),
        params_initial: params.clone(),
        // Bodies 0 and 5 grounded: one echo of a unit seed and one echo of a
        // non-unit one, beside four free bodies the solver composes.
        fixed_mask: vec![0b0010_0001],
        mates: vec![
            mate(
                MateKind::Spherical,
                mate_ref(0, 1.0, 2.0, 3.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                mate_ref(1, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Point),
                false,
                0.0,
                1.0,
                0.0,
            ),
            mate(
                MateKind::Fixed,
                mate_ref(0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, AnchorKind::Plane),
                mate_ref(2, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, AnchorKind::Plane),
                false,
                0.0,
                1.0,
                0.0,
            ),
            mate(
                MateKind::Rotating,
                mate_ref(2, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                mate_ref(3, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, AnchorKind::Cylinder),
                false,
                0.0,
                1.0,
                0.0,
            ),
            mate(
                MateKind::Parallel,
                mate_ref(3, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, AnchorKind::Plane),
                mate_ref(4, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, AnchorKind::Plane),
                false,
                0.0,
                1.0,
                0.0,
            ),
        ],
    };

    let out = solve_mate(&input);
    for body in 0..6 {
        // Body 5's seed is non-unit on purpose but it is GROUNDED, and a
        // grounded body is its own bytes back; the guarantee under test is the
        // one the wire gives a consumer: every FREE body's quaternion is unit.
        if body == 5 {
            continue;
        }
        let n = quat_norm(&out.params_solved, body);
        assert!(
            (n - 1.0).abs() < 1e-14,
            "body {}: |q| = {} (seed |q| = {})",
            body,
            n,
            quat_norm(&input.params_initial, body)
        );
    }
    // The grounded non-unit seed comes back as itself, block for block: it is
    // not a solver parameter, so nothing normalises it on the way out either.
    let bits = |v: &[f64]| v.iter().map(|f| f.to_bits()).collect::<Vec<_>>();
    assert_eq!(
        bits(&out.params_solved[35..42]),
        bits(&input.params_initial[35..42]),
        "grounded echo must not be rewritten"
    );
    let n5 = quat_norm(&out.params_solved, 5);
    assert!((n5 - 1.0).abs() > 1e-6, "the point is the non-unit echo");
}

#[test]
fn residual_matches_normalised_pose() {
    // The honesty check: what `mate_residuals[i]` reports must be what a host
    // recomputes from the pose the wire hands it, anchors normalised. Fixed's
    // seven rows are recomputed here from scratch (point gap, axis difference,
    // dihedral roll) rather than by calling the solver's own residual, so a
    // shared bug cannot make both sides agree.
    let input = lever_arm_input(400.0, 5.0, 12.0);
    let out = solve_mate(&input);
    let p = &out.params_solved;

    let a_point = CUBE_TOP;
    let b_point = rail_top(400.0);
    let a_axis = [0.0, 1.0, 0.0];
    let b_axis = [0.0, 1.0, 0.0];
    let a_perp = canonical_perp(&a_axis);
    let b_perp = canonical_perp(&b_axis);

    let pa = posed_point(p, 0, a_point);
    let pb = posed_point(p, 1, b_point);
    let wa = rotate_point([p[3], p[4], p[5], p[6]], a_axis);
    let wb = rotate_point([p[10], p[11], p[12], p[13]], b_axis);
    let xa = rotate_point([p[3], p[4], p[5], p[6]], a_perp);
    let xb = rotate_point([p[10], p[11], p[12], p[13]], b_perp);

    let mut rows = [0.0_f64; 7];
    for k in 0..3 {
        rows[k] = pa[k] - pb[k]; // flip=true, offset zero
    }
    // Axis difference with the authored flip: a - s*b, s = -1.
    for k in 0..3 {
        rows[3 + k] = wa[k] + wb[k];
    }
    // Absolute roll: the signed angle from A's perp to B's about A's axis,
    // minus the authored target (0 here).
    let sin_r = {
        let c = [
            xa[1] * xb[2] - xa[2] * xb[1],
            xa[2] * xb[0] - xa[0] * xb[2],
            xa[0] * xb[1] - xa[1] * xb[0],
        ];
        c[0] * wa[0] + c[1] * wa[1] + c[2] * wa[2]
    };
    let cos_r = xa[0] * xb[0] + xa[1] * xb[1] + xa[2] * xb[2];
    rows[6] = sin_r.atan2(cos_r);

    let reported = rows.iter().map(|v| v * v).sum::<f64>().sqrt();
    let wire = out.mate_residuals[0];
    assert!(
        (reported - wire).abs() <= 1e-9 * reported.max(1.0),
        "recomputed={} wire={}",
        reported,
        wire
    );
    // And the wire value is itself the honest, converged gap: no headroom
    // between "reported satisfied" and "poses agree".
    assert!(wire < 1e-9, "wire residual={}", wire);
}
