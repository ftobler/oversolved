// Test-only shim giving the old `detectTopology(richGeom, featureId)` signature,
// backed by the Rust/WASM area builder + TS decoration. The behavioral suites
// that drove the old `topology.ts` now drive Rust through this helper.
//
// `topologyAvailable` is false on a fresh checkout (no `just wasm`); guard suites
// with `describe.skipIf(!topologyAvailable)`.

import { solveTopology, type TopologyDict } from "./topologyDecorate"
import { loadTopology } from "@/wasm-kernel/loadTopology"

const topo = loadTopology()

export const topologyAvailable = !!topo

// Loose `Record<string, unknown>` param to match the original `detectTopology`
// signature the behavioral suites were written against.
export function detectTopology(
  geometry: Record<string, unknown>,
  featureId = "",
): TopologyDict {
  return solveTopology(geometry as Record<string, Record<string, unknown>>, featureId, topo)
}
