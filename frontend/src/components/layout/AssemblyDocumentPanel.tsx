import { AssemblyTree, type AssemblyTreeProps } from '@/components/layout/AssemblyTree'
import '@/components/layout/Glass.css'
import '@/pages/Part.css'

/**
 * The assembly editor's navigator as two floating cards, the part editor's
 * PartDocumentPanel in assembly terms: the Parts card over the Mates card,
 * each reserving its share of the column and scrolling its list internally,
 * so the pair holds its size whatever the lists do. One AssemblyTree instance
 * draws both cards, because the drag reorder and the cross-highlight are one
 * piece of state shared by the two lists.
 */
export function AssemblyDocumentPanel(props: AssemblyTreeProps) {
  return (
    <div className="document-panel">
      <AssemblyTree {...props} />
    </div>
  )
}
