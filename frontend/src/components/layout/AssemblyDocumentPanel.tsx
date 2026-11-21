import { AssemblyTree, type AssemblyTreeProps } from '@/components/layout/AssemblyTree'
import '@/components/layout/Glass.css'
import '@/pages/Part.css'

/**
 * The assembly editor's navigator as two floating cards, the part editor's
 * PartDocumentPanel in assembly terms: the Parts card over the Mates card. The
 * Parts card takes the height the Mates card does not need, and Mates hugs its
 * list up to a share, so a short mate list leaves the room to the part rows
 * that scroll. One AssemblyTree instance draws both cards, because the drag
 * reorder and the cross-highlight are one piece of state shared by the two
 * lists.
 */
export function AssemblyDocumentPanel(props: AssemblyTreeProps) {
  return (
    <div className="document-panel">
      <AssemblyTree {...props} />
    </div>
  )
}
