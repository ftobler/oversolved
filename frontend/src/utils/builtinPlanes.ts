// Render-side constants for the built-in sketch planes, shared by the part
// editor (components/Geometry3D) and the assembly viewport (utils/assemblyRender):
// the XYZ Euler triples that orient a plane quad and the default quad edge length.
//
// The canonical frames live in kernel/solverConstants.ts (BUILTIN_PLANES).
// Deriving the triples from them would need a frame-to-Euler conversion at
// runtime and would make utils import kernel, inverting the dependency (kernel
// already imports utils). The two are pinned to agree by builtinPlanes.test.ts.

export const BUILTIN_PLANE_ROTATIONS: Record<string, [number, number, number]> = {
  builtin_plane_front: [0, 0, 0],
  builtin_plane_top: [-Math.PI / 2, 0, 0],
  builtin_plane_right: [0, Math.PI / 2, 0],
}

// Default edge length, in world units, of a plane quad with no sized geometry
// behind it: builtin reference planes, user-defined planes with no extent, and
// the active sketch-plane display.
export const DEFAULT_PLANE_SIZE = 100
