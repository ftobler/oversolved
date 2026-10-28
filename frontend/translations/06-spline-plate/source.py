import cadquery as cq

# Ex010: a plate whose top edge is an interpolating spline through seven points
# plus the current point, the corpus case for the fit_spline entity.
sPnts = [
    (2.75, 1.5),
    (2.5, 1.75),
    (2.0, 1.5),
    (1.5, 1.0),
    (1.0, 1.25),
    (0.5, 1.0),
    (0, 1.0),
]

result = (
    cq.Workplane("XY")
    .lineTo(3.0, 0)
    .lineTo(3.0, 1.0)
    .spline(sPnts, includeCurrent=True)
    .close()
    .extrude(0.5)
)
