import { usePreview } from '@/stores/previewStore'

// Tile thumbnail. Previews are derived data, so they live in the preview store
// keyed by (workspace, entry) rather than on the document record (A9, I5). In
// C2 every document is a one-document workspace, so both key parts are the
// document's uuid. A missing preview is cosmetic: the tile paints a placeholder
// until one exists. Shared between the documents grid, the trash grid and the
// insert-part browser so all three render the same tile.
export default function DocTilePreview(
  { workspace, entry, name }: { workspace: string; entry: string; name: string },
) {
  const image = usePreview(workspace, entry)
  if (!image) return <div className="doc-tile-placeholder" />
  return <img src={`data:image/png;base64,${image}`} alt={name} />
}
