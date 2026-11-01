// How many segments one full turn is tessellated into. One number for the
// body edge curves and the sketch area shapes, so a change reaches the fill,
// the pick triangles and the drawn edges together instead of drifting apart.
//
// It lives in a dependency-free leaf because the picking and sketching layers
// both need it, and neither may import the UI tree (importBoundary.test.ts).
export const ARC_SEGMENTS = 64
