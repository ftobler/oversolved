// The section card's own controls: plane tabs, re-pick, offset box, reverse and
// Exit. It is presentational over the section store, so these tests need no
// viewport and no document: the store is the subject's whole input.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SectionPanel } from '@/components/Viewport/SectionPanel'
import {
  DEFAULT_SECTION_STATE,
  SECTION_PICK_HINT,
  SECTION_PICK_UNAVAILABLE_NOTE,
  useSectionStore,
} from '@/stores/sectionStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartFeature } from '@/types/cad'

const FEATURES = [
  { id: 'ex1', kind: 'extrude', label: 'Extrude 1', extrude: { sketch: [], distance: 1 } },
  { id: 'pln1', kind: 'plane', label: 'Plane 1' },
] as PartFeature[]

function reset(): void {
  useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
  useSketchEditorStore.setState({ activePickField: null, chipOwnedSelection: new Set() })
  usePartEditorStore.setState({
    partLabels: { body_ex1: 'Plate' },
    features: FEATURES,
  })
}

const offsetBox = () => screen.getByRole('textbox', { name: /Section offset/ }) as HTMLInputElement

beforeEach(() => {
  vi.restoreAllMocks()
  reset()
})

describe('SectionPanel visibility', () => {
  it('renders nothing while the section is off and there is no reason', () => {
    render(<SectionPanel />)
    expect(screen.queryByText('Section')).toBeNull()
  })

  it('renders the card while the section is on', () => {
    useSectionStore.setState({ enabled: true })
    render(<SectionPanel />)
    expect(screen.getByText('Section')).toBeInTheDocument()
    expect(document.querySelector('.section-panel')).not.toBeNull()
  })

  it('hides itself during a thumbnail capture', () => {
    useSectionStore.setState({ enabled: true, capturing: true })
    render(<SectionPanel />)
    expect(screen.queryByText('Section')).toBeNull()
  })

  it('shows why a section turned itself off, with a way back on', () => {
    useSectionStore.setState({ enabled: false, disabledReason: 'the picked face is gone' })
    render(<SectionPanel />)

    expect(screen.getByText('the picked face is gone')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Turn on again' }))
    expect(useSectionStore.getState().enabled).toBe(true)
    expect(useSectionStore.getState().disabledReason).toBeNull()
  })
})

describe('SectionPanel Exit', () => {
  it('sits last in the header and turns the section off', () => {
    useSectionStore.setState({ enabled: true, picking: true, pickError: 'missed' })
    render(<SectionPanel />)

    const header = document.querySelector('.feature-edit-panel-header')!
    const exit = screen.getByRole('button', { name: 'Exit section view' })
    expect(header.lastElementChild).toBe(exit)

    fireEvent.click(exit)
    expect(useSectionStore.getState().enabled).toBe(false)
    expect(useSectionStore.getState().picking).toBe(false)
    expect(useSectionStore.getState().pickError).toBeNull()
    expect(screen.queryByText('Section')).toBeNull()
  })
})

describe('SectionPanel plane', () => {
  it('selects a builtin plane and marks the active one', () => {
    useSectionStore.setState({ enabled: true })
    render(<SectionPanel />)

    expect(screen.getByRole('button', { name: 'Front' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Top' }))
    expect(useSectionStore.getState().plane).toEqual({ kind: 'builtin', id: 'top' })
    expect(screen.getByRole('button', { name: 'Top' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Front' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('arms a viewport pick, shows the hint, and cancels from the same button', () => {
    useSectionStore.setState({ enabled: true })
    render(<SectionPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Pick' }))
    expect(useSectionStore.getState().picking).toBe(true)
    expect(screen.getByText(SECTION_PICK_HINT)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel pick' }))
    expect(useSectionStore.getState().picking).toBe(false)
    expect(screen.queryByText(SECTION_PICK_HINT)).toBeNull()
  })

  it('disarms an armed feature pick before arming its own', () => {
    useSectionStore.setState({ enabled: true })
    useSketchEditorStore.setState({ activePickField: { featureId: 'ex1', field: 'faces' } })
    render(<SectionPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Pick' }))
    expect(useSketchEditorStore.getState().activePickField).toBeNull()
    expect(useSectionStore.getState().picking).toBe(true)
  })

  it('names a picked body-face query by the face, not the whole part', () => {
    // A section pick stores the face's key. The body-pick label would answer
    // "Plate", which hides that a face was picked.
    useSectionStore.setState({
      enabled: true,
      plane: { kind: 'query', query: '@body_ex1/face/3' },
    })
    render(<SectionPanel />)

    expect(screen.getByRole('button', { name: 'Face of Extrude 1' })).toBeInTheDocument()
    expect(screen.queryByText('Plate')).toBeNull()
    expect(screen.queryByText('@body_ex1/face/3')).toBeNull()
  })

  it('names a picked ancestry face query too', () => {
    useSectionStore.setState({
      enabled: true,
      plane: { kind: 'query', query: '?9;@body_ex1:flatface' },
    })
    render(<SectionPanel />)

    expect(screen.getByRole('button', { name: 'Face of Extrude 1' })).toBeInTheDocument()
    expect(screen.queryByText('?9;@body_ex1:flatface')).toBeNull()
  })

  it('resolves a user plane stored as a bare feature id', () => {
    // `sectionPickSource` keeps the solve-result key, which has no `@`.
    useSectionStore.setState({
      enabled: true,
      plane: { kind: 'query', query: 'pln1' },
    })
    render(<SectionPanel />)

    expect(screen.getByRole('button', { name: 'Plane 1' })).toBeInTheDocument()
    expect(screen.queryByText('pln1')).toBeNull()
  })

  it('shows a refused pick reason', () => {
    useSectionStore.setState({ enabled: true, pickError: 'Pick a flat face or a plane.' })
    render(<SectionPanel />)
    expect(screen.getByText('Pick a flat face or a plane.')).toBeInTheDocument()
  })

  it('offers only the builtin planes and says why when picking is unavailable', () => {
    useSectionStore.setState({ enabled: true })
    render(<SectionPanel allowPick={false} />)

    expect(screen.queryByRole('button', { name: 'Pick' })).toBeNull()
    expect(screen.getByText(SECTION_PICK_UNAVAILABLE_NOTE)).toBeInTheDocument()
  })
})

describe('SectionPanel offset', () => {
  it('commits a typed value on blur', () => {
    useSectionStore.setState({ enabled: true })
    render(<SectionPanel />)

    fireEvent.focus(offsetBox())
    fireEvent.change(offsetBox(), { target: { value: '12.5' } })
    fireEvent.blur(offsetBox())
    expect(useSectionStore.getState().offset).toBe(12.5)
  })

  it('evaluates an expression', () => {
    useSectionStore.setState({ enabled: true })
    render(<SectionPanel />)

    fireEvent.focus(offsetBox())
    fireEvent.change(offsetBox(), { target: { value: '10/4' } })
    fireEvent.blur(offsetBox())
    expect(useSectionStore.getState().offset).toBe(2.5)
  })

  it('steps by exactly one per wheel notch', () => {
    useSectionStore.setState({ enabled: true, offset: 2.5 })
    render(<SectionPanel />)

    fireEvent.wheel(offsetBox(), { deltaY: -1 })
    expect(useSectionStore.getState().offset).toBe(3.5)
    fireEvent.wheel(offsetBox(), { deltaY: 1 })
    expect(useSectionStore.getState().offset).toBe(2.5)
  })

  it('refuses text it cannot evaluate and keeps the offset', () => {
    useSectionStore.setState({ enabled: true, offset: 4 })
    render(<SectionPanel />)

    fireEvent.focus(offsetBox())
    fireEvent.change(offsetBox(), { target: { value: 'abc' } })
    expect(screen.getByRole('status')).toHaveTextContent('cannot evaluate')
    fireEvent.blur(offsetBox())
    expect(useSectionStore.getState().offset).toBe(4)
  })

  it('accepts a negative offset', () => {
    useSectionStore.setState({ enabled: true })
    render(<SectionPanel />)

    fireEvent.focus(offsetBox())
    fireEvent.change(offsetBox(), { target: { value: '-3' } })
    fireEvent.blur(offsetBox())
    expect(useSectionStore.getState().offset).toBe(-3)
  })

  it('shows the document unit and spells it in the accessible name', () => {
    useSectionStore.setState({ enabled: true })
    render(<SectionPanel lengthUnit="inch" />)

    expect(screen.getByRole('textbox', { name: 'Section offset, inches' })).toBeInTheDocument()
    expect(screen.getByText('in')).toBeInTheDocument()
  })
})

describe('SectionPanel reverse', () => {
  it('toggles the kept side', () => {
    useSectionStore.setState({ enabled: true })
    render(<SectionPanel />)

    fireEvent.click(screen.getByLabelText('Reverse direction'))
    expect(useSectionStore.getState().flipped).toBe(true)
    fireEvent.click(screen.getByLabelText('Reverse direction'))
    expect(useSectionStore.getState().flipped).toBe(false)
  })
})
