import { FeatureTree } from '@/components/layout/FeatureTree'
import { BodyPartsList } from '@/components/layout/BodyPartsList'
import '@/components/layout/Glass.css'

// The part editor's navigator as two floating cards: Features on top, Parts
// below, each sized to its content under a max-height and scrolling internally
// (Part.css scopes those rules to .document-panel), so a short feature list
// leaves the model visible through the gap and below the cards. The drag
// splitter is gone for the part editor: the panels no longer share one column's
// height. The assembly tree keeps its own splitter until phase 2.
export function PartDocumentPanel() {
  return (
    <div className="document-panel">
      <FeatureTree />
      <BodyPartsList />
    </div>
  )
}
