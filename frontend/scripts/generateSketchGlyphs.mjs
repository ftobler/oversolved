// Writes the glyph outline table `add_text` expands a string from, so sketch
// lettering needs no font parser and no font fetch at runtime.
//
// The source is the WOFF the viewport labels already self-host, read through
// the Typr and woff2otf builds troika-three-text already installs: no new
// dependency, so the third-party notice bundles do not change. Typr's
// glyphToPath resolves the two TrueType outline rules a hand-written walk gets
// wrong (an implied on-curve midpoint between two off-curve points, and a
// contour that starts off-curve); this script then degree-elevates every
// quadratic to the exact cubic, so the runtime emits only lines and cubic
// splines and never re-parses an outline.
//
// The asset is checked in, and `--check` fails when it differs from a fresh
// generation, so it cannot drift the way a "run it manually" asset does.
//
// Usage (from frontend/):
//   node scripts/generateSketchGlyphs.mjs            # write the asset
//   node scripts/generateSketchGlyphs.mjs --check    # fail if stale

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import typrFactory from 'troika-three-text/libs/typr.factory.js'
import woff2otfFactory from 'troika-three-text/libs/woff2otf.factory.js'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(scriptDir, '..')
const fontPath = path.join(frontendDir, 'public', 'fonts', 'roboto-latin-400-normal.woff')
const outputPath = path.join(frontendDir, 'src', 'assets', 'fonts', 'roboto-400-glyphs.json')

// Printable ASCII, the whole v1 character set.
const FIRST_CODE = 32
const LAST_CODE = 126

// Degree elevation turns integer font units into thirds; four decimals keep
// the asset small while staying far below the 1e-6 document rounding once the
// glyph is scaled to any practical text size.
const DECIMALS = 4

function fixed(v) {
  const r = Number(v.toFixed(DECIMALS))
  return Object.is(r, -0) ? 0 : r
}

function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1]
}

// One glyph's Typr path as closed contours of line ([x, y]) and cubic
// ([c1x, c1y, c2x, c2y, x, y]) segments, each contour starting at `start`.
function contoursOf(path) {
  const contours = []
  let current = null
  let pen = null
  let k = 0
  const take = () => {
    const p = [fixed(path.crds[k]), fixed(path.crds[k + 1])]
    k += 2
    return p
  }
  const close = () => {
    if (current === null) return
    // Typr leaves the closing edge implicit when the last point is not the start.
    if (!samePoint(pen, current.start)) current.segments.push([...current.start])
    if (current.segments.length > 0) contours.push(current)
    current = null
  }
  for (const cmd of path.cmds) {
    if (cmd === 'M') {
      close()
      pen = take()
      current = { start: pen, segments: [] }
    } else if (cmd === 'L') {
      const to = take()
      if (!samePoint(to, pen)) current.segments.push(to)
      pen = to
    } else if (cmd === 'Q') {
      const q = take()
      const to = take()
      // The exact cubic of a quadratic: each control sits 2/3 of the way from
      // its end point to the quadratic control.
      const c1 = [fixed(pen[0] + (2 / 3) * (q[0] - pen[0])), fixed(pen[1] + (2 / 3) * (q[1] - pen[1]))]
      const c2 = [fixed(to[0] + (2 / 3) * (q[0] - to[0])), fixed(to[1] + (2 / 3) * (q[1] - to[1]))]
      if (!samePoint(to, pen)) current.segments.push([...c1, ...c2, ...to])
      pen = to
    } else if (cmd === 'C') {
      const c1 = take()
      const c2 = take()
      const to = take()
      if (!samePoint(to, pen)) current.segments.push([...c1, ...c2, ...to])
      pen = to
    } else if (cmd === 'Z') {
      close()
    } else {
      throw new Error(`unexpected path command ${cmd}`)
    }
  }
  close()
  return contours
}

function generate() {
  // The factory is built for a worker and assigns `self.window`; Node has
  // neither, and globalThis is the object both names alias there.
  globalThis.self ??= globalThis
  const Typr = typrFactory()
  const woff2otf = woff2otfFactory()
  const woff = readFileSync(fontPath)
  // A Buffer may be a view into a larger or pooled ArrayBuffer (newer Node
  // readFileSync does this), and woff2otf reads its DataView from offset 0 of
  // whatever it is given, so hand it a copy of exactly the file's bytes.
  const otf = woff2otf(woff.buffer.slice(woff.byteOffset, woff.byteOffset + woff.byteLength))
  // Typr reports the GSUB lookups it skips on console.debug; shaping is out of
  // scope here, so the notice is noise in a gate log.
  const debug = console.debug
  console.debug = () => {}
  const font = Typr.parse(otf)[0]
  console.debug = debug
  const glyphs = {}
  for (let code = FIRST_CODE; code <= LAST_CODE; code++) {
    const gid = Typr.U.codeToGlyph(font, code)
    if (gid === 0) throw new Error(`the font has no glyph for code point ${code}`)
    glyphs[code] = {
      advance: font.hmtx.aWidth[gid],
      contours: contoursOf(Typr.U.glyphToPath(font, gid)),
    }
  }
  return {
    source: 'frontend/public/fonts/roboto-latin-400-normal.woff',
    version: font.name.version ?? null,
    unitsPerEm: font.head.unitsPerEm,
    ascender: font.hhea.ascender,
    descender: font.hhea.descender,
    glyphs,
  }
}

// One glyph per line, so a regeneration diff names the glyphs that changed.
function serialize(table) {
  const { glyphs, ...header } = table
  const lines = Object.entries(header).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
  const glyphLines = Object.entries(glyphs).map(([code, glyph]) => `    ${JSON.stringify(code)}: ${JSON.stringify(glyph)}`)
  return `{\n${lines.join('\n')}\n  "glyphs": {\n${glyphLines.join(',\n')}\n  }\n}\n`
}

const fresh = serialize(generate())
if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(outputPath, 'utf8')
  } catch {
    // A missing asset is stale by definition.
  }
  if (current !== fresh) {
    console.error(`${path.relative(frontendDir, outputPath)} is stale; run node scripts/generateSketchGlyphs.mjs`)
    process.exit(1)
  }
  console.log('sketch glyph asset is current')
} else {
  writeFileSync(outputPath, fresh)
  console.log(`wrote ${path.relative(frontendDir, outputPath)}`)
}
