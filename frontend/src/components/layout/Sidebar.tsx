import type { ReactNode } from 'react'
import { PartDocumentPanel } from '@/components/layout/PartDocumentPanel'
import '@/pages/Part.css'

interface SidebarProps {
  // undefined keeps the part stack, which is what the layout tests render; the
  // part editor itself no longer mounts this host (its panels float over the
  // viewport, pages/PartEditorPanel.tsx), so the only production caller is the
  // assembly editor with its own navigator node.
  documentPanel?: ReactNode
}

// The editor's navigator host, and nothing else. The workspace layer used to
// live here behind an activity bar, one 288px rail switching Workspace /
// Document / Origins; it now has a surface of its own at
// `/workspaces/:workspace`, which has room for a thumbnail per entry. With one
// panel left there was nothing to switch, so the rail went with it and this is
// a plain host again: the aside is the flex column and the navigator is its
// only child, flexing to fill it. The part editor's navigator is the floating
// Features/Parts stack (PartDocumentPanel.tsx); the assembly still hands its
// splitter-bearing AssemblyTree in through `documentPanel` until phase 2 moves
// that editor to the same floating panels.
export function Sidebar({ documentPanel }: SidebarProps) {
  return (
    <aside className="doc-sidebar">
      {documentPanel === undefined ? <PartDocumentPanel /> : documentPanel}
    </aside>
  )
}
