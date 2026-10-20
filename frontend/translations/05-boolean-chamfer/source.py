import cadquery as cq

# A union of a block and a cylindrical boss, with the boss rim chamfered.
base = cq.Workplane("XY").box(30, 20, 8, centered=(True, True, False))
boss = cq.Workplane("XY").workplane(offset=8).circle(6).extrude(6)
result = base.union(boss).edges(">Z").chamfer(1)
