/**
 * The backend must not grow back.
 *
 * The app is browser-only: IndexedDB for storage, WASM for compute, no server of
 * any kind. This test is what keeps that structural rather than aspirational.
 * The failure mode it guards is not a deliberate decision to add a server -- it
 * is one `fetch('/api/...')` slipped into a view because that was the quickest
 * way to get some data, which then quietly makes the app depend on something
 * being deployed behind it. By the time that is noticed it is load-bearing.
 *
 * It replaces the capability-bundle ratchet that used to live here (no
 * `hasBackend` reads, no `/api/` literals outside the adapters). That ratchet
 * ended at zero on both counts, and its subject -- the flag distinguishing two
 * deployments -- was deleted with the server. The ratchet shape is kept: a list
 * of banned tokens, and per-file exemptions that must keep earning their place
 * (a stale one fails). The Python side pins the same boundary from the other
 * end (tests/test_import_boundary.py: `oversolved/` is build-time tooling with
 * an empty runtime dependency list).
 *
 * Scope note: this scans src/ only. The kernel's Worker `postMessage` traffic
 * and IndexedDB are not network calls and are not matched by any rule below.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative, sep } from 'node:path'

// src/ root, derived from this file's location (src/config/<this>).
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface Rule {
  // Named in the failure message, so make it read as the thing being banned.
  token: string
  test: (text: string) => boolean
  why: string
  // Files allowed to match. Every entry must still exist AND still match, or the
  // list is stale (asserted below) -- an exemption that stopped being needed is
  // a hole waiting for the next leak to fall into.
  exempt?: string[]
}

// A server URL path. `/api/` is the one the deleted Flask app served under, and
// the one every historical leak used; a new server would almost certainly be
// reached the same way.
const API_LITERAL = /['"`]\/api\//

// Network calls out of the app. Every way the platform offers is named here,
// adapters included, so "put it behind a port" is not an escape hatch: there is
// nowhere for the port's implementation to call either.
const NETWORK_CALL = /\b(?:fetch\s*\(|new\s+XMLHttpRequest\b|new\s+WebSocket\b|new\s+EventSource\b)/

// Auth coupling. There is no session, no user and no permission model; a
// document belongs to the browser it is stored in. These identifiers reappearing
// means someone is modelling an owner again, which only makes sense with a
// server to be owned on.
const AUTH_COUPLING = /\b(?:useAuth|AuthContext|AuthProvider|is_admin|must_change_password)\b/

const RULES: Rule[] = [
  {
    token: '/api/ literal',
    test: text => API_LITERAL.test(text),
    why: 'there is no server to route a path at',
  },
  {
    token: 'network call',
    test: text => NETWORK_CALL.test(text),
    why: 'the app runs entirely in the browser tab: storage is IndexedDB, compute is WASM',
    // The OCC.js loaders, which pull the WASM kernel's own JS shim out of
    // /occ/ -- a static asset shipped inside the bundle, on the app's own
    // origin, not a service. They fetch it rather than importing it because the
    // artifact has to be rewritten into a blob URL before it will run. Nothing
    // is listening at the other end of these; a plain file server answers them.
    // The notices reader, which pulls the third-party license texts out of
    // /third_party/ -- static files copied into the bundle from public/, on the
    // app's own origin. They are read rather than imported so several hundred
    // kilobytes of license text stays out of the JS every visitor downloads,
    // and so the rendered page and the deployed files cannot diverge. A plain
    // file server answers this one too.
    exempt: [
      'kernel/occ/loadOccWeb.ts',
      'kernel/occ/loadOccWorker.ts',
      'pages/hooks/useNotices.ts',
    ],
  },
  {
    token: 'auth coupling',
    test: text => AUTH_COUPLING.test(text),
    why: 'documents belong to the browser storing them; there is no user to authenticate',
  },
]

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name)
      if (statSync(full).isDirectory()) {
        if (name === '__tests__') continue
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(name)) continue
      if (/\.test\.(ts|tsx)$/.test(name)) continue
      if (name.endsWith('.d.ts')) continue
      out.push(full)
    }
  }
  walk(SRC_DIR)
  return out
}

function relPath(full: string): string {
  return relative(SRC_DIR, full).split(sep).join('/')
}

// The rules describe what the app DOES, so prose about what it no longer does
// must not trip them: several files legitimately explain a `fetch()` they do not
// make, or a `/api/` route that is gone. Comments are stripped before matching.
// The two carve-outs keep a `//` that is not a comment (inside a string literal,
// or the scheme separator in a URL) from truncating a real line of code.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => {
      const i = line.indexOf('//')
      if (i < 0) return line
      const before = line.slice(0, i)
      if (before.endsWith(':')) return line  // https:// and friends
      const quotes = (before.match(/(?<!\\)['"`]/g) ?? []).length
      if (quotes % 2 === 1) return line  // inside a string literal
      return before
    })
    .join('\n')
}

function offenders(rule: Rule): string[] {
  const exempt = new Set(rule.exempt ?? [])
  return sourceFiles()
    .map(relPath)
    .filter(rel => !exempt.has(rel))
    .filter(rel => rule.test(stripComments(readFileSync(resolve(SRC_DIR, rel), 'utf8'))))
    .sort()
}

describe('no backend', () => {
  it.each(RULES)('src/ contains no $token', (rule) => {
    expect(
      offenders(rule),
      `The app is browser-only -- ${rule.why}. Found ${rule.token} in:\n` +
        offenders(rule).join('\n') +
        `\n\nIf this is genuinely a same-origin static asset of the app itself, ` +
        `add it to that rule's \`exempt\` list with a comment saying why. ` +
        `Anything else means a server is being reintroduced.`,
    ).toEqual([])
  })

  // Exemptions rot: a file that was deleted, or that stopped making the call
  // that justified its exemption, leaves an entry that silently covers the NEXT
  // leak in that path. Every entry must still exist and still match its rule.
  it.each(RULES.filter(r => r.exempt?.length))('every $token exemption is still needed', (rule) => {
    const stale = (rule.exempt ?? []).filter(rel => {
      let text: string
      try {
        text = readFileSync(resolve(SRC_DIR, rel), 'utf8')
      } catch {
        return true  // file gone
      }
      return !rule.test(stripComments(text))
    })
    expect(
      stale,
      `These files no longer need their "${rule.token}" exemption (deleted, or ` +
        `no longer matching). Remove them from the rule's \`exempt\` list:\n` +
        stale.join('\n'),
    ).toEqual([])
  })

  // The seam itself: with the server gone, storage is the only thing an adapter
  // stands in front of, and `documents` is the slot a future store would be
  // wired into. A view that reaches past it to a concrete store class would put
  // the app back to being welded to one persistence layer.
  it('no view constructs a document store directly', () => {
    const offenders = sourceFiles()
      .map(relPath)
      .filter(rel => !rel.startsWith('stores/') && !rel.startsWith('adapters/'))
      .filter(rel => /new\s+IndexedDb(DocumentStore|TrashAdapter)\b/.test(
        stripComments(readFileSync(resolve(SRC_DIR, rel), 'utf8'))))
      .sort()
    expect(
      offenders,
      `Read the store off backendBundle instead of naming an implementation. ` +
        `The composition root (adapters/backend.ts) is the one place that picks ` +
        `which DocumentStore the app runs on:\n` + offenders.join('\n'),
    ).toEqual([])
  })
})
