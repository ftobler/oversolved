import { useEffect, useState } from 'react'
import { getPreviewStore } from './index'
import { previewKey } from './types'
import { previewRevision, subscribePreview } from './events'

// The tile's async view of a preview. `undefined` covers both "no preview yet"
// and "not resolved yet": a thumbnail is cosmetic, so a missing value paints the
// tile's fallback and a late arrival re-renders through the revision counter.
export function usePreview(workspace: string, entry: string): string | undefined {
  const key = previewKey(workspace, entry)
  const [state, setState] = useState<{ key: string; image: string | undefined }>({ key, image: undefined })
  const [revision, setRevision] = useState(previewRevision())

  useEffect(() => subscribePreview(() => setRevision(r => r + 1)), [])

  useEffect(() => {
    let cancelled = false
    getPreviewStore().get(workspace, entry).then(image => {
      if (!cancelled) setState({ key, image })
    }).catch(() => {
      if (!cancelled) setState({ key, image: undefined })
    })
    return () => { cancelled = true }
  }, [workspace, entry, key, revision])

  return state.key === key ? state.image : undefined
}
