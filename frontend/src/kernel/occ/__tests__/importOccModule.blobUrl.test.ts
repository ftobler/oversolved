// @vitest-environment jsdom
//
// `occt.js` is imported off a blob URL that must stay alive for as long as the
// module is. Chrome showed a 404 for a bare UUID resource (its label for a blob
// URL) on a normal session: something asked the URL again after the import had
// resolved, and the loader had revoked it in a `finally` right after the import.
// The contract these tests pin: one URL per import, kept while the module is
// live, released only by a loader reset (releaseOccFactory) or by the later
// import that replaces it.
//
// wasmCompile is mocked as in the loader tests: streaming and progress belong to
// wasmCompile.test.ts, and here only the factory import is under test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface FakeWasmReport {
  download(loadedBytes: number, totalBytes: number): void
  compiling(): void
}

vi.mock('../wasmCompile', () => ({
  compileOccWasm: async (_url: string, _report: FakeWasmReport) => ({ fake: 'module' }),
  makeInstantiateWasm: () => 'instantiate-hook',
}))

// resetModules gives a fresh importOccModule, and with it an empty live-URL
// cell, since that state is module-scoped.
async function freshImportOccModule() {
  vi.resetModules()
  const [progress, mod] = await Promise.all([
    import('../loadProgress'),
    import('../importOccModule'),
  ])
  progress.resetOccLoadProgress()
  return mod
}

const FACTORY_JS =
  'export default async () => { return { occt: "ready" } };'

// jsdom has no object URLs, so createObjectURL hands back a data URL holding the
// fetched text. Each call gets its own URL (a trailing comment) so a test can
// tell the first from the replacement.
function serve(): { create: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> } {
  let n = 0
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => FACTORY_JS })))
  const create = vi.fn(
    () => `data:text/javascript,${encodeURIComponent(`${FACTORY_JS}\n// blob ${++n}`)}`,
  )
  const revoke = vi.fn()
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
  return { create, revoke }
}

describe('importOccModule blob URL lifetime', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does not revoke the blob URL while the imported module is live', async () => {
    const { create, revoke } = serve()
    const mod = await freshImportOccModule()

    expect(await mod.importOccModule('/base/')).toEqual({ occt: 'ready' })
    expect(create).toHaveBeenCalledTimes(1)
    // Revoking here is the bug that produced the 404, not the cleanup.
    expect(revoke).not.toHaveBeenCalled()
  })

  it('revokes the live URL when a loader reset releases the factory', async () => {
    const { create, revoke } = serve()
    const mod = await freshImportOccModule()
    await mod.importOccModule('/base/')
    const url = create.mock.results[0].value as string

    mod.releaseOccFactory()
    expect(revoke).toHaveBeenCalledWith(url)

    // A second release is a no-op, not a second revoke of the same URL.
    mod.releaseOccFactory()
    expect(revoke).toHaveBeenCalledTimes(1)
  })

  it('revokes the previous URL only once a replacement import resolves', async () => {
    const { create, revoke } = serve()
    const mod = await freshImportOccModule()
    await mod.importOccModule('/base/')
    const first = create.mock.results[0].value as string
    await mod.importOccModule('/base/')

    expect(create).toHaveBeenCalledTimes(2)
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith(first)
  })

  it('still resolves the module when it has no default factory, and keeps the URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'export const x = 1;' })))
    const revoke = vi.fn()
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'data:text/javascript,export%20const%20x%20%3D%201%3B'),
      revokeObjectURL: revoke,
    })
    const mod = await freshImportOccModule()

    expect(await mod.importOccModule('/base/')).toBeNull()
    // A module with no factory is a miss the loader retries, but the URL may
    // still be asked for its source; it goes on the retry, not here.
    expect(revoke).not.toHaveBeenCalled()
  })
})
