// The loader is a hardening boundary, so it is fuzzed with a fixed seed set:
// random mutations of a valid document must never throw out of the loader and
// must always answer either a doc that loads again or a DocLoadError. The seed
// set is fixed so a failure is reproducible; widening it stays a deliberate
// edit with the new seed committed.
import { describe, it, expect } from 'vitest'
import { loadAssemblyDoc, loadPartDoc } from '@/persistence/docSchema'

// A tiny deterministic PRNG, so the suite has no new dependency and the
// mutation order is exactly the committed seeds.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FUZZ_SEEDS = [0xc0ffee, 42, 20261015]
const MUTATIONS_PER_SEED = 200

const VALID_PART = {
  version: 1,
  kind: 'part',
  features: [
    {
      id: 'sk1',
      kind: 'sketch',
      plane: '@builtin_plane_front',
      initial: { line1: [0, 0, 20, 0] },
      entities: [{ id: 'line1', kind: 'line' }],
      constraints: [{ id: 'c1', kind: 'horizontal', a: '$line1' }],
    },
    { id: 'ex1', kind: 'extrude', extrude: { sketch: ['@sk1'], distance: 10, direction: 'normal' } },
    { id: 'a1', kind: 'array', array: { source_body: '@ex1', count_x: 4, count_y: 2, pitch_x: 15 } },
  ],
  part_style: { ex1: { name: 'Body', color: '#4f8a8b', visible: true } },
}

const VALID_ASSEMBLY = {
  version: 1,
  kind: 'assembly',
  features: [
    { id: 'AssemblyOrigin', kind: 'origin' },
    {
      id: 'f1',
      kind: 'part_instance',
      instance: {
        handle: 'hA',
        doc_id: 'part-1',
        doc_rev: 1,
        transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
      },
    },
  ],
}

// Paths into the valid documents, as key chains. Arrays are addressed by index.
const PATHS: Array<Array<string | number>> = [
  ['version'], ['kind'], ['features'], ['features', 0], ['features', 0, 'id'],
  ['features', 0, 'kind'], ['features', 0, 'entity'], ['features', 0, 'entities'],
  ['features', 0, 'entities', 0], ['features', 0, 'constraints'],
  ['features', 0, 'initial'], ['features', 0, 'initial', 'line1'],
  ['features', 1, 'extrude'], ['features', 1, 'extrude', 'distance'],
  ['features', 1, 'extrude', 'sketch'], ['features', 2, 'array'],
  ['features', 2, 'array', 'count_x'], ['part_style'], ['part_style', 'ex1'],
  ['features', 1, 'instance'], ['features', 1, 'instance', 'transform'],
]

const REPLACEMENTS: unknown[] = [
  null, undefined, NaN, Infinity, -Infinity, 0, -1, 1e300, 'text', '', true, [], {},
  new Array(1e9),
]

function clone<T>(value: T): T {
  return structuredClone(value)
}

function getParent(root: Record<string, unknown>, path: Array<string | number>): unknown {
  let node: unknown = root
  for (const key of path.slice(0, -1)) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string | number, unknown>)[key]
  }
  return node
}

function mutate(root: Record<string, unknown>, rng: () => number): void {
  const path = PATHS[Math.floor(rng() * PATHS.length)]
  const parent = getParent(root, path)
  const last = path[path.length - 1]
  if (parent === null || typeof parent !== 'object') return
  const target = parent as Record<string | number, unknown>
  const op = rng()
  if (op < 0.3) {
    delete target[last]
  } else if (op < 0.5) {
    target[last] = new Array(1e9)
  } else if (op < 0.7) {
    target[last] = REPLACEMENTS[Math.floor(rng() * REPLACEMENTS.length)]
  } else if (op < 0.85 && Array.isArray(target[last])) {
    const list = target[last] as unknown[]
    list.length = 1e9
  } else {
    // Deep nesting under a key the loader must simply ignore.
    let nested: Record<string, unknown> = {}
    target[last] = nested
    for (let i = 0; i < Math.floor(rng() * 2000); i++) {
      nested.child = {}
      nested = nested.child as Record<string, unknown>
    }
  }
}

// Structural so the same loop drives both loaders without a cast.
type FuzzedLoad = (raw: unknown) =>
  | { ok: true; doc: unknown; migrations: string[] }
  | { ok: false; error: { field: string } }

function exercise(
  base: Record<string, unknown>,
  load: FuzzedLoad,
  seed: number,
): void {
  const rng = mulberry32(seed)
  for (let i = 0; i < MUTATIONS_PER_SEED; i++) {
    const doc = clone(base)
    const mutations = 1 + Math.floor(rng() * 4)
    for (let m = 0; m < mutations; m++) mutate(doc, rng)
    const result = load(doc)
    if (!result.ok) {
      expect(result.error.field).toBeTruthy()
      continue
    }
    // A doc the loader accepted must load again: the migration ladder and the
    // guards are idempotent on their own output.
    const again = load(result.doc)
    expect(again.ok).toBe(true)
  }
}

describe('loader fuzz (fixed seeds)', () => {
  for (const seed of FUZZ_SEEDS) {
    it(`part documents never throw and always answer with doc or DocLoadError (seed ${seed})`, () => {
      exercise(VALID_PART, loadPartDoc, seed)
    })

    it(`assembly documents never throw and always answer with doc or DocLoadError (seed ${seed})`, () => {
      exercise(VALID_ASSEMBLY, loadAssemblyDoc, seed)
    })
  }

  it('a wholly random payload is refused, never thrown out of the loader', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 500; i++) {
      const shape = rng()
      const raw = shape < 0.25 ? null
        : shape < 0.5 ? Math.floor(rng() * 100)
          : shape < 0.75 ? `text ${i}`
            : { features: new Array(Math.floor(rng() * 1e9)), version: rng() * 10 }
      const result = loadPartDoc(raw)
      if (!result.ok) expect(result.error.field).toBeTruthy()
    }
  })
})
