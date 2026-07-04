// The builtin reference features every fresh document starts with: an Origin
// and the three cardinal planes. Lives in a leaf module (no upstream imports
// beyond the PartFeature type) so both the React hook layer and the document
// store layer can read it at module-eval time without forming an import cycle
// through adapters/backend.

import type { PartFeature } from '@/types/cad'

export const BUILTIN_FEATURE_DEFAULTS: PartFeature[] = [
  { id: 'Origin', kind: 'origin' },
  { id: 'Top',    kind: 'plane' },
  { id: 'Front',  kind: 'plane' },
  { id: 'Right',  kind: 'plane' },
]

export const BUILTIN_FEATURE_IDS = new Set(BUILTIN_FEATURE_DEFAULTS.map(f => f.id))