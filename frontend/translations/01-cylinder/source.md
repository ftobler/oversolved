# Source: analytic cylinder

An r = 4, h = 12 right circular cylinder, extruded 12 mm along the front
plane normal from a circle centred at (10, 10).

- Volume: V = pi r^2 h = pi * 16 * 12
- Surface area: A = 2 pi r^2 + 2 pi r h
- Centroid: the centre of the axis, (10, 10, 6)
- Bounding box: the circle spans [6, 14] on both in-plane axes, and the
  extrusion spans [0, 12] along the normal
- A full circle extrudes to 3 faces (2 caps plus the lateral face) and 3 edges
  (2 rims plus the seam)

The values are the closed-form ones, so this case proves the tier end to end
without a third-party tool.
