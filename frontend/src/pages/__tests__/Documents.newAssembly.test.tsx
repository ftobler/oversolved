import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { parse as parseYaml } from 'yaml'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { backendBundle } from '@/adapters/backend'
import Documents from '@/pages/Documents'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
})

afterEach(() => {
  vi.useRealTimers()
})

function wrap() {
  return render(
    <BrowserRouter>
      <Documents />
    </BrowserRouter>
  )
}

async function createVia(buttonTitle: string, name: string) {
  wrap()
  await waitFor(() => expect(screen.getByText('Documents', { selector: '.sidebar-item-label' })).toBeInTheDocument())

  await act(async () => {
    fireEvent.click(screen.getByTitle(buttonTitle))
  })
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText(/name/i), { target: { value: name } })
  })
  await act(async () => {
    fireEvent.click(screen.getByText('Create'))
  })
  await waitFor(() => expect(screen.getByTitle(name)).toBeInTheDocument())
}

/** The content the store actually persisted for the single document that exists. */
async function onlyDocContent(): Promise<string> {
  const summaries = await backendBundle.documents.list()
  expect(summaries).toHaveLength(1)
  const doc = await backendBundle.documents.load(summaries[0].uuid)
  return doc.content
}

describe('Documents: creating an assembly (static build)', () => {
  // The whole point of the button: `create` writes empty content, and empty
  // content parses to a part, so an assembly needs its `kind` seeded.
  it('seeds kind: assembly into the new document, which is what DocumentPage routes on', async () => {
    await createVia('Add assembly', 'gearbox')
    const parsed = parseYaml(await onlyDocContent())
    expect(parsed.kind).toBe('assembly')
  })

  it('leaves features empty so useAssemblyDoc prepends the assembly built-ins', async () => {
    await createVia('Add assembly', 'gearbox')
    const parsed = parseYaml(await onlyDocContent())
    expect(parsed.features).toEqual([])
  })

  it('still creates a part as empty content when the part button is used', async () => {
    await createVia('Add part', 'bracket')
    expect(await onlyDocContent()).toBe('')
  })

  it('titles the dialog by the kind the pressed button chose', async () => {
    wrap()
    await waitFor(() => expect(screen.getByText('Documents', { selector: '.sidebar-item-label' })).toBeInTheDocument())

    await act(async () => { fireEvent.click(screen.getByTitle('Add assembly')) })
    expect(screen.getByText('Create New Assembly')).toBeInTheDocument()
  })

  // The kind is per-press, not sticky: opening the part dialog after the
  // assembly one must not leave an assembly seeded behind.
  it('does not carry the assembly kind over to a later part creation', async () => {
    wrap()
    await waitFor(() => expect(screen.getByText('Documents', { selector: '.sidebar-item-label' })).toBeInTheDocument())

    await act(async () => { fireEvent.click(screen.getByTitle('Add assembly')) })
    await act(async () => { fireEvent.click(screen.getByTitle('Add assembly')) })  // close
    await act(async () => { fireEvent.click(screen.getByTitle('Add part')) })
    expect(screen.getByText('Create New Part')).toBeInTheDocument()

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/name/i), { target: { value: 'bracket' } })
    })
    await act(async () => { fireEvent.click(screen.getByText('Create')) })
    await waitFor(() => expect(screen.getByTitle('bracket')).toBeInTheDocument())

    expect(await onlyDocContent()).toBe('')
  })
})
