// The mate name is not a field of the parameter panel. It used to sit at the top
// as a labelled text box, which made renaming the one mate operation that did not
// live where every other feature renames -- the row's tridot menu. The panel now
// carries only the references and the kind's parameters; AssemblyEditor.test.tsx
// covers the menu path that replaced this box.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MateEditor } from '@/components/layout/MateEditor'
import type { MateFeatureDef } from '@/types/cad'

const mate: MateFeatureDef = {
  kind: 'fixed',
  ref_a: { part: 'h1', anchor: 'a1' },
  ref_b: { part: 'h2', anchor: 'b1' },
  label: 'top clamp',
}

function renderEditor() {
  return render(
    <MateEditor
      featureId="m1"
      mate={mate}
      activeField={null}
      onArmField={vi.fn()}
      onUpdate={vi.fn()}
    />
  )
}

describe('MateEditor name field', () => {
  it('renders no field labelled Name', () => {
    renderEditor()
    const labels = [...document.querySelectorAll('.feature-field-label')].map(n => n.textContent)
    expect(labels).not.toContain('Name')
  })

  it('offers no text box for the mate name', () => {
    renderEditor()
    expect(screen.queryByLabelText('Mate name')).toBeNull()
    // The label itself is not smuggled in as a value of some other control.
    expect(screen.queryByDisplayValue('top clamp')).toBeNull()
  })

  it('still renders the reference fields the panel is for', () => {
    renderEditor()
    const labels = [...document.querySelectorAll('.feature-field-label')].map(n => n.textContent)
    expect(labels).toContain('Reference A')
    expect(labels).toContain('Reference B')
  })
})
