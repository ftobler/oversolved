import { FeatureTree } from '@/components/layout/FeatureTree'
import { PartsList } from '@/components/layout/PartsList'
import '@/components/layout/Glass.css'
import '@/pages/Part.css'

// The part editor's navigator as two floating cards: Features on top, Parts
// below. Part.css reserves a share for the Parts card and gives Features the
// rest, so the card stays readable with no parts at all and the lists scroll
// inside their cards. The drag splitter is gone; the shared flex rules size the
// two cards now.
export function PartDocumentPanel() {
  return (
    <div className="document-panel">
      <FeatureTree />
      <PartsList />
    </div>
  )
}
