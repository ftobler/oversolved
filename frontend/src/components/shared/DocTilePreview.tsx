import type { DocumentStore } from '@/stores/documentStore'

// Tile thumbnail: prefer the inline base64 preview the summary carries, else a
// URL the store hands out for it, else a placeholder. The URL branch is dead
// against today's store (thumbnailUrl returns null) and is kept because it is
// the whole reason the view asks the STORE for a thumbnail instead of building
// a path itself -- a store that serves thumbnails as separate resources drops in
// without touching this file. Shared between the documents grid and the
// insert-part browser so both render the same tile.
export default function DocTilePreview(
  { doc, store }: { doc: { uuid: string; name: string; preview_image?: string }; store: Pick<DocumentStore, 'thumbnailUrl'> },
) {
  if (doc.preview_image) {
    return <img src={`data:image/png;base64,${doc.preview_image}`} alt={doc.name} />
  }
  const url = store.thumbnailUrl(doc.uuid)
  if (!url) return <div className="doc-tile-placeholder" />
  return (
    <>
      <img
        src={url}
        alt={doc.name}
        onError={(e) => {
          const target = e.target as HTMLImageElement
          target.style.display = 'none'
          const next = target.nextElementSibling as HTMLElement
          if (next) next.style.display = 'block'
        }}
      />
      <div className="doc-tile-placeholder" style={{ display: 'none' }} />
    </>
  )
}
