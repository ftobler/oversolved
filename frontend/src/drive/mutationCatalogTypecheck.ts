// Type-level guard for the mutation catalog: one mapped assertion compares the
// fields of every union member with the catalog row's field names. A new field
// on a Mutation, or a typo in a row, fails `tsc -b` here; the runtime twin of
// this check is mutationHandlers key coverage in the catalog test.

import type { Mutation } from '@/types/cad'
import type { MutationCatalog } from './mutationCatalog'

type Expect<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

// The naked M conditional distributes over the union, so every mutation is
// checked against its own catalog row and the result folds to a single true.
type FieldsMatch<M> = M extends { type: infer T extends Mutation['type'] }
  ? Equal<keyof Omit<M, 'type'>, keyof MutationCatalog[T]['fields']>
  : never

export type MutationCatalogFieldNamesCheck = Expect<Equal<FieldsMatch<Mutation>, true>>
