// The one header row the four floating cards share. jsdom applies no
// stylesheet, so these pin the markup (the icon as the tinted <img>, the title
// line, the actions after it) and the row's own CSS lives in
// components/layout/__tests__/editPanelHeaderCss.test.ts.
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CardHeader } from '@/components/shared/CardHeader'
import icon from '@/assets/icons/feature-sketch.svg'

describe('CardHeader', () => {
  it('renders the icon as the shared tinted image, with the title beside it', () => {
    const { container } = render(<CardHeader icon={icon} title="sketch 2" />)

    const header = container.querySelector('.card-header') as HTMLElement
    const image = header.querySelector('img') as HTMLImageElement
    expect(image.classList.contains('feature-icon')).toBe(true)
    expect(image.getAttribute('src')).toBe(icon)
    expect(image.getAttribute('alt')).toBe('')
    expect(header.querySelector('.card-header-title')!.textContent).toBe('sketch 2')
  })

  it('passes an icon alt when the icon carries meaning of its own', () => {
    render(<CardHeader icon={icon} iconAlt="sketch" title="sketch 2" />)
    expect(screen.getByRole('img', { name: 'sketch' })).toBeInTheDocument()
  })

  it('places the actions after the title, in the order the card gives them', () => {
    const { container } = render(
      <CardHeader
        icon={icon}
        title="sketch 2"
        actions={(
          <>
            <button title="OK">ok</button>
            <button title="Cancel">cancel</button>
          </>
        )}
      />,
    )

    const header = container.querySelector('.card-header') as HTMLElement
    const children = Array.from(header.children)
    expect(children.map(child => child.tagName)).toEqual(['IMG', 'SPAN', 'BUTTON', 'BUTTON'])
    expect(children[1].textContent).toBe('sketch 2')
    expect((children[2] as HTMLButtonElement).title).toBe('OK')
    expect((children[3] as HTMLButtonElement).title).toBe('Cancel')
  })

  it('keeps the shared title class and adds a card-specific one on top', () => {
    const { container } = render(
      <CardHeader icon={icon} title="Section" titleClassName="section-panel-title" />,
    )
    expect(container.querySelector('.card-header-title')!.classList.contains('section-panel-title')).toBe(true)
  })
})
