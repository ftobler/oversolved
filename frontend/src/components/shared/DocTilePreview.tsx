import type { DocumentStore } from '@/stores/documentStore'

// Tile thumbnail: prefer the inline base64 preview (local store), else the
// store's own thumbnail URL (the cloud store's /api path), else a placeholder.
// The view asks the store for the URL instead of hardcoding /api -- the one spot
// that used to reach past the adapter. Shared between the documents grid and
// the insert-part browser so both render the same tile.
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
