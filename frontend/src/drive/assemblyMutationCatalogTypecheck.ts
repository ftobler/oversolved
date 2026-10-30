// Type-level guard for the assembly mutation catalog: every wire mutation is
// compared with its catalog row on field names, optionality and null inclusion,
// and the wire type set is compared with the operation table minus the hidden
// fold twin. A new operation without a wire row fails `tsc -b` here, and the
// runtime twin is the catalog test.

import type { AssemblyOperationId } from '@/utils/assemblyOperations'
import type { AssemblyMutationCatalog, AssemblyWireMutation, AssemblyWireType } from './assemblyMutationCatalog'

type Expect<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

type OptionalKeys<T> = { [K in keyof T]-?: [Pick<T, K>] extends [Required<Pick<T, K>>] ? never : K }[keyof T]
type NullableKeys<T> = { [K in keyof T]-?: null extends T[K] ? K : never }[keyof T]

type CatalogOptionalKeys<F> = { [K in keyof F]-?: F[K] extends { required: false } ? K : never }[keyof F]
type CatalogNullableKeys<F> = { [K in keyof F]-?: F[K] extends { nullable: true } ? K : never }[keyof F]

type MemberOf<K extends AssemblyWireType> = Extract<AssemblyWireMutation, { type: K }>

// A mapped type rather than a distributive conditional: `infer T extends ...`
// widened the type key for the two rows with nullable parameters, which made the
// check report false for a row that is in fact exact.
type RowMatch<K extends AssemblyWireType> =
  Equal<keyof Omit<MemberOf<K>, 'type'>, keyof AssemblyMutationCatalog[K]['fields']> extends true
    ? Equal<OptionalKeys<Omit<MemberOf<K>, 'type'>>, CatalogOptionalKeys<AssemblyMutationCatalog[K]['fields']>> extends true
      ? Equal<NullableKeys<Omit<MemberOf<K>, 'type'>>, CatalogNullableKeys<AssemblyMutationCatalog[K]['fields']>>
      : false
    : false

type AllRowsMatch = { [K in AssemblyWireType]: RowMatch<K> }[AssemblyWireType]

export type AssemblyMutationCatalogFieldsCheck = Expect<Equal<AllRowsMatch, true>>

export type DebugRow<K extends AssemblyWireType> = RowMatch<K>

// The macro row expands in the drive session and has no operation of its own.
export type AssemblyWireTypeCheck = Expect<
  Equal<Exclude<AssemblyWireType, 'add_part_pattern'>, Exclude<AssemblyOperationId, 'set_part_fixed_oneshot'>>
>
