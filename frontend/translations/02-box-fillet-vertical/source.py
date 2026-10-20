import cadquery as cq

# A rectangular block with the four vertical edges rounded.
result = (
    cq.Workplane("XY")
    .box(20, 14, 10, centered=(False, False, False))
    .edges("|Z")
    .fillet(3)
)
