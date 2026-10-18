import { FeatureTree } from '@/components/layout/FeatureTree'
import { BodyPartsList } from '@/components/layout/BodyPartsList'
import '@/components/layout/Glass.css'
import '@/pages/Part.css'

// The part editor's navigator as two floating cards: Features on top, Parts
// below, each with its height reserved up front and its list scrolling
// internally when it outgrows that (Part.css scopes those rules to
// .document-panel), so the cards hold their size whatever the lists do. The
// drag splitter is gone for the part editor: the panels no longer share one
// column's height. The assembly tree keeps its own splitter until phase 2.
export function PartDocumentPanel() {
  return (
    <div className="document-panel">
      <FeatureTree />
      <BodyPartsList />
    </div>
  )
}
