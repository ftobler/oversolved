// @vitest-environment node
// The headless wall from the runtime side: every core folder must be importable
// in a plain node process. A stray `window` or `document` read at module scope
// throws here, before any React or viewport exists, which is the "delete the
// Viewport and the logic still passes" goal made concrete.
import { describe, it, expect } from 'vitest'

// One entry per core folder (the plan's section 2 list). Keep this list next to
// the eslint fence: a new core folder should get an entry here with its first
// file. The loaders are written out so vite resolves the alias statically.
const CORE_ENTRIES: Array<[string, () => Promise<unknown>]> = [
  ['@/kernel/worker/kernelReady', () => import('@/kernel/worker/kernelReady')],
  ['@/kernel/query', () => import('@/kernel/query')],
  ['@/kernel/errors', () => import('@/kernel/errors')],
  ['@/drive/headlessPart', () => import('@/drive/headlessPart')],
  ['@/drive/headlessOps', () => import('@/drive/headlessOps')],
  ['@/session/DocSession', () => import('@/session/DocSession')],
  ['@/session/History', () => import('@/session/History')],
  ['@/session/result', () => import('@/session/result')],
  ['@/persistence/docSchema', () => import('@/persistence/docSchema')],
  ['@/persistence/idb', () => import('@/persistence/idb')],
  ['@/persistence/stepImport', () => import('@/persistence/stepImport')],
  ['@/persistence/fileRegistry', () => import('@/persistence/fileRegistry')],
  ['@/persistence/previewStore', () => import('@/persistence/previewStore')],
  ['@/registry', () => import('@/registry')],
  ['@/workspace/index', () => import('@/workspace/index')],
  ['@/wasm-kernel/lowerSketch', () => import('@/wasm-kernel/lowerSketch')],
  ['@/types/cad', () => import('@/types/cad')],
  ['@/utils/core/commandNames', () => import('@/utils/core/commandNames')],
  ['@/utils/core/commandSpec', () => import('@/utils/core/commandSpec')],
  ['@/utils/query/index', () => import('@/utils/query/index')],
  ['@/utils/measure/rules', () => import('@/utils/measure/rules')],
  ['@/utils/yamlMutations', () => import('@/utils/yamlMutations')],
  ['@/utils/geometry/sketchHelpers', () => import('@/utils/geometry/sketchHelpers')],
  ['@/utils/geometry/dragLogic', () => import('@/utils/geometry/dragLogic')],
  ['@/utils/geometry/surfaceShapes', () => import('@/utils/geometry/surfaceShapes')],
]

describe('core entries import headlessly', () => {
  it('has no DOM globals installed in the node project', () => {
    expect(typeof window).toBe('undefined')
    expect(typeof document).toBe('undefined')
  })

  it.each(CORE_ENTRIES)('imports %s without a DOM', async (_specifier, load) => {
    const module = await load() as Record<string, unknown>
    expect(Object.keys(module).length).toBeGreaterThan(0)
  })
})
