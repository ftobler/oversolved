/**
 * Read a positive integer override from the environment, or fall back.
 *
 * The fuzz recipes widen a suite by exporting a variable (`FUZZ_SEEDS=200`);
 * an unset, non-numeric or non-positive value keeps the bounded default the PR
 * gate runs with. Every harness had its own copy of this three-liner.
 */
export function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}
