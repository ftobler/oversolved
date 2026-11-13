use super::*;
use crate::constraints::{Constraint, ConstraintKind, PointSelector, Ref, RefRole};
use crate::test_util::*;
use crate::{EqualityPin, Kind, Options, Output, Status};

#[test]
fn stale_entity_ref_solves_instead_of_panicking() {
    // The whole status pass runs over an input carrying a constraint on a
    // non-existent entity: the solve completes and simply ignores it.
    let inp = input(
        vec![line(0)],
        vec![0.0, 0.0, 10.0, 1.0],
        vec![c_target(
            ConstraintKind::Horizontal,
            7,
            PointSelector::Absent,
        )],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    assert_eq!(out.entity_status.len(), 1);
}

#[test]
fn entity_whose_param_block_overruns_the_buffer_solves() {
    // Second entity claims params 4..8 of a 4-param buffer. Both the
    // per-entity pinning pass and the vertex-freedom pass must skip it.
    let inp = input(vec![line(0), line(4)], vec![0.0, 0.0, 10.0, 1.0], vec![]);
    let out = solve_sketch(&inp);
    assert_eq!(out.entity_status.len(), 2);
    assert_eq!(out.entity_status[1], Status::Underconstrained.to_u8());
    assert_eq!(out.vertex_freedom.len(), 4);
}

#[test]
fn entity_with_overflowing_param_offset_takes_the_out_of_range_path() {
    // The codec decodes a stale param_offset verbatim, so one far past
    // the param buffer can arrive. usize::MAX scale makes `offset + size`
    // overflow on every target width, so the guard path here is a real
    // regression detector on 64-bit native CI too, not just wasm32.
    let inp = input(
        vec![line(0), ent(Kind::Line, usize::MAX)],
        vec![0.0, 0.0, 10.0, 1.0],
        vec![c_target(
            ConstraintKind::Horizontal,
            0,
            PointSelector::Absent,
        )],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    assert_eq!(out.entity_status.len(), 2);
    // Same absent status a neighboring past-the-buffer entity reports.
    assert_eq!(out.entity_status[1], Status::Underconstrained.to_u8());
    assert_eq!(out.vertex_freedom.len(), 4);
    assert_eq!(&out.vertex_freedom[2..], &[0.0, 0.0]);
}

#[test]
fn vertex_freedom_skips_entity_whose_offset_wraps_the_bounds_check() {
    // Line 0 carries the free DOF so a null-space column exists; the
    // stale-offset line (usize::MAX scale, overflowing on every width)
    // must not wrap `off + 1` into a passing bounds check and slice the
    // eigenvector far out of range.
    let inp = input(
        vec![line(0), ent(Kind::Line, usize::MAX)],
        vec![0.0, 0.0, 10.0, 1.0],
        vec![c_target(
            ConstraintKind::Horizontal,
            0,
            PointSelector::Absent,
        )],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    // Freedom pair emitted for the real line, (0, 0) left for the stale one.
    assert_eq!(out.vertex_freedom.len(), 4);
    assert_eq!(&out.vertex_freedom[2..], &[0.0, 0.0]);
}

#[test]
fn drag_anchor_with_overflowing_offset_leaves_base_weights() {
    // A verbatim stale anchor offset must not wrap through
    // `offset + count` and bump arbitrary weights; it just gets no firmer
    // pull, like any other out-of-range anchor block.
    let inp = Input {
        options: Options {
            drag_anchor_id: 1,
            ..Default::default()
        },
        ..input(
            vec![line(0), ent(Kind::Line, usize::MAX)],
            vec![0.0; 4],
            vec![],
        )
    };
    let w = drag_reg_weights(&inp, 4);
    assert_eq!(w, vec![REG_WEIGHT_BASE; 4]);
}

#[test]
fn line_end_reaches_a_far_fixed_arc_end_exactly() {
    // A fixed r=2000 arc and a line whose start must sit on the arc end,
    // seeded ~2000 away. The old seed anchor stopped this at a 5e-3 gap
    // (degree-param columns inflate its weight with r^2) and still called
    // the sketch satisfied.
    let fixed_arc = c_target(ConstraintKind::Fixed, 0, PointSelector::Absent);
    let joint = Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: ab(e_ref(1, PointSelector::Start), e_ref(0, PointSelector::End)),
        ..Default::default()
    };
    let inp = input(
        vec![ent(Kind::Arc, 0), line(5)],
        vec![13.7, -4.2, 2000.0, 3.0, 91.0, 0.0, 0.0, 50.0, 50.0],
        vec![fixed_arc, joint],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    assert!(
        out.diagnostics.residual_norm < 1e-8,
        "coincidence left open by {}",
        out.diagnostics.residual_norm
    );
}

/// Eight lines, each parallel to the previous one, of length `10 s` and
/// with its start `s` from the previous start; line 0 fixed. Satisfiable
/// at every scale `s`.
fn parallel_chain(s: f64) -> Input {
    let mut entities = vec![];
    let mut params = vec![];
    let mut constraints = vec![c_target(ConstraintKind::Fixed, 0, PointSelector::Absent)];
    for k in 0..8u32 {
        let (kf, y) = (k as f64, k as f64 * 1.1);
        entities.push(line(4 * k as usize));
        params.extend([0.1 * kf * s, y * s, (10.0 + 0.3 * kf) * s, (y + 0.5) * s]);
        if k > 0 {
            let pair = ab(
                e_ref(k - 1, PointSelector::Absent),
                e_ref(k, PointSelector::Absent),
            );
            constraints.push(cons(ConstraintKind::Parallel, pair));
            let mut len = c_target(ConstraintKind::Length, k, PointSelector::Absent);
            len.value = Some(10.0 * s);
            constraints.push(len);
            let starts = ab(
                e_ref(k - 1, PointSelector::Start),
                e_ref(k, PointSelector::Start),
            );
            constraints.push(cons_v(ConstraintKind::PointDistance, starts, s));
        }
    }
    input(entities, params, constraints)
}

#[test]
fn a_satisfiable_chain_solves_at_every_scale() {
    // The raw cross-product parallel row weighed length squared against
    // the length rows: this chain solved at s=0.01 and read
    // Overconstrained after 200 iterations at s=1 and s=100.
    for s in [0.01f64, 1.0, 100.0] {
        let out = solve_sketch(&parallel_chain(s));
        assert_eq!(
            out.overall_status,
            Status::Underconstrained.to_u8(),
            "s={s}: norm {} after {} iterations",
            out.diagnostics.residual_norm,
            out.diagnostics.iters
        );
        assert!(
            out.diagnostics.residual_norm < 1e-6 * s,
            "s={s}: norm {}",
            out.diagnostics.residual_norm
        );
    }
}

#[test]
fn a_small_sketch_with_a_four_percent_conflict_is_overconstrained() {
    // Length 0.1 and 0.104 on one line, about 0.1 wide: the least-squares
    // compromise misses by ~3e-3. The absolute verdict (norm up to 1e-2)
    // called that satisfied; relative to the sketch it is a 4% conflict.
    let mut fixed_start = c_target(ConstraintKind::Fixed, 0, PointSelector::Start);
    fixed_start.xy = Some((0.0, 0.0));
    let mut short = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
    short.value = Some(0.1);
    let mut long = short.clone();
    long.value = Some(0.104);
    let inp = input(
        vec![line(0)],
        vec![0.0, 0.0, 0.1, 0.0],
        vec![fixed_start, short, long],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
}

#[test]
fn a_user_typeable_conflict_at_a_metre_scale_is_overconstrained() {
    // The verdict is relative (tolerance::verdict_tol: 1e8 resolutions of
    // the sketch scale), so the question is whether the smallest conflict a
    // user can type disappears into the width at the top of the scale
    // range. A 1 m line drawn as 1000.0 and dimensioned 1000.01 disagrees
    // by 0.01: the least-squares compromise misses each length row by
    // ~0.005, against the 1e-4 verdict width of a scale-1000 sketch. The
    // conflict stays visible, and the same sketch with the conflict spelled
    // away stays satisfied, so the width is not hiding a real disagreement.
    let metre = |len: f64| {
        let fixed_start = c_target(ConstraintKind::Fixed, 0, PointSelector::Start);
        let mut first = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
        first.value = Some(1000.0);
        let mut second = first.clone();
        second.value = Some(len);
        input(
            vec![line(0)],
            vec![0.0, 0.0, 1000.0, 0.0],
            vec![fixed_start, first, second],
        )
    };
    let out = solve_sketch(&metre(1000.01));
    assert_eq!(
        out.overall_status,
        Status::Overconstrained.to_u8(),
        "0.01 mm of conflict on a 1 m sketch must not read as satisfied"
    );
    assert!(
        out.diagnostics.residual_norm > 50.0 * verdict_tol(1000.0),
        "the compromise must measure well past the width: {}",
        out.diagnostics.residual_norm
    );
    assert_eq!(
        solve_sketch(&metre(1000.0)).overall_status,
        Status::Underconstrained.to_u8(),
        "the satisfiable spelling of the same sketch stays satisfied"
    );
}

#[test]
fn entity_status_marks_only_the_entities_with_free_params() {
    // Line 0 fixed; line 1 hangs off its end by one coincident (free to
    // swing and stretch); line 2 fixed too. Fewer rows (4 + 2 + 4) than
    // params (12), so the null space only shows up whole because the
    // Jacobian is padded square before the thin SVD.
    let joint = Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: ab(e_ref(1, PointSelector::Start), e_ref(0, PointSelector::End)),
        ..Default::default()
    };
    let inp = input(
        vec![line(0), line(4), line(8)],
        vec![0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 2.0, 1.0, 5.0, 5.0, 6.0, 5.0],
        vec![
            c_target(ConstraintKind::Fixed, 0, PointSelector::Absent),
            joint,
            c_target(ConstraintKind::Fixed, 2, PointSelector::Absent),
        ],
    );
    let out = solve_sketch(&inp);
    let (full, under) = (
        Status::FullyConstrained.to_u8(),
        Status::Underconstrained.to_u8(),
    );
    assert_eq!(out.entity_status, vec![full, under, full]);
    assert_eq!(out.diagnostics.dof, 2);
    // The freedom direction moves line 1's start not at all (it is pinned
    // to line 0) and the fixed lines not at all.
    assert_eq!(&out.vertex_freedom[0..4], &[0.0, 0.0, 0.0, 0.0]);
    assert_eq!(&out.vertex_freedom[4..6], &[0.0, 0.0]);
}

#[test]
fn free_line_is_underconstrained() {
    let inp = input(vec![line(0)], vec![0.0, 0.0, 10.0, 1.0], vec![]);
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    assert_eq!(out.entity_status, vec![Status::Underconstrained.to_u8()]);
}

#[test]
fn fixed_horizontal_length_line_converges_and_is_fully_constrained() {
    // Start fixed at (0,0); horizontal; length 10. Seeded slightly off.
    let mut fixed_start = c_target(ConstraintKind::Fixed, 0, PointSelector::Start);
    fixed_start.xy = Some((0.0, 0.0));
    let mut length = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
    length.value = Some(10.0);
    let horizontal = c_target(ConstraintKind::Horizontal, 0, PointSelector::Absent);

    let inp = input(
        vec![line(0)],
        vec![0.2, -0.1, 9.5, 0.8],
        vec![fixed_start, horizontal, length],
    );
    let out = solve_sketch(&inp);

    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    let p = &out.params_solved;
    // start pinned at origin
    assert!(
        p[0].abs() < 1e-4 && p[1].abs() < 1e-4,
        "start {:?}",
        &p[0..2]
    );
    // horizontal -> end.y == 0, length 10 -> end.x ~ 10 (from the +x seed)
    assert!((p[2] - 10.0).abs() < 1e-3, "end.x {}", p[2]);
    assert!(p[3].abs() < 1e-3, "end.y {}", p[3]);
    assert!(out.diagnostics.residual_norm < 1e-5);
}

#[test]
fn line_pinned_at_origin_with_length_but_no_orientation_is_underconstrained() {
    // Regression: start pinned at the origin and length fixed, but the line
    // is still free to rotate about that pinned point. That rotation is a
    // real, removable DOF (a horizontal/angle constraint would take it), so
    // the sketch is NOT fully constrained. The old rigid-body-DOF allowance
    // wrongly forgave this one DOF and reported FullyConstrained.
    let mut fixed_start = c_target(ConstraintKind::Fixed, 0, PointSelector::Start);
    fixed_start.xy = Some((0.0, 0.0));
    let mut length = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
    length.value = Some(10.0);

    let inp = input(
        vec![line(0)],
        vec![0.0, 0.0, 9.0, 1.0],
        vec![fixed_start, length],
    );
    let out = solve_sketch(&inp);

    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    assert_eq!(out.entity_status, vec![Status::Underconstrained.to_u8()]);
    // One free DOF remains (the rotation): rank 3 of 4 params.
    assert_eq!(out.diagnostics.dof, 1);
}

#[test]
fn pinned_mask_holds_point_and_reports_fully_constrained() {
    let mut inp = input(vec![point(0)], vec![2.0, 3.0], vec![]);
    // Pin both params at their initial values.
    inp.pinned_mask = vec![0b11];
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    assert!((out.params_solved[0] - 2.0).abs() < 1e-5);
    assert!((out.params_solved[1] - 3.0).abs() < 1e-5);
}

#[test]
fn equality_pins_move_point_to_target() {
    let mut inp = input(vec![point(0)], vec![0.0, 0.0], vec![]);
    inp.equality_pins = vec![
        EqualityPin {
            param_index: 0,
            target: 5.0,
        },
        EqualityPin {
            param_index: 1,
            target: -4.0,
        },
    ];
    let out = solve_sketch(&inp);
    assert!(
        (out.params_solved[0] - 5.0).abs() < 1e-4,
        "x {}",
        out.params_solved[0]
    );
    assert!(
        (out.params_solved[1] - (-4.0)).abs() < 1e-4,
        "y {}",
        out.params_solved[1]
    );
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
}

#[test]
fn skip_status_pass_omits_status_and_freedom() {
    let inp = Input {
        options: Options {
            skip_status_pass: true,
            ..Default::default()
        },
        ..input(vec![line(0)], vec![0.0, 0.0, 10.0, 1.0], vec![])
    };
    let out = solve_sketch(&inp);
    assert!(out.entity_status.is_empty());
    assert!(out.vertex_freedom.is_empty());
}

#[test]
fn coincident_endpoints_form_solvable_triangle_corner() {
    // Two lines; end of line A coincident with start of line B; both pinned
    // at their far ends. Exercises coincident point-point through the solver.
    let mut fix_a = c_target(ConstraintKind::Fixed, 0, PointSelector::Start);
    fix_a.xy = Some((0.0, 0.0));
    let mut fix_b = c_target(ConstraintKind::Fixed, 1, PointSelector::End);
    fix_b.xy = Some((10.0, 0.0));
    let coincident = Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: vec![
            (
                RefRole::A,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::End,
                },
            ),
            (
                RefRole::B,
                Ref::Entity {
                    index: 1,
                    point: PointSelector::Start,
                },
            ),
        ],
        ..Default::default()
    };
    let inp = input(
        vec![line(0), line(4)],
        vec![0.0, 0.0, 4.0, 5.0, 4.2, 4.8, 10.0, 0.0],
        vec![fix_a, fix_b, coincident],
    );
    let out = solve_sketch(&inp);
    // line A end == line B start after solve
    let p = &out.params_solved;
    assert!((p[2] - p[4]).abs() < 1e-4, "x meet {} vs {}", p[2], p[4]);
    assert!((p[3] - p[5]).abs() < 1e-4, "y meet {} vs {}", p[3], p[5]);
    assert!(out.diagnostics.residual_norm < 1e-4);
}

#[test]
fn point_on_fixed_ellipse_is_fully_constrained() {
    // Ellipse [0,0,4,2,0] pinned whole; a point pinned in x at 3 and forced
    // onto the ellipse by a point-on-ellipse coincident. The point's y is the
    // only free DOF and the conic determines it -> fully constrained, and the
    // point lands on the curve at y = sqrt(b^2 (1 - x^2/a^2)) = sqrt(1.75).
    let fix_ellipse = c_target(ConstraintKind::Fixed, 0, PointSelector::Absent);
    let on_ellipse = Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: vec![
            (
                RefRole::A,
                Ref::Entity {
                    index: 1,
                    point: PointSelector::Xy,
                },
            ),
            (
                RefRole::B,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Absent,
                },
            ),
        ],
        ..Default::default()
    };
    let mut inp = input(
        vec![ellipse(0), point(5)],
        vec![0.0, 0.0, 4.0, 2.0, 0.0, 3.0, 1.0],
        vec![fix_ellipse, on_ellipse],
    );
    inp.equality_pins = vec![EqualityPin {
        param_index: 5,
        target: 3.0,
    }];

    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    let p = &out.params_solved;
    assert!((p[5] - 3.0).abs() < 1e-4, "x pinned: {}", p[5]);
    assert!(
        (p[6] - 1.75_f64.sqrt()).abs() < 1e-3,
        "y on ellipse: {}",
        p[6]
    );
    assert!(out.diagnostics.residual_norm < 1e-4);
}

#[test]
fn point_on_rotated_ellipse_lands_on_the_curve() {
    // Ellipse [0,0,4,2,90] (major axis along +y after the 90deg rotation),
    // pinned whole. A point pinned in x at 1 and forced onto the ellipse: the
    // solved y must satisfy the conic in the rotated frame. With theta=90 the
    // frame swaps axes, so the conic is x^2/b^2 + y^2/a^2 = 1 -> at x=1,
    // y = a*sqrt(1 - x^2/b^2) = 4*sqrt(1 - 1/4) = 4*sqrt(3)/2 = 2*sqrt(3).
    let fix_ellipse = c_target(ConstraintKind::Fixed, 0, PointSelector::Absent);
    let on_ellipse = Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: vec![
            (
                RefRole::A,
                Ref::Entity {
                    index: 1,
                    point: PointSelector::Xy,
                },
            ),
            (
                RefRole::B,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Absent,
                },
            ),
        ],
        ..Default::default()
    };
    let mut inp = input(
        vec![ellipse(0), point(5)],
        vec![0.0, 0.0, 4.0, 2.0, 90.0, 1.0, 1.0],
        vec![fix_ellipse, on_ellipse],
    );
    inp.equality_pins = vec![EqualityPin {
        param_index: 5,
        target: 1.0,
    }];

    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    let p = &out.params_solved;
    assert!((p[5] - 1.0).abs() < 1e-4, "x pinned: {}", p[5]);
    assert!(
        (p[6] - 2.0 * 3.0_f64.sqrt()).abs() < 1e-3,
        "y on rotated ellipse: {}",
        p[6]
    );
    assert!(out.diagnostics.residual_norm < 1e-4);
}

#[test]
fn point_on_fixed_spline_lands_on_the_curve() {
    // Symmetric arch Bezier P1(0,0) P2(0,3) P3(3,3) P4(3,0), pinned whole.
    // Its apex is B(0.5)=(1.5,2.25) with a horizontal tangent. A point pinned
    // in x at 1.5 and forced onto the spline has y as the only free DOF; the
    // perpendicular-distance residual drives it to the apex -> fully
    // constrained, y = 2.25.
    let fix_spline = c_target(ConstraintKind::Fixed, 0, PointSelector::Absent);
    let on_spline = Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: vec![
            (
                RefRole::A,
                Ref::Entity {
                    index: 1,
                    point: PointSelector::Xy,
                },
            ),
            (
                RefRole::B,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Absent,
                },
            ),
        ],
        ..Default::default()
    };
    let mut inp = input(
        vec![spline(0), point(8)],
        vec![0.0, 0.0, 0.0, 3.0, 3.0, 3.0, 3.0, 0.0, 1.5, 1.0],
        vec![fix_spline, on_spline],
    );
    inp.equality_pins = vec![EqualityPin {
        param_index: 8,
        target: 1.5,
    }];

    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    let p = &out.params_solved;
    assert!((p[8] - 1.5).abs() < 1e-4, "x pinned: {}", p[8]);
    assert!((p[9] - 2.25).abs() < 1e-3, "y on spline apex: {}", p[9]);
    assert!(out.diagnostics.residual_norm < 1e-4);
}

#[test]
fn point_distance_to_axis_endpoints_dimensions_major_and_minor_radius() {
    // Center + theta pinned; point_distance(center, Major)=5 pins a, and
    // point_distance(center, Minor)=3 pins b. Fully constrained, and the
    // solved ellipse has a=5, b=3.
    let pd_major = Constraint {
        kind_code: ConstraintKind::PointDistance.to_u8(),
        refs: vec![
            (
                RefRole::A,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Center,
                },
            ),
            (
                RefRole::B,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Major,
                },
            ),
        ],
        value: Some(5.0),
        ..Default::default()
    };
    let pd_minor = Constraint {
        kind_code: ConstraintKind::PointDistance.to_u8(),
        refs: vec![
            (
                RefRole::A,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Center,
                },
            ),
            (
                RefRole::B,
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Minor,
                },
            ),
        ],
        value: Some(3.0),
        ..Default::default()
    };
    let mut inp = input(
        vec![ellipse(0)],
        vec![0.0, 0.0, 1.0, 1.0, 0.0],
        vec![pd_major, pd_minor],
    );
    // Pin cx (0), cy (1) and theta (4); the two radii stay free.
    inp.pinned_mask = vec![0b0001_0011];

    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    let p = &out.params_solved;
    assert!((p[2] - 5.0).abs() < 1e-3, "major radius a: {}", p[2]);
    assert!((p[3] - 3.0).abs() < 1e-3, "minor radius b: {}", p[3]);
    assert!(out.diagnostics.residual_norm < 1e-4);
}

#[test]
fn drag_reg_weights_bump_only_the_anchor_entity() {
    // line (off 0, 4 params) + point (off 4, 2 params); anchor = the point.
    let inp = Input {
        options: Options {
            drag_anchor_id: 1,
            ..Default::default()
        },
        ..input(vec![line(0), point(4)], vec![0.0; 6], vec![])
    };
    let w = drag_reg_weights(&inp, 6);
    // The line keeps the base pull; the dragged point is bumped.
    assert_eq!(&w[0..4], &[REG_WEIGHT_BASE; 4]);
    assert_eq!(&w[4..6], &[REG_WEIGHT_DRAG; 2]);
}

#[test]
fn drag_preserves_status_rank_and_feasibility() {
    // p1 fixed at origin (seeded off), p2 free. Underconstrained either way.
    // Dragging must not change the geometry - only re-place free DOF toward
    // seed. The sparse drag fast path skips SVD/rank, so entity_status
    // and rank diagnostics are not compared against the cold path.
    let mut fix_p1 = c_target(ConstraintKind::Fixed, 0, PointSelector::Absent);
    fix_p1.xy = Some((0.0, 0.0));
    let make = |drag: bool| Input {
        options: Options {
            drag_mode: drag,
            drag_anchor_id: 1,
            ..Default::default()
        },
        ..input(
            vec![point(0), point(2)],
            vec![1.0, 1.0, 3.0, 4.0],
            vec![fix_p1.clone()],
        )
    };

    let plain = solve_sketch(&make(false));
    let dragged = solve_sketch(&make(true));

    // Drag path classifies as underconstrained without the SVD (always true
    // when loss is low, which it is for a feasible underconstrained sketch).
    assert_eq!(dragged.overall_status, Status::Underconstrained.to_u8());
    assert_eq!(plain.overall_status, Status::Underconstrained.to_u8());

    // Both solves are feasible and place the fixed point at the origin.
    assert!(dragged.diagnostics.residual_norm < 1e-4);
    assert!(dragged.params_solved[0].abs() < 1e-3 && dragged.params_solved[1].abs() < 1e-3);
    // The free, undragged-by-constraints point stays near its seed under reg.
    assert!((dragged.params_solved[2] - 3.0).abs() < 1e-2);
    assert!((dragged.params_solved[3] - 4.0).abs() < 1e-2);
}

/// One line asked for two different lengths: no placement satisfies both,
/// so the cold path must reach the unsatisfiable branch.
fn contradictory_lengths(drag: bool) -> Input {
    let mut short = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
    short.value = Some(10.0);
    let mut long = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
    long.value = Some(20.0);
    Input {
        options: Options {
            drag_mode: drag,
            ..Default::default()
        },
        ..input(vec![line(0)], vec![0.0, 0.0, 10.0, 0.0], vec![short, long])
    }
}

#[test]
fn contradictory_lengths_are_overconstrained_on_the_cold_path() {
    let out = solve_sketch(&contradictory_lengths(false));
    assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
    // The per-entity pass mirrors the overall status for every entity.
    assert_eq!(out.entity_status, vec![Status::Overconstrained.to_u8()]);
    assert!(out.diagnostics.residual_norm > 1e-2);
}

#[test]
fn contradictory_lengths_are_overconstrained_on_the_drag_path() {
    let out = solve_sketch(&contradictory_lengths(true));
    assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
    // The drag fast path skips the per-entity SVD; the status is its output.
    assert!(out.entity_status.is_empty());
    assert!(out.diagnostics.residual_norm > 1e-2);
}

/// A non-finite param poisons the length residual; the LM driver refuses to
/// step and reports a NaN norm, which the solve layer must classify as
/// Overconstrained rather than let NaN fall through to a success status.
fn non_finite_length(drag: bool) -> Input {
    let mut length = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
    length.value = Some(10.0);
    Input {
        options: Options {
            drag_mode: drag,
            ..Default::default()
        },
        ..input(vec![line(0)], vec![0.0, 0.0, f64::NAN, 0.0], vec![length])
    }
}

#[test]
fn non_finite_residual_is_overconstrained_on_the_cold_path() {
    let out = solve_sketch(&non_finite_length(false));
    assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
    assert_eq!(out.entity_status, vec![Status::Overconstrained.to_u8()]);
    assert!(!out.diagnostics.residual_norm.is_finite());
}

#[test]
fn non_finite_residual_is_overconstrained_on_the_drag_path() {
    let out = solve_sketch(&non_finite_length(true));
    assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
    assert!(out.entity_status.is_empty());
    assert!(!out.diagnostics.residual_norm.is_finite());
}

#[test]
fn dragged_point_far_off_a_line_is_not_overconstrained() {
    // A point coincident with a fixed horizontal line, seeded 100 units off
    // it and dragged there. The anchored compromise sits ~0.25 off the line,
    // so its raw constraint residual exceeds the verdict width; the status must
    // still come from the constraint system (satisfiable), exactly as the
    // old first unanchored solve classified it. Otherwise the caller drops
    // the frame and the point freezes instead of sliding. The returned
    // geometry is the polished one: on the line, below the cursor.
    let fixed_line = c_target(ConstraintKind::Fixed, 0, PointSelector::Absent);
    let on_line = Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: ab(e_ref(1, PointSelector::Xy), e_ref(0, PointSelector::Absent)),
        ..Default::default()
    };
    let inp = Input {
        options: Options {
            drag_mode: true,
            drag_anchor_id: 1,
            ..Default::default()
        },
        ..input(
            vec![line(0), point(4)],
            vec![0.0, 0.0, 10.0, 0.0, 5.0, 100.0],
            vec![fixed_line, on_line],
        )
    };

    let out = solve_sketch(&inp);
    assert_eq!(
        out.overall_status,
        Status::Underconstrained.to_u8(),
        "a satisfiable far drag must not read as overconstrained"
    );
    let (x, y) = (out.params_solved[4], out.params_solved[5]);
    assert!(y.abs() < 1e-5, "dragged point left off its line: y={y}");
    assert!(
        (x - 5.0).abs() < 1e-3,
        "point did not slide under the cursor: x={x}"
    );
}

/// A vertical line through an external origin at (-5, 0), its end
/// dragged to the cursor (3, -10). The constraints leave the line free to
/// grow along itself, and the absolute vertical offset against the
/// angular point-on-line row opens a valley in that direction.
fn vertical_line_through_origin(drag: bool) -> Input {
    let through_origin = Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: ab(
            e_ref(0, PointSelector::Absent),
            Ref::External { x: -5.0, y: 0.0 },
        ),
        ..Default::default()
    };
    let vertical = c_target(ConstraintKind::Vertical, 0, PointSelector::Absent);
    Input {
        options: Options {
            drag_mode: drag,
            drag_anchor_id: 0,
            skip_status_pass: drag,
        },
        ..input(
            vec![line(0)],
            vec![-5.0, 21.95, 3.0, -10.0],
            vec![through_origin, vertical],
        )
    }
}

#[test]
fn polish_holds_a_free_direction_with_a_valley() {
    // Regression for the polish phases: dropping the anchor outright to
    // remove its bias let LM slide the dragged end off to ~1e4 here.
    for drag in [false, true] {
        let out = solve_sketch(&vertical_line_through_origin(drag));
        let p = &out.params_solved;
        assert!(out.diagnostics.residual_norm < 1e-6, "drag={drag}: {p:?}");
        assert!(
            (p[0] + 5.0).abs() < 1e-4 && (p[2] + 5.0).abs() < 1e-4,
            "drag={drag}: {p:?}"
        );
        assert!(
            p[1].abs() < 100.0 && p[3].abs() < 100.0,
            "drag={drag}: line ran off: {p:?}"
        );
    }
}

#[test]
fn drag_on_manifold_seed_is_a_no_op() {
    // Underconstrained, seeded already satisfying all constraints: the seed
    // anchor must leave the geometry put (it pulls toward x0, already there).
    let inp = Input {
        options: Options {
            drag_mode: true,
            drag_anchor_id: 0,
            ..Default::default()
        },
        ..input(vec![line(0)], vec![1.0, 2.0, 5.0, 2.0], vec![])
    };
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    let p = &out.params_solved;
    for (got, want) in p.iter().zip([1.0, 2.0, 5.0, 2.0]) {
        assert!(
            (got - want).abs() < 1e-4,
            "drag moved a satisfied DOF: {p:?}"
        );
    }
}

#[test]
fn a_duplicate_dimension_is_flagged_redundant() {
    // Start fixed at the origin, horizontal, length 10, then the SAME length
    // again. The duplicate's row is the first length row verbatim, so the
    // later constraint is the redundant one.
    let mut fixed_start = c_target(ConstraintKind::Fixed, 0, PointSelector::Start);
    fixed_start.xy = Some((0.0, 0.0));
    let horizontal = c_target(ConstraintKind::Horizontal, 0, PointSelector::Absent);
    let mut length = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
    length.value = Some(10.0);
    let mut duplicate = length.clone();
    duplicate.value = Some(10.0);

    let inp = input(
        vec![line(0)],
        vec![0.0, 0.0, 10.0, 0.0],
        vec![fixed_start, horizontal, length, duplicate],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    assert_eq!(
        out.constraint_flags,
        vec![0, 0, 0, CONSTRAINT_FLAG_REDUNDANT],
        "the duplicate (last) constraint must take the blame"
    );
}

#[test]
fn a_parallel_implied_by_four_horizontals_is_flagged_redundant() {
    // The plan's four-horizontals rectangle: with every side horizontal, the
    // parallel row is a linear combination of the two horizontal rows it
    // references, so it adds no rank. The four horizontals themselves do
    // (each acts on a different line).
    let entities = vec![line(0), line(4), line(8), line(12)];
    // The rectangle's sides, in bottom, right, top, left order.
    let params = vec![
        0.0, 0.0, 10.0, 0.0, 10.0, 0.0, 10.0, 6.0, 10.0, 6.0, 0.0, 6.0, 0.0, 6.0, 0.0, 0.0,
    ];
    let horiz = |i| c_target(ConstraintKind::Horizontal, i, PointSelector::Absent);
    let constraints = vec![
        horiz(0),
        horiz(1),
        horiz(2),
        horiz(3),
        cons(
            ConstraintKind::Parallel,
            ab(
                e_ref(0, PointSelector::Absent),
                e_ref(2, PointSelector::Absent),
            ),
        ),
    ];
    let out = solve_sketch(&input(entities, params, constraints));
    assert_eq!(out.constraint_flags[4], CONSTRAINT_FLAG_REDUNDANT);
    assert!(
        out.constraint_flags[..4].iter().all(|&f| f == 0),
        "the four horizontals each add rank: {:?}",
        out.constraint_flags
    );
}

#[test]
fn a_clean_sketch_reports_zero_redundancy_flags() {
    // Start pinned at the origin, horizontal, length: three independent
    // drivers. Nothing may be flagged, or the UI would dim a real driver.
    let mut fixed_start = c_target(ConstraintKind::Fixed, 0, PointSelector::Start);
    fixed_start.xy = Some((0.0, 0.0));
    let mut length = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
    length.value = Some(10.0);
    let inp = input(
        vec![line(0)],
        vec![0.2, -0.1, 9.5, 0.8],
        vec![
            fixed_start,
            c_target(ConstraintKind::Horizontal, 0, PointSelector::Absent),
            length,
        ],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    assert!(out.constraint_flags.iter().all(|&f| f == 0));
    assert!(out.constraint_miss.iter().all(|&m| m == 0.0));
}

#[test]
fn a_short_jacobian_stops_the_redundancy_walk_instead_of_misflagging_the_tail() {
    // Three horizontals, one row each, but a Jacobian truncated to two
    // rows: the third constraint has no row to check, so its verdict is
    // unknown and the walk must stop. The old walk only broke the inner
    // loop, advanced row0 past the end, and read every later constraint as
    // if it added no rank, flagging the whole tail redundant.
    let horiz = |i| c_target(ConstraintKind::Horizontal, i, PointSelector::Absent);
    let inp = input(
        vec![line(0), line(4), line(8)],
        vec![
            0.0, 0.0, 10.0, 0.0, 10.0, 1.0, 10.0, 5.0, 10.0, 5.0, 10.0, 6.0,
        ],
        vec![horiz(0), horiz(1), horiz(2)],
    );
    let problem = Problem::new(&inp);
    let x = problem.x0.clone();
    let full = problem.jacobian(&x, x.len());
    assert_eq!(full.nrows(), 3, "fixture assumes one row per horizontal");

    let short = full.rows(0, 2).into_owned();
    let flags = redundancy_flags(&problem, &x, &short, 3);
    assert_eq!(
        flags,
        vec![0, 0, 0],
        "a missing row must leave the tail unflagged, not blame it"
    );
}

#[test]
fn conflicting_dimensions_carry_the_miss_and_nothing_is_flagged_redundant() {
    // A fixed start plus two lengths that disagree by 4%. The unsatisfied
    // solve must not run the redundancy walk (flags are for satisfied
    // solves), and the miss must land on the two dimensions, not on the
    // satisfied fixed-start rows.
    let mut fixed_start = c_target(ConstraintKind::Fixed, 0, PointSelector::Start);
    fixed_start.xy = Some((0.0, 0.0));
    let mut short = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
    short.value = Some(0.1);
    let mut long = short.clone();
    long.value = Some(0.104);
    let inp = input(
        vec![line(0)],
        vec![0.0, 0.0, 0.1, 0.0],
        vec![fixed_start, short, long],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
    assert!(out.constraint_flags.iter().all(|&f| f == 0));
    assert_eq!(out.constraint_miss.len(), 3);
    // The fixed start sits exactly where it was asked to: ~zero miss.
    assert!(
        out.constraint_miss[0] < 1e-4,
        "fixed rows carried the miss: {:?}",
        out.constraint_miss
    );
    for i in [1, 2] {
        assert!(
            out.constraint_miss[i] > 0.01,
            "conflicting dimension {i} missed nothing: {:?}",
            out.constraint_miss
        );
    }
}

#[test]
fn the_drag_path_emits_no_constraint_verdicts() {
    // The drag fast path owns the 60 Hz budget; the per-constraint walk is
    // cold-path work, and the caller's count guard expects empty arrays.
    let out = solve_sketch(&contradictory_lengths(true));
    assert!(out.constraint_flags.is_empty());
    assert!(out.constraint_miss.is_empty());
}

#[test]
fn the_verdict_walk_handles_the_degenerate_constraint_sets() {
    // Empty constraint list: the walk has nothing to classify and emits one
    // empty verdict array per request, not a panic.
    let out = solve_sketch(&input(vec![line(0)], vec![0.0, 0.0, 10.0, 1.0], vec![]));
    assert!(out.constraint_flags.is_empty());
    assert!(out.constraint_miss.is_empty());

    // One constraint: the single verdict is the walk's whole output.
    let out = solve_sketch(&input(
        vec![line(0)],
        vec![0.0, 0.0, 10.0, 0.0],
        vec![c_target(
            ConstraintKind::Horizontal,
            0,
            PointSelector::Absent,
        )],
    ));
    assert_eq!(out.constraint_flags, vec![0]);
    assert_eq!(out.constraint_miss, vec![0.0]);

    // All pins, no authored constraints: the sketch is fully constrained by
    // the pin rows alone, and there is no constraint to blame.
    let mut inp = input(vec![point(0)], vec![2.0, 3.0], vec![]);
    inp.pinned_mask = vec![0b11];
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    assert!(out.constraint_flags.is_empty());
    assert!(out.constraint_miss.is_empty());
}

#[test]
fn coincident_line_ends_keep_the_arcs_authored_sweep() {
    // The bug-3 case: a 105 degree cap at (-45,0), r15, with line ends
    // already within 2e-5 of its ends. Adding the two coincidences must
    // move everything by about that much and never change the sweep.
    let a0 = 127.5;
    let a1 = 232.5;
    let (cx, cy, r) = (-45.0, 0.0, 15.0);
    let at = |deg: f64| {
        let a = deg.to_radians();
        [cx + r * a.cos(), cy + r * a.sin()]
    };
    let start = at(a0);
    let end = at(a1);
    let entities = vec![line(0), line(4), ent(Kind::Arc, 8)];
    let params = vec![
        start[0] - 30.0,
        start[1] + 2e-5,
        start[0],
        start[1] - 2e-5,
        end[0],
        end[1] + 2e-5,
        end[0] + 30.0,
        end[1] - 2e-5,
        cx,
        cy,
        r,
        a0,
        a1,
    ];
    let constraints = vec![
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(0, PointSelector::End), e_ref(2, PointSelector::Start)),
        ),
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(2, PointSelector::End), e_ref(1, PointSelector::Start)),
        ),
    ];
    let out = solve_sketch(&input(entities, params, constraints));
    let solved_a0 = out.params_solved[11];
    let solved_a1 = out.params_solved[12];
    assert!((solved_a0 - a0).abs() <= 1e-4, "a0 moved to {solved_a0}");
    assert!((solved_a1 - a1).abs() <= 1e-4, "a1 moved to {solved_a1}");
    assert!(
        (solved_a1 - solved_a0 - 105.0).abs() <= 1e-3,
        "sweep {} is not the authored 105 degrees",
        solved_a1 - solved_a0
    );
}

#[test]
fn perturbed_coincident_arcs_never_flip_their_sweep() {
    // Property: random arcs with both line ends perturbed by 1e-5 and the
    // two coincidences added. Starting that close to a solution, the solve
    // may move by about the perturbation but never change the sweep
    // branch. Radii below 2 are excluded: there a 1e-5 world perturbation
    // is a >1e-3 degree angular move by arithmetic, not a branch change.
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut rnd = move || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((state >> 11) as f64) / ((1u64 << 53) as f64)
    };
    let mut worst = 0.0f64;
    for _ in 0..2000 {
        let cx = (rnd() - 0.5) * 400.0;
        let cy = (rnd() - 0.5) * 400.0;
        let r = 2.0 + rnd() * 60.0;
        let a0 = (rnd() - 0.5) * 720.0;
        let sweep = 1.0 + rnd() * 358.0;
        let a1 = a0 + sweep;
        let at = |deg: f64| {
            let a = deg.to_radians();
            [cx + r * a.cos(), cy + r * a.sin()]
        };
        let start = at(a0);
        let end = at(a1);
        let j = 1e-5;
        let lostart = [
            start[0] + (rnd() - 0.5) * 2.0 * j,
            start[1] + (rnd() - 0.5) * 2.0 * j,
        ];
        let loend = [
            end[0] + (rnd() - 0.5) * 2.0 * j,
            end[1] + (rnd() - 0.5) * 2.0 * j,
        ];
        let entities = vec![line(0), line(4), ent(Kind::Arc, 8)];
        let params = vec![
            lostart[0] - 20.0,
            lostart[1],
            lostart[0],
            lostart[1],
            loend[0],
            loend[1],
            loend[0] + 20.0,
            loend[1],
            cx,
            cy,
            r,
            a0,
            a1,
        ];
        let constraints = vec![
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(0, PointSelector::End), e_ref(2, PointSelector::Start)),
            ),
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(2, PointSelector::End), e_ref(1, PointSelector::Start)),
            ),
        ];
        let out = solve_sketch(&input(entities, params, constraints));
        let mut drift = (out.params_solved[12] - out.params_solved[11] - sweep).abs();
        drift = drift.min((drift - 360.0).abs()).min((drift + 360.0).abs());
        worst = worst.max(drift);
    }
    assert!(worst < 1e-3, "worst sweep drift {worst} degrees");
}

#[test]
fn arc_branches_are_rebased_onto_the_authored_spelling() {
    // A solve can land an angle a whole turn away: same curve, but the
    // document's CCW reading would call it the complement. The rebase adds
    // whole turns only, so the geometry is unchanged.
    let entities = vec![ent(Kind::Arc, 0)];
    let x0 = vec![0.0, 0.0, 10.0, 127.5, 232.5];
    let probe = input(entities, x0.clone(), vec![]);
    let problem = Problem::new(&probe);
    let mut solved = vec![0.0, 0.0, 10.0, -232.5, 592.5];
    problem.rebase_arc_branches(&mut solved);
    assert!((solved[3] - 127.5).abs() < 1e-12, "a0 {}", solved[3]);
    assert!((solved[4] - 232.5).abs() < 1e-12, "a1 {}", solved[4]);
}

#[test]
fn a_non_finite_jacobian_returns_a_verdict_without_decomposing_it() {
    // End-to-end shape of the failure: a NaN coordinate makes the residual
    // non-finite too, so the driver returns early. The gate itself is pinned
    // directly below; this test is the integration tripwire that a malformed
    // sketch still answers (the channel's timeout catches a wedged worker).
    use std::sync::mpsc;
    use std::time::Duration;
    let mut length = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
    length.value = Some(10.0);
    let inp = input(vec![line(0)], vec![f64::NAN, 0.0, 10.0, 1.0], vec![length]);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let out = solve_sketch(&inp);
        tx.send((
            out.overall_status,
            out.diagnostics.rank,
            out.diagnostics.dof,
        ))
        .unwrap();
    });
    let (status, rank, dof) = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("solve did not return: a non-finite Jacobian reached the SVD");
    assert_eq!(status, Status::Overconstrained.to_u8());
    assert_eq!(rank, 0, "a skipped spectrum must not invent a rank");
    assert_eq!(
        dof, 0,
        "a skipped spectrum must not report every param free"
    );
}

#[test]
fn the_spectrum_of_a_non_finite_jacobian_never_reaches_the_svd() {
    // The gate at the SVD itself: nalgebra's decomposition never converges on
    // NaN, so this call must refuse the matrix before the factorization. A
    // finite matrix still produces the real spectrum.
    let nan = DMatrix::from_row_slice(2, 2, &[1.0, f64::NAN, 0.0, 1.0]);
    let spectrum = Spectrum::of(&nan, 2, true);
    assert_eq!(spectrum.rank, 0);
    assert_eq!(spectrum.null.ncols(), 0);
    assert!(spectrum.null_sv.is_empty());

    let finite = DMatrix::from_row_slice(1, 2, &[1.0, 0.0]);
    assert_eq!(Spectrum::of(&finite, 2, true).rank, 1);
}

#[test]
fn a_non_finite_jacobian_forces_overconstrained_whatever_the_residual() {
    // The verdict branch: a residual under the width with a full rank would
    // read FullyConstrained, and a partial rank Underconstrained. Neither is
    // trustworthy when the Jacobian could not be decomposed.
    assert_eq!(
        overall_status(false, 0.0, 4, 4, 1.0),
        Status::Overconstrained
    );
    assert_eq!(
        overall_status(true, 0.0, 4, 4, 1.0),
        Status::FullyConstrained
    );
    assert_eq!(
        overall_status(true, 0.0, 2, 4, 1.0),
        Status::Underconstrained
    );
    assert_eq!(
        overall_status(true, f64::NAN, 4, 4, 1.0),
        Status::Overconstrained
    );
}

/// Two lines whose placement reads the finite-difference angle row, drawn
/// at scale `s`: line 0 fixed, line 1 coincident at its start, length 5 s
/// and at 90 degrees to line 0.
fn angled_pair(s: f64) -> Input {
    let params = vec![0.0, 0.0, 10.0 * s, 0.0, s, s, 5.0 * s, 4.0 * s];
    let mut length = c_target(ConstraintKind::Length, 1, PointSelector::Absent);
    length.value = Some(5.0 * s);
    let coincident = Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: ab(
            e_ref(1, PointSelector::Start),
            e_ref(0, PointSelector::Start),
        ),
        ..Default::default()
    };
    let angle = cons_v(
        ConstraintKind::Angle,
        ab(
            e_ref(0, PointSelector::Absent),
            e_ref(1, PointSelector::Absent),
        ),
        90.0,
    );
    input(
        vec![line(0), line(4)],
        params,
        vec![
            c_target(ConstraintKind::Fixed, 0, PointSelector::Absent),
            coincident,
            length,
            angle,
        ],
    )
}

fn arc_point(params: &[f64], deg: f64) -> [f64; 2] {
    let a = deg.to_radians();
    [
        params[0] + params[2] * a.cos(),
        params[1] + params[2] * a.sin(),
    ]
}

/// Circumcircle through three points, `None` when they are collinear.
fn circumcircle(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> Option<([f64; 2], f64)> {
    let d = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if d.abs() < 1e-12 {
        return None;
    }
    let (a2, b2, c2) = (
        a[0] * a[0] + a[1] * a[1],
        b[0] * b[0] + b[1] * b[1],
        c[0] * c[0] + c[1] * c[1],
    );
    let ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
    let uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
    Some(([ux, uy], ((a[0] - ux).powi(2) + (a[1] - uy).powi(2)).sqrt()))
}

/// A near seed of an exact arc: the same stored start and end points, with a
/// through point pushed 10 percent of the chord along the bulge.
fn seeded_arc(centre: [f64; 2], r: f64, a0: f64, a1: f64) -> Vec<f64> {
    let exact = [centre[0], centre[1], r, 0.0, 0.0];
    let start = arc_point(&exact, a0);
    let end = arc_point(&exact, a1);
    let mid = arc_point(&exact, 0.5 * (a0 + a1));
    let chord = ((end[0] - start[0]).powi(2) + (end[1] - start[1]).powi(2)).sqrt();
    let rv = [mid[0] - centre[0], mid[1] - centre[1]];
    let rn = (rv[0] * rv[0] + rv[1] * rv[1]).sqrt();
    let through = [
        mid[0] + 0.1 * chord * rv[0] / rn,
        mid[1] + 0.1 * chord * rv[1] / rn,
    ];
    let (c, sr) = circumcircle(start, end, through).expect("seed arc points are not collinear");
    let sa = (start[1] - c[1]).atan2(start[0] - c[0]).to_degrees();
    let ea = (end[1] - c[1]).atan2(end[0] - c[0]).to_degrees();
    let delta = (ea - sa).rem_euclid(360.0);
    vec![c[0], c[1], sr, sa, sa + delta]
}

/// The minimal line plus arc repro: a fixed line, a vertex-to-vertex
/// coincident at the shared joint, the far arc end fixed, and a tangent.
fn line_arc_shared_vertex() -> Input {
    let absent = PointSelector::Absent;
    input(
        vec![line(0), ent(Kind::Arc, 4)],
        vec![
            // Line (0,0)-(1,0).
            0.0, 0.0, 1.0, 0.0,
            // Arc centre (1,-1) r 1, stored CCW 0..90: Start (2,-1), End (1,0).
            1.0, -1.0, 1.0, 0.0, 90.0,
        ],
        vec![
            c_target(ConstraintKind::Fixed, 0, absent),
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(0, PointSelector::End), e_ref(1, PointSelector::End)),
            ),
            c_target(ConstraintKind::Fixed, 1, PointSelector::Start),
            cons(
                ConstraintKind::Tangent,
                vec![
                    (RefRole::Line, e_ref(0, absent)),
                    (RefRole::Arc, e_ref(1, absent)),
                ],
            ),
        ],
    )
}

/// The two-arc repro: the same line and first arc, then a second arc joined at
/// the first one's far end, its own far end fixed and a tangent at the joint.
fn line_arc_arc_shared_vertices() -> Input {
    let absent = PointSelector::Absent;
    input(
        vec![line(0), ent(Kind::Arc, 4), ent(Kind::Arc, 9)],
        vec![
            0.0,
            0.0,
            1.0,
            0.0,
            1.0,
            -1.0,
            1.0,
            0.0,
            90.0,
            // Seeded just off the exact B: centre (12.1,-1), r 10.1. These
            // are the circumcircle of the three authored points, so the seed
            // arc still passes through both fixed ends.
            12.113018978396916,
            -0.9986981021603096,
            10.113019062196718,
            -179.9926240372614,
            -168.58618968773933,
        ],
        vec![
            c_target(ConstraintKind::Fixed, 0, absent),
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(0, PointSelector::End), e_ref(1, PointSelector::End)),
            ),
            c_target(ConstraintKind::Fixed, 1, PointSelector::Start),
            cons(
                ConstraintKind::Tangent,
                vec![
                    (RefRole::Line, e_ref(0, absent)),
                    (RefRole::Arc, e_ref(1, absent)),
                ],
            ),
            cons(
                ConstraintKind::Coincident,
                ab(
                    e_ref(1, PointSelector::Start),
                    e_ref(2, PointSelector::Start),
                ),
            ),
            c_target(ConstraintKind::Fixed, 2, PointSelector::End),
            cons(
                ConstraintKind::Tangent,
                ab(e_ref(1, absent), e_ref(2, absent)),
            ),
        ],
    )
}

#[test]
fn line_arc_tangent_at_a_shared_vertex_is_fully_constrained() {
    let inp = line_arc_shared_vertex();
    let out = solve_sketch(&inp);
    assert_eq!(
        out.overall_status,
        Status::FullyConstrained.to_u8(),
        "norm {}",
        out.diagnostics.residual_norm
    );
    assert_eq!(out.diagnostics.rank as usize, inp.params_initial.len());
    assert!(
        (out.params_solved[4] - 1.0).abs() < 1e-9,
        "centre x {}",
        out.params_solved[4]
    );
    assert!(
        (out.params_solved[5] + 1.0).abs() < 1e-9,
        "centre y {}",
        out.params_solved[5]
    );
    assert!(
        (out.params_solved[6] - 1.0).abs() < 1e-9,
        "radius {}",
        out.params_solved[6]
    );
}

#[test]
fn arc_arc_tangent_at_a_shared_vertex_solves_exactly() {
    let inp = line_arc_arc_shared_vertices();
    let out = solve_sketch(&inp);
    assert_eq!(
        out.overall_status,
        Status::FullyConstrained.to_u8(),
        "norm {}",
        out.diagnostics.residual_norm
    );
    // The geometry sits at 12.1 with an error amplified by this pair's
    // conditioning (radius 10.1 against a 2.0 chord): the residual is at the
    // driver's gradient tolerance, so the centre lands at the document grid
    // rather than at machine epsilon. The old centre-distance row left it
    // 1.3e-2 off.
    assert!(
        (out.params_solved[9] - 12.1).abs() < 1e-6,
        "B centre x {}",
        out.params_solved[9]
    );
    assert!(
        (out.params_solved[10] + 1.0).abs() < 1e-6,
        "B centre y {}",
        out.params_solved[10]
    );
    assert!(
        (out.params_solved[11] - 10.1).abs() < 1e-6,
        "B radius {}",
        out.params_solved[11]
    );
}

#[test]
fn arc_arc_internal_tangent_at_a_shared_vertex() {
    let absent = PointSelector::Absent;
    // A is fixed: centre (0,0), r 2, 0..90 deg. B touches A's 90 deg end at
    // (0,2) from inside, centre (0,1), r 1, curling the same way.
    let inp = input(
        vec![ent(Kind::Arc, 0), ent(Kind::Arc, 5)],
        vec![0.0, 0.0, 2.0, 0.0, 90.0, 0.05, 1.0, 1.05, 90.0, 180.0],
        vec![
            c_target(ConstraintKind::Fixed, 0, absent),
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(0, PointSelector::End), e_ref(1, PointSelector::Start)),
            ),
            c_target(ConstraintKind::Fixed, 1, PointSelector::End),
            cons(
                ConstraintKind::Tangent,
                ab(e_ref(0, absent), e_ref(1, absent)),
            ),
        ],
    );
    let out = solve_sketch(&inp);
    assert_eq!(
        out.overall_status,
        Status::FullyConstrained.to_u8(),
        "norm {}",
        out.diagnostics.residual_norm
    );
    assert!(
        (out.params_solved[5] - 0.0).abs() < 1e-9,
        "B centre x {}",
        out.params_solved[5]
    );
    assert!(
        (out.params_solved[6] - 1.0).abs() < 1e-9,
        "B centre y {}",
        out.params_solved[6]
    );
    assert!(
        (out.params_solved[7] - 1.0).abs() < 1e-9,
        "B radius {}",
        out.params_solved[7]
    );
}

#[test]
fn arc_endpoint_on_circle_locus_tangent_is_contact_pinned() {
    let absent = PointSelector::Absent;
    // Circle at the origin r 2 fixed; arc centre (0,3) r 1 from 180 to 270,
    // so its End is the circle's top point (0,2). A radius row removes the
    // last arc degree of freedom, so the sketch is exactly determined.
    let mut radius = c_target(ConstraintKind::Radius, 1, absent);
    radius.value = Some(1.0);
    let inp = input(
        vec![ent(Kind::Circle, 0), ent(Kind::Arc, 3)],
        vec![0.0, 0.0, 2.0, 0.0, 3.0, 1.0, 180.0, 270.0],
        vec![
            c_target(ConstraintKind::Fixed, 0, absent),
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(1, PointSelector::End), e_ref(0, absent)),
            ),
            c_target(ConstraintKind::Fixed, 1, PointSelector::Start),
            radius,
            cons(
                ConstraintKind::Tangent,
                ab(e_ref(0, absent), e_ref(1, absent)),
            ),
        ],
    );
    let out = solve_sketch(&inp);
    assert_eq!(
        out.overall_status,
        Status::FullyConstrained.to_u8(),
        "norm {}",
        out.diagnostics.residual_norm
    );
    assert!(
        (out.params_solved[3] - 0.0).abs() < 1e-9,
        "arc centre x {}",
        out.params_solved[3]
    );
    assert!(
        (out.params_solved[4] - 3.0).abs() < 1e-9,
        "arc centre y {}",
        out.params_solved[4]
    );
    assert!(
        (out.params_solved[5] - 1.0).abs() < 1e-9,
        "arc radius {}",
        out.params_solved[5]
    );
}

/// Two fixed lines with four arcs between them: line, cw arc, ccw arc, cw
/// arc, ccw arc, line, each arc's start tangent to the previous curve.
fn four_arc_s_chain() -> (Input, Vec<[f64; 5]>) {
    let absent = PointSelector::Absent;
    // The exact arcs, stored CCW. The first three curve one way then the
    // other, giving an S that returns to a horizontal line.
    let exact = vec![
        [-3.0, -1.0, 1.0, 0.0, 90.0],
        [0.0, -1.0, 2.0, 180.0, 270.0],
        [0.0, -2.0, 1.0, 270.0, 360.0],
        [3.0, -2.0, 2.0, 90.0, 180.0],
    ];
    let mut params = vec![
        // Line 1: (-4,0) to (-3,0).
        -4.0, 0.0, -3.0, 0.0,
    ];
    for a in &exact {
        params.extend(seeded_arc([a[0], a[1]], a[2], a[3], a[4]));
    }
    // Line 2: (3,0) to (4,0).
    params.extend([3.0, 0.0, 4.0, 0.0]);

    let entities = vec![
        line(0),
        ent(Kind::Arc, 4),
        ent(Kind::Arc, 9),
        ent(Kind::Arc, 14),
        ent(Kind::Arc, 19),
        line(24),
    ];
    let constraints = vec![
        c_target(ConstraintKind::Fixed, 0, absent),
        c_target(ConstraintKind::Fixed, 5, absent),
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(0, PointSelector::End), e_ref(1, PointSelector::End)),
        ),
        cons(
            ConstraintKind::Coincident,
            ab(
                e_ref(1, PointSelector::Start),
                e_ref(2, PointSelector::Start),
            ),
        ),
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(2, PointSelector::End), e_ref(3, PointSelector::Start)),
        ),
        cons(
            ConstraintKind::Coincident,
            ab(e_ref(3, PointSelector::End), e_ref(4, PointSelector::End)),
        ),
        cons(
            ConstraintKind::Coincident,
            ab(
                e_ref(4, PointSelector::Start),
                e_ref(5, PointSelector::Start),
            ),
        ),
        // The three arc-to-arc joints are pinned.
        c_target(ConstraintKind::Fixed, 1, PointSelector::Start),
        c_target(ConstraintKind::Fixed, 2, PointSelector::End),
        c_target(ConstraintKind::Fixed, 3, PointSelector::End),
        cons(
            ConstraintKind::Tangent,
            ab(e_ref(0, absent), e_ref(1, absent)),
        ),
        cons(
            ConstraintKind::Tangent,
            ab(e_ref(1, absent), e_ref(2, absent)),
        ),
        cons(
            ConstraintKind::Tangent,
            ab(e_ref(2, absent), e_ref(3, absent)),
        ),
        cons(
            ConstraintKind::Tangent,
            ab(e_ref(3, absent), e_ref(4, absent)),
        ),
        cons(
            ConstraintKind::Tangent,
            ab(e_ref(4, absent), e_ref(5, absent)),
        ),
    ];
    (input(entities, params, constraints), exact)
}

#[test]
fn tangent_chain_of_four_arcs_between_two_lines_converges() {
    let (inp, exact) = four_arc_s_chain();
    let out = solve_sketch(&inp);
    assert_ne!(
        out.overall_status,
        Status::Overconstrained.to_u8(),
        "norm {}",
        out.diagnostics.residual_norm
    );
    assert!(
        out.diagnostics.residual_norm < 1e-9,
        "norm {}",
        out.diagnostics.residual_norm
    );
    for (i, want) in exact.iter().enumerate() {
        let off = 4 + 5 * i;
        let want_start = arc_point(want, want[3]);
        let want_end = arc_point(want, want[4]);
        let got = &out.params_solved[off..off + 5];
        let got_start = arc_point(got, got[3]);
        let got_end = arc_point(got, got[4]);
        for (label, (got_pt, want_pt)) in [
            ("start", (got_start, want_start)),
            ("end", (got_end, want_end)),
        ] {
            assert!(
                (got_pt[0] - want_pt[0]).abs() < 1e-9 && (got_pt[1] - want_pt[1]).abs() < 1e-9,
                "arc {i} {label}: got {got_pt:?} want {want_pt:?}"
            );
        }
    }
    // The fixed lines are pinned; the write-back relies on them not moving
    // (the failing chain used to shift one by 2e-6).
    for i in (0..4).chain(24..28) {
        assert!(
            (out.params_solved[i] - inp.params_initial[i]).abs() < 1e-9,
            "param {i}: {} from {}",
            out.params_solved[i],
            inp.params_initial[i]
        );
    }
}

#[test]
fn conflicting_tangent_chain_is_overconstrained() {
    let mut inp = line_arc_arc_shared_vertices();
    // Pin B's centre well off the exact one, which the tangency and the two
    // coincidents cannot satisfy together.
    let mut fixed_centre = c_target(ConstraintKind::Fixed, 2, PointSelector::Center);
    fixed_centre.xy = Some((12.1, 0.0));
    inp.constraints.push(fixed_centre);
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
    let extra_fixed = inp.constraints.len() - 1;
    let tangent_a_b = extra_fixed - 1;
    // The frontend blames the largest misses until they cover 90 percent of
    // the total; the conflict must land on the added pin or the tangent, not
    // only on the pins that happen to be nearby.
    let mut order: Vec<(f64, usize)> = out
        .constraint_miss
        .iter()
        .copied()
        .enumerate()
        .filter(|(_, m)| m.is_finite() && *m > 0.0)
        .map(|(i, m)| (m, i))
        .collect();
    order.sort_by(|a, b| b.0.total_cmp(&a.0));
    let total: f64 = order.iter().map(|(m, _)| m).sum();
    let mut culprits = Vec::new();
    let mut covered = 0.0;
    for (miss, i) in order {
        culprits.push(i);
        covered += miss;
        if covered >= 0.9 * total {
            break;
        }
    }
    assert!(
        culprits.contains(&extra_fixed) || culprits.contains(&tangent_a_b),
        "culprits {culprits:?}: {:?}",
        out.constraint_miss
    );
    assert!(
        out.constraint_miss[extra_fixed] > 0.0,
        "the added pin carries no miss: {:?}",
        out.constraint_miss
    );
}

#[test]
fn a_contact_pinned_tangent_chain_has_no_redundant_constraint() {
    let inp = line_arc_arc_shared_vertices();
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    for (i, flag) in out.constraint_flags.iter().enumerate() {
        assert_eq!(
            flag & crate::CONSTRAINT_FLAG_REDUNDANT,
            0,
            "constraint {i} reads redundant: {:?}",
            out.constraint_flags
        );
    }
}

#[test]
fn the_finite_difference_step_keeps_the_rank_and_verdict_at_every_scale() {
    // The angle row is the finite-difference fallback, so this reads the
    // same sketch at the bottom and the top of the modelled range: the
    // same constraints must leave the same rank and the same verdict.
    let expected = (Status::FullyConstrained.to_u8(), 8);
    for s in [0.01, 1.0, 100.0] {
        let out = solve_sketch(&angled_pair(s));
        assert_eq!(
            (out.overall_status, out.diagnostics.rank),
            expected,
            "s={s}: norm {}",
            out.diagnostics.residual_norm
        );
        assert!(
            out.diagnostics.residual_norm < 1e-6 * s,
            "s={s}: norm {}",
            out.diagnostics.residual_norm
        );
    }
}

// ─── The moved report: what the write-back keeps ───

fn moved(out: &Output, entity: usize) -> bool {
    (out.entity_moved[entity / 8] >> (entity % 8)) & 1 == 1
}

/// A fully constrained 0.123457 x 0.05 rectangle whose seed sits on the
/// document's 6dp grid. The authored length is supplied separately, so a seed
/// can be off the true solution by less than the write-back's half-step line
/// while still breaking the sketch's verdict: at this size `verdict_tol(scale)`
/// is ~1.3e-8, so a 3e-7 grid error really does make the LM move the seed.
fn grid_rectangle(authored_length: f64) -> Input {
    let stored = 0.123457;
    let w = 0.05;
    let entities = vec![line(0), line(4), line(8), line(12)];
    let params = vec![
        0.0, 0.0, stored, 0.0, // l0
        stored, 0.0, stored, w, // l1
        stored, w, 0.0, w, // l2
        0.0, w, 0.0, 0.0, // l3
    ];
    let mut constraints = vec![
        c_target(ConstraintKind::Fixed, 0, PointSelector::Start),
        c_target(ConstraintKind::Horizontal, 0, PointSelector::Absent),
        c_target(ConstraintKind::Vertical, 1, PointSelector::Absent),
        c_target(ConstraintKind::Horizontal, 2, PointSelector::Absent),
        c_target(ConstraintKind::Vertical, 3, PointSelector::Absent),
    ];
    for (a, b) in [(0u32, 1u32), (1, 2), (2, 3), (3, 0)] {
        constraints.push(cons(
            ConstraintKind::Coincident,
            ab(e_ref(a, PointSelector::End), e_ref(b, PointSelector::Start)),
        ));
    }
    let mut long = c_target(ConstraintKind::Length, 0, PointSelector::Absent);
    long.value = Some(authored_length);
    constraints.push(long);
    let mut wide = c_target(ConstraintKind::Length, 1, PointSelector::Absent);
    wide.value = Some(w);
    constraints.push(wide);
    let mut inp = input(entities, params, constraints);
    inp.seed_quantum = 1e-6;
    inp
}

#[test]
fn an_unchanged_grid_seed_reports_every_entity_unmoved() {
    let inp = grid_rectangle(0.1234567);
    // Precondition: the stored seed is off the authored length by 3e-7, above
    // the sketch's verdict width, so this is the "grid breaks the verdict"
    // case and the LM really moves the seed.
    let problem = crate::residuals::Problem::new(&inp);
    let residual = problem
        .residuals(&inp.params_initial)
        .iter()
        .map(|v| v * v)
        .sum::<f64>()
        .sqrt();
    assert!(
        residual > crate::tolerance::verdict_tol(problem.scale()),
        "seed residual {residual:e} does not clear the verdict"
    );

    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    assert_eq!(
        out.entity_moved,
        vec![0],
        "a move under half a grid step must not be reported"
    );
    assert_ne!(
        out.params_solved, inp.params_initial,
        "the solve did not move the seed, so the case has no teeth"
    );
}

#[test]
fn a_driven_edit_reports_the_entities_it_moved() {
    // One grid step wider than the stored seed: the right-hand side moves and
    // the free point (bit 4) stays exactly where it was seeded.
    let mut inp = grid_rectangle(0.123458);
    inp.entities.push(point(16));
    inp.params_initial.extend([5.0, 5.0]);

    let out = solve_sketch(&inp);
    assert!(moved(&out, 0), "the dimensioned line did not report");
    assert!(moved(&out, 1), "the right vertical moved with the width");
    assert!(!moved(&out, 3), "the left vertical stayed put");
    assert!(!moved(&out, 4), "an unconstrained point was reported moved");
    assert!((out.params_solved[2] - 0.123458).abs() < 1e-9);
}

#[test]
fn the_half_step_boundary_is_strict() {
    // Two params pinned by equality to 0.49 and 0.51 grid steps: the first is
    // a move the stored grid cannot represent, the second is one it can.
    let inp = Input {
        entities: vec![point(0), point(2)],
        params_initial: vec![0.0; 4],
        params_reference: Vec::new(),
        pinned_mask: Vec::new(),
        equality_pins: vec![
            EqualityPin {
                param_index: 0,
                target: 0.49e-6,
            },
            EqualityPin {
                param_index: 2,
                target: 0.51e-6,
            },
        ],
        constraints: Vec::new(),
        seed_quantum: 1e-6,
        options: Options::default(),
    };
    let out = solve_sketch(&inp);
    // The precondition, so a solve that missed the pins cannot pass by luck.
    assert!((out.params_solved[0] - 0.49e-6).abs() < 1e-9);
    assert!((out.params_solved[2] - 0.51e-6).abs() < 1e-9);
    assert!(!moved(&out, 0), "0.49 of a step is not writable");
    assert!(moved(&out, 1), "0.51 of a step is writable");
}

#[test]
fn a_disabled_quantum_reports_every_entity_moved() {
    let mut inp = grid_rectangle(0.123457);
    inp.seed_quantum = 0.0;
    let out = solve_sketch(&inp);
    assert_eq!(
        out.entity_moved,
        vec![0b0000_1111],
        "no storage grid means the conservative report"
    );
}

#[test]
fn the_drag_fast_path_carries_no_moved_report() {
    let mut inp = grid_rectangle(0.1234567);
    inp.options = Options {
        drag_mode: true,
        drag_anchor_id: 0,
        skip_status_pass: true,
    };
    let out = solve_sketch(&inp);
    assert!(out.entity_moved.is_empty());
    // The other per-entity arrays stay empty on the same path, which is what
    // the host's count guards read.
    assert!(out.entity_status.is_empty());
    assert!(out.constraint_flags.is_empty());
    assert!(out.constraint_miss.is_empty());
}

/// The precision audit's outline: two R arcs about the origin, two r lobes,
/// joined by four external tangent lines, all seeded 1e-3 off. The tangency of
/// each line to the arc it touches is the row that a wrong convergence stop
/// would leave short.
fn tangent_outline() -> (Input, [f64; 3]) {
    let absent = PointSelector::Absent;
    let (r, lr, d): (f64, f64, f64) = (20.0, 8.0, 30.0);
    let nx = (r - lr) / d;
    let ny = (1.0 - nx * nx).sqrt();
    let theta = ny.atan2(nx).to_degrees();
    let on_big = |sx: f64, sy: f64| [r * sx, r * sy];
    let on_lobe = |cx: f64, sy: f64| [cx + cx.signum() * lr * nx, lr * sy];

    let big_top = [0.0, 0.0, r, theta, 180.0 - theta];
    let left_lobe = [-d, 0.0, lr, 180.0 - theta, 180.0 + theta];
    let big_bottom = [0.0, 0.0, r, 180.0 + theta, 360.0 - theta];
    let right_lobe = [d, 0.0, lr, -theta, theta];
    let big_top_start = on_big(nx, ny);
    let big_top_end = on_big(-nx, ny);
    let left_start = on_lobe(-d, 1.0);
    let left_end = on_lobe(-d, -1.0);
    let big_bottom_start = on_big(-nx, -ny);
    let big_bottom_end = on_big(nx, -ny);
    let right_start = on_lobe(d, -1.0);
    let right_end = on_lobe(d, 1.0);

    let mut exact = Vec::new();
    exact.extend(big_top);
    exact.extend([big_top_end[0], big_top_end[1], left_start[0], left_start[1]]);
    exact.extend(left_lobe);
    exact.extend([
        left_end[0],
        left_end[1],
        big_bottom_start[0],
        big_bottom_start[1],
    ]);
    exact.extend(big_bottom);
    exact.extend([
        big_bottom_end[0],
        big_bottom_end[1],
        right_start[0],
        right_start[1],
    ]);
    exact.extend(right_lobe);
    exact.extend([
        right_end[0],
        right_end[1],
        big_top_start[0],
        big_top_start[1],
    ]);
    // A 1e-3 seed error on every param: well inside the LM's basin, well
    // outside every tolerance this test asserts.
    let seeded = exact.iter().map(|v| v + 1e-3).collect();

    let entities = vec![
        ent(Kind::Arc, 0),
        line(5),
        ent(Kind::Arc, 9),
        line(14),
        ent(Kind::Arc, 18),
        line(23),
        ent(Kind::Arc, 27),
        line(32),
    ];
    let joint = |a: u32, pa: PointSelector, b: u32, pb: PointSelector| {
        cons(ConstraintKind::Coincident, ab(e_ref(a, pa), e_ref(b, pb)))
    };
    let tangent = |a: u32, b: u32| {
        cons(
            ConstraintKind::Tangent,
            ab(e_ref(a, absent), e_ref(b, absent)),
        )
    };
    let mut radius_top = c_target(ConstraintKind::Radius, 0, absent);
    radius_top.value = Some(r);
    let mut radius_bottom = c_target(ConstraintKind::Radius, 4, absent);
    radius_bottom.value = Some(r);
    let mut centre_top = c_target(ConstraintKind::Fixed, 0, PointSelector::Center);
    centre_top.xy = Some((0.0, 0.0));
    let mut centre_bottom = c_target(ConstraintKind::Fixed, 4, PointSelector::Center);
    centre_bottom.xy = Some((0.0, 0.0));

    let constraints = vec![
        joint(0, PointSelector::End, 1, PointSelector::Start),
        joint(1, PointSelector::End, 2, PointSelector::Start),
        joint(2, PointSelector::End, 3, PointSelector::Start),
        joint(3, PointSelector::End, 4, PointSelector::Start),
        joint(4, PointSelector::End, 5, PointSelector::Start),
        joint(5, PointSelector::End, 6, PointSelector::Start),
        joint(6, PointSelector::End, 7, PointSelector::Start),
        joint(7, PointSelector::End, 0, PointSelector::Start),
        tangent(1, 0),
        tangent(1, 2),
        tangent(3, 2),
        tangent(3, 4),
        tangent(5, 4),
        tangent(5, 6),
        tangent(7, 6),
        tangent(7, 0),
        radius_top,
        radius_bottom,
        centre_top,
        centre_bottom,
    ];
    (input(entities, seeded, constraints), [r, lr, d])
}

/// Distance from `p` to the infinite line through `a` and `b`.
fn point_line_distance(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let d = [b[0] - a[0], b[1] - a[1]];
    let len = (d[0] * d[0] + d[1] * d[1]).sqrt();
    let q = [p[0] - a[0], p[1] - a[1]];
    (q[0] * d[1] - q[1] * d[0]).abs() / len
}

#[test]
fn tangent_outline_from_a_millimetre_off_seed_lands_exactly() {
    let (inp, [r, lr, d]) = tangent_outline();
    let out = solve_sketch(&inp);
    assert_ne!(
        out.overall_status,
        Status::Overconstrained.to_u8(),
        "norm {}",
        out.diagnostics.residual_norm
    );
    let (big_top, left_lobe, big_bottom, right_lobe) = (0, 9, 18, 27);
    let line_offsets = [5usize, 14, 23, 32];
    // The scale the verdict reads: the seed's bounding-box diagonal.
    let scale = (2.0 * (d + lr)).hypot(2.0 * r);
    let tol = 1e-9 * scale;

    let params = &out.params_solved;
    // The big arcs are pinned to the origin at exactly R.
    for (cx, cy, cr) in [(0, 1, 2), (18, 19, 20)] {
        assert!(params[cx].abs() < tol, "centre x {}", params[cx]);
        assert!(params[cy].abs() < tol, "centre y {}", params[cy]);
        assert!(
            (params[cr] - r).abs() <= 1e-12 * r,
            "radius {} want {r}",
            params[cr]
        );
    }
    let arc_end = |off: usize, deg: f64| arc_point(&params[off..off + 5], deg);

    // Every coincidence: the two named points of each joint.
    let joints = [
        (
            arc_end(big_top, params[big_top + 4]),
            line_offsets[0],
            0usize,
        ),
        (
            arc_end(left_lobe, params[left_lobe + 3]),
            line_offsets[0],
            2,
        ),
        (
            arc_end(left_lobe, params[left_lobe + 4]),
            line_offsets[1],
            0,
        ),
        (
            arc_end(big_bottom, params[big_bottom + 3]),
            line_offsets[1],
            2,
        ),
        (
            arc_end(big_bottom, params[big_bottom + 4]),
            line_offsets[2],
            0,
        ),
        (
            arc_end(right_lobe, params[right_lobe + 3]),
            line_offsets[2],
            2,
        ),
        (
            arc_end(right_lobe, params[right_lobe + 4]),
            line_offsets[3],
            0,
        ),
        (arc_end(big_top, params[big_top + 3]), line_offsets[3], 2),
    ];
    for (point, line_off, end) in joints {
        let got = if end == 0 {
            [params[line_off], params[line_off + 1]]
        } else {
            [params[line_off + 2], params[line_off + 3]]
        };
        let gap = (point[0] - got[0]).hypot(point[1] - got[1]);
        assert!(gap < tol, "joint gap {gap} want < {tol}");
    }

    // Every line's distance from each arc centre it touches equals that
    // arc's radius: the tangency residual the convergence must clear.
    let tangencies = [
        (0usize, line_offsets[0]),
        (left_lobe, line_offsets[0]),
        (left_lobe, line_offsets[1]),
        (big_bottom, line_offsets[1]),
        (big_bottom, line_offsets[2]),
        (right_lobe, line_offsets[2]),
        (right_lobe, line_offsets[3]),
        (big_top, line_offsets[3]),
    ];
    for (arc_off, line_off) in tangencies {
        let centre = [params[arc_off], params[arc_off + 1]];
        let a = [params[line_off], params[line_off + 1]];
        let b = [params[line_off + 2], params[line_off + 3]];
        let miss = (point_line_distance(centre, a, b) - params[arc_off + 2]).abs();
        assert!(miss < tol, "tangency miss {miss} want < {tol}");
    }
}

fn axis_distance(kind: ConstraintKind, b: Ref, value: f64, sign: Option<f64>) -> Constraint {
    Constraint {
        kind_code: kind.to_u8(),
        refs: ab(Ref::External { x: 0.0, y: 0.0 }, b),
        value: Some(value),
        sign,
        ..Default::default()
    }
}

#[test]
fn an_unsigned_zero_axis_distance_is_fully_constrained() {
    // The minimal repro: point (0, 1.5) against the fixed origin, x distance
    // 0 unsigned and y distance 1.5 signed. The zero row's central difference
    // of |x| used to be empty, so the sketch read one free DOF and the zero
    // dimension read redundant.
    let inp = input(
        vec![point(0)],
        vec![0.0, 1.5],
        vec![
            axis_distance(
                ConstraintKind::PointDistanceX,
                e_ref(0, PointSelector::Xy),
                0.0,
                None,
            ),
            axis_distance(
                ConstraintKind::PointDistanceY,
                e_ref(0, PointSelector::Xy),
                1.5,
                Some(1.0),
            ),
        ],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    assert_eq!(out.diagnostics.dof, 0);
    assert!(
        out.constraint_flags.iter().all(|&f| f == 0),
        "the zero dimension was blamed: {:?}",
        out.constraint_flags
    );
}

#[test]
fn an_unsigned_zero_axis_distance_converges_from_an_off_zero_seed() {
    // The same sketch seeded at x = 0.3. With an empty row the |x| kink gave
    // the solve no gradient to follow; the row now walks the point to zero.
    let inp = input(
        vec![point(0)],
        vec![0.3, 1.5],
        vec![
            axis_distance(
                ConstraintKind::PointDistanceX,
                e_ref(0, PointSelector::Xy),
                0.0,
                None,
            ),
            axis_distance(
                ConstraintKind::PointDistanceY,
                e_ref(0, PointSelector::Xy),
                1.5,
                Some(1.0),
            ),
        ],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    let p = &out.params_solved;
    assert!(p[0].abs() < 1e-6, "x did not converge to zero: {p:?}");
    assert!((p[1] - 1.5).abs() < 1e-6, "y moved off 1.5: {p:?}");
}

#[test]
fn the_ex006_plate_is_fully_constrained_without_a_redundant_row() {
    // The practice run's plate (Ex006): an outer circle on the origin, a square
    // whose midpoint-defined centre and a hole are each dimensioned with one
    // signed and one unsigned axis distance. The unsigned zeros are the two
    // rows the finite difference used to empty, costing 2 DOF and flagging both
    // constraints redundant.
    let origin = Ref::External { x: 0.0, y: 0.0 };
    let mut radius_outer = c_target(ConstraintKind::Radius, 0, PointSelector::Absent);
    radius_outer.value = Some(3.0);
    let mut radius_hole = c_target(ConstraintKind::Radius, 6, PointSelector::Absent);
    radius_hole.value = Some(0.25);
    let mut length1 = c_target(ConstraintKind::Length, 1, PointSelector::Absent);
    length1.value = Some(0.5);
    let mut length2 = c_target(ConstraintKind::Length, 2, PointSelector::Absent);
    length2.value = Some(0.5);
    let midpoint = Constraint {
        kind_code: ConstraintKind::Midpoint.to_u8(),
        refs: vec![
            (RefRole::PointA, e_ref(1, PointSelector::Start)),
            (RefRole::PointB, e_ref(3, PointSelector::Start)),
            (RefRole::Point, e_ref(5, PointSelector::Xy)),
        ],
        ..Default::default()
    };

    let inp = input(
        vec![
            ent(Kind::Circle, 0),
            line(3),
            line(7),
            line(11),
            line(15),
            point(19),
            ent(Kind::Circle, 21),
        ],
        vec![
            0.0, 0.0, 3.0, // outer circle
            1.25, -0.25, 1.75, -0.25, // sq1
            1.75, -0.25, 1.75, 0.25, // sq2
            1.75, 0.25, 1.25, 0.25, // sq3
            1.25, 0.25, 1.25, -0.25, // sq4
            1.5, 0.0, // sqc
            0.0, 1.5, 0.25, // hole
        ],
        vec![
            radius_outer,
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(0, PointSelector::Center), origin),
            ),
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(1, PointSelector::End), e_ref(2, PointSelector::Start)),
            ),
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(2, PointSelector::End), e_ref(3, PointSelector::Start)),
            ),
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(3, PointSelector::End), e_ref(4, PointSelector::Start)),
            ),
            cons(
                ConstraintKind::Coincident,
                ab(e_ref(4, PointSelector::End), e_ref(1, PointSelector::Start)),
            ),
            cons(
                ConstraintKind::EqualLength,
                ab(
                    e_ref(1, PointSelector::Absent),
                    e_ref(3, PointSelector::Absent),
                ),
            ),
            cons(
                ConstraintKind::EqualLength,
                ab(
                    e_ref(2, PointSelector::Absent),
                    e_ref(4, PointSelector::Absent),
                ),
            ),
            c_target(ConstraintKind::Horizontal, 1, PointSelector::Absent),
            c_target(ConstraintKind::Vertical, 2, PointSelector::Absent),
            midpoint,
            length1,
            length2,
            axis_distance(
                ConstraintKind::PointDistanceX,
                e_ref(5, PointSelector::Xy),
                1.5,
                Some(1.0),
            ),
            axis_distance(
                ConstraintKind::PointDistanceY,
                e_ref(5, PointSelector::Xy),
                0.0,
                None,
            ),
            radius_hole,
            axis_distance(
                ConstraintKind::PointDistanceX,
                e_ref(6, PointSelector::Center),
                0.0,
                None,
            ),
            axis_distance(
                ConstraintKind::PointDistanceY,
                e_ref(6, PointSelector::Center),
                1.5,
                Some(1.0),
            ),
        ],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    assert_eq!(out.diagnostics.dof, 0, "the plate kept free DOF");
    assert!(
        out.constraint_flags.iter().all(|&f| f == 0),
        "a plate constraint reads redundant: {:?}",
        out.constraint_flags
    );
}

#[test]
fn a_zero_radius_difference_pins_the_second_radius() {
    // Both circles seeded at radius 1, concentric, one radius fixed by the
    // lower circle: a gap of 0 must pin the upper radius too. The finite
    // difference of |ra - rb| at the zero gap used to be empty, leaving the
    // radius free and the dimension redundant.
    let fixed_a = c_target(ConstraintKind::Fixed, 0, PointSelector::Absent);
    let gap = Constraint {
        kind_code: ConstraintKind::RadiusDifference.to_u8(),
        refs: ab(
            e_ref(0, PointSelector::Absent),
            e_ref(1, PointSelector::Absent),
        ),
        value: Some(0.0),
        ..Default::default()
    };
    let inp = input(
        vec![ent(Kind::Circle, 0), ent(Kind::Circle, 3)],
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
        vec![
            fixed_a,
            cons(
                ConstraintKind::Concentric,
                ab(
                    e_ref(0, PointSelector::Absent),
                    e_ref(1, PointSelector::Absent),
                ),
            ),
            gap,
        ],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    assert_eq!(out.diagnostics.dof, 0);
    assert!(
        out.constraint_flags.iter().all(|&f| f == 0),
        "the zero gap reads redundant: {:?}",
        out.constraint_flags
    );
}

// A radius is a magnitude in the document. The solver's parameter is signed,
// and a free circle in a degenerate basin can be driven through zero and out
// the other side; that answer is not a sketch the area builder or OCC can use.
// The gate must call it unsatisfied, and the culprit walk must not claim the
// force-free circle is just underconstrained.
#[test]
fn a_negative_solved_radius_is_overconstrained_not_underconstrained() {
    let inp = input(vec![ent(Kind::Circle, 0)], vec![0.0, 0.0, -1.0], vec![]);
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
    assert!(out.params_solved[2] <= 0.0);
}

#[test]
fn a_positive_solved_radius_stays_underconstrained() {
    let inp = input(vec![ent(Kind::Circle, 0)], vec![0.0, 0.0, 5.0], vec![]);
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
}

#[test]
fn a_negative_radius_in_a_drag_frame_is_not_a_committable_frame() {
    let mut inp = input(vec![ent(Kind::Circle, 0)], vec![0.0, 0.0, -1.0], vec![]);
    inp.options.drag_mode = true;
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
}

#[test]
fn a_degenerate_arc_names_every_constraint_that_touches_it() {
    let radius = c_target(ConstraintKind::Radius, 0, PointSelector::Absent);
    let inp = input(
        vec![ent(Kind::Arc, 0)],
        vec![0.0, 0.0, 0.0, 0.0, 90.0],
        vec![radius],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Overconstrained.to_u8());
    assert!(
        out.constraint_miss[0] > 0.0,
        "the radius constraint that touches the degenerate arc must be a culprit"
    );
}
