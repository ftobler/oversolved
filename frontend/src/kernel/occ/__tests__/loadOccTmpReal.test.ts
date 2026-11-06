// @vitest-environment node
//
// The headless loader writes a CommonJS rewrite of opencascade.js to a temp
// directory to require it. That directory must be gone once the load returns:
// left behind, one copy per load filled a RAM-backed /tmp to 40 GB and starved
// the vitest workers. Skips when OCC is absent.
//
// The load runs against a private TMPDIR (os.tmpdir() reads it per call), so
// other workers loading in parallel cannot make the count flicker.

import { mkdtempSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { loadOcc, resetOcc, occInstalled } from '../loadOcc'

describe.skipIf(!occInstalled())('loadOcc temp copy', () => {
  it('leaves no occjs-* directory behind after a load', async () => {
    // Anchored on this file, not the cwd, so a vitest run from elsewhere still
    // stays inside the project tmp/.
    const projectTmp = fileURLToPath(new URL('../../../../../tmp', import.meta.url))
    mkdirSync(projectTmp, { recursive: true })
    const privateTmp = mkdtempSync(path.join(projectTmp, 'loadocc-test-'))
    const savedTmpdir = process.env.TMPDIR
    process.env.TMPDIR = privateTmp
    try {
      // Drop any module this worker already holds so the load really writes.
      resetOcc()
      const oc = await loadOcc()
      expect(oc).not.toBeNull()
      expect(readdirSync(privateTmp)).toEqual([])
    } finally {
      if (savedTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = savedTmpdir
      rmSync(privateTmp, { recursive: true, force: true })
    }
  }, 60_000)
})
