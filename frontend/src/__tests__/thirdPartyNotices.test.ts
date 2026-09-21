import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The compliance gate for what ships beside the app.
//
// Serving the built site distributes every bundled dependency to every visitor,
// and most of those licenses require their text to travel with the copy. That
// makes the notices a build output rather than documentation: they can go stale
// without anything failing to compile, and nobody notices until someone asks.
// So the suite treats them like any other derived artifact and fails when they
// drift from what is actually installed and actually deployed.

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const noticesDir = path.join(frontendDir, 'public', 'third_party')

function readNotices(...segments: string[]) {
  return readFileSync(path.join(noticesDir, ...segments), 'utf8')
}

function packageJson() {
  return JSON.parse(readFileSync(path.join(frontendDir, 'package.json'), 'utf8'))
}

describe('third-party notices', () => {
  // The whole point of generating the bundle: a dependency added without
  // regenerating would otherwise reach a deployment with no license at all.
  it('are current with the installed dependency graph', () => {
    expect(() => {
      execFileSync('node', ['scripts/generateThirdPartyNotices.mjs', '--check'], {
        cwd: frontendDir,
        stdio: 'pipe',
      })
    }).not.toThrow()
  })

  it('cover every declared production dependency', () => {
    const bundle = readNotices('npm', 'LICENSES.txt')
    for (const name of Object.keys(packageJson().dependencies)) {
      expect(bundle, `${name} is missing from the notices`).toContain(`\n${name}@`)
    }
  })

  it('publish the licenses the notices point at', () => {
    for (const file of [
      'README.md',
      'npm/LICENSES.txt',
      'opencascade/README.md',
      'opencascade/LICENSE-LGPL-2.1.txt',
      'opencascade/OCCT-EXCEPTION.txt',
    ]) {
      expect(existsSync(path.join(noticesDir, file)), `${file} is missing`).toBe(true)
    }
  })

  it('reproduce the LGPL and the Open CASCADE exception in full', () => {
    expect(readNotices('opencascade', 'LICENSE-LGPL-2.1.txt'))
      .toContain('GNU LESSER GENERAL PUBLIC LICENSE')
    expect(readNotices('opencascade', 'OCCT-EXCEPTION.txt'))
      .toContain('Open CASCADE exception (version 1.0)')
  })

  // The exception grants its permission on the condition that a work using OCCT
  // says prominently that it does. The sentence is therefore a term, not a
  // courtesy, and deleting it as boilerplate would break the grant.
  it('give the prominent notice the Open CASCADE exception requires', () => {
    const notice = 'makes use of and is based on facilities provided by the Open\nCASCADE Technology software'
    expect(readNotices('README.md')).toContain(notice)
    expect(readNotices('opencascade', 'README.md')).toContain(notice)
  })

  // A version bump in occ:install changes which OCCT binary is distributed, and
  // therefore which corresponding source the notices must offer.
  it('document the OpenCascade version that occ:install actually pins', () => {
    const install = packageJson().scripts['occ:install']
    const pinned = /opencascade\.js@([\d.]+)/.exec(install)?.[1]
    expect(pinned, 'occ:install no longer pins an explicit version').toBeTruthy()
    expect(readNotices('opencascade', 'README.md')).toContain(`opencascade.js@${pinned}`)
  })

  // occ:provision decides which files are served, so the notices have to name
  // the same ones. A renamed or added artifact would otherwise ship undeclared.
  it('name every OpenCascade artifact that occ:provision deploys', () => {
    const provision = packageJson().scripts['occ:provision']
    const artifacts = provision.match(/opencascade\.wasm\.[a-z]+/g) ?? []
    const doc = readNotices('opencascade', 'README.md')
    expect(artifacts.length).toBeGreaterThan(0)
    for (const artifact of new Set<string>(artifacts)) {
      expect(doc, `${artifact} is deployed but not documented`).toContain(artifact)
    }
  })

  // Relative links are how the notices point at the license texts. A broken one
  // is a notice that does not actually publish the terms it claims to.
  it('link only to files that are published', () => {
    const doc = readNotices('README.md')
    const links = [...doc.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1])
    const relative = links.filter(href => !/^[a-z]+:/i.test(href) && !href.startsWith('#'))

    expect(relative.length).toBeGreaterThan(0)
    for (const href of relative) {
      const target = path.resolve(noticesDir, href)
      expect(existsSync(target), `${href} does not resolve to a published file`).toBe(true)
    }
  })

  // The solver crates are linked into public/wasm/*.wasm and served with the
  // app, so they are distributed as surely as any npm package. cargo is not
  // installed everywhere the frontend suite runs, so the regeneration check
  // skips where it cannot run, the same way the OCC.js tests do.
  describe('rust crates', () => {
    const hasCargo = (() => {
      try {
        execFileSync('cargo', ['--version'], { stdio: 'pipe' })
        return true
      } catch {
        return false
      }
    })()

    it('are published with the app', () => {
      const bundle = readNotices('cargo', 'LICENSES.txt')
      for (const crate of ['nalgebra', 'serde', 'wasm-bindgen']) {
        expect(bundle, `${crate} is missing from the rust notices`).toContain(`\n${crate}@`)
      }
    })

    it('do not list the workspace\'s own crates as third-party', () => {
      const bundle = readNotices('cargo', 'LICENSES.txt')
      for (const own of ['solver-core@', 'sketch-solver@', 'mate-solver@']) {
        expect(bundle, `${own} is Oversolved's own code`).not.toContain(`\n${own}`)
      }
    })

    it.skipIf(!hasCargo)('are current with the solver dependency graph', () => {
      expect(() => {
        execFileSync('node', ['scripts/generateRustNotices.mjs', '--check'], {
          cwd: frontendDir,
          stdio: 'pipe',
        })
      }).not.toThrow()
    })
  })

  // Packages that ship no license text of their own are pointed at a canonical
  // copy instead. The pointer is only worth anything if the copy is there.
  it('publish every canonical license text the bundles fall back to', () => {
    const referenced = new Set<string>()
    for (const bundle of ['npm', 'cargo']) {
      const text = readNotices(bundle, 'LICENSES.txt')
      for (const match of text.matchAll(/\.\.\/spdx\/([^\s,.]+\.txt)/g)) referenced.add(match[1])
    }
    for (const file of referenced) {
      expect(existsSync(path.join(noticesDir, 'spdx', file)), `spdx/${file} is missing`).toBe(true)
    }
  })

  // The toolchain credits cover what neither package manager can see: code the
  // compiler linked in that was never a declared dependency of anything.
  it('credit the compiler runtime linked into the WebAssembly', () => {
    const doc = readNotices('toolchain', 'README.md')
    for (const component of ['Rust standard library', 'Emscripten', 'libc++']) {
      expect(doc, `${component} is shipped but not credited`).toContain(component)
    }
    for (const file of [
      'toolchain/LICENSE-rust-MIT.txt',
      'toolchain/LICENSE-rust-Apache-2.0.txt',
      'toolchain/LICENSE-emscripten.txt',
      'toolchain/LICENSE-libcxx-Apache-2.0-with-LLVM-exception.txt',
    ]) {
      expect(existsSync(path.join(noticesDir, file)), `${file} is missing`).toBe(true)
    }
  })

  // The source mirror is the one obligation that cannot be discharged in the
  // repository: it needs a release that exists, at a URL that resolves, in a
  // public repository that has not been created yet. So the notices carry a
  // marker instead of a fabricated link, and this test makes the marker
  // impossible to ship: the moment a deployment workflow appears, publishing
  // becomes real and the URL has to be real too.
  it('do not let a deployment be configured while the source mirror is unpublished', () => {
    const doc = readNotices('opencascade', 'README.md')
    if (!doc.includes('MIRROR_RELEASE_URL_PENDING')) {
      // The marker is gone, so a concrete release link must have replaced it.
      expect(doc).toMatch(/https:\/\/\S+\/releases\/tag\/occ-source-v7_4_0p1/)
      return
    }

    const workflowDir = path.join(frontendDir, '..', '.github', 'workflows')
    const workflows = existsSync(workflowDir) ? readdirSync(workflowDir) : []
    const deploying = workflows.filter(name => {
      const text = readFileSync(path.join(workflowDir, name), 'utf8')
      return /pages|deploy/i.test(text)
    })

    expect(
      deploying,
      'A deployment workflow exists while the OpenCascade source mirror is still '
      + 'unpublished. Serving the app distributes the library, and the notices promise '
      + 'a release that does not exist. Create the release, then replace '
      + 'MIRROR_RELEASE_URL_PENDING in opencascade/README.md with its URL.',
    ).toEqual([])
  })

  // The source offer is a mirror in the same repository that publishes the app,
  // which is what section 6(d) asks for. It is only as good as the archives
  // matching the binary, so the digests the notices publish and the digests the
  // fetch script verifies against have to be the same numbers.
  it('offer source archives whose digests match the ones the fetcher pins', () => {
    const script = readFileSync(
      path.join(frontendDir, 'scripts', 'fetchOccSource.mjs'), 'utf8')
    const doc = readNotices('opencascade', 'README.md')

    const pinned = [...script.matchAll(/sha256:\s*'([0-9a-f]{64})'/g)].map(match => match[1])
    expect(pinned.length, 'the fetch script pins no digests').toBe(2)
    for (const digest of pinned) {
      expect(doc, `${digest} is verified on fetch but not published`).toContain(digest)
    }

    const name = /name:\s*'([^']+\.tar\.gz)'/g
    for (const match of script.matchAll(name)) {
      expect(doc, `${match[1]} is mirrored but not named in the notices`).toContain(match[1])
    }
  })

  // The corresponding source of the OCC binary is the OCCT revision plus the
  // patches opencascade.js applies to it. Offering the bare upstream revision
  // would point a recipient at a tree that does not build what is shipped.
  it('name the patches that stand between upstream OCCT and the shipped binary', () => {
    const doc = readNotices('opencascade', 'README.md')
    for (const patch of [
      'CMakeLists.txt.patch',
      'OSD_Path.cxx.patch',
      'OSD_Process.cxx.patch',
      'Bnd_Box.hxx.patch',
      'BRepGProp.hxx.patch',
    ]) {
      expect(doc, `${patch} is applied to the shipped build but not documented`).toContain(patch)
    }
  })
})
