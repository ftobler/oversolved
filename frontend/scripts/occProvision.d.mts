// Types for the helpers occProvision.mjs exports, so the vitest suite can drive
// them with a stubbed fetch instead of the network.

export interface OccPin {
  _comment?: string
  repo: string
  tag: string
  occt: { version: string; tag: string; commit: string; archive?: string; sha256?: string }
  emcc?: string
  build_commit?: string
  artifacts: Record<string, string>
}

type FetchLike = (url: string, init?: unknown) => Promise<{
  ok: boolean
  status: number
  arrayBuffer(): Promise<ArrayBuffer>
}>

export function normalizeOcctVersion(text: string): string
export function occtVersionOfTag(tag: string): string | undefined
export function releaseUrl(repo: string, tag: string, file: string): string
export function pinFromManifest(repo: string, tag: string, manifest: unknown): OccPin
export function verifyOccInstall(pin: OccPin, cacheDir: string): string[]
export function installOcc(pin: OccPin, cacheDir: string, fetchImpl?: FetchLike): Promise<void>
export function provisionOcc(pin: OccPin, cacheDir: string, outDir: string): void
