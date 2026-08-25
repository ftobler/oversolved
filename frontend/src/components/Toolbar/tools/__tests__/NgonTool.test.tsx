import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import NgonTool from '@/components/Toolbar/tools/NgonTool'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

// The side-count field used to write every keystroke straight into the store,
// whose 3..64 clamp then fed back into the controlled value: typing "12"
// produced 3 then 32, the whole 10..29 range was unreachable by keyboard and
// clearing snapped back to 6 mid-edit. These tests pin the fix: raw text is
// held in component state while focused, and only Enter or blur commits.
describe('NgonTool side-count input', () => {
  beforeEach(() => {
    useSketchEditorStore.setState({ activeTool: 'ngon', ngonSides: 6 })
  })

  const input = () => screen.getByTitle('Number of sides') as HTMLInputElement
  const storeSides = () => useSketchEditorStore.getState().ngonSides

  it('holds the draft while focused and commits 12 on Enter', () => {
    render(<NgonTool />)
    fireEvent.change(input(), { target: { value: '1' } })
    // Mid-typing "1" must not hit the clamp (which would snap it to 3).
    expect(input().value).toBe('1')
    expect(storeSides()).toBe(6)
    fireEvent.change(input(), { target: { value: '12' } })
    expect(storeSides()).toBe(6)
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(storeSides()).toBe(12)
    // The draft is consumed, so the field shows the committed value.
    expect(input().value).toBe('12')
  })

  it('commits on blur without needing Enter', () => {
    render(<NgonTool />)
    fireEvent.change(input(), { target: { value: '5' } })
    fireEvent.blur(input())
    expect(storeSides()).toBe(5)
  })

  it('falls back to the clamp default when cleared and blurred', () => {
    useSketchEditorStore.setState({ ngonSides: 12 })
    render(<NgonTool />)
    fireEvent.change(input(), { target: { value: '' } })
    // Clearing alone must not rewrite the store mid-edit.
    expect(input().value).toBe('')
    expect(storeSides()).toBe(12)
    fireEvent.blur(input())
    // parseInt('') is NaN and the store's `|| 6` arm supplies the default.
    expect(storeSides()).toBe(6)
    expect(input().value).toBe('6')
  })

  it('clamps an out-of-range value on commit', () => {
    render(<NgonTool />)
    fireEvent.change(input(), { target: { value: '99' } })
    expect(storeSides()).toBe(6)
    fireEvent.blur(input())
    expect(storeSides()).toBe(64)
    expect(input().value).toBe('64')
  })
})
