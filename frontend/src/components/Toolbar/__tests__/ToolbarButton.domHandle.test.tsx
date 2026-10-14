import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import ToolbarButton from '../ToolbarButton'
import { DOM_HANDLE_ATTRIBUTE } from '@/picking'

/**
 * The probe finds DOM controls by attribute, so a toolbar button must carry
 * the handle it was given and nothing when it was not.
 */

afterEach(cleanup)

describe('ToolbarButton probe handle', () => {
  it('renders the handle attribute when given one', () => {
    const { getByRole } = render(
      <ToolbarButton title="Line" icon="line.svg" onClick={() => {}} handle="toolbar:set_tool_line" />,
    )
    expect(getByRole('button').getAttribute(DOM_HANDLE_ATTRIBUTE)).toBe('toolbar:set_tool_line')
  })

  it('renders no handle attribute when omitted', () => {
    const { getByRole } = render(
      <ToolbarButton title="Line" icon="line.svg" onClick={() => {}} />,
    )
    expect(getByRole('button').hasAttribute(DOM_HANDLE_ATTRIBUTE)).toBe(false)
  })
})
