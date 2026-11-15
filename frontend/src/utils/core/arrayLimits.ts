// The caps one array-like feature may expand to. They live here rather than in
// persistence/docSchema so the kernel's pure instance model can enforce the same
// numbers without importing the document boundary.

/** One axis (or one total) of instances. Far above a hand-authored pattern,
 *  well below what the kernel can build in a reasonable time. */
export const MAX_ARRAY_COUNT = 1_000

/** A rectangular grid's cell count: count_x * count_y. */
export const MAX_ARRAY_CELLS = 100_000
