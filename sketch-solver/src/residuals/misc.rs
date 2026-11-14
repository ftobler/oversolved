use super::{Problem, P2};
use crate::constraints::{Axis, Constraint, PointSelector, Ref, RefRole};
use crate::tolerance::contract_positional;
use crate::Kind;

/// How many leading scalars of a member's param block are coordinates (as
/// opposed to shape scalars such as a radius or an arc angle).
///
/// The group holds coordinates at their reference plus the group's rigid
/// transform and every later scalar at its reference exactly (or relative to
/// the turn, for an angle). `fit_spline` stores the fit points and the optional
/// end handles as absolute points, so its whole block transforms; a spline is
/// four Bezier control points.
pub(super) fn group_coord_count(kind: Kind, param_count: usize) -> usize {
    match kind {
        Kind::Line => 4,
        Kind::Circle | Kind::Arc | Kind::Ellipse | Kind::Point => 2,
        Kind::Spline => 8,
        Kind::FitSpline => param_count,
    }
}

/// True for a param that stores an angle in degrees (an arc's endpoint angles,
/// an ellipse's rotation) rather than a world coordinate or a length. The group
/// turns these with the carrier; `rows.rs` reads the same predicate so a row
/// class cannot drift from the residual.
pub(super) fn is_angle_param(kind: Kind, index: usize) -> bool {
    match kind {
        Kind::Arc => index >= 3,
        Kind::Ellipse => index == 4,
        _ => false,
    }
}

/// The angle slot a shape's rotation is carried by: an arc's start angle, an
/// ellipse's rotation. `None` for a kind without one.
fn angle_carrier_slot(kind: Kind) -> Option<usize> {
    match kind {
        Kind::Arc => Some(3),
        Kind::Ellipse => Some(4),
        _ => None,
    }
}

/// Fold an angle difference into `[-180, 180)` degrees. A group turned past
/// half a turn would otherwise see its held angle jump a whole turn; the
/// derivative is unchanged except at the seam, where the half-away-from-zero
/// rounding sends an exact +180 to -180.
fn wrap180(deg: f64) -> f64 {
    deg - 360.0 * (deg / 360.0).round()
}

/// True when the anchor selector names the entity's first param pair. Every
/// kind's first point lives at params 0,1 (line/spline start, the centre of a
/// circle/arc/ellipse, a point's xy, a fit spline's first fit point), and the
/// host's lowering always writes one of these selectors.
pub(super) fn anchor_is_first_pair(point: PointSelector) -> bool {
    matches!(
        point,
        PointSelector::Absent | PointSelector::Start | PointSelector::Center | PointSelector::Xy
    )
}

/// Where one group row set measures its rotation from. Every row of one
/// document group carries the same carrier.
#[derive(Clone, Copy)]
pub(super) enum GroupCarrier {
    /// A member point `P`: the turn is the angle that takes the reference
    /// offset `P0 - A0` onto the current `P - A`.
    Point { at: Ref },
    /// A whole arc's start angle or ellipse's rotation carries the turn: the
    /// fallback for a group whose points all sit on the anchor (concentric
    /// arcs), where only the shape's own orientation can show it turned.
    Angle { index: u32, slot: usize },
}

impl GroupCarrier {
    /// The carrier a wire `Group` row names under the `b` role (a point) or the
    /// `arc` role (an angle). A ref the walk cannot use as a carrier is no
    /// carrier: the rows then keep the old translation-only shape.
    fn of(problem: &Problem, c: &Constraint) -> Option<Self> {
        // A point carrier rides the `b` role; the angle fallback rides `arc`,
        // which is the whole arc or ellipse entity and no point selector.
        let carrier_ref = c.ref_for(RefRole::B).or_else(|| c.ref_for(RefRole::Arc))?;
        let Ref::Entity { index, point } = carrier_ref else {
            return None;
        };
        if point.is_present() {
            return Some(GroupCarrier::Point {
                at: Ref::Entity { index, point },
            });
        }
        Some(GroupCarrier::Angle {
            index,
            slot: angle_carrier_slot(problem.kind_of(index))?,
        })
    }
}

/// The coordinate pair of a whole member a point carrier names, when the
/// selector is one of the member's own pairs. A derived point (an arc end, an
/// ellipse axis end) owns no pair, so it is `None` and the member's rows keep
/// their two-coordinate form.
fn carrier_pair_index(
    kind: Kind,
    param_count: usize,
    flags: u8,
    point: PointSelector,
) -> Option<usize> {
    match kind {
        Kind::Line => match point {
            PointSelector::Start => Some(0),
            PointSelector::End => Some(1),
            _ => None,
        },
        Kind::Circle | Kind::Arc | Kind::Ellipse => (point == PointSelector::Center).then_some(0),
        Kind::Point => (point == PointSelector::Xy).then_some(0),
        Kind::Spline => match point {
            PointSelector::Start => Some(0),
            PointSelector::C1 => Some(1),
            PointSelector::C2 => Some(2),
            PointSelector::End => Some(3),
            _ => None,
        },
        Kind::FitSpline => {
            let has_start = flags & 1 != 0;
            let has_end = flags & 2 != 0;
            let handles = usize::from(has_start) + usize::from(has_end);
            let points = param_count.saturating_sub(2 * handles) / 2;
            match point {
                PointSelector::Start => Some(0),
                PointSelector::End => points.checked_sub(1),
                PointSelector::Fit(k) => ((k as usize) < points).then_some(k as usize),
                PointSelector::C1 => has_start.then_some(points),
                PointSelector::C2 => has_end.then_some(points + usize::from(has_start)),
                _ => None,
            }
        }
    }
}

/// The row shape of one group constraint, shared by `r_group`, its analytic
/// Jacobian, the row-class walk and the precision classifier so their counts
/// cannot drift.
///
/// A whole member emits rows for its coordinate pairs (one distance row instead
/// of two on the carrier pair) and one row per shape scalar. A point member
/// emits its two world coordinates, or the single carrier distance when it IS
/// the carrier. Naming the anchor's own pair is the translation itself and emits
/// no row.
#[derive(Clone, Copy)]
pub(super) enum GroupWalk {
    /// The held point's `(x, y)`, its rows relative to `anchor`.
    Point {
        member: Ref,
        anchor: Ref,
        carrier: Option<GroupCarrier>,
        /// Set when this point member is the group's carrier pair.
        is_carrier: bool,
    },
    /// Every member param, the anchor pair skipped when it is the translation.
    Whole {
        member: u32,
        size: usize,
        /// Leading params that are coordinates, so the transform moves them.
        coords: usize,
        skip_first_pair: bool,
        anchor: Ref,
        carrier: Option<GroupCarrier>,
        /// The member-local pair the point carrier names, when it is one here.
        carrier_pair: Option<usize>,
        /// The member-local degree slot that IS the angle carrier.
        carrier_angle: Option<usize>,
    },
}

impl GroupWalk {
    /// The walk for `c`, or `None` when the constraint names no usable operands
    /// or its point member is the anchor's own pair. Those are the shapes that
    /// contribute no row anywhere.
    pub(super) fn of(problem: &Problem, c: &Constraint) -> Option<Self> {
        let (
            Some(Ref::Entity {
                index: member,
                point: member_point,
            }),
            Some(
                anchor @ Ref::Entity {
                    index: anchor_index,
                    point: anchor_point,
                },
            ),
        ) = (c.ref_for(RefRole::Target), c.ref_for(RefRole::A))
        else {
            return None;
        };
        let carrier = GroupCarrier::of(problem, c);
        if member_point.is_present() {
            let target = Ref::Entity {
                index: member,
                point: member_point,
            };
            // The anchor's own pair IS the translation, so it adds no row. Any
            // other point on the anchor entity is a distinct held point.
            if target == anchor {
                return None;
            }
            let is_carrier = matches!(carrier, Some(GroupCarrier::Point { at }) if at == target);
            return Some(GroupWalk::Point {
                member: target,
                anchor,
                carrier,
                is_carrier,
            });
        }
        // A whole member of the anchor entity under a point anchor is the pair
        // the host's dedup rule forbids (the anchor point already holds it), so
        // it can only arrive from a hand-built wire: fail the test build rather
        // than author a second, redundant hold.
        debug_assert!(
            member != anchor_index || anchor_is_first_pair(anchor_point),
            "group names a whole entity and a point member of the same entity"
        );
        let size = problem.param_count_of(member);
        let kind = problem.kind_of(member);
        let flags = problem.entities[member as usize].flags;
        let carrier_pair = match carrier {
            Some(GroupCarrier::Point {
                at: Ref::Entity { index, point },
            }) if index == member => carrier_pair_index(kind, size, flags, point),
            _ => None,
        };
        let carrier_angle = match carrier {
            Some(GroupCarrier::Angle { index, slot }) if index == member => Some(slot),
            _ => None,
        };
        Some(GroupWalk::Whole {
            member,
            size,
            coords: group_coord_count(kind, size),
            skip_first_pair: member == anchor_index
                && size >= 2
                && anchor_is_first_pair(anchor_point),
            anchor,
            carrier,
            carrier_pair,
            carrier_angle,
        })
    }

    /// The anchor point the group transform is measured from.
    pub(super) fn anchor(self) -> Ref {
        match self {
            GroupWalk::Point { anchor, .. } | GroupWalk::Whole { anchor, .. } => anchor,
        }
    }

    pub(super) fn carrier(self) -> Option<GroupCarrier> {
        match self {
            GroupWalk::Point { carrier, .. } | GroupWalk::Whole { carrier, .. } => carrier,
        }
    }
}

impl Problem<'_> {
    /// The rigid transform every row of one group shares: the anchor's
    /// displacement, the turn the carrier measures, and that turn in degrees
    /// for the angle-valued rows.
    pub(super) fn group_frame(&self, x: &[f64], walk: GroupWalk) -> GroupFrame {
        let anchor = self.point(x, walk.anchor());
        let anchor0 = self.point(&self.reference, walk.anchor());
        match walk.carrier() {
            Some(GroupCarrier::Point { at }) => {
                let p = self.point(x, at);
                let p0 = self.point(&self.reference, at);
                let u0 = [p0[0] - anchor0[0], p0[1] - anchor0[1]];
                let u = [p[0] - anchor[0], p[1] - anchor[1]];
                let floor = contract_positional();
                let d0 = (u0[0] * u0[0] + u0[1] * u0[1]).sqrt();
                let d = (u[0] * u[0] + u[1] * u[1]).sqrt();
                // Below the positional contract a direction is not observable;
                // reading the turn as identity keeps a solve that drives the
                // pair together from dividing by zero, and the next step can
                // pull it apart again.
                let (cos, sin) = if d0 <= floor || d <= floor {
                    (1.0, 0.0)
                } else {
                    let denom = d0 * d;
                    let dot = u0[0] * u[0] + u0[1] * u[1];
                    let cross = u0[0] * u[1] - u0[1] * u[0];
                    (dot / denom, cross / denom)
                };
                GroupFrame {
                    anchor,
                    anchor0,
                    u0,
                    u,
                    cos,
                    sin,
                }
            }
            Some(GroupCarrier::Angle { index, slot }) => {
                let i = self.offset_of(index) + slot;
                let phi = (x[i] - self.reference[i]).to_radians();
                GroupFrame {
                    anchor,
                    anchor0,
                    u0: [0.0, 0.0],
                    u: [0.0, 0.0],
                    cos: phi.cos(),
                    sin: phi.sin(),
                }
            }
            None => GroupFrame {
                anchor,
                anchor0,
                u0: [0.0, 0.0],
                u: [0.0, 0.0],
                cos: 1.0,
                sin: 0.0,
            },
        }
    }

    /// `d(phi)/dparam` in radians, from the same carrier the frame reads: the
    /// point carrier through `point_jac`, the angle carrier directly.
    pub(super) fn group_phi_grad(
        &self,
        x: &[f64],
        walk: GroupWalk,
        frame: &GroupFrame,
    ) -> Vec<(usize, f64)> {
        match walk.carrier() {
            Some(GroupCarrier::Point { at }) => {
                let d = frame.dphi_dp();
                if d == [0.0, 0.0] {
                    return Vec::new();
                }
                let mut out = Vec::new();
                for (col, dpx, dpy) in self.point_jac(x, at) {
                    out.push((col, d[0] * dpx + d[1] * dpy));
                }
                for (col, dpx, dpy) in self.point_jac(x, walk.anchor()) {
                    out.push((col, -(d[0] * dpx + d[1] * dpy)));
                }
                out
            }
            Some(GroupCarrier::Angle { index, slot }) => {
                vec![(self.offset_of(index) + slot, crate::DEG2RAD)]
            }
            None => Vec::new(),
        }
    }

    pub(super) fn r_midpoint(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let mid: P2 = if let Some(Ref::Entity { index, .. }) = c.ref_for(RefRole::Line) {
            let ep = self.params(x, index);
            [(ep[0] + ep[2]) / 2.0, (ep[1] + ep[3]) / 2.0]
        } else if let (Some(pa_ref), Some(pb_ref)) =
            (c.ref_for(RefRole::PointA), c.ref_for(RefRole::PointB))
        {
            let pa = self.point(x, pa_ref);
            let pb = self.point(x, pb_ref);
            [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0]
        } else {
            return;
        };
        let Some(pt_ref) = c.ref_for(RefRole::Point) else {
            return;
        };
        let pt = self.point(x, pt_ref);
        let axis = c.axis.unwrap_or(Axis::Both);
        if axis.includes_x() {
            r.push(pt[0] - mid[0]);
        }
        if axis.includes_y() {
            r.push(pt[1] - mid[1]);
        }
    }

    pub(super) fn r_concentric(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let (Some(Ref::Entity { index: a_idx, .. }), Some(Ref::Entity { index: b_idx, .. })) =
            (c.ref_for(RefRole::A), c.ref_for(RefRole::B))
        else {
            return;
        };
        let ea = self.params(x, a_idx);
        let eb = self.params(x, b_idx);
        r.push(ea[0] - eb[0]);
        r.push(ea[1] - eb[1]);
    }

    pub(super) fn r_fixed(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let Some(target) = c.ref_for(RefRole::Target) else {
            return;
        };
        let Ref::Entity { index, point } = target else {
            return;
        };
        let has_point = point.is_present();
        let has_xy = c.xy.is_some();
        if has_point || has_xy {
            let pt = self.point(x, target);
            let (fix_x, fix_y) = match c.xy {
                Some((fx, fy)) => (fx, fy),
                None => {
                    let p0 = self.point(&self.reference, target);
                    (p0[0], p0[1])
                }
            };
            r.push(pt[0] - fix_x);
            r.push(pt[1] - fix_y);
        } else {
            let off = self.offset_of(index);
            let size = self.param_count_of(index);
            for i in 0..size {
                r.push(x[off + i] - self.reference[off + i]);
            }
        }
    }

    /// Rigid group member: its coordinates hold their reference offset from the
    /// anchor point, turned by the carrier's angle, and its shape scalars hold
    /// their reference value (a length exactly, an angle relative to the turn).
    ///
    /// The anchor point's displacement `t = anchor(x) - anchor(reference)` is the
    /// translation the whole group is allowed. Only the anchor entity's own first
    /// pair is that `t` itself, so it contributes no rows. The carrier pair
    /// contributes ONE distance row instead of its two coordinate rows, which is
    /// where the third DOF comes from: the pair's direction about the anchor is
    /// free and every other member follows it.
    ///
    /// A member that names only one point holds that point alone, at its
    /// reference plus `t` and the turn. A group with no carrier (a lone circle)
    /// has no observable turn and keeps today's translation-only rows.
    pub(super) fn r_group(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let Some(walk) = GroupWalk::of(self, c) else {
            return;
        };
        let frame = self.group_frame(x, walk);
        match walk {
            GroupWalk::Point {
                member, is_carrier, ..
            } => {
                if is_carrier {
                    r.push(frame.carrier_length());
                    return;
                }
                let now = self.point(x, member);
                let held = self.point(&self.reference, member);
                let v0 = [held[0] - frame.anchor0[0], held[1] - frame.anchor0[1]];
                let rv = frame.rotate(v0);
                r.push(now[0] - frame.anchor[0] - rv[0]);
                r.push(now[1] - frame.anchor[1] - rv[1]);
            }
            GroupWalk::Whole {
                member,
                size,
                coords,
                skip_first_pair,
                carrier_pair,
                carrier_angle,
                ..
            } => {
                let off = self.offset_of(member);
                let kind = self.kind_of(member);
                for pair in 0..coords / 2 {
                    if skip_first_pair && pair == 0 {
                        continue;
                    }
                    if Some(pair) == carrier_pair {
                        r.push(frame.carrier_length());
                        continue;
                    }
                    let v0 = [
                        self.reference[off + 2 * pair] - frame.anchor0[0],
                        self.reference[off + 2 * pair + 1] - frame.anchor0[1],
                    ];
                    let rv = frame.rotate(v0);
                    r.push(x[off + 2 * pair] - frame.anchor[0] - rv[0]);
                    r.push(x[off + 2 * pair + 1] - frame.anchor[1] - rv[1]);
                }
                let phi_deg = frame.phi_deg();
                for i in coords..size {
                    if carrier_angle == Some(i) {
                        continue;
                    }
                    let residual = if is_angle_param(kind, i) {
                        wrap180(x[off + i] - self.reference[off + i] - phi_deg)
                    } else {
                        x[off + i] - self.reference[off + i]
                    };
                    r.push(residual);
                }
            }
        }
    }
}

/// The rigid transform of one group row set, shared by the residual and its
/// analytic Jacobian.
#[derive(Clone, Copy)]
pub(super) struct GroupFrame {
    pub(super) anchor: P2,
    pub(super) anchor0: P2,
    /// `P0 - A0` and `P - A` for a point carrier; zero for an angle carrier.
    pub(super) u0: P2,
    pub(super) u: P2,
    pub(super) cos: f64,
    pub(super) sin: f64,
}

impl GroupFrame {
    fn rotate(self, v: P2) -> P2 {
        [
            self.cos * v[0] - self.sin * v[1],
            self.sin * v[0] + self.cos * v[1],
        ]
    }

    /// `|P - A| - |P0 - A0|`, the carrier pair's one row.
    fn carrier_length(self) -> f64 {
        let now = (self.u[0] * self.u[0] + self.u[1] * self.u[1]).sqrt();
        let held = (self.u0[0] * self.u0[0] + self.u0[1] * self.u0[1]).sqrt();
        now - held
    }

    fn phi_deg(self) -> f64 {
        self.sin.atan2(self.cos).to_degrees()
    }

    /// `d(phi)/dP`; the anchor's derivative is its negative. Zero when the
    /// carrier pair is not observable: either its current offset or its
    /// reference offset is below the positional contract, the same predicate
    /// the frame uses to read the turn as identity. A reference offset that is
    /// degenerate makes `phi` undefined, so the row keeps no gradient either.
    fn dphi_dp(self) -> P2 {
        let d = self.u[0] * self.u[0] + self.u[1] * self.u[1];
        let d0 = (self.u0[0] * self.u0[0] + self.u0[1] * self.u0[1]).sqrt();
        let floor = contract_positional();
        if d0 <= floor || d <= floor * floor {
            [0.0, 0.0]
        } else {
            [-self.u[1] / d, self.u[0] / d]
        }
    }

    /// `dR/dphi * v0`, the direction the carrier offset's image moves as the
    /// turn advances.
    pub(super) fn rotate_derivative(self, v0: P2) -> P2 {
        [
            -self.sin * v0[0] - self.cos * v0[1],
            self.cos * v0[0] - self.sin * v0[1],
        ]
    }
}
