// The joint-limit boxes: one bound per key, empty meaning an open end, and a
// rotating value folded onto the solver's signed roll coordinate on blur.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MateEditor } from '@/components/layout/MateEditor'
import type { MateFeatureDef } from '@/types/cad'

function mate(kind: MateFeatureDef['kind'], overrides: Partial<MateFeatureDef> = {}): MateFeatureDef {
  return {
    kind,
    ref_a: { part: 'h1', anchor: 'a1' },
    ref_b: { part: 'h2', anchor: 'b1' },
    ...overrides,
  }
}

function renderEditor(m: MateFeatureDef) {
  const onUpdate = vi.fn()
  render(
    <MateEditor featureId="m1" mate={m} activeField={null} onArmField={vi.fn()} onUpdate={onUpdate} />,
  )
  return onUpdate
}

describe('MateEditor joint limits', () => {
  it('labels a hinge bound in degrees and a slide bound in distance', () => {
    renderEditor(mate('rotating'))
    expect((screen.getByLabelText('Min angle') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Max angle') as HTMLInputElement).value).toBe('')
  })

  it('offers distance bounds on a sliding mate', () => {
    renderEditor(mate('sliding'))
    expect(screen.getByLabelText('Min distance')).toBeTruthy()
    expect(screen.getByLabelText('Max distance')).toBeTruthy()
  })

  it('does not offer a bound on a kind with no single free coordinate', () => {
    renderEditor(mate('fixed'))
    expect(screen.queryByLabelText('Min angle')).toBeNull()
    expect(screen.queryByLabelText('Max distance')).toBeNull()
  })

  it('writes an authored bound and clears it back to open', () => {
    const onUpdate = renderEditor(mate('sliding', { limit_min: 5 }))
    const box = screen.getByLabelText('Min distance') as HTMLInputElement
    expect(box.value).toBe('5')
    fireEvent.change(box, { target: { value: '12' } })
    expect(onUpdate).toHaveBeenCalledWith({ limit_min: 12 })
    fireEvent.change(box, { target: { value: '' } })
    expect(onUpdate).toHaveBeenCalledWith({ limit_min: undefined })
  })

  it('accepts a negative number as it is typed', () => {
    // The dirty-text state exists so the leading '-' is not reverted by the
    // controlled value before the digits arrive.
    const onUpdate = renderEditor(mate('rotating'))
    fireEvent.change(screen.getByLabelText('Min angle'), { target: { value: '-45' } })
    expect(onUpdate).toHaveBeenCalledWith({ limit_min: -45 })
  })

  it('refuses an out-of-range rotating bound and restores the stored value on blur', () => {
    // A lone max of 181 allows every reachable roll; folding it to -179 would
    // invent a one-degree stop. The refused entry is not written, and the blur
    // shows the value the document really holds rather than the rejected text.
    const onUpdate = renderEditor(mate('rotating', { limit_min: 27 }))
    const box = screen.getByLabelText('Min angle') as HTMLInputElement
    fireEvent.change(box, { target: { value: '270' } })
    expect(onUpdate).not.toHaveBeenCalled()
    expect(screen.getByText(/A rotating bound must be inside \(-180, 180\]/)).toBeTruthy()
    fireEvent.blur(box)
    expect(onUpdate).not.toHaveBeenCalled()
    expect(box.value).toBe('27')
  })

  it('commits a signed rotating bound as it is typed', () => {
    const onUpdate = renderEditor(mate('rotating'))
    fireEvent.change(screen.getByLabelText('Min angle'), { target: { value: '-90' } })
    expect(onUpdate).toHaveBeenCalledWith({ limit_min: -90 })
  })

  it('leaves a sliding bound unsigned on blur', () => {
    const onUpdate = renderEditor(mate('sliding', { limit_max: 270 }))
    fireEvent.blur(screen.getByLabelText('Max distance'))
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('refuses an inverted range instead of writing a document the loader rejects', () => {
    // The loader refuses min > max, so the editor must not author it. The text
    // stays on screen with the reason, and the document keeps its last valid
    // pair.
    const onUpdate = renderEditor(mate('sliding', { limit_min: 10 }))
    fireEvent.change(screen.getByLabelText('Max distance'), { target: { value: '5' } })
    expect(onUpdate).not.toHaveBeenCalled()
    expect(screen.getByText('Min must not exceed max.')).toBeTruthy()
  })

  it('refuses a rotating range that crosses the +/-180 cut', () => {
    // 170..190 is 20 degrees wide, but folding the endpoints gives 170..-170:
    // the inverted pair the loader calls unrepresentable.
    const onUpdate = renderEditor(mate('rotating', { limit_min: 170 }))
    fireEvent.change(screen.getByLabelText('Max angle'), { target: { value: '190' } })
    expect(onUpdate).not.toHaveBeenCalled()
    expect(screen.getByText(/A rotating bound must be inside \(-180, 180\]/)).toBeTruthy()
  })
})
