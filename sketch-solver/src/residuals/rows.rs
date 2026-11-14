//! Row classes for the kernel precision contract: what each residual row
//! measures, so `solve::finish_contract` can ask every row for a width the
//! downstream B-rep kernel agrees with.
//!
//! Every row is already a length (see `scale.rs`), but the two families answer
//! different questions. An ANGULAR row is `sin(angle)` times a seed length, so
//! dividing it by that same seed length reads a dimensionless angle: the
//! contract is OCC's angular precision. A POSITIONAL row already is a world
//! distance, so it is compared against the positional rung directly.
//!
//! The class of a constraint's rows is computed, not stored on the row: the
//! residual builders push bare f64s (and `jacobian.rs` mirrors their count), so
//! a parallel tag vector would be a third thing to keep in sync. This walk
//! mirrors `residual_one`'s branch structure instead, and `row_tags_cover_every_kind`
//! plus the per-kind count assertions pin it to the builders. The counts are a
//! HARD invariant: `contract_rows` asserts one class per pushed row in debug
//! builds, and a release build that somehow hit a mismatch reads the row as
//! `RowClass::Unclassified`, which makes both misses non-finite rather than
//! quietly granting the row a looser target.

use super::geom::is_curve;
use super::Problem;
use crate::constraints::{Axis, Constraint, ConstraintKind, Ref, RefRole};
use crate::tolerance::{contract_angular, contract_positional};
use crate::Kind;

/// What one residual row measures.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RowClass {
    /// `sin(angle) * seed_len` (or an angle error times a seed length): the
    /// realised angle is `|row| / seed_len`.
    Angular { seed_len: f64 },
    /// A world distance (a coincidence, a dimension, a radius, a pin).
    Positional,
    /// A non-world scalar: an arc's endpoint angle or an ellipse's rotation, in
    /// degrees. The contract is about lengths and angles in the kernel's units,
    /// so a degree-valued row has no honest width here and is excluded from
    /// both misses rather than compared as if it were a world distance.
    Parameter,
    /// A row the walk did not classify. This is a programming error (the debug
    /// assertion in `contract_rows` catches it in tests); in a release build it
    /// reads as non-finite misses so no caller mistakes it for a satisfied
    /// contract. It is never a target.
    Unclassified,
}

impl RowClass {
    /// The absolute row width the contract asks of this class. `Parameter` and
    /// `Unclassified` have none: the first is excluded from the contract, the
    /// second is a failure.
    pub fn target(self) -> f64 {
        match self {
            RowClass::Angular { seed_len } => contract_angular(seed_len),
            RowClass::Positional => contract_positional(),
            RowClass::Parameter | RowClass::Unclassified => 0.0,
        }
    }
}

/// `n` positional rows.
fn positional(n: usize) -> Vec<RowClass> {
    vec![RowClass::Positional; n]
}

/// `n` angular rows over one seed length.
fn angular(n: usize, seed_len: f64) -> Vec<RowClass> {
    vec![RowClass::Angular { seed_len }; n]
}

/// The class of one raw param of an entity of `kind`: `Kind::Arc` stores
/// `(cx, cy, r, a0, a1)` and `Kind::Ellipse` `(cx, cy, rx, ry, theta)`, so the
/// trailing degree slots are the only non-world scalars. Everything else is a
/// position, a length or a control point.
fn param_class(kind: Kind, index: usize) -> RowClass {
    match kind {
        Kind::Arc if index >= 3 => RowClass::Parameter,
        Kind::Ellipse if index == 4 => RowClass::Parameter,
        _ => RowClass::Positional,
    }
}

impl Problem<'_> {
    /// One class per row `residual_one` pushes for `c`, in the same order. A
    /// constraint whose roles are missing or whose operand kinds its builder
    /// rejects contributes no rows here either, so the lengths stay equal.
    pub fn row_classes(&self, c: &Constraint) -> Vec<RowClass> {
        let Some(kind) = c.kind() else {
            return Vec::new();
        };
        match kind {
            ConstraintKind::Horizontal => self.class_axis_aligned(c, true),
            ConstraintKind::Vertical => self.class_axis_aligned(c, false),
            ConstraintKind::Length | ConstraintKind::Radius | ConstraintKind::Diameter => {
                self.class_dimension(c)
            }
            ConstraintKind::LineDistance
            | ConstraintKind::PointDistance
            | ConstraintKind::PointDistanceX
            | ConstraintKind::PointDistanceY => self.class_pair_dimension(c),
            ConstraintKind::RadiusDifference => self.class_radius_difference(c),
            ConstraintKind::Coincident => self.class_coincident(c),
            ConstraintKind::Normal => self.class_normal(c),
            ConstraintKind::Parallel => self.class_parallel(c),
            ConstraintKind::Angle => self.class_angle(c),
            ConstraintKind::Tangent => self.class_tangent(c),
            ConstraintKind::EqualLength => self.class_equal_length(c),
            ConstraintKind::Midpoint => self.class_midpoint(c),
            ConstraintKind::Concentric => self.class_concentric(c),
            ConstraintKind::Fixed => self.class_fixed(c),
            ConstraintKind::Group => self.class_group(c),
        }
    }

    /// A dimension whose builder reads one world-distance row. The kind gates
    /// the builder applies are already enforced by `operand_kinds_supply_slots`
    /// before a constraint survives, so the row count depends only on the
    /// payload being present.
    fn class_dimension(&self, c: &Constraint) -> Vec<RowClass> {
        match (c.ref_for(RefRole::Target), c.value) {
            (Some(Ref::Entity { .. }), Some(_)) => positional(1),
            _ => Vec::new(),
        }
    }

    /// A two-operand dimension: A and B plus a value, one row.
    fn class_pair_dimension(&self, c: &Constraint) -> Vec<RowClass> {
        match (c.ref_for(RefRole::A), c.ref_for(RefRole::B), c.value) {
            (Some(_), Some(_), Some(_)) => positional(1),
            _ => Vec::new(),
        }
    }

    fn class_radius_difference(&self, c: &Constraint) -> Vec<RowClass> {
        let pair = (c.ref_for(RefRole::A), c.ref_for(RefRole::B), c.value);
        let (Some(Ref::Entity { index: a, .. }), Some(Ref::Entity { index: b, .. }), Some(_)) =
            pair
        else {
            return Vec::new();
        };
        if is_curve(self.kind_of(a)) && is_curve(self.kind_of(b)) {
            positional(1)
        } else {
            Vec::new()
        }
    }

    /// Horizontal/vertical: a coordinate difference. Both forms read as an
    /// angle over a lever arm, so they take the angular rung. The bare-entity
    /// form's lever is the line's own seed length; the two-point form's is the
    /// seed separation along the OTHER axis, which is the distance the tilt
    /// acts over.
    fn class_axis_aligned(&self, c: &Constraint, horizontal: bool) -> Vec<RowClass> {
        if let (Some(a), Some(b)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) {
            let (pa, pb) = (self.point(&self.x0, a), self.point(&self.x0, b));
            let lever = if horizontal {
                (pa[0] - pb[0]).abs()
            } else {
                (pa[1] - pb[1]).abs()
            };
            return angular(1, lever.max(self.min_len()));
        }
        match c.ref_for(RefRole::Target) {
            Some(Ref::Entity { index, .. }) => angular(1, self.line_len0(index)),
            _ => Vec::new(),
        }
    }

    /// Collinear (line/line) is two rows: the parallel row first, then B's
    /// start on A's line. Every other form is a point on a carrier or a
    /// point-to-point coincidence, all positional.
    fn class_coincident(&self, c: &Constraint) -> Vec<RowClass> {
        let (Some(a_ref), Some(b_ref)) = (c.ref_for(RefRole::A), c.ref_for(RefRole::B)) else {
            return Vec::new();
        };
        let entity_of = |r: &Ref| match r {
            Ref::Entity { index, .. } => Some((*index, self.kind_of(*index))),
            _ => None,
        };
        let (a_entity, b_entity) = (entity_of(&a_ref), entity_of(&b_ref));
        let a_point = self.ref_is_point(&a_ref);
        let b_point = self.ref_is_point(&b_ref);
        if !a_point
            && !b_point
            && matches!(a_entity, Some((_, Kind::Line)))
            && matches!(b_entity, Some((_, Kind::Line)))
        {
            let (Some((a, _)), Some((b, _))) = (a_entity, b_entity) else {
                return Vec::new();
            };
            let mut classes = angular(1, self.line_pair_len0(a, b));
            classes.push(RowClass::Positional);
            return classes;
        }
        let b_carrier = matches!(
            b_entity,
            Some((
                _,
                Kind::Line
                    | Kind::Circle
                    | Kind::Arc
                    | Kind::Ellipse
                    | Kind::Spline
                    | Kind::FitSpline
            ))
        );
        let a_carrier = matches!(
            a_entity,
            Some((
                _,
                Kind::Line
                    | Kind::Circle
                    | Kind::Arc
                    | Kind::Ellipse
                    | Kind::Spline
                    | Kind::FitSpline
            ))
        );
        if (!b_point && b_carrier) || (!a_point && a_carrier && b_point) {
            return positional(1);
        }
        positional(2)
    }

    /// Line/line normal is `cos(angle)` times a seed length. The line/curve
    /// form is `sin(angle to the contact normal)` times the line's length.
    /// Either way it is an angular row; a pairing the builder rejects is no
    /// row.
    fn class_normal(&self, c: &Constraint) -> Vec<RowClass> {
        let (Some(Ref::Entity { index: a, .. }), Some(Ref::Entity { index: b, .. })) =
            (c.ref_for(RefRole::A), c.ref_for(RefRole::B))
        else {
            return Vec::new();
        };
        let (ka, kb) = (self.kind_of(a), self.kind_of(b));
        if ka == Kind::Line && kb == Kind::Line {
            return angular(1, self.line_pair_len0(a, b));
        }
        let line = if ka == Kind::Line {
            a
        } else if kb == Kind::Line {
            b
        } else {
            return Vec::new();
        };
        let curve = if ka == Kind::Line { kb } else { ka };
        if matches!(
            curve,
            Kind::Circle | Kind::Arc | Kind::Ellipse | Kind::Spline | Kind::FitSpline
        ) {
            angular(1, self.line_len0(line))
        } else {
            Vec::new()
        }
    }

    fn class_parallel(&self, c: &Constraint) -> Vec<RowClass> {
        let (Some(Ref::Entity { index: a, .. }), Some(Ref::Entity { index: b, .. })) =
            (c.ref_for(RefRole::A), c.ref_for(RefRole::B))
        else {
            return Vec::new();
        };
        if self.kind_of(a) != Kind::Line || self.kind_of(b) != Kind::Line {
            return Vec::new();
        }
        angular(1, self.line_pair_len0(a, b))
    }

    fn class_angle(&self, c: &Constraint) -> Vec<RowClass> {
        let (Some(Ref::Entity { index: a, .. }), Some(Ref::Entity { index: b, .. }), Some(_)) =
            (c.ref_for(RefRole::A), c.ref_for(RefRole::B), c.value)
        else {
            return Vec::new();
        };
        angular(1, self.line_pair_len0(a, b))
    }

    /// The tangency arms follow `r_tangent`: a pinned contact or a direction
    /// against a curve tangent is angular, a centre distance or a support
    /// distance is positional.
    fn class_tangent(&self, c: &Constraint) -> Vec<RowClass> {
        let Some((first, second, _)) = self.tangent_operands(c) else {
            return Vec::new();
        };
        if !matches!(self.kind_of(first), Kind::Line) {
            if self.tangent_contact.contains_key(&(first, second)) {
                return angular(1, self.curve_pair_radius0(first, second));
            }
            return positional(1);
        }
        match self.kind_of(second) {
            Kind::Spline => angular(1, self.line_len0(first)),
            Kind::FitSpline => angular(1, self.fit_len0(second)),
            Kind::Circle | Kind::Arc => {
                if self.tangent_contact.contains_key(&(first, second)) {
                    angular(1, self.line_len0(first))
                } else {
                    positional(1)
                }
            }
            Kind::Ellipse => positional(1),
            _ => Vec::new(),
        }
    }

    fn class_equal_length(&self, c: &Constraint) -> Vec<RowClass> {
        let (Some(Ref::Entity { index: a, .. }), Some(Ref::Entity { index: b, .. })) =
            (c.ref_for(RefRole::A), c.ref_for(RefRole::B))
        else {
            return Vec::new();
        };
        let (ka, kb) = (self.kind_of(a), self.kind_of(b));
        if (ka == Kind::Line && kb == Kind::Line) || (is_curve(ka) && is_curve(kb)) {
            positional(1)
        } else {
            Vec::new()
        }
    }

    fn class_midpoint(&self, c: &Constraint) -> Vec<RowClass> {
        let has_mid = c.ref_for(RefRole::Line).is_some()
            || (c.ref_for(RefRole::PointA).is_some() && c.ref_for(RefRole::PointB).is_some());
        if !has_mid || c.ref_for(RefRole::Point).is_none() {
            return Vec::new();
        }
        let axis = c.axis.unwrap_or(Axis::Both);
        positional(axis.includes_x() as usize + axis.includes_y() as usize)
    }

    fn class_concentric(&self, c: &Constraint) -> Vec<RowClass> {
        if c.ref_for(RefRole::A).is_some() && c.ref_for(RefRole::B).is_some() {
            positional(2)
        } else {
            Vec::new()
        }
    }

    /// A fixed row set: a named point gives a coordinate pair, the bare entity
    /// pins every param. A pinned shape scalar (an arc angle in degrees, an
    /// ellipse's rotation) is not a world distance and is classed as
    /// `Parameter`, not read as one.
    fn class_fixed(&self, c: &Constraint) -> Vec<RowClass> {
        let Some(Ref::Entity { index, point }) = c.ref_for(RefRole::Target) else {
            return Vec::new();
        };
        if point.is_present() || c.xy.is_some() {
            return positional(2);
        }
        let kind = self.kind_of(index);
        (0..self.param_count_of(index))
            .map(|i| param_class(kind, i))
            .collect()
    }

    fn class_group(&self, c: &Constraint) -> Vec<RowClass> {
        let (
            Some(Ref::Entity { index: member, .. }),
            Some(Ref::Entity {
                index: anchor_index,
                point: anchor_point,
                ..
            }),
        ) = (c.ref_for(RefRole::Target), c.ref_for(RefRole::A))
        else {
            return Vec::new();
        };
        let size = self.param_count_of(member);
        let kind = self.kind_of(member);
        let skip_pair =
            member == anchor_index && size >= 2 && super::misc::anchor_is_first_pair(anchor_point);
        (0..size)
            .skip(if skip_pair { 2 } else { 0 })
            .map(|i| param_class(kind, i))
            .collect()
    }

    /// The class of the param at absolute index `i`, found by the entity block
    /// that contains it. Pin rows name params, not constraints, so this is the
    /// only way to tell an arc's angle pin from its radius pin.
    fn param_class_at(&self, i: usize) -> RowClass {
        for entity in self.entities {
            let end = entity.param_offset + entity.param_count;
            if (entity.param_offset..end).contains(&i) {
                return param_class(entity.kind, i - entity.param_offset);
            }
        }
        RowClass::Positional
    }

    /// Every residual row with the class the contract reads it as, in wire
    /// order: constraint rows, then the pin rows, then the equality pins.
    pub fn contract_rows(&self, x: &[f64]) -> Vec<(f64, RowClass)> {
        let mut out = Vec::with_capacity(x.len());
        let mut rows: Vec<f64> = Vec::new();
        for c in &self.constraints {
            rows.clear();
            self.residual_one(c, x, &mut rows);
            let classes = self.row_classes(c);
            debug_assert_eq!(
                classes.len(),
                rows.len(),
                "constraint {:?}: {} classes for {} rows",
                c.kind(),
                classes.len(),
                rows.len()
            );
            for (i, &residual) in rows.iter().enumerate() {
                // A mismatch is impossible on a correct build (and asserted
                // above); in release it is a failure, never a looser target.
                let class = classes.get(i).copied().unwrap_or(RowClass::Unclassified);
                out.push((residual, class));
            }
        }
        for &i in &self.pinned_indices {
            out.push((x[i] - self.x0[i], self.param_class_at(i)));
        }
        for &(i, target) in &self.equality_pins {
            out.push((x[i] - target, self.param_class_at(i)));
        }
        out
    }

    /// The realised precision at `x`, as the two numbers the wire reports:
    /// `(angular_miss, linear_miss)`. The angular miss is the largest
    /// `|row| / seed_len` (radians); the linear miss is the largest positional
    /// row (a world length). Degree-valued shape scalars are excluded (see
    /// `RowClass::Parameter`). Both 0 when no row of that class exists, both
    /// non-finite when the classification invariant broke.
    pub fn contract_misses(&self, x: &[f64]) -> (f64, f64) {
        let mut angular_miss = 0.0_f64;
        let mut linear_miss = 0.0_f64;
        for (residual, class) in self.contract_rows(x) {
            match class {
                RowClass::Angular { seed_len } => {
                    let divisor = if seed_len > 0.0 { seed_len } else { 1.0 };
                    angular_miss = angular_miss.max(residual.abs() / divisor);
                }
                RowClass::Positional => linear_miss = linear_miss.max(residual.abs()),
                RowClass::Parameter => {}
                RowClass::Unclassified => return (f64::INFINITY, f64::INFINITY),
            }
        }
        (angular_miss, linear_miss)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constraints::{ConstraintKind, PointSelector, Ref};
    use crate::test_util::*;
    use crate::{Input, Kind};

    /// The kitchen-sink fixture: one entity of every kind, so any constraint
    /// kind can be built with operands its builder accepts.
    fn entities() -> Vec<crate::Entity> {
        let mut off = 0usize;
        let mut out = Vec::new();
        let mut push = |kind: Kind| {
            // The fit spline's count is authored (four fit points here), so it
            // cannot come from `Entity::new`'s fixed-size default.
            let count = kind.fixed_param_count().unwrap_or(8);
            out.push(crate::Entity {
                kind,
                param_offset: off,
                param_count: count,
                flags: 0,
            });
            off += count;
        };
        push(Kind::Line); // 0: (0,0)-(10,0)
        push(Kind::Line); // 1: (0,5)-(10,5)
        push(Kind::Circle); // 2
        push(Kind::Arc); // 3
        push(Kind::Ellipse); // 4
        push(Kind::Spline); // 5
        push(Kind::FitSpline); // 6, four fit points
        push(Kind::Point); // 7
        out
    }

    fn params() -> Vec<f64> {
        vec![
            // line 0
            0.0, 0.0, 10.0, 0.0, // line 1
            0.0, 5.0, 10.0, 5.0, // circle 2
            20.0, 0.0, 5.0, // arc 3
            20.0, 20.0, 5.0, 0.0, 90.0, // ellipse 4
            40.0, 0.0, 6.0, 3.0, 0.0, // spline 5
            50.0, 0.0, 56.0, 0.0, 56.0, 6.0, 50.0, 6.0, // fit spline 6
            60.0, 0.0, 63.0, 1.0, 66.0, -1.0, 69.0, 0.0, // point 7
            70.0, 0.0,
        ]
    }

    fn problem() -> Problem<'static> {
        // Leaked on purpose: the fixtures are immutable for the whole test and
        // the problem borrows them, so this keeps the assertions readable.
        let inp: &'static Input = Box::leak(Box::new(input(entities(), params(), vec![])));
        Problem::new(inp)
    }

    fn angle(seed: f64) -> RowClass {
        RowClass::Angular { seed_len: seed }
    }

    /// True for an angular row, false for a positional one.
    fn kinds(classes: &[RowClass]) -> Vec<bool> {
        classes
            .iter()
            .map(|c| matches!(c, RowClass::Angular { .. }))
            .collect()
    }

    /// The class vector of `c`, after checking it has one entry per residual
    /// row the builder pushes.
    fn classes_of(problem: &Problem, c: &Constraint) -> Vec<RowClass> {
        let mut rows = Vec::new();
        problem.residual_one(c, &problem.x0, &mut rows);
        let classes = problem.row_classes(c);
        assert_eq!(
            classes.len(),
            rows.len(),
            "kind {:?}: {} tags for {} rows",
            c.kind(),
            classes.len(),
            rows.len()
        );
        classes
    }

    /// One fixture per constraint kind the lowering emits, plus the shapes
    /// whose rows are a mix. Every variant must appear here, which is what
    /// "every constraint kind gets a tag" means: a new kind fails the coverage
    /// assertion below until it is classified.
    fn fixtures() -> Vec<(ConstraintKind, Constraint)> {
        let line0 = e_ref(0, PointSelector::Absent);
        let line1 = e_ref(1, PointSelector::Absent);
        let circle = e_ref(2, PointSelector::Absent);
        let arc = e_ref(3, PointSelector::Absent);
        let point = e_ref(7, PointSelector::Absent);
        let mut v = vec![
            (
                ConstraintKind::Horizontal,
                c_target(ConstraintKind::Horizontal, 0, PointSelector::Absent),
            ),
            (
                ConstraintKind::Vertical,
                c_target(ConstraintKind::Vertical, 1, PointSelector::Absent),
            ),
            (
                ConstraintKind::Length,
                cons_v(
                    ConstraintKind::Length,
                    vec![target(0, PointSelector::Absent)],
                    10.0,
                ),
            ),
            (
                ConstraintKind::Radius,
                cons_v(
                    ConstraintKind::Radius,
                    vec![target(2, PointSelector::Absent)],
                    5.0,
                ),
            ),
            (
                ConstraintKind::Diameter,
                cons_v(
                    ConstraintKind::Diameter,
                    vec![target(2, PointSelector::Absent)],
                    10.0,
                ),
            ),
            (
                ConstraintKind::LineDistance,
                cons_v(ConstraintKind::LineDistance, ab(line0, point), 5.0),
            ),
            (
                ConstraintKind::Coincident,
                cons(
                    ConstraintKind::Coincident,
                    ab(e_ref(0, PointSelector::End), e_ref(1, PointSelector::Start)),
                ),
            ),
            (
                ConstraintKind::Normal,
                cons(ConstraintKind::Normal, ab(line0, line1)),
            ),
            (
                ConstraintKind::Parallel,
                cons(ConstraintKind::Parallel, ab(line0, line1)),
            ),
            (
                ConstraintKind::Angle,
                cons_v(ConstraintKind::Angle, ab(line0, line1), 30.0),
            ),
            (
                ConstraintKind::Tangent,
                cons(ConstraintKind::Tangent, ab(line0, circle)),
            ),
            (
                ConstraintKind::EqualLength,
                cons(ConstraintKind::EqualLength, ab(line0, line1)),
            ),
            (
                ConstraintKind::PointDistance,
                cons_v(
                    ConstraintKind::PointDistance,
                    ab(
                        e_ref(0, PointSelector::Start),
                        e_ref(1, PointSelector::Start),
                    ),
                    5.0,
                ),
            ),
            (
                ConstraintKind::Midpoint,
                Constraint {
                    kind_code: ConstraintKind::Midpoint.to_u8(),
                    refs: vec![
                        (RefRole::Line, line0),
                        (RefRole::Point, Ref::External { x: 5.0, y: 0.0 }),
                    ],
                    ..Default::default()
                },
            ),
            (
                ConstraintKind::Concentric,
                cons(ConstraintKind::Concentric, ab(circle, arc)),
            ),
            (
                ConstraintKind::Fixed,
                c_target(ConstraintKind::Fixed, 0, PointSelector::Absent),
            ),
            (
                ConstraintKind::RadiusDifference,
                cons_v(ConstraintKind::RadiusDifference, ab(circle, arc), 0.0),
            ),
            (
                ConstraintKind::PointDistanceX,
                cons_v(
                    ConstraintKind::PointDistanceX,
                    ab(
                        e_ref(0, PointSelector::Start),
                        e_ref(1, PointSelector::Start),
                    ),
                    0.0,
                ),
            ),
            (
                ConstraintKind::PointDistanceY,
                cons_v(
                    ConstraintKind::PointDistanceY,
                    ab(
                        e_ref(0, PointSelector::Start),
                        e_ref(1, PointSelector::Start),
                    ),
                    5.0,
                ),
            ),
            (
                ConstraintKind::Group,
                Constraint {
                    kind_code: ConstraintKind::Group.to_u8(),
                    refs: vec![
                        (RefRole::Target, line1),
                        (RefRole::A, e_ref(0, PointSelector::Start)),
                    ],
                    ..Default::default()
                },
            ),
        ];
        // Shapes that must not be lost in the mixed rows: collinear lines are
        // the one constraint with an angular AND a positional row.
        v.push((
            ConstraintKind::Tangent,
            cons(ConstraintKind::Tangent, ab(circle, arc)),
        ));
        v.push((
            ConstraintKind::Normal,
            cons(ConstraintKind::Normal, ab(line0, circle)),
        ));
        v.push((
            ConstraintKind::EqualLength,
            cons(ConstraintKind::EqualLength, ab(circle, arc)),
        ));
        v.push((
            ConstraintKind::Coincident,
            cons(ConstraintKind::Coincident, ab(line0, line1)),
        ));
        v.push((
            ConstraintKind::Coincident,
            cons(
                ConstraintKind::Coincident,
                ab(point, e_ref(6, PointSelector::Fit(1))),
            ),
        ));
        v.push((
            ConstraintKind::Vertical,
            cons(
                ConstraintKind::Vertical,
                ab(
                    e_ref(0, PointSelector::Start),
                    e_ref(1, PointSelector::Start),
                ),
            ),
        ));
        v.push((
            ConstraintKind::Horizontal,
            cons(
                ConstraintKind::Horizontal,
                ab(
                    e_ref(0, PointSelector::Start),
                    e_ref(1, PointSelector::Start),
                ),
            ),
        ));
        // The builder arms the class walk mirrors: line/spline,
        // line/fit-spline, line/ellipse and a pinned curve/curve contact.
        v.push((
            ConstraintKind::Tangent,
            cons(
                ConstraintKind::Tangent,
                ab(line0, e_ref(5, PointSelector::Absent)),
            ),
        ));
        v.push((
            ConstraintKind::Tangent,
            cons(
                ConstraintKind::Tangent,
                ab(line0, e_ref(6, PointSelector::Absent)),
            ),
        ));
        v.push((
            ConstraintKind::Tangent,
            cons(
                ConstraintKind::Tangent,
                ab(line0, e_ref(4, PointSelector::Absent)),
            ),
        ));
        v
    }

    #[test]
    fn row_tags_cover_every_kind() {
        let problem = problem();
        let all: Vec<ConstraintKind> = (0..=u8::MAX).filter_map(ConstraintKind::from_u8).collect();
        assert!(all.len() >= 20, "the wire table shrank: {}", all.len());
        let fixtures = fixtures();
        for kind in all {
            assert!(
                fixtures.iter().any(|(k, _)| *k == kind),
                "{kind:?} has no fixture, so its rows are untested"
            );
        }
        for (kind, c) in fixtures {
            let classes = classes_of(&problem, &c);
            assert!(
                !classes.is_empty(),
                "{kind:?} produced no tagged row for a fixture its builder accepts"
            );
        }
        // One tag per residual row, over the whole stack, including the pin
        // rows: the finish reads the two lists positionally, so a whole-stack
        // mismatch is the same class of bug as a per-constraint one.
        let stacked = problem.contract_rows(&problem.x0);
        assert_eq!(stacked.len(), problem.residuals(&problem.x0).len());
    }

    #[test]
    fn the_angular_rows_are_the_direction_rows() {
        let problem = problem();
        let by_kind = |kind: ConstraintKind| {
            fixtures()
                .into_iter()
                .filter(|(k, _)| *k == kind)
                .map(|(_, c)| c)
                .collect::<Vec<_>>()
        };
        let line0 = e_ref(0, PointSelector::Absent);
        let line1 = e_ref(1, PointSelector::Absent);
        let expect = |c: &Constraint, want: Vec<bool>| {
            assert_eq!(kinds(&classes_of(&problem, c)), want);
        };
        expect(
            &cons(ConstraintKind::Parallel, ab(line0, line1)),
            vec![true],
        );
        expect(&cons(ConstraintKind::Normal, ab(line0, line1)), vec![true]);
        expect(
            &cons_v(ConstraintKind::Angle, ab(line0, line1), 30.0),
            vec![true],
        );
        expect(
            &c_target(ConstraintKind::Horizontal, 0, PointSelector::Absent),
            vec![true],
        );
        expect(
            &c_target(ConstraintKind::Vertical, 1, PointSelector::Absent),
            vec![true],
        );
        // Collinear: the parallel row, then the point-on-line row.
        expect(
            &cons(ConstraintKind::Coincident, ab(line0, line1)),
            vec![true, false],
        );
        // Point/point, point/curve and curve/curve tangencies are positional
        // unless a coincident pins the contact (the fixtures above have none).
        expect(
            &cons(
                ConstraintKind::Tangent,
                ab(line0, e_ref(2, PointSelector::Absent)),
            ),
            vec![false],
        );
        expect(
            &cons(
                ConstraintKind::Concentric,
                ab(
                    e_ref(2, PointSelector::Absent),
                    e_ref(3, PointSelector::Absent),
                ),
            ),
            vec![false, false],
        );
        expect(
            &c_target(ConstraintKind::Fixed, 0, PointSelector::Absent),
            vec![false, false, false, false],
        );
        expect(
            &c_target(ConstraintKind::Fixed, 0, PointSelector::Start),
            vec![false, false],
        );
        expect(
            &cons(ConstraintKind::Group, {
                by_kind(ConstraintKind::Group).remove(0).refs
            }),
            // The member is not the anchor entity, so all four of its params
            // row; only the anchor's own first pair is exempt.
            vec![false; 4],
        );
        // The anchor-skip arm: the member IS the anchor and its selector is the
        // first pair, so only the two trailing params row.
        let anchor_skip = Constraint {
            kind_code: ConstraintKind::Group.to_u8(),
            refs: vec![
                (RefRole::Target, e_ref(1, PointSelector::Absent)),
                (RefRole::A, e_ref(1, PointSelector::Start)),
            ],
            ..Default::default()
        };
        expect(&anchor_skip, vec![false; 2]);
        // A kind the tagger does not know has no target (and an invariant
        // failure is non-finite, never a looser width).
        assert_eq!(RowClass::Parameter.target(), 0.0);
        assert_eq!(RowClass::Unclassified.target(), 0.0);
        assert_eq!(RowClass::Positional.target(), contract_positional());
        assert!(matches!(angle(2.0), RowClass::Angular { seed_len } if seed_len == 2.0));
    }

    #[test]
    fn the_two_point_lever_is_the_tilt_arm() {
        // Horizontal reads the x separation, vertical the y separation: that is
        // the distance the tilt acts over, not the sketch scale.
        let problem = problem();
        let a = e_ref(0, PointSelector::Start);
        let b = e_ref(1, PointSelector::Start);
        let horizontal = classes_of(&problem, &cons(ConstraintKind::Horizontal, ab(a, b)));
        // Both starts are at x = 0, so the floor (min_len) applies.
        let RowClass::Angular { seed_len } = horizontal[0] else {
            panic!("two-point horizontal is not angular");
        };
        assert!((seed_len - problem.min_len()).abs() < f64::EPSILON);
        let vertical = classes_of(&problem, &cons(ConstraintKind::Vertical, ab(a, b)));
        let RowClass::Angular { seed_len } = vertical[0] else {
            panic!("two-point vertical is not angular");
        };
        assert!((seed_len - 5.0).abs() < 1e-12);
    }

    #[test]
    fn the_tangent_builder_arms_are_classified() {
        let problem = problem();
        let line0 = e_ref(0, PointSelector::Absent);
        let tangent = |b: Ref| cons(ConstraintKind::Tangent, ab(line0, b));
        // Line/spline and line/fit-spline are direction rows over their own
        // seed length; line/ellipse is the body-distance form, positional.
        let spline = classes_of(&problem, &tangent(e_ref(5, PointSelector::Absent)));
        assert!(matches!(
            spline[0],
            RowClass::Angular { seed_len } if (seed_len - problem.line_len0(0)).abs() < f64::EPSILON
        ));
        let fit = classes_of(&problem, &tangent(e_ref(6, PointSelector::Absent)));
        assert!(matches!(
            fit[0],
            RowClass::Angular { seed_len } if (seed_len - problem.fit_len0(6)).abs() < f64::EPSILON
        ));
        let ellipse = classes_of(&problem, &tangent(e_ref(4, PointSelector::Absent)));
        assert_eq!(ellipse, vec![RowClass::Positional]);
    }

    #[test]
    fn a_pinned_curve_contact_is_angular() {
        // The contact form is `seed_radius * sin(angle between the radials)`,
        // which only the coincident makes reachable: a Problem without it builds
        // the centre-distance body form instead.
        let entities = entities();
        let params = params();
        let coincident = cons(
            ConstraintKind::Coincident,
            ab(
                e_ref(3, PointSelector::End),
                e_ref(2, PointSelector::Absent),
            ),
        );
        let tangent = cons(
            ConstraintKind::Tangent,
            ab(
                e_ref(2, PointSelector::Absent),
                e_ref(3, PointSelector::Absent),
            ),
        );
        let inp: &'static Input = Box::leak(Box::new(input(
            entities,
            params,
            vec![coincident, tangent.clone()],
        )));
        let problem = Problem::new(inp);
        let classes = classes_of(&problem, &tangent);
        assert!(matches!(
            classes[0],
            RowClass::Angular { seed_len }
                if (seed_len - problem.curve_pair_radius0(3, 2)).abs() < f64::EPSILON
        ));
    }

    #[test]
    fn a_fixed_arc_shape_scalar_is_parameter_not_a_world_distance() {
        // A bare `fixed` on an arc pins all five params: the centre and radius
        // are world lengths, the two endpoint angles are degrees. Reading the
        // angles as world distances would put a 90 into `linear_miss`.
        let fixed_arc = c_target(ConstraintKind::Fixed, 3, PointSelector::Absent);
        let fixed_ellipse = c_target(ConstraintKind::Fixed, 4, PointSelector::Absent);
        let inp: &'static Input = Box::leak(Box::new(input(
            entities(),
            params(),
            vec![fixed_arc.clone(), fixed_ellipse.clone()],
        )));
        let problem = Problem::new(inp);
        assert_eq!(
            classes_of(&problem, &fixed_arc),
            vec![
                RowClass::Positional,
                RowClass::Positional,
                RowClass::Positional,
                RowClass::Parameter,
                RowClass::Parameter,
            ]
        );
        assert_eq!(
            classes_of(&problem, &fixed_ellipse),
            vec![
                RowClass::Positional,
                RowClass::Positional,
                RowClass::Positional,
                RowClass::Positional,
                RowClass::Parameter,
            ]
        );
        // A moved endpoint angle alone must not appear as a world distance.
        let mut moved = problem.x0.clone();
        moved[14] += 90.0; // arc 3's a0 (offset 11: cx, cy, r, a0, a1)
        let (angular, linear) = problem.contract_misses(&moved);
        assert_eq!(angular, 0.0);
        assert!(
            linear < 1e-15,
            "a degree row leaked into linear_miss: {linear}"
        );
    }

    #[test]
    fn the_seed_length_reads_the_builder_scale() {
        // The angular target is the row's own seed length, so the class must
        // carry the same length the residual was weighted with: a line pair's
        // geometric mean for parallel, the line's own for a line/curve normal.
        let problem = problem();
        let line0 = e_ref(0, PointSelector::Absent);
        let line1 = e_ref(1, PointSelector::Absent);
        let parallel = classes_of(&problem, &cons(ConstraintKind::Parallel, ab(line0, line1)));
        let RowClass::Angular { seed_len } = parallel[0] else {
            panic!("parallel is not angular");
        };
        assert!((seed_len - problem.line_pair_len0(0, 1)).abs() < f64::EPSILON);
        let normal = classes_of(
            &problem,
            &cons(
                ConstraintKind::Normal,
                ab(line0, e_ref(2, PointSelector::Absent)),
            ),
        );
        let RowClass::Angular { seed_len } = normal[0] else {
            panic!("line/curve normal is not angular");
        };
        assert!((seed_len - problem.line_len0(0)).abs() < f64::EPSILON);
    }
}
