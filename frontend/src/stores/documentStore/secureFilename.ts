// A TypeScript port of Werkzeug's `secure_filename`, used to name the entries
// inside an exported bundle (`<user>/<name>.yaml`). A document name is arbitrary
// user text and a zip entry path is not: it must not contain separators, must
// survive extraction on Windows, and must round-trip back through import.
// Werkzeug's rules are the well-tested answer to exactly that, so this mirrors
// them rather than inventing a sanitizer -- and it keeps bundles written by
// older versions of the app importable. Keep this in sync with
// werkzeug.utils.secure_filename.
//
// Mirrored in full except for one platform gate: werkzeug prepends the
// Windows reserved-device-name underscore only when it runs on Windows
// (`os.name == "nt"`), while this port applies the rule unconditionally so
// entry paths are safe to extract wherever the bundle lands. The reachable device set
// after ASCII filtering is CON, PRN, AUX, NUL, COM1-9, LPT1-9 (werkzeug's
// superscript variants normalize into COM/LPT1-3, and '$' is stripped before
// the check, so CONIN$/CONOUT$ can never match there either).

// secureFilename strips every non-ASCII code point, so a Cyrillic or CJK
// document name sanitizes to '' and would become a nameless file. Every caller
// needs the same fallback, and they must agree: a bundle written by one and a
// folder written by the other have to name the document identically.
export const UNTITLED_DOC_NAME = 'Untitled'

const STRIP_RE = /[^A-Za-z0-9_.-]/g

const WINDOWS_DEVICE_FILES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
])

export function secureFilename(filename: string): string {
  // NFKD normalize then drop non-ASCII (werkzeug encodes ascii, ignore).
  // Filter by code point rather than a regex range so no control character is
  // embedded in a pattern (eslint no-control-regex).
  let name = [...filename.normalize('NFKD')].filter(ch => ch.charCodeAt(0) < 128).join('')
  // Replace path separators with spaces.
  name = name.replace(/[/\\]/g, ' ')
  // Collapse whitespace runs, join tokens with '_', strip disallowed chars,
  // then trim leading/trailing dots and underscores.
  name = name.split(/\s+/).filter(Boolean).join('_')
  name = name.replace(STRIP_RE, '')
  name = name.replace(/^[._]+/, '').replace(/[._]+$/, '')
  // Windows treats device names as files in every directory, so an entry like
  // 'nul.yaml' would silently redirect to the NUL device on extraction. Match
  // werkzeug's check position: stem before the first dot of the final,
  // sanitized name.
  if (name && WINDOWS_DEVICE_FILES.has(name.split('.')[0].toUpperCase())) {
    return `_${name}`
  }
  return name
}

// The stem a name lands on when another document already owns it. There are two
// callers with the same problem in different containers -- a folder on disk and
// a zip entry path, which are one canonical layout -- and they have to agree,
// because a document exported from a folder and imported back has to keep its
// name. They did not: one appended the suffix and the other inserted it before
// the last dot, so a document called "Bracket.v2" was suffixed differently on
// each side of the round trip.
//
// The suffix goes BEFORE the last dot, which is where werkzeug and the backend
// this format came from put it: a name with a dot in it reads as having an
// extension whether or not it is one, and `Bracket_1.v2` keeps that tail intact
// where `Bracket.v2_1` buries it.
//
// `isTaken` rather than a Set so a caller keying on more than the stem (bundle
// scopes its reservations per owner directory) can answer for itself. The
// candidate is offered including its suffix, so a generated `Bracket_1` cannot
// land on a document really called that.
export function uniqueStem(base: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(base)) return base
  const dot = base.lastIndexOf('.')
  for (let n = 1; ; n++) {
    const candidate = dot > 0
      ? `${base.slice(0, dot)}_${n}.${base.slice(dot + 1)}`
      : `${base}_${n}`
    if (!isTaken(candidate)) return candidate
  }
}
