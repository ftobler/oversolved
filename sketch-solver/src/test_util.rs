//! Shared test utilities used across solver test modules.

use crate::constraints::{Constraint, ConstraintKind, PointSelector, Ref, RefRole};
use crate::{Entity, Input, Kind, Options};

pub fn ent(kind: Kind, off: usize) -> Entity {
    Entity { kind, param_offset: off }
}

pub fn line(off: usize) -> Entity {
    ent(Kind::Line, off)
}

pub fn point(off: usize) -> Entity {
    ent(Kind::Point, off)
}

pub fn ellipse(off: usize) -> Entity {
    ent(Kind::Ellipse, off)
}

pub fn spline(off: usize) -> Entity {
    ent(Kind::Spline, off)
}

pub fn target(index: u32, point: PointSelector) -> (RefRole, Ref) {
    (RefRole::Target, Ref::Entity { index, point })
}

pub fn ab(a: Ref, b: Ref) -> Vec<(RefRole, Ref)> {
    vec![(RefRole::A, a), (RefRole::B, b)]
}

pub fn e_ref(index: u32, point: PointSelector) -> Ref {
    Ref::Entity { index, point }
}

pub fn cons(kind: ConstraintKind, refs: Vec<(RefRole, Ref)>) -> Constraint {
    Constraint {
        kind_code: kind.to_u8(),
        refs,
        ..Default::default()
    }
}

pub fn cons_v(kind: ConstraintKind, refs: Vec<(RefRole, Ref)>, value: f64) -> Constraint {
    Constraint {
        kind_code: kind.to_u8(),
        refs,
        value: Some(value),
        ..Default::default()
    }
}

/// A dimension constraint carrying both a value and an orientation `sign`
/// (`+1.0` / `-1.0`), for the directional dimensions (distance_x/y,
/// line_distance, angle).
pub fn cons_vs(
    kind: ConstraintKind,
    refs: Vec<(RefRole, Ref)>,
    value: f64,
    sign: f64,
) -> Constraint {
    Constraint {
        kind_code: kind.to_u8(),
        refs,
        value: Some(value),
        sign: Some(sign),
        ..Default::default()
    }
}

pub fn c_target(kind: ConstraintKind, index: u32, point: PointSelector) -> Constraint {
    Constraint {
        kind_code: kind.to_u8(),
        refs: vec![(RefRole::Target, Ref::Entity { index, point })],
        ..Default::default()
    }
}

pub fn input(entities: Vec<Entity>, params: Vec<f32>, constraints: Vec<Constraint>) -> Input {
    Input {
        entities,
        params_initial: params,
        pinned_mask: Vec::new(),
        equality_pins: Vec::new(),
        constraints,
        options: Options::default(),
    }
}
