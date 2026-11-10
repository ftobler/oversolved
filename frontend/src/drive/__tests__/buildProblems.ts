// Shared by drive suites whose fixtures are free hand-authored profiles. An
// underconstrained sketch is legitimate fixture geometry: these cases test a
// feature's behaviour, not the sketch verdict, and the law has dedicated tests.
// Only that WARNING row is tolerated. An overconstrained sketch or a sketch
// exception still fails the whole-list assertions, so a fixture regression is
// not hidden by this helper.
export function nonSketchProblems<T extends { kind: string; status: string }>(
  features: readonly T[] | null | undefined,
): T[] {
  return (features ?? []).filter(
    feature => !(feature.kind === 'sketch' && feature.status === 'underconstrained'),
  )
}
