use super::*;
use crate::fit_spline::{FitSpline, ParamLayout, FLAG_HANDLE_START};

/// A `fit_spline` entity record with the layout its params imply.
fn fit_entity(off: usize, points: usize, flags: u8) -> Entity {
    let handles = (flags & 1 != 0) as usize + (flags & 2 != 0) as usize;
    Entity {
        kind: Kind::FitSpline,
        param_offset: off,
        param_count: 2 * points + 2 * handles,
        flags,
    }
}

/// Ex010's eight fit points, the fixture the golden and kernel tests share.
fn ex010() -> Vec<f64> {
    [
        (3.0, 1.0),
        (2.75, 1.5),
        (2.5, 1.75),
        (2.0, 1.5),
        (1.5, 1.0),
        (1.0, 1.25),
        (0.5, 1.0),
        (0.0, 1.0),
    ]
    .iter()
    .flat_map(|p| [p.0, p.1])
    .collect()
}

/// Pin every param of the listed entity indices to its initial value.
fn pin_entities(inp: &mut Input, indices: &[usize]) {
    let n = inp.params_initial.len();
    let mut mask = vec![0u8; n.div_ceil(8)];
    for &index in indices {
        let e = &inp.entities[index];
        for i in e.param_offset..e.param_offset + e.param_count {
            mask[i / 8] |= 1 << (i % 8);
        }
    }
    inp.pinned_mask = mask;
}

#[test]
fn a_point_on_a_pinned_ex010_fit_spline_lands_on_the_curve() {
    // The fit spline is pinned; the point's x is held at 1.25 by a
    // point_distance_x to a fixed origin, so only y can move onto the curve.
    let mut params = ex010();
    params.extend_from_slice(&[1.25, 4.0, 0.0, 0.0]);
    let fit = fit_entity(0, 8, 0);
    let point = ent(Kind::Point, 16);
    let origin = ent(Kind::Point, 18);
    let constraints = vec![
        Constraint {
            kind_code: ConstraintKind::Fixed.to_u8(),
            refs: vec![(
                RefRole::Target,
                Ref::Entity {
                    index: 2,
                    point: PointSelector::Xy,
                },
            )],
            xy: Some((0.0, 0.0)),
            ..Default::default()
        },
        Constraint {
            kind_code: ConstraintKind::PointDistanceX.to_u8(),
            refs: ab(
                Ref::Entity {
                    index: 2,
                    point: PointSelector::Xy,
                },
                Ref::Entity {
                    index: 1,
                    point: PointSelector::Xy,
                },
            ),
            value: Some(1.25),
            sign: Some(1.0),
            ..Default::default()
        },
        Constraint {
            kind_code: ConstraintKind::Coincident.to_u8(),
            refs: ab(
                Ref::Entity {
                    index: 1,
                    point: PointSelector::Xy,
                },
                Ref::Entity {
                    index: 0,
                    point: PointSelector::Absent,
                },
            ),
            ..Default::default()
        },
    ];
    let mut inp = input(vec![fit, point, origin], params, constraints);
    pin_entities(&mut inp, &[0, 2]);
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    let solved = [out.params_solved[16], out.params_solved[17]];
    assert!((solved[0] - 1.25).abs() < 1e-9, "x moved: {solved:?}");

    // The solved point must sit on the golden-pinned curve. The scan is only a
    // sanity bound on the branch: Ex010 descends in x, so the point at x = 1.25
    // is the one between (1.5, 1.0) and (1.0, 1.25).
    let points: Vec<[f64; 2]> = ex010().chunks_exact(2).map(|p| [p[0], p[1]]).collect();
    let curve = FitSpline::new(&points, None, None).unwrap();
    let closest = curve.closest(solved);
    assert!(
        closest.distance < 1e-9,
        "point {solved:?} is {} off the curve",
        closest.distance
    );
    assert!(
        (solved[1] - 1.13).abs() < 0.05,
        "y {} is not on the expected branch",
        solved[1]
    );
}

#[test]
fn a_line_tangent_at_the_start_rotates_the_handle_not_the_points() {
    // Fit points and the line are pinned, so the only free params are the
    // start handle's two scalars. The tangent row must satisfy itself there.
    let mut params = ex010();
    params.extend_from_slice(&[4.0, 3.0]); // start handle, not axis aligned
    params.extend_from_slice(&[3.0, 1.0, 3.0, 3.0]); // line start/end
    let fit = fit_entity(0, 8, FLAG_HANDLE_START);
    let line = ent(Kind::Line, 18);
    let constraints = vec![Constraint {
        kind_code: ConstraintKind::Tangent.to_u8(),
        refs: ab(
            Ref::Entity {
                index: 1,
                point: PointSelector::Absent,
            },
            Ref::Entity {
                index: 0,
                point: PointSelector::Start,
            },
        ),
        ..Default::default()
    }];
    let mut inp = input(vec![fit, line], params, constraints);
    // Pin the fit points (0..16) and the line (18..22), leaving 16..18 free.
    let n = inp.params_initial.len();
    let mut mask = vec![0u8; n.div_ceil(8)];
    for i in (0..16).chain(18..22) {
        mask[i / 8] |= 1 << (i % 8);
    }
    inp.pinned_mask = mask;
    let out = solve_sketch(&inp);
    assert!(
        out.diagnostics.residual_norm < 1e-8,
        "tangent not satisfied: {}",
        out.diagnostics.residual_norm
    );
    // The handle moved, the fit points did not (the pins are residuals, so a
    // solve leaves them within the verdict width, not bit-exactly).
    assert!((out.params_solved[16] - 4.0).abs() > 1e-6);
    assert!((out.params_solved[0] - 3.0).abs() < 1e-9);
}

#[test]
fn a_tangent_without_a_handle_moves_the_fit_points() {
    // Raw solver input, no authoring sugar: the constraint has to be satisfied
    // by the points, which is exactly why authoring adds a handle first.
    let mut params = ex010();
    params.extend_from_slice(&[3.0, 1.0, 3.0, 3.0]);
    let fit = fit_entity(0, 8, 0);
    let line = ent(Kind::Line, 16);
    let constraints = vec![Constraint {
        kind_code: ConstraintKind::Tangent.to_u8(),
        refs: ab(
            Ref::Entity {
                index: 1,
                point: PointSelector::Absent,
            },
            Ref::Entity {
                index: 0,
                point: PointSelector::Start,
            },
        ),
        ..Default::default()
    }];
    let mut inp = input(vec![fit, line], params, constraints);
    pin_entities(&mut inp, &[1]);
    let out = solve_sketch(&inp);
    assert!(
        out.diagnostics.residual_norm < 1e-6,
        "tangent not satisfied: {}",
        out.diagnostics.residual_norm
    );
    assert!(
        (out.params_solved[0] - 3.0).abs() > 1e-9 || (out.params_solved[1] - 1.0).abs() > 1e-9,
        "the fit points did not move"
    );
}

#[test]
fn an_unconstrained_fit_spline_has_its_own_dof_and_fixed_pins_it() {
    let fit = fit_entity(0, 4, 0);
    let inp = input(
        vec![fit],
        vec![0.0, 0.0, 1.0, 2.0, 3.0, 1.0, 4.0, 3.0],
        vec![],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::Underconstrained.to_u8());
    assert_eq!(out.diagnostics.dof, 8);

    let fit = fit_entity(0, 4, 0);
    let fixed = c_target(ConstraintKind::Fixed, 0, PointSelector::Absent);
    let inp = input(
        vec![fit],
        vec![0.0, 0.0, 1.0, 2.0, 3.0, 1.0, 4.0, 3.0],
        vec![fixed],
    );
    let out = solve_sketch(&inp);
    assert_eq!(out.overall_status, Status::FullyConstrained.to_u8());
    assert_eq!(out.diagnostics.dof, 0);
}

#[test]
fn a_handle_ref_without_a_handle_is_dropped_not_panicked() {
    let fit = fit_entity(0, 3, 0);
    let point = ent(Kind::Point, 6);
    let constraints = vec![Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: ab(
            Ref::Entity {
                index: 1,
                point: PointSelector::Xy,
            },
            Ref::Entity {
                index: 0,
                point: PointSelector::C1,
            },
        ),
        ..Default::default()
    }];
    let inp = input(
        vec![fit, point],
        vec![0.0, 0.0, 1.0, 2.0, 3.0, 1.0, 5.0, 5.0],
        constraints,
    );
    let p = Problem::new(&inp);
    assert_eq!(p.constraints().len(), 0);
    assert!(p.residuals(&p.x0).is_empty());
}

#[test]
fn an_out_of_range_fit_point_ref_is_dropped() {
    let fit = fit_entity(0, 3, 0);
    let point = ent(Kind::Point, 6);
    let constraints = vec![Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: ab(
            Ref::Entity {
                index: 1,
                point: PointSelector::Xy,
            },
            Ref::Entity {
                index: 0,
                point: PointSelector::Fit(2),
            },
        ),
        ..Default::default()
    }];
    let inp = input(
        vec![fit, point],
        vec![0.0, 0.0, 1.0, 2.0, 3.0, 1.0, 5.0, 5.0],
        constraints,
    );
    let p = Problem::new(&inp);
    assert_eq!(p.constraints().len(), 0);
    // Fit(1) is the one interior point of a three-point spline.
    let ok = Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: ab(
            Ref::Entity {
                index: 1,
                point: PointSelector::Xy,
            },
            Ref::Entity {
                index: 0,
                point: PointSelector::Fit(1),
            },
        ),
        ..Default::default()
    };
    let inp = input(
        vec![fit_entity(0, 3, 0), ent(Kind::Point, 6)],
        vec![0.0, 0.0, 1.0, 2.0, 3.0, 1.0, 5.0, 5.0],
        vec![ok],
    );
    let p = Problem::new(&inp);
    assert_eq!(p.constraints().len(), 1);
    let r = p.residuals(&p.x0);
    // Point (5,5) against fit point 1 (1,2): a two-row point-point residual.
    assert_eq!(r.len(), 2);
    assert!((r[0] - 4.0).abs() < 1e-12 && (r[1] - 3.0).abs() < 1e-12);
}

#[test]
fn a_duplicate_coincident_on_an_interior_fit_point_is_redundant() {
    let fit = fit_entity(0, 4, 0);
    let point = ent(Kind::Point, 8);
    let coincident = Constraint {
        kind_code: ConstraintKind::Coincident.to_u8(),
        refs: ab(
            Ref::Entity {
                index: 1,
                point: PointSelector::Xy,
            },
            Ref::Entity {
                index: 0,
                point: PointSelector::Fit(2),
            },
        ),
        ..Default::default()
    };
    let mut inp = input(
        vec![fit, point],
        vec![0.0, 0.0, 1.0, 2.0, 3.0, 1.0, 4.0, 3.0, 3.0, 1.0],
        vec![coincident.clone(), coincident],
    );
    pin_entities(&mut inp, &[0]);
    let out = solve_sketch(&inp);
    assert_eq!(out.constraint_flags.len(), 2);
    assert_eq!(
        out.constraint_flags[0] & crate::CONSTRAINT_FLAG_REDUNDANT,
        0
    );
    assert_ne!(
        out.constraint_flags[1] & crate::CONSTRAINT_FLAG_REDUNDANT,
        0
    );
}

#[test]
fn the_param_layout_of_a_fit_entity_matches_its_record() {
    for (points, flags) in [(2, 0), (4, 0), (3, 1), (5, 3)] {
        let entity = fit_entity(0, points, flags);
        let layout = ParamLayout::from_wire(entity.param_count, entity.flags).unwrap();
        assert_eq!(layout.points, points);
        assert_eq!(
            2 * layout.points + 2 * (layout.handle_start as usize + layout.handle_end as usize),
            entity.param_count
        );
    }
}
