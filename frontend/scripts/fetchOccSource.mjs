// Fetches the corresponding source of the OpenCascade binary this project
// serves, so a deploy can ship it beside the binary.
//
// The LGPL lets a distributor satisfy its source obligation by offering
// "equivalent access to copy the above specified materials from the same
// place" (section 6d). Linking at upstream is not that: neither OCCT's gitweb
// nor a third party's GitHub repository is the same place as this project's
// own deployment, and neither is under this project's control. Serving the two
// archives from the deployed site itself, at the relative links in
// public/third_party/opencascade/README.md, is.
//
// The corresponding source is BOTH archives: the OCCT release and the
// oversolved-occt build at the commit that produced the binary. The build repo
// generates the embind layer and holds the hand-written bindings and the
// compile and link flags, so the upstream release alone does not build the
// binary that ships.
//
// Every deploy runs this into dist/third_party/opencascade/source. It fails
// the deploy if upstream moves or drops an archive. The default output in tmp/
// doubles as a cache: an existing file is checked against its pin instead of
// downloaded, so a dev machine that ran this once still holds verified copies
// to restore from if upstream is ever gone.
//
// Usage:
//   node scripts/fetchOccSource.mjs [outputDir]     # default: tmp/occ-source

import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoDir = path.resolve(scriptDir, '..', '..')

// Pinned to the release frontend/occ.pin.json names (its `occt.commit` and
// `build_commit`). A repin there has to be a bump here, or the offered source
// stops matching the binary, which is the one way this file can be worse than
// useless. The digests are checked, not just reported. A tag that upstream
// moved, or an archive regenerated with different compression, would otherwise
// be mirrored and offered as the corresponding source without anyone noticing
// it changed. (They are of the .tar.gz as served; the pin's `occt.sha256` is of
// the uncompressed tar, which is what the build repo verifies.)
export const SOURCES = [
  {
    name: 'occt-V8.0.1.tar.gz',
    url: 'https://github.com/Open-Cascade-SAS/OCCT/archive/refs/tags/V8.0.1.tar.gz',
    what: 'Open CASCADE Technology V8.0.1, commit b8f597c677811d1f9f4d8a97f5ae2825c0353a42',
    sha256: '6297cc55a1720523a437c54d07dc16b9da8c5f5ab5800da3c6ebded568d53c18',
  },
  {
    name: 'oversolved-occt-2d888f3-src.tar.gz',
    url: 'https://github.com/ftobler/oversolved-occt/archive/2d888f36721be579263a7e6b8854e7738cf1d575.tar.gz',
    what: 'The oversolved-occt build at 2d888f36721be579263a7e6b8854e7738cf1d575: binding generator, manual bindings, build flags',
    sha256: '1c15ee3e1d500e80406e4390d6c31c66396738579e830b1c98750181553de5aa',
  },
]

async function download(source, outputDir) {
  const target = path.join(outputDir, source.name)
  if (existsSync(target)) {
    console.log(`  already present, skipping download (${statSync(target).size} bytes)`)
    return target
  }
  const response = await fetch(source.url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${source.url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  writeFileSync(target, bytes)
  return target
}

async function main() {
  const outputDir = path.resolve(repoDir, process.argv[2] ?? path.join('tmp', 'occ-source'))
  mkdirSync(outputDir, { recursive: true })

  const checksums = []
  for (const source of SOURCES) {
    console.log(`${source.name}`)
    console.log(`  ${source.what}`)
    console.log(`  from ${source.url}`)
    const target = await download(source, outputDir)
    const digest = createHash('sha256').update(await readAll(target)).digest('hex')
    if (digest !== source.sha256) {
      throw new Error(
        `${source.name} does not match the pinned digest.\n`
        + `  expected ${source.sha256}\n`
        + `  got      ${digest}\n`
        + 'Upstream changed what that tag resolves to. Do not mirror this until it is '
        + 'understood: the offered source must be the source the shipped binary was built from.',
      )
    }
    checksums.push(`${digest}  ${source.name}`)
    console.log(`  sha256 ${digest} (matches the pin)`)
  }

  const manifest = path.join(outputDir, 'SHA256SUMS')
  writeFileSync(manifest, checksums.join('\n') + '\n')

  console.log('')
  console.log(`Archives and ${path.basename(manifest)} are in ${outputDir}`)
}

async function readAll(file) {
  const { readFile } = await import('node:fs/promises')
  return readFile(file)
}

await main()
