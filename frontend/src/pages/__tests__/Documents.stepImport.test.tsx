import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
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

// jsdom's File has no arrayBuffer(), which the registry import path now reads.
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

describe('Documents STEP import (static build)', () => {
  it('uploads a .step file into a new document tile', async () => {
    wrap()
    await waitFor(() => expect(screen.getByText('Documents', { selector: '.sidebar-item-label' })).toBeInTheDocument())

    const input = document.querySelector<HTMLInputElement>('.doc-controls input.file-upload-input')!
    expect(input.accept).toContain('.step')

    const bytes = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nEND-STEP;\n')
    const file = stepFile('bracket.step', bytes)

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })

    await waitFor(() => expect(screen.getByTitle('bracket')).toBeInTheDocument())
  })
})