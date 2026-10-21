// A layer toggle must dirty the ID buffer and drop the hover resolved against
// the old layers, in that order. The registration hooks dirty the buffer on
// their own mount/unmount, so this pins the extra half: the hover invalidation
// and the reason that names the change in the pipeline's diagnostics.
import { describe, it, expect, vi } from 'vitest'
import { notifyLayerChange } from '@/components/Viewport/viewOptionsEffects'

describe('notifyLayerChange', () => {
  it('marks the pipeline dirty with the view-options reason, then clears hover', () => {
    const calls: string[] = []
    notifyLayerChange({
      markDirty: reason => { calls.push(`dirty:${reason}`) },
      clearHover: () => { calls.push('clear') },
    })
    expect(calls).toEqual(['dirty:view-options', 'clear'])
  })

  it('clears the hover even when no pipeline is live', () => {
    // An editor can toggle before IdPickingDriver attached. The hover teardown
    // is still right, and the registration effects dirty the buffer when the
    // pipeline arrives.
    const clearHover = vi.fn()
    notifyLayerChange({ markDirty: () => {}, clearHover })
    expect(clearHover).toHaveBeenCalledTimes(1)
  })
})
