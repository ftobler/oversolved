/**
 * Capability-bundle guardrail (static-build-notes.md, cross-cutting section
 * "backend as an injected capability bundle").
 *
 * The rule: view/page/hook/context code must NOT read `hasBackend` or hardcode
 * a raw `/api/...` literal. Those belong behind the document store / capability
 * adapters, wired once at the composition root. Each leak is a fork that lives
 * forever, so we gate against NEW ones before chipping at the existing pile.
 *
 * This is a ratchet, not a clean sweep: the ~30 `hasBackend` + ~49 `/api`
 * references that exist today are listed in the baselines below so the suite is
 * green now. When you migrate a file behind a capability, REMOVE it from the
 * baseline -- the test fails if a baselined file no longer leaks (stale entry)
 * just as it fails if a non-baselined file starts to. The baseline can only
 * shrink. Adding a new file to a baseline is forbidden; migrate instead.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative, sep } from 'node:path'

// src/ root, derived from this file's location (src/config/<this>).
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The legitimate homes for backend coupling: the store/adapter seam, the single
// source of the capability flag, and the composition root. References here are
// expected and never flagged.
const ALLOWED_HOME_PREFIXES = [
  'stores/',
  'adapters/',
  'config/capabilities.ts',
  'main.tsx',
]

// Sanctioned cloud-only seams: views/contexts that exist ONLY when there is a
// server and never mount on the static build (the auth gatekeeping flow + the
// admin / account / login pages, all self-guarded behind `user?.`). Their
// backend coupling is structural, not migration debt -- there is no static
// behaviour to fold them into, so they are deliberately exempt rather than
// baselined (decided 2026-06-19, static-build-notes "Auth as a capability": auth
// is a FLOW, not a port; admin/account pages ride the same reasoning). Unlike
// the shrink-only baselines below, this list is permanent by design. Keep it
// tight: a view that ALSO ships on static (Part, Documents) is debt, not a seam.
const SANCTIONED_SEAMS = [
  'App.tsx',                       // route wall / redirects (auth gatekeeping)
  'components/layout/AppHeader.tsx',  // sign-in affordance vs username + logout
  'contexts/AuthContext.tsx',      // the auth flow itself + /api/auth
  'pages/AdminPeriodicTasks.tsx',
  'pages/AdminUsers.tsx',
  'pages/Backup.tsx',
  'pages/Login.tsx',
  'pages/UserProfile.tsx',
]

// Existing `hasBackend` leaks awaiting migration behind the capability bundle.
// Remove an entry when its file stops reading the flag.
const HAS_BACKEND_BASELINE = [
  'pages/Part.tsx',
]

// Existing raw `/api/...` literals awaiting migration behind an adapter.
// Remove an entry when its file stops reaching the API path directly.
const API_LITERAL_BASELINE = [
  'kernel/solveLocally.ts',  // comment reference to the retired /api/export path
  'pages/Documents.tsx',
  'pages/Part.tsx',
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

function isAllowedHome(rel: string): boolean {
  return ALLOWED_HOME_PREFIXES.some(p => rel === p || rel.startsWith(p))
}

const SANCTIONED_SET = new Set(SANCTIONED_SEAMS)

function isExempt(rel: string): boolean {
  return isAllowedHome(rel) || SANCTIONED_SET.has(rel)
}

function offenders(test: (text: string) => boolean): string[] {
  return sourceFiles()
    .map(relPath)
    .filter(rel => !isExempt(rel))
    .filter(rel => test(readFileSync(resolve(SRC_DIR, rel), 'utf8')))
    .sort()
}

function assertRatchet(found: string[], baseline: string[], token: string) {
  const baseSet = new Set(baseline)
  const newLeaks = found.filter(f => !baseSet.has(f))
  expect(
    newLeaks,
    `New ${token} leak(s) outside the allowed homes (stores/, adapters/, ` +
      `config/capabilities.ts, composition root). Route through the document ` +
      `store / a capability adapter instead of reading ${token} in a view:\n` +
      newLeaks.join('\n'),
  ).toEqual([])

  const foundSet = new Set(found)
  const stale = baseline.filter(b => !foundSet.has(b))
  expect(
    stale,
    `Baselined file(s) no longer contain ${token} -- nice, the migration ` +
      `tightened the ratchet. Remove these stale entries from the baseline ` +
      `in capabilityGuardrail.test.ts:\n` + stale.join('\n'),
  ).toEqual([])
}

describe('capability-bundle guardrail', () => {
  it('no NEW hasBackend reference outside the allowed homes', () => {
    const found = offenders(text => /\bhasBackend\b/.test(text))
    assertRatchet(found, HAS_BACKEND_BASELINE, 'hasBackend')
  })

  it('no NEW raw /api/ literal outside the allowed homes', () => {
    const found = offenders(text => text.includes('/api/'))
    assertRatchet(found, API_LITERAL_BASELINE, '/api/')
  })

  // Sanctioned seams are permanent by design, but the list must not rot: every
  // entry must still exist AND still carry the backend coupling that justifies
  // its exemption. A seam that lost its coupling (or was deleted) should drop off
  // the list, not sit there hiding a future leak in that file.
  it('every sanctioned seam still exists and still carries backend coupling', () => {
    const stale = SANCTIONED_SEAMS.filter(rel => {
      let text: string
      try {
        text = readFileSync(resolve(SRC_DIR, rel), 'utf8')
      } catch {
        return true  // file gone
      }
      return !/\bhasBackend\b/.test(text) && !text.includes('/api/')
    })
    expect(
      stale,
      `Sanctioned seam(s) no longer exist or no longer touch the backend. ` +
        `Remove them from SANCTIONED_SEAMS in capabilityGuardrail.test.ts:\n` +
        stale.join('\n'),
    ).toEqual([])
  })
})
