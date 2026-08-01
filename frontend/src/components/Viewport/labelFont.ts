import { preload } from 'suspend-react'
import { configureTextBuilder, preloadFont } from 'troika-three-text'

// The one font every 3D text label in the viewport renders with.
//
// This module exists to keep a single value in a single place. drei's <Text>
// gates its first paint on `suspend(..., ['troika-text', font, characters])`
// (@react-three/drei/core/Text.js), and suspend-react compares keys by `===`
// per slot. Two <Text> sites that pass different `font` values therefore land
// in different cache entries: the warm-up below fills one, the other stays cold
// and suspends on its first mount. Since R3F wraps all Canvas children in ONE
// Suspense boundary, a cold suspend blanks the entire viewport mid-gesture.
// Every <Text> in the viewport must import LABEL_FONT from here, and a test
// asserts that they do.
//
// Self-hosted. Must stay a WOFF1/glyf file: troika parses fonts with Typr and
// does not support .woff2.
export const LABEL_FONT: string = '/fonts/roboto-latin-400-normal.woff'

// Deliberately undefined, and not merely unset-by-omission.
//
// Passing a `characters` allowlist to <Text> would let troika build a smaller
// SDF atlas, but it would also silently drop every glyph outside the list.
// Plane labels carry arbitrary user text (user-defined plane names, the sketch
// label in Viewport/index.tsx) so no finite allowlist is correct. It is also
// half of the suspend key above, so it has to match at every <Text> site.
export const LABEL_CHARACTERS: string | undefined = undefined

// The exact key drei computes for a <Text font={LABEL_FONT}> with no
// `characters` prop. Derived rather than written out so it cannot drift.
export const LABEL_FONT_KEY = ['troika-text', LABEL_FONT, LABEL_CHARACTERS]

// What the warm-up actually typesets, which is NOT the same thing as the
// `characters` prop above and must not be confused with it.
//
// `characters` is part of the cache key; this string is only the sample text
// handed to troika so it has real glyphs to rasterize while the font loads.
// troika does `text = '' + characters` in TextBuilder.js, so passing undefined
// here would warm the font on the literal 9-character string "undefined" -- it
// happens to work, because the font file is what is being fetched, but it warms
// the wrong glyphs. These are the ones the viewport actually draws first: the
// builtin plane names, and the digits/sign/decimal/degree of the AngleDial
// readout.
const WARMUP_TEXT = 'TopFrontRight0123456789.-°'

// Sets troika's own default font, not just each <Text> prop: a future <Text>
// added without a font prop would otherwise fall back to troika's unicode
// resolver (TextBuilder.js: `if (defaultFontURL) fonts.push(...)`, else the
// resolver runs).
//
// Module scope on purpose: configureTextBuilder is ignored once the first font
// has been requested, and every <Text> in the app sits downstream of an import
// of this module, so this runs first by construction.
configureTextBuilder({ defaultFontURL: LABEL_FONT })

/**
 * Fills drei's font cache ahead of the first label mount, so the font is
 * fetched at app startup instead of on the user's gesture (unhiding a plane,
 * starting a rotation drag). Idempotent: suspend-react returns the existing
 * entry rather than refetching.
 *
 * It must go through suspend-react's `preload`, NOT `preloadFont` on its own.
 * Calling preloadFont directly warms troika's own internal font cache, which
 * looks like it should be enough and is not: drei gates on its suspend-react
 * entry, so with that entry still empty <Text> throws a promise on first mount
 * anyway and the viewport still flashes -- just for a shorter time, which makes
 * the bug look fixed while leaving it in. `preload` registers the entry under
 * the same key without throwing, which is the part that actually matters.
 *
 * Note the asymmetry between the two arguments: `characters` is WARMUP_TEXT
 * (glyphs to rasterize) while the key uses LABEL_CHARACTERS (undefined). That
 * is intentional. The key has to match what <Text> looks up; the warm-up text
 * only has to be representative.
 */
export function preloadViewportLabelFont(): void {
  preload(
    () => new Promise<void>(resolve => {
      preloadFont({ font: LABEL_FONT, characters: WARMUP_TEXT }, () => resolve())
    }),
    LABEL_FONT_KEY,
  )
}
