//! Interpolating spline through N fit points.
//!
//! This is the canonical implementation of the `fit_spline` entity: the solver
//! residuals, the area builder's piece expansion and the TypeScript mirror
//! (`frontend/src/utils/geometry/fitSpline.ts`) all agree with it, and the
//! golden fixture in `fit_spline/golden.json` (generated from OCP's
//! `GeomAPI_Interpolate`) pins the agreement.
//!
//! The construction is the clamped C2 cubic spline that OCP builds:
//!
//!   1. Parameters are cumulative chord length, `u_0 = 0`,
//!      `u_i = u_{i-1} + |P_i - P_{i-1}|`.
//!   2. End derivatives come from the stored handle point when there is one
//!      (`D_0 = 3 (c1 - P_0) / h_0`, `D_{N-1} = 3 (P_{N-1} - c2) / h_{N-2}`),
//!      otherwise from the derivative of the Lagrange polynomial through the
//!      nearest `min(4, N)` points at the end parameter. OCP's `BuildTangents`
//!      uses the same rule for the free end of a one-handle curve; the one
//!      documented deviation is `N = 2` with a single handle, where OCP leaves
//!      the free derivative at zero and we use the chord.
//!   3. Interior derivatives solve the C2 tridiagonal system
//!      `h_i D_{i-1} + 2 (h_{i-1} + h_i) D_i + h_{i-1} D_{i+1}
//!       = 3 [h_i (P_i - P_{i-1}) / h_{i-1} + h_{i-1} (P_{i+1} - P_i) / h_i]`.
//!   4. Piece `i` is the Hermite cubic in Bezier form
//!      `[P_i, P_i + h_i D_i / 3, P_{i+1} - h_i D_{i+1} / 3, P_{i+1}]`.
//!
//! The chain of pieces IS the curve. The solver reads it directly; the OCC
//! writer hands the same poles and knots to `Geom_BSplineCurve` with
//! multiplicities `[4, 3, ..., 3, 4]` and removes the interior knots, which
//! recovers the C2 form (and OCP's `N + 2` poles) without a second algorithm.
//!
//! No solver types live here on purpose: the module is pure geometry so the
//! area builder and the tests can use it without the residual machinery.

/// The document's fit-point cap, shared with `MAX_INITIAL_PARAMS` on the TS
/// side (`2 * 64 + 4`).
pub const MAX_FIT_POINTS: usize = 64;

/// Entity flag bits: the optional end handles. Bit 0 is the start handle, bit 1
/// the end handle. They ride the wire entity record (see `codec`).
pub const FLAG_HANDLE_START: u8 = 1 << 0;
pub const FLAG_HANDLE_END: u8 = 1 << 1;
pub const HANDLE_FLAGS: u8 = FLAG_HANDLE_START | FLAG_HANDLE_END;

/// Why a fit-point list is not a valid spline. Authoring refuses these; the
/// solver floors a zero span instead (see `with_min_span`) so a solve stays
/// finite, while the area builder refuses the entity outright.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FitSplineError {
    TooFewPoints,
    TooManyPoints,
    /// Consecutive fit points at (or below) the resolution: the chord
    /// parameter span vanishes and the tridiagonal system has no answer.
    CoincidentPoints(usize, usize),
    NonFinite,
}

/// The refusal text the area builder and the authoring sugar surface.
#[allow(dead_code)]
pub fn fit_spline_error_message(error: &FitSplineError, id: &str) -> String {
    match error {
        FitSplineError::TooFewPoints => {
            format!("fit spline '{id}' needs at least 2 fit points")
        }
        FitSplineError::TooManyPoints => {
            format!("fit spline '{id}' has more than {MAX_FIT_POINTS} fit points")
        }
        FitSplineError::CoincidentPoints(i, j) => {
            format!("fit spline '{id}' has coincident consecutive fit points {i},{j}")
        }
        FitSplineError::NonFinite => {
            format!("fit spline '{id}' has a non-finite fit point or handle")
        }
    }
}

/// The param layout of a `fit_spline` entity: `2 N + 2 h` scalars, the N fit
/// points in order followed by the start handle (if any) and the end handle (if
/// any).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParamLayout {
    pub points: usize,
    pub handle_start: bool,
    pub handle_end: bool,
}

impl ParamLayout {
    /// Decode a wire entity record's `(param_count, flags)` pair. Every
    /// malformed combination is refused here, at the one door, so the residual
    /// builders never index a param block that does not exist.
    pub fn from_wire(param_count: usize, flags: u8) -> Result<Self, FitSplineError> {
        if flags & !HANDLE_FLAGS != 0 {
            return Err(FitSplineError::NonFinite);
        }
        let handles =
            (flags & FLAG_HANDLE_START != 0) as usize + (flags & FLAG_HANDLE_END != 0) as usize;
        let remaining = param_count
            .checked_sub(2 * handles)
            .ok_or(FitSplineError::TooFewPoints)?;
        if remaining % 2 != 0 {
            return Err(FitSplineError::TooFewPoints);
        }
        let points = remaining / 2;
        if points < 2 {
            return Err(FitSplineError::TooFewPoints);
        }
        if points > MAX_FIT_POINTS {
            return Err(FitSplineError::TooManyPoints);
        }
        Ok(ParamLayout {
            points,
            handle_start: flags & FLAG_HANDLE_START != 0,
            handle_end: flags & FLAG_HANDLE_END != 0,
        })
    }
}

/// The three pieces a fit-spline param block splits into: fit points, then the
/// optional start and end handles.
pub type SplitParams = (Vec<[f64; 2]>, Option<[f64; 2]>, Option<[f64; 2]>);

/// Split a param block into its fit points and optional handles.
pub fn split_params(params: &[f64], layout: ParamLayout) -> SplitParams {
    let mut points = Vec::with_capacity(layout.points);
    for i in 0..layout.points {
        points.push([params[2 * i], params[2 * i + 1]]);
    }
    let mut next = 2 * layout.points;
    let handle_start = if layout.handle_start {
        let h = [params[next], params[next + 1]];
        next += 2;
        Some(h)
    } else {
        None
    };
    let handle_end = if layout.handle_end {
        Some([params[next], params[next + 1]])
    } else {
        None
    };
    (points, handle_start, handle_end)
}

/// One interpolated curve: its chord knots and its end/interior derivatives.
/// The poles are derived on demand, which keeps the tridiagonal solve in one
/// place and makes the representation independent of how many pieces a caller
/// wants to see.
#[derive(Debug, Clone, PartialEq)]
pub struct FitSpline {
    points: Vec<[f64; 2]>,
    knots: Vec<f64>,
    derivatives: Vec<[f64; 2]>,
}

impl FitSpline {
    /// Build the exact OCP-compatible curve. A zero chord span is an error.
    pub fn new(
        points: &[[f64; 2]],
        handle_start: Option<[f64; 2]>,
        handle_end: Option<[f64; 2]>,
    ) -> Result<Self, FitSplineError> {
        Self::with_min_span(points, handle_start, handle_end, 0.0)
    }

    /// Build the curve with every chord span floored at `min_span`.
    ///
    /// The solver calls this with `resolution(scale)`: two fit points the user
    /// (or a constraint) drove together would otherwise divide by zero and
    /// poison the whole residual vector with NaN. The curve that comes out is
    /// finite and converges back out of the degeneracy. Authoring and the area
    /// builder use `new`, so a degenerate entity is refused, not silently
    /// squashed.
    pub fn with_min_span(
        points: &[[f64; 2]],
        handle_start: Option<[f64; 2]>,
        handle_end: Option<[f64; 2]>,
        min_span: f64,
    ) -> Result<Self, FitSplineError> {
        let n = points.len();
        if n < 2 {
            return Err(FitSplineError::TooFewPoints);
        }
        if n > MAX_FIT_POINTS {
            return Err(FitSplineError::TooManyPoints);
        }
        if points.iter().flatten().any(|v| !v.is_finite())
            || handle_start.is_some_and(|p| p.iter().any(|v| !v.is_finite()))
            || handle_end.is_some_and(|p| p.iter().any(|v| !v.is_finite()))
        {
            return Err(FitSplineError::NonFinite);
        }

        let mut knots = Vec::with_capacity(n);
        knots.push(0.0);
        for i in 1..n {
            let chord = (points[i][0] - points[i - 1][0]).hypot(points[i][1] - points[i - 1][1]);
            if chord <= 0.0 && min_span <= 0.0 {
                return Err(FitSplineError::CoincidentPoints(i - 1, i));
            }
            knots.push(knots[i - 1] + chord.max(min_span));
        }

        let mut derivatives = vec![[0.0, 0.0]; n];
        derivatives[0] = match handle_start {
            Some(h) => handle_derivative(points[0], h, knots[1] - knots[0]),
            None => end_derivative(points, &knots, true),
        };
        derivatives[n - 1] = match handle_end {
            Some(h) => {
                let d = handle_derivative(points[n - 1], h, knots[n - 1] - knots[n - 2]);
                [-d[0], -d[1]]
            }
            None => end_derivative(points, &knots, false),
        };
        solve_interior(points, &knots, &mut derivatives);

        Ok(FitSpline {
            points: points.to_vec(),
            knots,
            derivatives,
        })
    }

    /// The chord parameter values, one per fit point.
    pub fn knots(&self) -> &[f64] {
        &self.knots
    }

    /// The derivative `D_i` at fit point `i`.
    pub fn derivative(&self, i: usize) -> [f64; 2] {
        self.derivatives[i]
    }

    pub fn point_count(&self) -> usize {
        self.knots.len()
    }

    /// Number of cubic pieces: `N - 1`.
    pub fn piece_count(&self) -> usize {
        self.knots.len() - 1
    }

    /// The four Bezier control points of piece `i`.
    pub fn piece(&self, i: usize) -> [[f64; 2]; 4] {
        let h = self.knots[i + 1] - self.knots[i];
        let d0 = self.derivatives[i];
        let d1 = self.derivatives[i + 1];
        [
            self.points[i],
            [
                self.points[i][0] + h * d0[0] / 3.0,
                self.points[i][1] + h * d0[1] / 3.0,
            ],
            [
                self.points[i + 1][0] - h * d1[0] / 3.0,
                self.points[i + 1][1] - h * d1[1] / 3.0,
            ],
            self.points[i + 1],
        ]
    }

    /// The C0 Bezier chain poles: `3 (N - 1) + 1` of them, sharing each joint.
    pub fn poles(&self) -> Vec<[f64; 2]> {
        let mut poles = Vec::with_capacity(3 * self.piece_count() + 1);
        for i in 0..self.piece_count() {
            let ctrl = self.piece(i);
            if i == 0 {
                poles.push(ctrl[0]);
            }
            poles.push(ctrl[1]);
            poles.push(ctrl[2]);
            poles.push(ctrl[3]);
        }
        poles
    }

    /// Piece index containing `u`, clamped to the domain.
    pub fn piece_at(&self, u: f64) -> usize {
        let last = self.piece_count() - 1;
        if u <= self.knots[0] {
            return 0;
        }
        if u >= self.knots[self.knots.len() - 1] {
            return last;
        }
        let mut lo = 0;
        let mut hi = self.knots.len() - 1;
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if self.knots[mid] <= u {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        lo.min(last)
    }

    /// Evaluate the curve at chord parameter `u`.
    pub fn eval(&self, u: f64) -> [f64; 2] {
        let i = self.piece_at(u);
        let h = self.knots[i + 1] - self.knots[i];
        let t = if h > 0.0 {
            ((u - self.knots[i]) / h).clamp(0.0, 1.0)
        } else {
            0.0
        };
        bezier_eval(&self.piece(i), t)
    }

    /// First derivative with respect to `u`.
    pub fn deriv(&self, u: f64) -> [f64; 2] {
        let i = self.piece_at(u);
        let h = self.knots[i + 1] - self.knots[i];
        let t = if h > 0.0 {
            ((u - self.knots[i]) / h).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let d = bezier_deriv(&self.piece(i), t);
        if h > 0.0 {
            [d[0] / h, d[1] / h]
        } else {
            d
        }
    }

    /// The chord parameter of a piece-space parameter `s = piece + t`.
    pub fn u_at(&self, s: f64) -> f64 {
        let i = (s.floor() as usize).min(self.piece_count() - 1);
        let t = (s - i as f64).clamp(0.0, 1.0);
        self.knots[i] + t * (self.knots[i + 1] - self.knots[i])
    }

    /// The closest point on the chain to `p`.
    ///
    /// `distance` is the full Euclidean distance and `signed` follows the side
    /// of the tangent there, matching the Bezier `spline_point_residual` so a
    /// coincident point on either kind reads the same way. The search is the
    /// per-piece coarse scan plus Newton refine the Bezier path uses, keeping
    /// the global minimum.
    pub fn closest(&self, p: [f64; 2]) -> ClosestPoint {
        let mut best = ClosestPoint {
            u: self.knots[0],
            point: self.eval(self.knots[0]),
            distance: f64::INFINITY,
            signed: f64::INFINITY,
        };
        for i in 0..self.piece_count() {
            let ctrl = self.piece(i);
            let t = bezier_closest_t(&ctrl, p);
            let point = bezier_eval(&ctrl, t);
            let w = [p[0] - point[0], p[1] - point[1]];
            let distance = w[0].hypot(w[1]);
            if distance < best.distance {
                let d1 = bezier_deriv(&ctrl, t);
                let signed = if d1[0] * w[1] - d1[1] * w[0] < 0.0 {
                    -distance
                } else {
                    distance
                };
                let h = self.knots[i + 1] - self.knots[i];
                best = ClosestPoint {
                    u: self.knots[i] + t * h,
                    point,
                    distance,
                    signed,
                };
            }
        }
        best
    }

    /// The chain restricted to `[u0, u1]`, as poles and knots for a fused
    /// topology edge. The end pieces are de Casteljau splits, so the result is
    /// the same curve over the sub-domain.
    pub fn sub_chain(&self, u0: f64, u1: f64) -> (Vec<[f64; 2]>, Vec<f64>) {
        let (u0, u1) = (u0.min(u1), u0.max(u1));
        if u0 <= self.knots[0] && u1 >= self.knots[self.knots.len() - 1] {
            return (self.poles(), self.knots.clone());
        }
        let mut poles: Vec<[f64; 2]> = Vec::new();
        let mut knots: Vec<f64> = vec![u0];
        for i in 0..self.piece_count() {
            let (a, b) = (self.knots[i], self.knots[i + 1]);
            if b <= u0 || a >= u1 {
                continue;
            }
            let t0 = ((u0 - a) / (b - a)).clamp(0.0, 1.0);
            let t1 = ((u1 - a) / (b - a)).clamp(0.0, 1.0);
            let ctrl = split_bezier(&self.piece(i), t0, t1);
            if poles.is_empty() {
                poles.extend_from_slice(&ctrl);
            } else {
                // The joint point is already the previous piece's end.
                poles.extend_from_slice(&ctrl[1..]);
            }
            knots.push(u1.min(b));
        }
        (poles, knots)
    }
}

/// A point on the chain's closest-point query.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClosestPoint {
    pub u: f64,
    pub point: [f64; 2],
    pub distance: f64,
    pub signed: f64,
}

fn handle_derivative(point: [f64; 2], handle: [f64; 2], h: f64) -> [f64; 2] {
    [
        3.0 * (handle[0] - point[0]) / h,
        3.0 * (handle[1] - point[1]) / h,
    ]
}

/// The end derivative of the Lagrange polynomial through the nearest
/// `min(4, N)` points, evaluated at the first (or last) node. For `N = 2` this
/// is the chord, which is also what OCP's degree-1 case uses.
fn end_derivative(points: &[[f64; 2]], knots: &[f64], start: bool) -> [f64; 2] {
    let n = points.len();
    let count = n.min(4);
    let (us, ps, k) = if start {
        (knots[..count].to_vec(), points[..count].to_vec(), 0)
    } else {
        (
            knots[n - count..].to_vec(),
            points[n - count..].to_vec(),
            count - 1,
        )
    };
    lagrange_derivative(&us, &ps, k)
}

/// Derivative at node `k` of the polynomial interpolating `(us, ps)`.
///
/// `L_j'(u_k)` is the nodal formula: for `j != k` the product runs over the
/// other nodes, and for `j == k` it is the derivative of that node's own
/// product, so the weights sum to zero and a constant point list has a zero
/// derivative.
fn lagrange_derivative(us: &[f64], ps: &[[f64; 2]], k: usize) -> [f64; 2] {
    let mut out = [0.0, 0.0];
    for (j, p) in ps.iter().enumerate() {
        let weight = if j == k {
            let mut sum = 0.0;
            for a in 0..us.len() {
                if a == k {
                    continue;
                }
                let mut product = 1.0;
                for (b, u) in us.iter().enumerate() {
                    if b != k && b != a {
                        product *= us[k] - u;
                    }
                }
                sum += product;
            }
            let mut denominator = 1.0;
            for (b, u) in us.iter().enumerate() {
                if b != k {
                    denominator *= us[k] - u;
                }
            }
            sum / denominator
        } else {
            let mut numerator = 1.0;
            for (m, u) in us.iter().enumerate() {
                if m != k && m != j {
                    numerator *= us[k] - u;
                }
            }
            let mut denominator = 1.0;
            for (m, u) in us.iter().enumerate() {
                if m != j {
                    denominator *= us[j] - u;
                }
            }
            numerator / denominator
        };
        out[0] += weight * p[0];
        out[1] += weight * p[1];
    }
    out
}

/// Solve the C2 tridiagonal system for the interior derivatives, per
/// coordinate, with the Thomas algorithm. The first and last rows carry the
/// known end derivative to the right-hand side.
fn solve_interior(points: &[[f64; 2]], knots: &[f64], derivatives: &mut [[f64; 2]]) {
    let n = points.len();
    let m = n.saturating_sub(2);
    if m == 0 {
        return;
    }
    let mut sub = vec![0.0; m];
    let mut diag = vec![0.0; m];
    let mut sup = vec![0.0; m];
    let mut rhs = vec![[0.0; 2]; m];
    for row in 0..m {
        let i = row + 1;
        let h_prev = knots[i] - knots[i - 1];
        let h_next = knots[i + 1] - knots[i];
        sub[row] = h_next;
        diag[row] = 2.0 * (h_prev + h_next);
        sup[row] = h_prev;
        rhs[row] = [
            3.0 * (h_next * (points[i][0] - points[i - 1][0]) / h_prev
                + h_prev * (points[i + 1][0] - points[i][0]) / h_next),
            3.0 * (h_next * (points[i][1] - points[i - 1][1]) / h_prev
                + h_prev * (points[i + 1][1] - points[i][1]) / h_next),
        ];
    }
    for c in 0..2 {
        rhs[0][c] -= sub[0] * derivatives[0][c];
        rhs[m - 1][c] -= sup[m - 1] * derivatives[n - 1][c];
    }

    let mut cprime = vec![0.0; m];
    let mut dprime = vec![[0.0; 2]; m];
    cprime[0] = sup[0] / diag[0];
    dprime[0] = [rhs[0][0] / diag[0], rhs[0][1] / diag[0]];
    for row in 1..m {
        let denominator = diag[row] - sub[row] * cprime[row - 1];
        cprime[row] = sup[row] / denominator;
        dprime[row] = [
            (rhs[row][0] - sub[row] * dprime[row - 1][0]) / denominator,
            (rhs[row][1] - sub[row] * dprime[row - 1][1]) / denominator,
        ];
    }
    let mut x = vec![[0.0; 2]; m];
    x[m - 1] = dprime[m - 1];
    for row in (0..m - 1).rev() {
        x[row] = [
            dprime[row][0] - cprime[row] * x[row + 1][0],
            dprime[row][1] - cprime[row] * x[row + 1][1],
        ];
    }
    derivatives[1..=m].copy_from_slice(&x);
}

/// Evaluate a cubic Bezier at `t`.
pub fn bezier_eval(ctrl: &[[f64; 2]; 4], t: f64) -> [f64; 2] {
    let mt = 1.0 - t;
    let a = mt * mt * mt;
    let b = 3.0 * mt * mt * t;
    let c = 3.0 * mt * t * t;
    let d = t * t * t;
    [
        a * ctrl[0][0] + b * ctrl[1][0] + c * ctrl[2][0] + d * ctrl[3][0],
        a * ctrl[0][1] + b * ctrl[1][1] + c * ctrl[2][1] + d * ctrl[3][1],
    ]
}

/// First derivative of a cubic Bezier with respect to `t`.
pub fn bezier_deriv(ctrl: &[[f64; 2]; 4], t: f64) -> [f64; 2] {
    let mt = 1.0 - t;
    [
        3.0 * mt * mt * (ctrl[1][0] - ctrl[0][0])
            + 6.0 * mt * t * (ctrl[2][0] - ctrl[1][0])
            + 3.0 * t * t * (ctrl[3][0] - ctrl[2][0]),
        3.0 * mt * mt * (ctrl[1][1] - ctrl[0][1])
            + 6.0 * mt * t * (ctrl[2][1] - ctrl[1][1])
            + 3.0 * t * t * (ctrl[3][1] - ctrl[2][1]),
    ]
}

fn bezier_deriv2(ctrl: &[[f64; 2]; 4], t: f64) -> [f64; 2] {
    let mt = 1.0 - t;
    [
        6.0 * mt * (ctrl[2][0] - 2.0 * ctrl[1][0] + ctrl[0][0])
            + 6.0 * t * (ctrl[3][0] - 2.0 * ctrl[2][0] + ctrl[1][0]),
        6.0 * mt * (ctrl[2][1] - 2.0 * ctrl[1][1] + ctrl[0][1])
            + 6.0 * t * (ctrl[3][1] - 2.0 * ctrl[2][1] + ctrl[1][1]),
    ]
}

/// Parameter of the closest point on one cubic Bezier, the same coarse scan
/// plus Newton refine the residual path uses. Deterministic, which is all the
/// finite-difference Jacobian needs.
fn bezier_closest_t(ctrl: &[[f64; 2]; 4], p: [f64; 2]) -> f64 {
    const SAMPLES: usize = 24;
    let dist2 = |t: f64| {
        let b = bezier_eval(ctrl, t);
        (p[0] - b[0]).powi(2) + (p[1] - b[1]).powi(2)
    };
    let mut best_t = 0.0;
    let mut best_d = f64::INFINITY;
    for i in 0..=SAMPLES {
        let t = i as f64 / SAMPLES as f64;
        let d = dist2(t);
        if d < best_d {
            best_d = d;
            best_t = t;
        }
    }
    let mut t = best_t;
    for _ in 0..8 {
        let b = bezier_eval(ctrl, t);
        let d1 = bezier_deriv(ctrl, t);
        let d2 = bezier_deriv2(ctrl, t);
        let w = [p[0] - b[0], p[1] - b[1]];
        let f = w[0] * d1[0] + w[1] * d1[1];
        let fp = -(d1[0] * d1[0] + d1[1] * d1[1]) + w[0] * d2[0] + w[1] * d2[1];
        if fp.abs() < 1e-12 {
            break;
        }
        t -= f / fp;
        t = t.clamp(0.0, 1.0);
    }
    t
}

/// The part of one cubic Bezier between parameters `t0 <= t1`, via de
/// Casteljau. The end pieces of a cut fit spline are these.
pub fn split_bezier(ctrl: &[[f64; 2]; 4], t0: f64, t1: f64) -> [[f64; 2]; 4] {
    if t1 < t0 {
        let mut r = split_bezier(ctrl, t1, t0);
        r.reverse();
        return r;
    }
    let right = subdivide(ctrl, t0, 1.0);
    subdivide(&right, 0.0, (t1 - t0) / (1.0 - t0))
}

fn subdivide(ctrl: &[[f64; 2]; 4], t0: f64, t1: f64) -> [[f64; 2]; 4] {
    if t0 <= 0.0 && t1 >= 1.0 {
        return *ctrl;
    }
    // Split at t1, keep the left part, then split that at t0/t1 and keep the
    // right part. Two de Casteljau passes keep the arithmetic exact.
    let left = de_casteljau(ctrl, t1).0;
    if t0 <= 0.0 {
        return left;
    }
    let scaled = (t0 / t1).clamp(0.0, 1.0);
    de_casteljau(&left, scaled).1
}

/// `(left, right)` halves of a cubic at `t`.
fn de_casteljau(ctrl: &[[f64; 2]; 4], t: f64) -> ([[f64; 2]; 4], [[f64; 2]; 4]) {
    let lerp = |a: [f64; 2], b: [f64; 2]| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    let p01 = lerp(ctrl[0], ctrl[1]);
    let p12 = lerp(ctrl[1], ctrl[2]);
    let p23 = lerp(ctrl[2], ctrl[3]);
    let p012 = lerp(p01, p12);
    let p123 = lerp(p12, p23);
    let p = lerp(p012, p123);
    ([ctrl[0], p01, p012, p], [p, p123, p23, ctrl[3]])
}

#[cfg(test)]
mod tests;
