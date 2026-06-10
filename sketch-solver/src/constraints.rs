//! Constraint model and its kind/role vocabulary.
//!
//! This mirrors the Python `_CONSTRAINT_HANDLERS` dicts in
//! `oversolved/kernel/solver_residuals.py`. A constraint is a kind plus a small
//! set of role-tagged references plus optional scalar payload (`value`, an
//! explicit `(x, y)` target for `fixed`, and an `axis` for `midpoint`).
//!
//! The crate never resolves queries: a reference always arrives already pointing
//! at a concrete entity *index* (the TS builder resolves ancestral query strings
//! to indices before the solve) or at an external `(x, y)` literal. Projection is
//! likewise not modelled here; a projected entity is an ordinary entity whose
//! params are pinned (via `pinned_mask`/`equality_pins`, see `codec`).

/// Which geometric sub-point of an entity a reference selects.
///
/// `Absent` is meaningful and distinct from `Start`: several handlers (notably
/// `coincident`) branch on whether the source dict carried a `point` key at all
/// (`"point" not in a_ref`), treating a point-less line reference as "the whole
/// line" rather than "its start point". `get_point` still falls back to the
/// start point when the selector is `Absent`, matching Python's
/// `ref.get("point", "start")`.
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
        }
    }

    /// True when the source dict carried an explicit `point` key. `coincident`
    /// uses this to distinguish whole-entity from point-on-entity semantics.
    pub fn is_present(self) -> bool {
        self != PointSelector::Absent
    }
}

/// The role a reference plays within a constraint, mirroring the dict keys
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

/// The 16 constraint kinds the solver understands. Codes are stable wire values;
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
        }
    }
}

/// One constraint: kind, role-tagged references, and optional scalar payload.
/// The residual builder dispatches on `kind` and reads whichever roles that kind
/// expects (mirroring the Python handlers' `if "a" in c` / `c["target"]` access).
#[derive(Debug, Clone, Default)]
pub struct Constraint {
    pub kind_code: u8,
    pub refs: Vec<(RefRole, Ref)>,
    pub value: Option<f64>,
    /// Explicit `(x, y)` target for `fixed` (mode 3 of `_residual_fixed`).
    pub xy: Option<(f64, f64)>,
    pub axis: Option<Axis>,
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

    pub fn has_role(&self, role: RefRole) -> bool {
        self.refs.iter().any(|(r, _)| *r == role)
    }
}
