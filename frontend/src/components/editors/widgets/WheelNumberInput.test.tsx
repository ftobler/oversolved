import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WheelNumberInput } from './WheelNumberInput'

function renderWheel(props: Partial<React.ComponentProps<typeof WheelNumberInput>> = {}) {
  const onStep = vi.fn()
  const onChange = vi.fn()
  const { rerender, unmount } = render(
    <WheelNumberInput value="3" ariaLabel="Sides" onStep={onStep} onChange={onChange} {...props} />,
  )
  const input = screen.getByRole('spinbutton', { name: 'Sides' }) as HTMLInputElement
  return { input, onStep, onChange, rerender, unmount }
}

describe('WheelNumberInput wheel step', () => {
  it('commits value plus one on wheel up', () => {
    const { input, onStep } = renderWheel({ value: '10' })
    fireEvent.wheel(input, { deltaY: -100 })
    expect(onStep).toHaveBeenCalledWith(11)
  })

  it('refuses a step at a rejected boundary instead of committing', () => {
    const accept = (n: number) => n >= 3
    const { input, onStep } = renderWheel({ value: '3', accept })
    fireEvent.wheel(input, { deltaY: 100 })  // would step to 2, below the min
    expect(onStep).not.toHaveBeenCalled()
  })

  it('still prevents default when the step is refused', () => {
    const accept = (n: number) => n >= 3
    const { input } = renderWheel({ value: '3', accept })
    const ev = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })
})
