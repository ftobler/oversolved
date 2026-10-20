import cadquery as cq

# A full revolve of an annular profile about the Y axis.
result = (
    cq.Workplane("XY")
    .moveTo(10, 0)
    .lineTo(20, 0)
    .lineTo(20, 5)
    .lineTo(10, 5)
    .close()
    .revolve(360, (0, 0, 0), (0, 1, 0))
)
