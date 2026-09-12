import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetFakeIndexedDb } from '@/stores/documentStore/__tests__/fakeIndexedDb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { IndexedDbFileRegistry } from '../IndexedDbFileRegistry'
import { MemoryFileRegistry } from '../memoryFileRegistry'
import type { FileRegistry } from '../types'

// One behavioral contract, run against every FileRegistry implementation. The
// in-memory conformer is written from this contract rather than ported from the
// IndexedDB store, so a behaviour only one of them has surfaces here instead of
// as silent coupling.
interface Adapter {
  name: string
  make: () => FileRegistry
  setup: () => void
}

const adapters: Adapter[] = [
  {
    name: 'IndexedDbFileRegistry',
    make: () => new IndexedDbFileRegistry(),
    setup: () => { resetFakeIndexedDb(); resetDbConnection() },
  },
  {
    name: 'MemoryFileRegistry',
    make: () => new MemoryFileRegistry(),
    setup: () => {},
  },
]

describe.each(adapters)('FileRegistry contract: $name', (adapter) => {
  let registry: FileRegistry

  beforeEach(() => {
    adapter.setup()
    registry = adapter.make()
  })
  afterEach(() => {})

  const bytes = () => new Uint8Array([1, 2, 3, 250])

  it('create mints a distinct id per record and stamps size', async () => {
    const a = await registry.create({ name: 'a.step', kind: 'step', bytes: bytes() })
    const b = await registry.create({ name: 'b.step', kind: 'step', bytes: bytes() })
    expect(a.id).not.toBe(b.id)
    expect(a.size).toBe(4)
    expect(a.createdAt).toBeGreaterThan(0)
  })

  it('create defaults mime to an empty string', async () => {
    const a = await registry.create({ name: 'a.step', kind: 'step', bytes: bytes() })
    expect(a.mime).toBe('')
  })

  it('get/getBytes round-trip the exact bytes', async () => {
    const a = await registry.create({ name: 'a.step', kind: 'step', mime: 'application/step', bytes: bytes() })
    expect(Array.from((await registry.getBytes(a.id))!)).toEqual([1, 2, 3, 250])
    const entry = await registry.get(a.id)
    expect(entry!.name).toBe('a.step')
    expect(entry!.mime).toBe('application/step')
    expect(Array.from(entry!.bytes)).toEqual([1, 2, 3, 250])
  })

  it('getBytes returns a copy, so mutating it cannot corrupt the store', async () => {
    const a = await registry.create({ name: 'a.step', kind: 'step', bytes: bytes() })
    const first = (await registry.getBytes(a.id))!
    first[0] = 99
    expect(Array.from((await registry.getBytes(a.id))!)).toEqual([1, 2, 3, 250])
  })

  it('get of a missing id is undefined', async () => {
    expect(await registry.get('no-such-file')).toBeUndefined()
    expect(await registry.getBytes('no-such-file')).toBeUndefined()
  })

  it('has reflects presence', async () => {
    const a = await registry.create({ name: 'a.step', kind: 'step', bytes: bytes() })
    expect(await registry.has(a.id)).toBe(true)
    expect(await registry.has('no-such-file')).toBe(false)
  })

  it('list returns metadata only, sorted by name', async () => {
    await registry.create({ name: 'zeta.step', kind: 'step', bytes: bytes() })
    await registry.create({ name: 'alpha.step', kind: 'step', bytes: bytes() })
    const list = await registry.list()
    expect(list.map(m => m.name)).toEqual(['alpha.step', 'zeta.step'])
    for (const meta of list) {
      expect('bytes' in meta).toBe(false)
      expect(meta.size).toBe(4)
    }
  })

  it('remove drops the record', async () => {
    const a = await registry.create({ name: 'a.step', kind: 'step', bytes: bytes() })
    await registry.remove(a.id)
    expect(await registry.has(a.id)).toBe(false)
    expect(await registry.list()).toEqual([])
  })

  it('clear drops every record', async () => {
    await registry.create({ name: 'a.step', kind: 'step', bytes: bytes() })
    await registry.create({ name: 'b.step', kind: 'step', bytes: bytes() })
    await registry.clear()
    expect(await registry.list()).toEqual([])
  })

  it('put stores a caller-keyed record unchanged', async () => {
    await registry.put({
      id: 'fixed-id', name: 'p.step', kind: 'step', mime: 'application/step',
      bytes: bytes(), size: 4, createdAt: 5, updatedAt: 6,
    })
    const entry = await registry.get('fixed-id')
    expect(entry!.id).toBe('fixed-id')
    expect(entry!.createdAt).toBe(5)
  })
})
