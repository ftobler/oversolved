// Collects the license text of every npm package that reaches a visitor's
// browser and writes them into one notice bundle.
//
// Serving the app is distribution: the moment the built site is public, every
// visitor downloads the bundled dependencies, and MIT, ISC, BSD and Apache all
// require their notice to travel with the copy. A hand-kept list goes stale on
// the next `npm install`, so the bundle is generated from the real dependency
// graph and committed, and `--check` fails when the two drift apart.
//
// Only the production graph is walked. Build and test tooling (vite, vitest,
// eslint, typescript) would only bury the packages that ship. The bundler is
// the one qualification: Vite and Rollup inject small runtime helpers into the
// output, so a trace of them does ship, under the same MIT terms the file
// already reproduces many times over. The published notices say so.
//
// OpenCascade is deliberately absent here: it is installed with `--no-save`
// and is not reachable from package.json, so it is documented by hand in
// public/third_party/opencascade/ instead.
//
// Usage:
//   node scripts/generateThirdPartyNotices.mjs            # write the bundle
//   node scripts/generateThirdPartyNotices.mjs --check     # fail if stale

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(scriptDir, '..')
const outputPath = path.join(frontendDir, 'public', 'third_party', 'npm', 'LICENSES.txt')

// Filenames packages use for their license and notice text, in the order we
// prefer them. Apache-2.0 section 4 makes NOTICE a separate obligation from the
// license itself, so it is collected alongside rather than instead.
const LICENSE_FILES = [
  'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE.markdown',
  'LICENSE-MIT', 'LICENSE-MIT.txt',
  'LICENCE', 'LICENCE.md', 'LICENCE.txt', 'LICENCE.markdown',
  'COPYING', 'COPYING.md', 'COPYING.txt',
  'license', 'license.md', 'license.txt',
]
const NOTICE_FILES = ['NOTICE', 'NOTICE.md', 'NOTICE.txt']

// Some packages declare a license but ship no text for it. The text cannot be
// invented, so the bundle carries a canonical copy of the common ones and the
// entry points at it. The copyright holder for those stays the package's own
// author, recorded in the entry rather than pasted into a borrowed notice.
//
// Read from disk rather than hard-coded, so an entry can never point at a
// canonical text that is not actually published beside it.
const spdxDir = path.join(frontendDir, 'public', 'third_party', 'spdx')
const SPDX_FALLBACKS = new Set(
  existsSync(spdxDir)
    ? readdirSync(spdxDir).filter(name => name.endsWith('.txt')).map(name => name.slice(0, -4))
    : [],
)

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

// Node's own resolution rules, minus the parts we do not need: walk up the
// directory chain looking for node_modules/<name>. require.resolve cannot be
// used because a package need not have an importable entry point, and several
// here are pure CSS or font payloads.
function resolvePackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function findFile(dir, names) {
  for (const name of names) {
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8').trimEnd()
  }
  return null
}

// The declared license as a plain string. Old packages still use the array or
// object forms that npm dropped, and a few use neither.
function declaredLicense(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map(entry => entry.type ?? entry).join(' OR ')
  }
  return null
}

// Breadth-first over the production graph.
//
// A package that does not resolve is reported, because a declared dependency
// with no license read is the one failure this file must never hide. Optional
// and peer edges are the exception: both are routinely absent by design, and an
// edge that resolves to nothing put nothing in the bundle either.
function collectPackages(rootDir) {
  const root = readJson(path.join(rootDir, 'package.json'))
  const found = new Map()
  const queue = Object.keys(root.dependencies ?? {})
    .map(name => ({ name, from: rootDir, optional: false }))
  const missing = []

  while (queue.length > 0) {
    const { name, from, optional } = queue.shift()
    const dir = resolvePackageDir(name, from)
    if (!dir) {
      if (!optional) missing.push(name)
      continue
    }
    const pkg = readJson(path.join(dir, 'package.json'))
    const key = `${pkg.name}@${pkg.version}`
    if (found.has(key)) continue

    found.set(key, {
      name: pkg.name,
      version: pkg.version,
      license: declaredLicense(pkg),
      author: authorName(pkg),
      homepage: pkg.homepage ?? repositoryUrl(pkg),
      licenseText: findFile(dir, LICENSE_FILES),
      noticeText: findFile(dir, NOTICE_FILES),
    })

    // peerDependencies are followed as well. A peer is installed by the
    // consumer rather than by the package that wants it, which makes it easy to
    // think of as someone else's problem, but it is imported and bundled like
    // any other dependency, so it is served to the same visitor.
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      queue.push({ name: dependency, from: dir, optional: false })
    }
    const loose = { ...pkg.optionalDependencies, ...pkg.peerDependencies }
    for (const dependency of Object.keys(loose)) {
      queue.push({ name: dependency, from: dir, optional: true })
    }
  }

  return { packages: [...found.values()].sort(byName), missing: [...new Set(missing)].sort() }
}

// Attribution for the packages that ship no license file: without their own
// text, the author field is the only copyright holder the package states.
function authorName(pkg) {
  const author = pkg.author
  if (typeof author === 'string') return author
  if (author && typeof author.name === 'string') {
    return author.email ? `${author.name} <${author.email}>` : author.name
  }
  return null
}

function repositoryUrl(pkg) {
  const repository = pkg.repository
  const url = typeof repository === 'string' ? repository : repository?.url
  if (!url) return null
  return url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://')
}

function byName(a, b) {
  return a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en')
}

function render({ packages, missing }) {
  const withoutText = packages.filter(entry => !entry.licenseText)
  const lines = []

  lines.push('Third-party licenses: npm dependencies')
  lines.push('')
  lines.push('This file is generated by scripts/generateThirdPartyNotices.mjs and lists')
  lines.push('every npm package in the production dependency graph, which is to say every')
  lines.push('package whose code can end up in a visitor\'s browser. Each entry reproduces')
  lines.push('the license text the package itself ships.')
  lines.push('')
  lines.push('Build and test tooling is not listed: it never reaches the browser.')
  lines.push('OpenCascade Technology is not listed either; it is installed separately and')
  lines.push('documented in ../opencascade/.')
  lines.push('')
  lines.push(`Packages: ${packages.length}`)
  lines.push('')

  if (withoutText.length > 0) {
    lines.push('Packages that declare a license but ship no text for it. Their entries name')
    lines.push('the license, the copyright holder the package states, and the canonical text')
    lines.push('in ../spdx/ where one exists.')
    lines.push('')
    for (const entry of withoutText) {
      lines.push(`  ${entry.name}@${entry.version}  ${entry.license ?? 'license not declared'}`)
    }
    lines.push('')
  }

  if (missing.length > 0) {
    lines.push('Declared dependencies that were not installed when this file was written,')
    lines.push('so their licenses could not be read. Reinstall and regenerate.')
    lines.push('')
    for (const name of missing) lines.push(`  ${name}`)
    lines.push('')
  }

  for (const entry of packages) {
    lines.push(divider())
    lines.push('')
    lines.push(`${entry.name}@${entry.version}`)
    if (entry.license) lines.push(`License: ${entry.license}`)
    if (entry.author) lines.push(`Copyright: ${entry.author}`)
    if (entry.homepage) lines.push(`Source: ${entry.homepage}`)
    lines.push('')
    if (entry.licenseText) {
      lines.push(entry.licenseText)
      lines.push('')
    } else {
      lines.push('This package ships no license file of its own.')
      if (entry.license && SPDX_FALLBACKS.has(entry.license)) {
        lines.push(`The terms are the standard ${entry.license} text, in ../spdx/${entry.license}.txt,`)
        lines.push('held by the copyright holder named above.')
      }
      lines.push('')
    }
    if (entry.noticeText) {
      lines.push('NOTICE:')
      lines.push('')
      lines.push(entry.noticeText)
      lines.push('')
    }
  }

  return lines.join('\n').trimEnd() + '\n'
}

function divider() {
  return '='.repeat(78)
}

export function generate() {
  return render(collectPackages(frontendDir))
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const generated = generate()

  if (checkOnly) {
    const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : ''
    if (current === generated) {
      console.log(`third-party notices are current (${outputPath})`)
      return
    }
    console.error('third-party notices are stale. Run: npm run licenses:generate')
    process.exitCode = 1
    return
  }

  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, generated)
  console.log(`wrote ${outputPath}`)
}

// Importable for the test that guards staleness, executable for the npm script.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
