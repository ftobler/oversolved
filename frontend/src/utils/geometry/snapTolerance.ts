// PURE geometry constant, shared by the draw clicks and the document writers.

/** Click positions that agree within this distance are the same point. Shared
 *  with drawLogic so the two tolerances can never drift, and kept out of
 *  drawAutoConstraints so a yamlMutations writer can use it without importing
 *  the snap-resolution side of the draw path. */
export const SNAP_EPS = 1e-6
