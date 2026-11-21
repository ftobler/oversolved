import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Variables from '@/pages/Variables'

describe('Variables docs page', () => {
  it('states the bare-name syntax the report could not guess', () => {
    render(<Variables />)
    expect(screen.getByRole('heading', { name: 'Variables' })).toBeInTheDocument()
    const example = document.querySelector('.variables-example')
    expect(example?.textContent).toContain('width * 2')
    expect(screen.getByText(/no prefix and no braces/i)).toBeInTheDocument()
  })

  it('names the report spellings that do not work', () => {
    render(<Variables />)
    const mistakes = document.querySelector('.variables-mistakes')
    expect(mistakes?.textContent).toContain('#var')
    expect(mistakes?.textContent).toContain('$var')
    expect(mistakes?.textContent).toContain('{var}')
  })

  it('explains that only variables above the feature are visible', () => {
    render(<Variables />)
    expect(screen.getByText(/defined below this feature/i)).toBeInTheDocument()
  })
})
