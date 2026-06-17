// A TypeScript port of Werkzeug's `secure_filename`, used so the frontend
// bundle writes the exact same entry paths the server's `/api/admin/backup`
// produces (`<user>/<name>.yaml`). One format, two producers: the zip a static
// build exports must be ingestible by `/api/admin/import-backup`, and vice
// versa. Keep this in sync with werkzeug.utils.secure_filename.

const STRIP_RE = /[^A-Za-z0-9_.-]/g

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
  return name
}
