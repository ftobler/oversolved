// The `?/@/$` wire format is canonical in kernel/query.ts; this module re-exports
// the serializer so the app-facing `@/utils/query` surface is the same code the
// kernel runs, not a parallel copy.
//
// Convert a Query to its wire-format string.
//
// Call ONLY at true serialization boundaries:
//   - writing into a PartDoc / YAML field
//   - React keys or Set members where an opaque stable string is needed
//
// Do NOT call to compare queries -- use structural equality on the objects.
// Do NOT call to inspect kind -- use the `kind` field directly.
// If you find yourself calling this just to pass the value somewhere else,
// keep the Query object instead.
export { emitWire, parseQuery, local, absolute, ancestry } from "@/kernel/query"
export type { Query, LocalQuery, AbsoluteQuery, AncestryQuery } from "@/types/query"
