import { AssemblyTree, type AssemblyTreeProps } from '@/components/layout/AssemblyTree'
import '@/components/layout/Glass.css'
import '@/pages/Part.css'

/**
 * The assembly editor's navigator as two floating cards, the part editor's
 * PartDocumentPanel in assembly terms: the Parts card over the Mates card. Both
 * cards get the panel's split from Part.css, a reserved share for Mates and the
 * rest for Parts, and each list scrolls inside its card. One AssemblyTree
 * instance draws both cards, because the drag reorder and the cross-highlight
 * are one piece of state shared by the two lists.
 */
export function AssemblyDocumentPanel(props: AssemblyTreeProps) {
  return (
    <div className="document-panel">
      <AssemblyTree {...props} />
    </div>
  )
}
