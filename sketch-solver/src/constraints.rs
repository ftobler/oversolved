//! Constraint model and its kind/role vocabulary.
//!
//! A constraint is a kind plus a small set of role-tagged references plus
//! optional scalar payload (`value`, an explicit `(x, y)` target for `fixed`,
//! an `axis` for `midpoint`, and a `sign` orientation selector for directional
//! dimensions). This crate is the canonical solver definition.
//!
//! The crate never resolves queries: a reference always arrives already pointing
//! at a concrete entity *index* (the TS builder resolves ancestral query strings
//! to indices before the solve) or at an external `(x, y)` literal. Projection is
//! likewise not modelled here; a projected entity is an ordinary entity whose
//! params are pinned (via `pinned_mask`/`equality_pins`, see `codec`).

/// Which geometric sub-point of an entity a reference selects.
///
/// `Absent` is meaningful and distinct from `Start`: several handlers (notably
/// `coincident`) branch on whether the source carried a `point` key at all,
/// treating a point-less line reference as "the whole line" rather than "its
/// start point". `point()` still falls back to the start point when the
/// selector is `Absent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointSelector {
    Absent,
    Start,
    End,
    Center,
    Xy,
    /// Ellipse axis endpoints (the 4 control points). `Major`/`Minor` are the
    /// positive ends of the major/minor axes; `*Neg` the negative ends. The
    /// distance from the ellipse center to a major endpoint is `a`, to a minor
    /// endpoint is `b`, so a `point_distance(center, endpoint)` dimension pins
    /// the major/minor radius without a dedicated constraint kind.
    Major,
    MajorNeg,
    Minor,
    MinorNeg,
    /// Spline off-curve control points: `C1` is P2 (params `[2,3]`), `C2` is P3
    /// (params `[4,5]`). The on-curve endpoints use `Start`/`End`.
    C1,
    C2,
}

impl PointSelector {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => PointSelector::Absent,
            1 => PointSelector::Start,
            2 => PointSelector::End,
            3 => PointSelector::Center,
            4 => PointSelector::Xy,
            5 => PointSelector::Major,
            6 => PointSelector::MajorNeg,
            7 => PointSelector::Minor,
            8 => PointSelector::MinorNeg,
            9 => PointSelector::C1,
            10 => PointSelector::C2,
            _ => return None,
        })
    }

    pub fn to_u8(self) -> u8 {
        match self {
            PointSelector::Absent => 0,
            PointSelector::Start => 1,
            PointSelector::End => 2,
            PointSelector::Center => 3,
            PointSelector::Xy => 4,
            PointSelector::Major => 5,
            PointSelector::MajorNeg => 6,
            PointSelector::Minor => 7,
            PointSelector::MinorNeg => 8,
            PointSelector::C1 => 9,
            PointSelector::C2 => 10,
        }
    }

    /// True when the source dict carried an explicit `point` key. `coincident`
    /// uses this to distinguish whole-entity from point-on-entity semantics.
    pub fn is_present(self) -> bool {
        self != PointSelector::Absent
    }
}

/// The role a reference plays within a constraint
/// (`target`, `a`, `b`, `line`, `arc`, `point`, `point_a`, `point_b`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefRole {
    Target,
    A,
    B,
    Line,
    Arc,
    Point,
    PointA,
    PointB,
}

impl RefRole {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => RefRole::Target,
            1 => RefRole::A,
            2 => RefRole::B,
            3 => RefRole::Line,
            4 => RefRole::Arc,
            5 => RefRole::Point,
            6 => RefRole::PointA,
            7 => RefRole::PointB,
            _ => return None,
        })
    }

    pub fn to_u8(self) -> u8 {
        match self {
            RefRole::Target => 0,
            RefRole::A => 1,
            RefRole::B => 2,
            RefRole::Line => 3,
            RefRole::Arc => 4,
            RefRole::Point => 5,
            RefRole::PointA => 6,
            RefRole::PointB => 7,
        }
    }
}

/// A resolved constraint reference: either an entity sub-point or an external
/// literal `(x, y)` (the `external_xy` case, used by `coincident` against
/// ancestral geometry the TS builder already projected into plane coords).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Ref {
    Entity { index: u32, point: PointSelector },
    External { x: f64, y: f64 },
}

/// Axis filter for `midpoint` (the optional `axis` field).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    X,
    Y,
    Both,
}

impl Axis {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Axis::X,
            1 => Axis::Y,
            2 => Axis::Both,
            _ => return None,
        })
    }

    pub fn to_u8(self) -> u8 {
        match self {
            Axis::X => 0,
            Axis::Y => 1,
            Axis::Both => 2,
        }
    }

    pub fn includes_x(self) -> bool {
        matches!(self, Axis::X | Axis::Both)
    }

    pub fn includes_y(self) -> bool {
        matches!(self, Axis::Y | Axis::Both)
    }
}

/// The 19 constraint kinds the solver understands. Codes are stable wire values;
/// do not renumber without bumping the codec contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConstraintKind {
    Horizontal,
    Vertical,
    Length,
    Radius,
    Diameter,
    LineDistance,
    Coincident,
    Normal,
    Parallel,
    Angle,
    Tangent,
    EqualLength,
    PointDistance,
    Midpoint,
    Concentric,
    Fixed,
    RadiusDifference,
    PointDistanceX,
    PointDistanceY,
}

impl ConstraintKind {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => ConstraintKind::Horizontal,
            1 => ConstraintKind::Vertical,
            2 => ConstraintKind::Length,
            3 => ConstraintKind::Radius,
            4 => ConstraintKind::Diameter,
            5 => ConstraintKind::LineDistance,
            6 => ConstraintKind::Coincident,
            7 => ConstraintKind::Normal,
            8 => ConstraintKind::Parallel,
            9 => ConstraintKind::Angle,
            10 => ConstraintKind::Tangent,
            11 => ConstraintKind::EqualLength,
            12 => ConstraintKind::PointDistance,
            13 => ConstraintKind::Midpoint,
            14 => ConstraintKind::Concentric,
            15 => ConstraintKind::Fixed,
            16 => ConstraintKind::RadiusDifference,
            17 => ConstraintKind::PointDistanceX,
            18 => ConstraintKind::PointDistanceY,
            _ => return None,
        })
    }

    pub fn to_u8(self) -> u8 {
        match self {
            ConstraintKind::Horizontal => 0,
            ConstraintKind::Vertical => 1,
            ConstraintKind::Length => 2,
            ConstraintKind::Radius => 3,
            ConstraintKind::Diameter => 4,
            ConstraintKind::LineDistance => 5,
            ConstraintKind::Coincident => 6,
            ConstraintKind::Normal => 7,
            ConstraintKind::Parallel => 8,
            ConstraintKind::Angle => 9,
            ConstraintKind::Tangent => 10,
            ConstraintKind::EqualLength => 11,
            ConstraintKind::PointDistance => 12,
            ConstraintKind::Midpoint => 13,
            ConstraintKind::Concentric => 14,
            ConstraintKind::Fixed => 15,
            ConstraintKind::RadiusDifference => 16,
            ConstraintKind::PointDistanceX => 17,
            ConstraintKind::PointDistanceY => 18,
        }
    }
}

/// One constraint: kind, role-tagged references, and optional scalar payload.
/// The residual builder dispatches on `kind` and reads whichever roles that kind
/// expects.
#[derive(Debug, Clone, Default)]
pub struct Constraint {
    pub kind_code: u8,
    pub refs: Vec<(RefRole, Ref)>,
    pub value: Option<f64>,
    /// Explicit `(x, y)` target for `fixed` (the explicit-coordinate mode).
    pub xy: Option<(f64, f64)>,
    pub axis: Option<Axis>,
    /// Orientation selector for directional dimensions (`point_distance_x`,
    /// `point_distance_y`, `line_distance`, `angle`). When `Some(s)` the
    /// residual constrains the *signed* measure to `s * value`, so `s` (`+1.0`
    /// or `-1.0`) picks which side / handedness while the user-facing `value`
    /// stays non-negative. `None` keeps the legacy side-agnostic (absolute)
    /// residual, so existing constraints without a sign are unchanged.
    pub sign: Option<f64>,
}

impl Constraint {
    pub fn kind(&self) -> Option<ConstraintKind> {
        ConstraintKind::from_u8(self.kind_code)
    }

    /// The reference tagged with `role`, if present.
    pub fn ref_for(&self, role: RefRole) -> Option<Ref> {
        self.refs
            .iter()
            .find(|(r, _)| *r == role)
            .map(|(_, rf)| *rf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The u8 codes are a stable wire contract (see the doc comments). These
    // round-trip tests pin every variant so an accidental renumber fails loudly
    // instead of silently reinterpreting a constraint on the codec boundary.

    #[test]
    fn point_selector_roundtrips_and_pins_codes() {
        let all = [
            (PointSelector::Absent, 0),
            (PointSelector::Start, 1),
            (PointSelector::End, 2),
            (PointSelector::Center, 3),
            (PointSelector::Xy, 4),
            (PointSelector::Major, 5),
            (PointSelector::MajorNeg, 6),
            (PointSelector::Minor, 7),
            (PointSelector::MinorNeg, 8),
            (PointSelector::C1, 9),
            (PointSelector::C2, 10),
        ];
        for (sel, code) in all {
            assert_eq!(sel.to_u8(), code);
            assert_eq!(PointSelector::from_u8(code), Some(sel));
        }
        assert_eq!(PointSelector::from_u8(11), None);
        assert_eq!(PointSelector::from_u8(255), None);
    }

    #[test]
    fn point_selector_is_present_only_for_non_absent() {
        assert!(!PointSelector::Absent.is_present());
        assert!(PointSelector::Start.is_present());
        assert!(PointSelector::C2.is_present());
    }

    #[test]
    fn ref_role_roundtrips_and_pins_codes() {
        let all = [
            (RefRole::Target, 0),
            (RefRole::A, 1),
            (RefRole::B, 2),
            (RefRole::Line, 3),
            (RefRole::Arc, 4),
            (RefRole::Point, 5),
            (RefRole::PointA, 6),
            (RefRole::PointB, 7),
        ];
        for (role, code) in all {
            assert_eq!(role.to_u8(), code);
            assert_eq!(RefRole::from_u8(code), Some(role));
        }
        assert_eq!(RefRole::from_u8(8), None);
    }

    #[test]
    fn axis_roundtrips_and_filters() {
        let all = [(Axis::X, 0), (Axis::Y, 1), (Axis::Both, 2)];
        for (axis, code) in all {
            assert_eq!(axis.to_u8(), code);
            assert_eq!(Axis::from_u8(code), Some(axis));
        }
        assert_eq!(Axis::from_u8(3), None);

        assert!(Axis::X.includes_x() && !Axis::X.includes_y());
        assert!(!Axis::Y.includes_x() && Axis::Y.includes_y());
        assert!(Axis::Both.includes_x() && Axis::Both.includes_y());
    }

    #[test]
    fn constraint_kind_roundtrips_for_all_19_kinds() {
        // Walks 0..=18 exhaustively: every code maps to a kind and back, and the
        // count is exactly 19 (guards against a kind added without a code).
        let mut count = 0;
        for code in 0u8..=18 {
            let kind = ConstraintKind::from_u8(code).expect("0..=18 must be valid");
            assert_eq!(kind.to_u8(), code);
            count += 1;
        }
        assert_eq!(count, 19);
        assert_eq!(ConstraintKind::from_u8(19), None);
        assert_eq!(ConstraintKind::from_u8(u8::MAX), None);
    }

    #[test]
    fn constraint_kind_helper_reads_kind_code() {
        let c = Constraint {
            kind_code: ConstraintKind::Tangent.to_u8(),
            ..Default::default()
        };
        assert_eq!(c.kind(), Some(ConstraintKind::Tangent));

        let bad = Constraint {
            kind_code: 200,
            ..Default::default()
        };
        assert_eq!(bad.kind(), None);
    }

    #[test]
    fn ref_for_select_by_role() {
        let a = Ref::Entity {
            index: 0,
            point: PointSelector::Start,
        };
        let b = Ref::External { x: 1.5, y: -2.0 };
        let c = Constraint {
            kind_code: ConstraintKind::Coincident.to_u8(),
            refs: vec![(RefRole::A, a), (RefRole::B, b)],
            ..Default::default()
        };

        assert_eq!(c.ref_for(RefRole::A), Some(a));
        assert_eq!(c.ref_for(RefRole::B), Some(b));
        assert_eq!(c.ref_for(RefRole::Target), None);
    }

    #[test]
    fn ref_for_returns_first_match_on_duplicate_role() {
        let first = Ref::Entity {
            index: 1,
            point: PointSelector::End,
        };
        let second = Ref::Entity {
            index: 2,
            point: PointSelector::Center,
        };
        let c = Constraint {
            kind_code: ConstraintKind::EqualLength.to_u8(),
            refs: vec![(RefRole::A, first), (RefRole::A, second)],
            ..Default::default()
        };
        assert_eq!(c.ref_for(RefRole::A), Some(first));
    }
}
