import { useEffect, useState } from 'react'

// Reads the third-party notices that ship in public/third_party.
//
// They are fetched rather than imported so the license texts stay out of the JS
// bundle: several hundred kilobytes of legal text in front of every visitor,
// for a page most of them never open. Fetching also means the rendered page and
// the deployed files are the same bytes, so there is no second copy to forget.

// Everything published under the notices root. Relative links inside the
// markdown resolve against it, so the documents keep working as plain files in
// the repository and as a rendered page in the app.
export const NOTICES_ROOT = `${import.meta.env.BASE_URL}third_party/`

export type NoticesState =
  | { status: 'loading' }
  | { status: 'ready', markdown: string }
  | { status: 'failed', reason: string }

const LOADING: NoticesState = { status: 'loading' }

export function useNotices(file: string): NoticesState {
  // Keyed by the file it belongs to, so switching documents reads as loading
  // during render instead of needing an effect to reset the state. That keeps
  // the effect free of synchronous setState and, more usefully, stops the
  // previous document flashing under the new one's heading.
  const [loaded, setLoaded] = useState<{ file: string, state: NoticesState } | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch(`${NOTICES_ROOT}${file}`)
      .then(response => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
        return response.text()
      })
      .then(markdown => {
        if (!cancelled) setLoaded({ file, state: { status: 'ready', markdown } })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const reason = error instanceof Error ? error.message : 'unknown'
        setLoaded({ file, state: { status: 'failed', reason } })
      })

    return () => { cancelled = true }
  }, [file])

  return loaded?.file === file ? loaded.state : LOADING
}

export interface NoticeSection {
  id: string
  label: string
}

// The anchor a section heading answers to. Nav entry and heading derive their id
// from the same function, so the two cannot drift; the documents use distinct
// headings, which is what keeps the ids unique without a counter threaded
// through the renderer.
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// The document's own second-level headings, in the order it states them. Read
// from the markdown rather than hand-listed the way the registry's sidebar is:
// these documents are fetched at runtime and edited as prose, so a fixed list
// here would be one more place to forget.
export function noticeSections(markdown: string): NoticeSection[] {
  // Fenced code can contain a line starting with ##, which is not a heading.
  const body = markdown.replace(/^```[\s\S]*?^```/gm, '')
  return [...body.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)]
    .map(match => match[1].trim())
    .map(label => ({ id: headingSlug(label), label }))
}

// A link in the notices is relative to the notices folder, not to the route the
// page happens to sit on. Anything relative is resolved against the folder and
// opened as a published file; absolute URLs and anchors are left alone.
export function resolveNoticeHref(href: string | undefined, file: string) {
  if (!href) return undefined
  if (/^[a-z]+:/i.test(href) || href.startsWith('#')) return href
  const base = new URL(`${NOTICES_ROOT}${file}`, window.location.origin)
  return new URL(href, base).pathname
}
