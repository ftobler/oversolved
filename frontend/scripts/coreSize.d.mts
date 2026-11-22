export type SizeSide = 'core' | 'ui' | 'rust' | 'other'

export interface SizeCounts {
  prod: number
  test: number
  files: number
}

export interface SizeSummary {
  core: SizeCounts
  ui: SizeCounts
  rust: SizeCounts
  other: SizeCounts
}

export const CORE_PREFIXES: readonly string[]
export const RUST_PREFIXES: readonly string[]

export function isTestPath(path: string): boolean
export function classifyPath(path: string): SizeSide
export function summarize(paths: readonly string[], lineCount: (path: string) => number): SizeSummary
export function countLines(path: string): number
export function collectTracked(root: string): string[]
export function formatReport(summary: SizeSummary): string
