import cadquery as cq

# A revolved profile whose outer side is an interpolating spline through four
# points (the current point plus three).
result = (
    cq.Workplane("XY")
    .moveTo(0, 0)
    .lineTo(1, 0)
    .spline([(1.5, 1), (1.2, 2), (1, 3)], includeCurrent=True)
    .lineTo(0, 3)
    .close()
    .revolve(360, (0, 0, 0), (0, 1, 0))
)
