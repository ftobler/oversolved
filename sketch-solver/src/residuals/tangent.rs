use super::geom::{bezier_closest_t, bezier_deriv, is_spline};
use super::{Problem, TangentContact, P2};
use crate::constraints::{Constraint, PointSelector, Ref, RefRole};
use crate::Kind;

impl Problem<'_> {
    /// The tangent's operands as `(line_idx, arc_idx, arc_point)`: explicit
    /// line/arc roles win, otherwise the A/B pair ordered line-kind-first.
    /// For curve/curve tangency neither is a line and the names are just
    /// "first" and "second". `None` when either operand is not an entity.
    pub(super) fn tangent_operands(&self, c: &Constraint) -> Option<(u32, u32, PointSelector)> {
        let (line_ref, arc_ref) =
            if let (Some(lr), Some(ar)) = (c.ref_for(RefRole::Line), c.ref_for(RefRole::Arc)) {
                (lr, ar)
            } else {
                let (a, b) = (c.ref_for(RefRole::A)?, c.ref_for(RefRole::B)?);
                match a {
                    Ref::Entity { index, .. } if self.kind_of(index) == Kind::Line => (a, b),
                    _ => (b, a),
                }
            };
        match (line_ref, arc_ref) {
            (
                Ref::Entity { index: li, .. },
                Ref::Entity {
                    index: ai,
                    point: ap,
                },
            ) => Some((li, ai, ap)),
            _ => None,
        }
    }

    /// `(external, internal)` tangency residuals of two circles/arcs: the
    /// centers' distance minus `rA + rB`, and minus `|rA - rB|`.
    pub(super) fn curve_tangent_terms(&self, x: &[f64], a_idx: u32, b_idx: u32) -> (f64, f64) {
        let ca = self.params(x, a_idx);
        let cb = self.params(x, b_idx);
        let d = ((ca[0] - cb[0]).powi(2) + (ca[1] - cb[1]).powi(2)).sqrt();
        let (ra, rb) = (ca[2], cb[2]);
        (d - (ra + rb), d - (ra - rb).abs())
    }

    /// The unit end tangent of a spline at a pinned end: the Bezier's end
    /// derivative, or the fit spline's own end derivative (the stored handle's
    /// direction when it has one, the Lagrange end otherwise).
    fn spline_end_tangent(&self, x: &[f64], index: u32, selector: PointSelector) -> P2 {
        let d = match self.kind_of(index) {
            Kind::Spline => {
                let sp = self.params(x, index);
                if selector == PointSelector::End {
                    bezier_deriv(sp, 1.0)
                } else {
                    bezier_deriv(sp, 0.0)
                }
            }
            Kind::FitSpline => {
                let Some(fit) = self.fit_spline(x, index) else {
                    return [0.0, 0.0];
                };
                if selector == PointSelector::End {
                    fit.derivative(fit.point_count() - 1)
                } else {
                    fit.derivative(0)
                }
            }
            _ => [0.0, 0.0],
        };
        let n = (d[0] * d[0] + d[1] * d[1]).sqrt().max(1e-12);
        [d[0] / n, d[1] / n]
    }

    /// The spline tangent direction a line must be parallel to.
    ///
    /// An end named on the tangent itself wins: it is what the author picked,
    /// and a line closing a spline has a coincident at both ends, of which the
    /// contact map keeps only the first. Otherwise the pinned contact decides:
    /// a spline end it names reads that end's tangent; a line endpoint it pins
    /// onto the spline locus is projected onto the spline and the tangent read
    /// at that closest parameter, which is the interior tangency. The survivors
    /// gate drops a row with neither, so the midpoint (Bezier) or line-start
    /// projection (fit) left below only keeps the row count for a row that
    /// reaches here some other way. `None` when the fit spline cannot be
    /// rebuilt for an interior read (no row, as before).
    fn line_spline_tangent(
        &self,
        x: &[f64],
        line_idx: u32,
        spline_idx: u32,
        arc_pt: PointSelector,
        contact: Option<&TangentContact>,
    ) -> Option<P2> {
        let end = |sel| matches!(sel, PointSelector::Start | PointSelector::End);
        if end(arc_pt) {
            return Some(self.spline_end_tangent(x, spline_idx, arc_pt));
        }
        let mut pinned = None;
        if let Some(contact) = contact {
            let sel = contact_selector(contact, 1);
            if end(sel) {
                return Some(self.spline_end_tangent(x, spline_idx, sel));
            }
            // A locus spline side means the owner is the line endpoint.
            if contact.owner == 0 {
                pinned = Some(self.point(
                    x,
                    Ref::Entity {
                        index: line_idx,
                        point: contact.selector,
                    },
                ));
            }
        }
        let fit = match self.kind_of(spline_idx) {
            Kind::FitSpline => Some(self.fit_spline(x, spline_idx)?),
            _ => None,
        };
        let sp = self.params(x, spline_idx);
        let line_start = || {
            let ep = self.params(x, line_idx);
            [ep[0], ep[1]]
        };
        Some(match (fit, pinned) {
            (Some(fit), Some(p)) => fit.deriv(fit.closest(p).u),
            (None, Some(p)) => bezier_deriv(sp, bezier_closest_t(sp, p)),
            (Some(fit), None) => fit.deriv(fit.closest(line_start()).u),
            (None, None) => bezier_deriv(sp, 0.5),
        })
    }

    /// One residual row per tangent.
    ///
    /// Tangency is a direction condition wherever a coincident pins an
    /// endpoint of one operand onto the other (its endpoint or its locus):
    /// `Problem::build_tangent_contacts` finds those contacts, and the row is
    /// measured at the contact point. Two touching circles through a common
    /// point can only touch AT that point, so the centre-distance form is a
    /// double root there: its Jacobian loses rank, LM crawls, and a chain
    /// stalls above `verdict_tol`. Free tangency (no coincident) keeps the
    /// centre-distance form and the seeded internal/external type.
    pub(super) fn r_tangent(&self, c: &Constraint, x: &[f64], r: &mut Vec<f64>) {
        let Some((line_idx, arc_idx, arc_pt)) = self.tangent_operands(c) else {
            return;
        };
        let contact = self.tangent_contact.get(&(line_idx, arc_idx));
        // Neither operand is a line: this is curve/curve tangency (two circles
        // or arcs). With a pinned contact the row is the sine of the angle
        // between the two radials at that point, so it stays smooth and holds
        // both the internal (parallel) and external (anti-parallel) case.
        // Without one the centers' distance equals rA+rB when the circles
        // touch externally or |rA-rB| when one sits inside the other, decided
        // once from the seed (`curve_tangent_internal`): choosing the nearer
        // per evaluation made the residual jump (-2 to +1.5 between two nearby
        // center distances) and let the type flip mid-solve. The Jacobian comes
        // from the finite-difference fallback.
        if !matches!(self.kind_of(line_idx), Kind::Line) {
            // A spline partner has no centre or radius; the tangency is read at
            // its pinned end as the direction of its end handle (fit spline) or
            // its end control point (Bezier). The circle/arc side contributes
            // its radial at the contact, the spline side its own end tangent.
            if is_spline(self.kind_of(line_idx)) || is_spline(self.kind_of(arc_idx)) {
                let Some(contact) = contact else {
                    return;
                };
                let (spline_idx, other_idx) = if is_spline(self.kind_of(line_idx)) {
                    (line_idx, arc_idx)
                } else {
                    (arc_idx, line_idx)
                };
                let spline_sel =
                    contact_selector(contact, if spline_idx == line_idx { 0 } else { 1 });
                let other_sel =
                    contact_selector(contact, if other_idx == line_idx { 0 } else { 1 });
                let owner = if contact.owner == 0 {
                    line_idx
                } else {
                    arc_idx
                };
                let p = self.point(
                    x,
                    Ref::Entity {
                        index: owner,
                        point: contact.selector,
                    },
                );
                let t = self.spline_end_tangent(x, spline_idx, spline_sel);
                let seed = self.curve_spline_len0(line_idx, arc_idx);
                if matches!(self.kind_of(other_idx), Kind::Circle | Kind::Arc) {
                    // The circle/arc tangent is perpendicular to its radial.
                    let rd = self.radius_dir(x, other_idx, other_sel, p);
                    r.push(seed * (rd[0] * t[0] + rd[1] * t[1]));
                } else if is_spline(self.kind_of(other_idx)) {
                    // G1: the two end tangents are parallel.
                    let u = self.spline_end_tangent(x, other_idx, other_sel);
                    r.push(seed * (u[0] * t[1] - u[1] * t[0]));
                }
                return;
            }
            if let Some(contact) = contact {
                let owner = if contact.owner == 0 {
                    line_idx
                } else {
                    arc_idx
                };
                let p = self.point(
                    x,
                    Ref::Entity {
                        index: owner,
                        point: contact.selector,
                    },
                );
                let sel_first = if contact.owner == 0 {
                    contact.selector
                } else {
                    PointSelector::Absent
                };
                let sel_second = if contact.owner == 1 {
                    contact.selector
                } else {
                    PointSelector::Absent
                };
                let ra = self.radius_dir(x, line_idx, sel_first, p);
                let rb = self.radius_dir(x, arc_idx, sel_second, p);
                let cross = ra[0] * rb[1] - ra[1] * rb[0];
                r.push(self.curve_pair_radius0(line_idx, arc_idx) * cross);
                return;
            }
            let (external, internal) = self.curve_tangent_terms(x, line_idx, arc_idx);
            let use_internal = match self.curve_tangent_internal.get(&(line_idx, arc_idx)) {
                Some(&decided) => decided,
                None => internal.abs() < external.abs(),
            };
            r.push(if use_internal { internal } else { external });
            return;
        }
        let line_ep = self.params(x, line_idx);
        let arc_ep = self.params(x, arc_idx);
        let mut line_dir = [line_ep[2] - line_ep[0], line_ep[3] - line_ep[1]];
        let norm = (line_dir[0] * line_dir[0] + line_dir[1] * line_dir[1])
            .sqrt()
            .max(1e-12);
        line_dir[0] /= norm;
        line_dir[1] /= norm;

        if is_spline(self.kind_of(arc_idx)) {
            // Line tangent to a spline: the line direction is parallel to the
            // spline tangent at the contact, so the cross product is zero.
            let Some(tan) = self.line_spline_tangent(x, line_idx, arc_idx, arc_pt, contact) else {
                return;
            };
            let tn = (tan[0] * tan[0] + tan[1] * tan[1]).sqrt().max(1e-12);
            let (tx, ty) = (tan[0] / tn, tan[1] / tn);
            // sin(angle) times a seed length (see `scale.rs`).
            let len0 = if self.kind_of(arc_idx) == Kind::Spline {
                self.line_len0(line_idx)
            } else {
                self.fit_len0(arc_idx)
            };
            r.push(len0 * (line_dir[0] * ty - line_dir[1] * tx));
        } else if matches!(self.kind_of(arc_idx), Kind::Circle | Kind::Arc) {
            // Line tangent to a circle or arc (identical math: an arc reuses its
            // underlying circle). When a coincident pins an endpoint of either
            // operand onto the other, the contact is pinned and we measure
            // perpendicularity of the line direction against the radial
            // direction at that contact. Otherwise the line body is tangent to
            // the circle: perpendicular distance from the centre to the
            // infinite line equals the radius.
            if let Some(contact) = contact {
                // Contact is whichever operand endpoint the coincident pinned
                // onto the other. Resolving through `point()` with the stored
                // selector (not a hand-inverted copy of it) keeps this honest
                // for both pin sides and for the locus form: reading the
                // opposite foot measured tangency at a point the constraints
                // never tied down, and a correctly-tangent sketch read ~-0.9
                // instead of 0.
                let owner = if contact.owner == 0 {
                    line_idx
                } else {
                    arc_idx
                };
                let p = self.point(
                    x,
                    Ref::Entity {
                        index: owner,
                        point: contact.selector,
                    },
                );
                let rd = self.radius_dir(x, arc_idx, arc_pt, p);
                r.push(self.line_len0(line_idx) * (line_dir[0] * rd[0] + line_dir[1] * rd[1]));
            } else {
                let (cx, cy) = (arc_ep[0], arc_ep[1]);
                let num = (cx - line_ep[0]) * line_dir[1] - (cy - line_ep[1]) * line_dir[0];
                // |num| kinks only at a zero centre distance, where the residual
                // is satisfied only when the radius is 0: not a valid circle, so
                // no fix here.
                r.push(num.abs() - arc_ep[2]);
            }
        } else if self.kind_of(arc_idx) == Kind::Ellipse {
            // Line body tangent to an ellipse: the infinite line touches it
            // exactly when the centre's distance to the line equals the
            // ellipse's support distance along the line normal n,
            // sqrt((a n.u)^2 + (b n.v)^2) with u, v the major/minor axes. The
            // circle branch above is the a = b case of the same formula.
            let (cx, cy, a, b) = (arc_ep[0], arc_ep[1], arc_ep[2], arc_ep[3]);
            let theta = arc_ep[4].to_radians();
            let (ct, st) = (theta.cos(), theta.sin());
            let n = [-line_dir[1], line_dir[0]];
            let n_u = n[0] * ct + n[1] * st;
            let n_v = -n[0] * st + n[1] * ct;
            let support = ((a * n_u).powi(2) + (b * n_v).powi(2)).sqrt();
            let dist = (cx - line_ep[0]) * n[0] + (cy - line_ep[1]) * n[1];
            // Same abs kink, at a zero distance, which pins no valid ellipse.
            r.push(dist.abs() - support);
        }
    }
}

/// The selector the contact side `side` (0 or 1) carries.
fn contact_selector(contact: &TangentContact, side: u8) -> PointSelector {
    if contact.owner == side {
        contact.selector
    } else {
        contact.other_selector
    }
}
