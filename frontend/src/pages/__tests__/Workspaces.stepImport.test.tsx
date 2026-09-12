import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { freshLocalDb } from './workspacesHarness'
import Workspaces from '@/pages/Workspaces'

// A dropped .step is one bag item and adoption synthesizes a part document plus
// a file entry holding the bytes (the C1 round-trip assertion lives in the
// workspace import round-trip suite). This pins the U1 gesture end to end.

beforeEach(() => {
  freshLocalDb()
})

afterEach(() => {
  // no timers are faked here
})

function stepFile(name: string, bytes: Uint8Array): File {
  return {
    name,
    size: bytes.byteLength,
    type: 'application/step',
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
  } as unknown as File
}

describe('Workspaces STEP import', () => {
  it('adopts a .step file into a new workspace tile', async () => {
    render(
      <BrowserRouter>
        <Workspaces />
      </BrowserRouter>,
    )
    await waitFor(() => expect(screen.getByText('Workspaces', { selector: '.sidebar-item-label' })).toBeInTheDocument())

    const input = document.querySelector<HTMLInputElement>('.doc-controls input.file-upload-input')!
    expect(input.accept).toContain('.step')

    const bytes = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nEND-STEP;\n')
    await act(async () => {
      fireEvent.change(input, { target: { files: [stepFile('bracket.step', bytes)] } })
    })

    await waitFor(() => expect(screen.getByTitle('bracket')).toBeInTheDocument())
    // Let the handler's own refetch and every trailing setState settle before
    // teardown, or they land after the environment is gone (an unhandled
    // rejection). Adoption now does extra working-copy edge writes, so drain
    // several macrotasks rather than one.
    await act(async () => {
      for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
    })
    // Keep the assertion after the flush too, so the tile is still there.
    expect(screen.getByTitle('bracket')).toBeInTheDocument()
  })
})
