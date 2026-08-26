// A TypeScript port of Werkzeug's `secure_filename`, used so the frontend
// bundle writes the exact same entry paths the server's `/api/admin/backup`
// produces (`<user>/<name>.yaml`). One format, two producers: the zip a static
// build exports must be ingestible by `/api/admin/import-backup`, and vice
// versa. Keep this in sync with werkzeug.utils.secure_filename.
//
// Mirrored in full except for one platform gate: werkzeug prepends the
// Windows reserved-device-name underscore only when it runs on Windows
// (`os.name == "nt"`), while this port applies the rule unconditionally so
// entry paths match backups from any deployment OS. The reachable device set
// after ASCII filtering is CON, PRN, AUX, NUL, COM1-9, LPT1-9 (werkzeug's
// superscript variants normalize into COM/LPT1-3, and '$' is stripped before
// the check, so CONIN$/CONOUT$ can never match there either).

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
