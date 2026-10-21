// Type-level guard for the mutation catalog: one distributive check compares
// every union member with its catalog row on three axes, names, optionality and
// null inclusion. A new field on a Mutation, a typo in a row, or a row that
// marks a union-optional or union-nullable field required/non-nullable fails
// `tsc -b` here; the runtime twin is the catalog test.

import type { Mutation } from '@/types/cad'
import type { MutationCatalog } from './mutationCatalog'

type Expect<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

type OptionalKeys<T> = { [K in keyof T]-?: [Pick<T, K>] extends [Required<Pick<T, K>>] ? never : K }[keyof T]
type NullableKeys<T> = { [K in keyof T]-?: null extends T[K] ? K : never }[keyof T]

type CatalogOptionalKeys<F> = { [K in keyof F]-?: F[K] extends { required: false } ? K : never }[keyof F]
type CatalogNullableKeys<F> = { [K in keyof F]-?: F[K] extends { nullable: true } ? K : never }[keyof F]

// The naked M conditional distributes over the union, so every mutation is
// checked against its own catalog row and the result folds to a single true.
type FieldsMatch<M> = M extends { type: infer T extends Mutation['type'] }
  ? Equal<keyof Omit<M, 'type'>, keyof MutationCatalog[T]['fields']> extends true
    ? Equal<OptionalKeys<Omit<M, 'type'>>, CatalogOptionalKeys<MutationCatalog[T]['fields']>> extends true
      ? Equal<NullableKeys<Omit<M, 'type'>>, CatalogNullableKeys<MutationCatalog[T]['fields']>>
      : false
    : false
  : never

export type MutationCatalogFieldsCheck = Expect<Equal<FieldsMatch<Mutation>, true>>
