import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { UnitBox, UnitLabel, UnitText } from './UnitLabel'
import { ExpressionInput } from './ExpressionInput'

const PART_CSS = readFileSync(join(__dirname, '../../../pages/Part.css'), 'utf8')

describe('UnitLabel', () => {
  it('renders the adornment in the quantity vocabulary', () => {
    render(<UnitLabel quantity="length" lengthUnit="inch" />)
    const unit = screen.getByText('in')
    expect(unit.className).toBe('field-unit')
  })

  it('is aria-hidden: the input already says the unit out loud', () => {
    render(<UnitLabel quantity="angle" />)
    expect(screen.getByText('deg').getAttribute('aria-hidden')).toBe('true')
  })

  it('renders nothing for a ratio', () => {
    const { container } = render(<UnitLabel quantity="none" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a free-form hint through UnitText, unhidden', () => {
    render(<UnitText label="kN" />)
    expect(screen.getByText('kN').getAttribute('aria-hidden')).toBeNull()
  })
})

describe('UnitBox', () => {
  it('marks the box as carrying a unit only when there is one', () => {
    const { container, rerender } = render(
      <UnitBox quantity="count"><input /></UnitBox>,
    )
    expect(container.querySelector('.field-unit-box')!.classList.contains('field-unit-box--with-unit')).toBe(true)
    rerender(<UnitBox quantity="none"><input /></UnitBox>)
    expect(container.querySelector('.field-unit-box')!.classList.contains('field-unit-box--with-unit')).toBe(false)
    expect(container.querySelector('.field-unit')).toBeNull()
  })
})

describe('ExpressionInput with a unit', () => {
  it('puts the unit inside the box and says it in the accessible name', () => {
    render(<ExpressionInput value={45} onChange={vi.fn()} ariaLabel="Angle" quantity="angle" />)
    const input = screen.getByRole('textbox', { name: 'Angle, degrees' })
    const box = input.closest('.field-unit-box')
    expect(box).not.toBeNull()
    expect(box!.querySelector('.field-unit')?.textContent).toBe('deg')
  })

  it('follows the document unit on a length', () => {
    render(
      <ExpressionInput value={0.5} onChange={vi.fn()} ariaLabel="Diameter" quantity="length" lengthUnit="inch" />,
    )
    expect(screen.getByRole('textbox', { name: 'Diameter, inches' })).toBeInTheDocument()
    expect(screen.getByText('in')).toBeInTheDocument()
  })

  it('renders the expression result beside the box, not in it', () => {
    render(<ExpressionInput value="1.6*2" onChange={vi.fn()} ariaLabel="Distance" quantity="length" />)
    const readout = screen.getByText('= 3.2')
    expect(readout.closest('.field-unit-box')).toBeNull()
  })

  it('leaves a ratio field bare', () => {
    render(<ExpressionInput value={2} onChange={vi.fn()} ariaLabel="Factor" quantity="none" />)
    expect(screen.getByRole('textbox', { name: 'Factor' })).toBeInTheDocument()
    expect(document.querySelector('.field-unit')).toBeNull()
  })
})

describe('the unit adornment is not a target', () => {
  // jsdom does no hit testing, so the guarantee is in the CSS: a click over the
  // adornment reaches the input behind it, and the text cannot be selected.
  it('is pointer-events: none inside the box, and its text is not selectable', () => {
    const boxRule = /\.field-unit-box > \.field-unit \{([^}]*)\}/.exec(PART_CSS)
    expect(boxRule, '.field-unit-box > .field-unit rule in pages/Part.css').not.toBeNull()
    expect(boxRule![1]).toMatch(/pointer-events:\s*none/)
    const baseRule = /(?:^|\n)\.field-unit \{([^}]*)\}/.exec(PART_CSS)
    expect(baseRule, '.field-unit rule in pages/Part.css').not.toBeNull()
    expect(baseRule![1]).toMatch(/user-select:\s*none/)
  })

  it('gives the input a right padding from the shared slot, never a pixel guess', () => {
    expect(PART_CSS).toMatch(/\.field-unit-box \{[^}]*--field-unit-slot:/)
    expect(PART_CSS).toMatch(/\.field-unit-box--with-unit > input \{[^}]*padding-right:\s*var\(--field-unit-slot\)/)
  })
})
