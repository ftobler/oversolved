import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FeatureItemEditors } from '../FeatureItemEditors'
import { getFileRegistry } from '@/stores/fileRegistry'
import { resetFakeIndexedDb } from '@/stores/documentStore/__tests__/fakeIndexedDb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import type { PartFeature } from '@/types/cad'

function importFeature(fileId?: string): PartFeature {
  return { id: 'IM1', kind: 'import_step', file_id: fileId }
}

function renderRow(fileId?: string) {
  return render(
    <FeatureItemEditors
      feature={importFeature(fileId)}
      editingFeatureId="IM1"
      doc={{ features: [] }}
      onMutation={() => {}}
      features={[]}
      partLabels={{}}
    />,
  )
}

describe('FeatureItemEditors import_step row', () => {
  beforeEach(() => {
    resetFakeIndexedDb()
    resetDbConnection()
  })

  it('renders the file name and byte size in place of the raw id', async () => {
    const entry = await getFileRegistry().create({
      name: 'bracket.step', kind: 'step', mime: 'application/step', bytes: new Uint8Array(2048),
    })
    renderRow(entry.id)
    expect(await screen.findByText('bracket.step (2.0 KB)')).toBeTruthy()
    // The raw uuid must not be the row's visible value.
    expect(screen.queryByText(entry.id)).toBeNull()
  })

  it('renders a clear missing state for an unresolvable reference', async () => {
    renderRow('no-such-file')
    expect(await screen.findByText('Missing file')).toBeTruthy()
  })

  it('renders a terminal missing state for an import with no file_id at all', async () => {
    // Not "Loading..." forever: a reference-less import is missing, not pending.
    renderRow(undefined)
    expect(await screen.findByText('Missing file')).toBeTruthy()
    expect(screen.queryByText('Loading...')).toBeNull()
  })
})
