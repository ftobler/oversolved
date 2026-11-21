import { FeatureTree } from '@/components/layout/FeatureTree'
import { PartsList } from '@/components/layout/PartsList'
import '@/components/layout/Glass.css'
import '@/pages/Part.css'

// The part editor's navigator as two floating cards: Features on top, Parts
// below. Part.css gives Features everything the Parts card does not take and
// lets Parts hug its list up to a share, so a part with one body leaves the
// height to the feature list instead of holding an empty card. The drag
// splitter is gone; the shared flex rules size the two cards now.
export function PartDocumentPanel() {
  return (
    <div className="document-panel">
      <FeatureTree />
      <PartsList />
    </div>
  )
}
