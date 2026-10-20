import cadquery as cq

# A plate with a four-hole pattern at the corners of a 20 x 16 rectangle.
result = (
    cq.Workplane("XY")
    .box(40, 30, 6, centered=(False, False, False))
    .faces(">Z")
    .workplane()
    .pushPoints([(10, 7), (30, 7), (10, 23), (30, 23)])
    .hole(6)
)
