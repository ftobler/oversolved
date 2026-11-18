// @vitest-environment node
//
// The recipe generator's own contract, no OCC involved: the same seed makes the
// same recipe on every machine (the plan's determinism spec), every reference
// names something an earlier step produced, and the upstream perturbation
// changes exactly the start body. The runner's checks are the geometry
// assertions; this file keeps the generator honest on its own.

import { describe, it, expect } from 'vitest'
import { generateRecipe, perturbStart, FUZZ_GRID_MM, PRIMARY_PART, type RecipeStep } from './recipe'

const SEEDS = 200

// The body ids a step produces, so a later step's refs can be checked to have
// an earlier producer. Tools are produced and consumed inside one boolean step,
// so they are live for exactly that step.
function producedBodies(step: RecipeStep): string[] {
  if (step.kind === 'start') return [step.body]
  if (step.kind === 'boolean') return [step.toolPart]
  if (step.kind === 'mirror' && step.keepOriginal && !step.merge) return [`body_${step.id}`]
  return [PRIMARY_PART]
}

function referencedBodies(step: RecipeStep): string[] {
  switch (step.kind) {
    case 'start': return []
    case 'boolean': return [step.target]
    case 'fillet': return [step.target]
    case 'chamfer': return [step.target]
    case 'hole': return [step.target]
    case 'linear-array': return [step.target]
    case 'circular-array': return [step.target]
    case 'curve-array': return [step.target]
    case 'instance-array': return [step.target]
    case 'mirror': return [step.target]
    case 'feature-mirror': return [step.target]
    case 'shell': return [step.target]
    case 'helix': return [step.target]
    case 'split': return [step.target]
  }
}

describe('the geometry-fuzz recipe generator', () => {
  it('draws the same recipe for the same seed', () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(generateRecipe(seed)).toEqual(generateRecipe(seed))
    }
  })

  it('draws different recipes for different seeds', () => {
    const first = JSON.stringify(generateRecipe(0))
    const second = JSON.stringify(generateRecipe(1))
    expect(first).not.toBe(second)
  })

  it('every step references only bodies an earlier step produced', () => {
    for (let seed = 0; seed < SEEDS; seed++) {
      const recipe = generateRecipe(seed)
      const available = new Set<string>()
      for (const step of recipe.steps) {
        for (const ref of referencedBodies(step)) {
          expect(available.has(ref), `seed ${seed}: step ${step.kind} references ${ref} before it exists`).toBe(true)
        }
        for (const body of producedBodies(step)) available.add(body)
      }
    }
  })

  // Millimetre fields land on the 2.5 mm grid (the placement contract);
  // counts, grid-offsets and pick indices are whole numbers.
  function mmValues(step: RecipeStep): number[] {
    switch (step.kind) {
      case 'start': return [...step.size, step.arcRadius]
      case 'boolean': return [...step.size]
      case 'fillet': return [step.radius]
      case 'chamfer': return [step.distance]
      case 'hole': return [step.diameter, step.depth]
      case 'linear-array': return [step.pitch]
      case 'circular-array': return [step.stepDeg]
      case 'curve-array': return [step.distance, step.length]
      case 'instance-array': return step.points.flat()
      case 'mirror': return []
      case 'feature-mirror': return [step.depth]
      case 'shell': return [step.thickness]
      case 'helix': return [step.pitch]
      case 'split': return []
    }
  }

  function wholeValues(step: RecipeStep): number[] {
    switch (step.kind) {
      case 'start': return []
      case 'boolean': return [...step.offset]
      case 'fillet': return [step.edge]
      case 'chamfer': return [step.edge]
      case 'hole': return [step.face]
      case 'linear-array': return [step.count]
      case 'circular-array': return [step.count]
      case 'curve-array': return [step.count]
      case 'instance-array': return []
      case 'mirror': return [step.face]
      case 'feature-mirror': return [step.face]
      case 'shell': return [step.face]
      case 'helix': return [step.face, step.turns]
      case 'split': return [step.fraction * 10]
    }
  }

  it('the split-tail option leaves the default chain byte-identical', () => {
    // The tail is drawn from a derived PRNG, so turning the option on cannot
    // redraw any existing seed's chain (the ring-start precedent).
    for (let seed = 0; seed < 50; seed++) {
      const plain = generateRecipe(seed)
      const tailed = generateRecipe(seed, { splitTail: true })
      expect(tailed.steps.slice(0, plain.steps.length)).toEqual(plain.steps)
      expect(tailed.steps).toHaveLength(plain.steps.length + 1)
    }
  })

  it('the instance-model sweep leaves the default chain byte-identical', () => {
    // The centered and skip fields come from a derived PRNG too, so they are a
    // new seed family: every existing pinned seed draws the same chain.
    for (let seed = 0; seed < 50; seed++) {
      const plain = generateRecipe(seed)
      const modeled = generateRecipe(seed, { patternInstanceModel: true })
      expect(modeled.steps).toHaveLength(plain.steps.length)
      modeled.steps.forEach((step, index) => {
        if (step.kind !== 'linear-array') {
          expect(step).toEqual(plain.steps[index])
          return
        }
        const rest = { ...step } as Record<string, unknown>
        delete rest.centered
        delete rest.skip
        expect(rest).toEqual(plain.steps[index])
      })
    }
    let centered = 0
    let skipped = 0
    for (let seed = 0; seed < SEEDS; seed++) {
      for (const step of generateRecipe(seed, { patternInstanceModel: true }).steps) {
        if (step.kind !== 'linear-array') continue
        if (step.centered === true) centered++
        if (step.skip === undefined) continue
        skipped++
        // A skip names an instance the count generates, never the original.
        for (const index of step.skip) {
          expect(index).toBeGreaterThanOrEqual(1)
          expect(index).toBeLessThanOrEqual(step.count - 1)
        }
      }
    }
    expect(centered).toBeGreaterThan(0)
    expect(skipped).toBeGreaterThan(0)
  })

  it('appends one instance-array step from its own stream, leaving the chain identical', () => {
    for (let seed = 0; seed < 50; seed++) {
      const plain = generateRecipe(seed)
      const tailed = generateRecipe(seed, { instancePatternTail: true })
      expect(tailed.steps.slice(0, plain.steps.length)).toEqual(plain.steps)
      expect(tailed.steps).toHaveLength(plain.steps.length + 1)
      const last = tailed.steps.at(-1)!
      expect(last.kind).toBe('instance-array')
      if (last.kind !== 'instance-array') continue
      expect(last.target).toBe(PRIMARY_PART)
      expect(last.points.length).toBeGreaterThanOrEqual(2)
      expect(last.points.length).toBeLessThanOrEqual(4)
    }
  })

  it('appends one curve-array step from its own stream, leaving the chain identical', () => {
    const spacings = new Set<string>()
    const orientations = new Set<string>()
    for (let seed = 0; seed < 50; seed++) {
      const plain = generateRecipe(seed)
      const tailed = generateRecipe(seed, { curvePatternTail: true })
      expect(tailed.steps.slice(0, plain.steps.length)).toEqual(plain.steps)
      expect(tailed.steps).toHaveLength(plain.steps.length + 1)
      const last = tailed.steps.at(-1)!
      expect(last.kind).toBe('curve-array')
      if (last.kind !== 'curve-array') continue
      expect(last.target).toBe(PRIMARY_PART)
      expect(last.count).toBeGreaterThanOrEqual(2)
      expect(last.count).toBeLessThanOrEqual(4)
      spacings.add(last.spacing)
      orientations.add(last.orientation)
    }
    // The two laws this step exists to cover: equal spacing and a distance that
    // may run past the short path, and a copy that does or does not turn.
    expect(spacings).toEqual(new Set(['equal', 'distance']))
    expect(orientations.size).toBe(2)
  })

  it('the feature-mirror sweep leaves the default chain byte-identical', () => {
    // The feature mirror tail comes from a derived PRNG too, so every existing
    // pinned seed draws the same chain.
    for (let seed = 0; seed < 50; seed++) {
      const plain = generateRecipe(seed)
      const tailed = generateRecipe(seed, { featureMirrorTail: true })
      expect(tailed.steps.slice(0, plain.steps.length)).toEqual(plain.steps)
      expect(tailed.steps).toHaveLength(plain.steps.length + 1)
      const last = tailed.steps.at(-1)!
      expect(last.kind).toBe('feature-mirror')
      if (last.kind !== 'feature-mirror') continue
      expect(last.target).toBe(PRIMARY_PART)
      expect(['x', 'y', 'z']).toContain(last.plane)
      expect(last.depth % FUZZ_GRID_MM).toBeCloseTo(0, 9)
    }
  })

  it('appends one split step with a drawn axis, fraction and keep side', () => {
    const keeps = new Set<string>()
    for (let seed = 0; seed < 50; seed++) {
      const last = generateRecipe(seed, { splitTail: true }).steps.at(-1)!
      expect(last.kind).toBe('split')
      if (last.kind !== 'split') continue
      expect(last.target).toBe(PRIMARY_PART)
      expect(['x', 'y', 'z']).toContain(last.axis)
      expect(last.fraction).toBeGreaterThanOrEqual(0.2)
      expect(last.fraction).toBeLessThanOrEqual(0.8)
      keeps.add(last.keep)
    }
    expect(keeps).toEqual(new Set(['above', 'below', 'both']))
  })

  it('draws one start plus at most eight edits, all on the grid', () => {
    for (let seed = 0; seed < SEEDS; seed++) {
      const { steps } = generateRecipe(seed)
      expect(steps.length).toBeGreaterThanOrEqual(1)
      expect(steps.length).toBeLessThanOrEqual(9)
      expect(steps[0].kind).toBe('start')
      for (const step of steps) {
        for (const value of mmValues(step)) {
          expect(Number.isFinite(value)).toBe(true)
          expect(value % FUZZ_GRID_MM).toBeCloseTo(0, 9)
        }
        for (const value of wholeValues(step)) {
          expect(Number.isInteger(value), `${step.kind} value ${value}`).toBe(true)
        }
      }
    }
  })

  it('perturbs only the start body by one grid step', () => {
    for (let seed = 0; seed < SEEDS; seed++) {
      const recipe = generateRecipe(seed)
      const perturbed = perturbStart(recipe)
      expect(perturbed.steps).toHaveLength(recipe.steps.length)
      const start = recipe.steps[0]
      const changed = perturbed.steps[0]
      expect(start.kind).toBe('start')
      expect(changed.kind).toBe('start')
      if (start.kind !== 'start' || changed.kind !== 'start') throw new Error('unreachable')
      const axis = start.shape === 'revolve' ? 1 : 0
      expect(changed.size[axis] - start.size[axis]).toBeCloseTo(FUZZ_GRID_MM, 9)
      expect(perturbed.steps.slice(1)).toEqual(recipe.steps.slice(1))
    }
  })

  it('covers every step kind across the seed range', () => {
    const kinds = new Set<string>()
    const tools = new Set<string>()
    for (let seed = 0; seed < SEEDS; seed++) {
      for (const step of generateRecipe(seed).steps) {
        kinds.add(step.kind)
        if (step.kind === 'boolean') tools.add(step.tool)
      }
    }
    expect([...kinds].sort()).toEqual([
      'boolean', 'chamfer', 'circular-array', 'fillet', 'helix', 'hole', 'linear-array', 'mirror', 'shell', 'start',
    ])
    expect([...tools].sort()).toEqual(['box', 'cylinder', 'sphere'])
  })
})
