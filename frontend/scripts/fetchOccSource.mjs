// Fetches the corresponding source of the OpenCascade binary this project
// serves, ready to be attached to a release in the public mirror.
//
// The LGPL lets a distributor satisfy its source obligation by offering
// "equivalent access to copy the above specified materials from the same
// place" (section 6d). Linking at upstream is not that: neither OCCT's gitweb
// nor a third party's GitHub repository is the same place as this project's
// own deployment, and neither is under this project's control. Hosting the two
// archives as release assets in the same repository that publishes the app is.
//
// The corresponding source is BOTH archives. opencascade.js patches the OCCT
// tree before compiling it, so the upstream revision alone does not build the
// binary that ships.
//
// Run this, then attach both files and the printed checksums to the release
// named in public/third_party/opencascade/README.md.
//
// Usage:
//   node scripts/fetchOccSource.mjs [outputDir]     # default: tmp/occ-source

import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoDir = path.resolve(scriptDir, '..', '..')

// Pinned to what occ:install installs and what occ:provision then deploys. A
// bump in either has to be a bump here, or the offered source stops matching
// the binary, which is the one way this file can be worse than useless.
// The digests are checked, not just reported. A tag that upstream moved, or an
// archive regenerated with different compression, would otherwise be mirrored
// and offered as the corresponding source without anyone noticing it changed.
export const SOURCES = [
  {
    name: 'occt-V7_4_0p1.tar.gz',
    url: 'https://github.com/Open-Cascade-SAS/OCCT/archive/refs/tags/V7_4_0p1.tar.gz',
    what: 'Open CASCADE Technology V7_4_0p1, commit 33d9a6fa21ca4fa711da7066655aa2ba854545ee',
    sha256: '85b66265cd861147fdc6e428b01a917a37fc3902d2d06d73c7298b1ac9a2cb0d',
  },
  {
    name: 'opencascade.js-1.1.1-src.tar.gz',
    url: 'https://github.com/donalffons/opencascade.js/archive/refs/tags/v1.1.1.tar.gz',
    what: 'The opencascade.js 1.1.1 build, including the patches it applies to OCCT',
    sha256: '7ce8617e77013c24ba4b32df7933094400a61fc96d143060634f1101f5ed6b93',
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
  console.log('Attach all three to the release named in')
  console.log('public/third_party/opencascade/README.md, then verify the link resolves.')
}

async function readAll(file) {
  const { readFile } = await import('node:fs/promises')
  return readFile(file)
}

await main()
