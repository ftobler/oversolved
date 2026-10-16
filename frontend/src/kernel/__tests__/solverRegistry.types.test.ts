/**
 * Type-level contract of the solver dispatch table.
 *
 * "Illegal features are unrepresentable" has two halves: the document union is
 * closed with literal kinds, and every dispatch entry's signature is keyed to
 * exactly its variant. Both are compile-level facts; `expectTypeOf` pins them
 * so a later widening (a `kind: string`, a dropped table key) fails here with a
 * focused message instead of surfacing as a runtime read of an absent payload.
 * The registered function itself is only typed as far as its own parameter is;
 * a same-shape swap stays invisible until the leaf solvers narrow.
 *
 * The assertions are erased at runtime, so this suite is pure build-time
 * checking.
 */
import { describe, it, expectTypeOf } from 'vitest'
import type {
  ArrayFeature,
  BooleanFeature,
  ChamferFeature,
  CircularArrayFeature,
  DeleteBodyFeature,
  DeleteFaceFeature,
  ExtrudeFeature,
  FilletFeature,
  HelixFeature,
  HoleFeature,
  MirrorFeature,
  MoveFaceFeature,
  PartFeature,
  LoftFeature,
  PlaneFeature,
  RevolveFeature,
  ShellFeature,
  SketchFeature,
  SweepFeature,
  TransformFeature,
  VariableFeature,
} from '@/types/cad'
import type { SolverTable } from '../solverRegistry'

/** The feature parameter of a dispatch entry (argument 3 of 7). */
type FeatureParam<K extends keyof SolverTable> = Parameters<SolverTable[K]>[3]

describe('the part feature union is closed', () => {
  it('spells every kind as a literal', () => {
    expectTypeOf<PartFeature['kind']>().toEqualTypeOf<
      | 'origin'
      | 'sketch'
      | 'plane'
      | 'extrude'
      | 'revolve'
      | 'sweep'
      | 'fillet'
      | 'chamfer'
      | 'shell'
      | 'loft'
      | 'move_face'
      | 'delete_face'
      | 'boolean'
      | 'array'
      | 'circular_array'
      | 'delete_body'
      | 'hole'
      | 'transform'
      | 'mirror'
      | 'variable'
      | 'helix'
      | 'import_step'
    >()
  })
})

describe('solver dispatch maps each kind to its variant', () => {
  it('pins the feature parameter per entry', () => {
    expectTypeOf<FeatureParam<'sketch'>>().toEqualTypeOf<SketchFeature>()
    expectTypeOf<FeatureParam<'plane'>>().toEqualTypeOf<PlaneFeature>()
    expectTypeOf<FeatureParam<'extrude'>>().toEqualTypeOf<ExtrudeFeature>()
    expectTypeOf<FeatureParam<'revolve'>>().toEqualTypeOf<RevolveFeature>()
    expectTypeOf<FeatureParam<'sweep'>>().toEqualTypeOf<SweepFeature>()
    expectTypeOf<FeatureParam<'fillet'>>().toEqualTypeOf<FilletFeature>()
    expectTypeOf<FeatureParam<'chamfer'>>().toEqualTypeOf<ChamferFeature>()
    expectTypeOf<FeatureParam<'shell'>>().toEqualTypeOf<ShellFeature>()
    expectTypeOf<FeatureParam<'loft'>>().toEqualTypeOf<LoftFeature>()
    expectTypeOf<FeatureParam<'move_face'>>().toEqualTypeOf<MoveFaceFeature>()
    expectTypeOf<FeatureParam<'delete_face'>>().toEqualTypeOf<DeleteFaceFeature>()
    expectTypeOf<FeatureParam<'boolean'>>().toEqualTypeOf<BooleanFeature>()
    expectTypeOf<FeatureParam<'array'>>().toEqualTypeOf<ArrayFeature>()
    expectTypeOf<FeatureParam<'circular_array'>>().toEqualTypeOf<CircularArrayFeature>()
    expectTypeOf<FeatureParam<'delete_body'>>().toEqualTypeOf<DeleteBodyFeature>()
    expectTypeOf<FeatureParam<'hole'>>().toEqualTypeOf<HoleFeature>()
    expectTypeOf<FeatureParam<'transform'>>().toEqualTypeOf<TransformFeature>()
    expectTypeOf<FeatureParam<'mirror'>>().toEqualTypeOf<MirrorFeature>()
    expectTypeOf<FeatureParam<'variable'>>().toEqualTypeOf<VariableFeature>()
    expectTypeOf<FeatureParam<'helix'>>().toEqualTypeOf<HelixFeature>()
  })

  it('rejects a feature of the wrong kind', () => {
    expectTypeOf<FeatureParam<'extrude'>>().not.toEqualTypeOf<RevolveFeature>()
    expectTypeOf<FeatureParam<'fillet'>>().not.toEqualTypeOf<ChamferFeature>()
  })

  it('covers every dispatchable kind and only those', () => {
    // origin has no solver (builtin repo result); import_step needs the file
    // map and is wired directly by createFeatureSolver.
    expectTypeOf<keyof SolverTable>().toEqualTypeOf<
      Exclude<PartFeature['kind'], 'origin' | 'import_step'>
    >()
  })
})
