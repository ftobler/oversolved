// The builtin reference features every fresh document starts with: an Origin
// and the three cardinal planes. Lives in a leaf module (no upstream imports
// beyond the PartFeature type) so both the React hook layer and the document
// store layer can read it at module-eval time without forming an import cycle
// through adapters/backend.

import type { PartFeature, AssemblyFeature } from '@/types/cad'

export const BUILTIN_FEATURE_DEFAULTS: PartFeature[] = [
  { id: 'Origin', kind: 'origin' },
  { id: 'Top',    kind: 'plane' },
  { id: 'Front',  kind: 'plane' },
  { id: 'Right',  kind: 'plane' },
]

export const BUILTIN_FEATURE_IDS = new Set(BUILTIN_FEATURE_DEFAULTS.map(f => f.id))

// The assembly's OWN coordinate frame: an Origin + 3 cardinal planes, separate
// from each part's built-ins. Assembly-scoped ids keep an empty AssemblyDoc from
// silently inheriting part built-ins (see useAssemblyDoc / useDocumentState
// empty-features scoping). These ids double as the assembly-builtin anchor ids a
// mate references (assemblyAnchors in kernel/solveAssembly.ts).
export const ASSEMBLY_ORIGIN_ID = 'AssemblyOrigin'
export const ASSEMBLY_TOP_ID = 'AssemblyTop'
export const ASSEMBLY_FRONT_ID = 'AssemblyFront'
export const ASSEMBLY_RIGHT_ID = 'AssemblyRight'

export const ASSEMBLY_BUILTIN_DEFAULTS: AssemblyFeature[] = [
  { id: ASSEMBLY_ORIGIN_ID, kind: 'origin' },
  { id: ASSEMBLY_TOP_ID,    kind: 'plane' },
  { id: ASSEMBLY_FRONT_ID,  kind: 'plane' },
  { id: ASSEMBLY_RIGHT_ID,  kind: 'plane' },
]

export const ASSEMBLY_BUILTIN_IDS = new Set(ASSEMBLY_BUILTIN_DEFAULTS.map(f => f.id))

// Reserved part handle addressing the assembly's own frame in a MateRef. A real
// PartInstance handle is randomId(8) (see assemblyMutations), which never yields
// this literal, so the reserved handle cannot collide with a generated instance.
export const ASSEMBLY_HANDLE = '__assembly'