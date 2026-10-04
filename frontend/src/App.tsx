import { Routes, Route, Navigate } from 'react-router-dom'
import DisclaimerDialog from '@/components/dialogs/DisclaimerDialog'
import Workspaces from '@/pages/Workspaces'
import WorkspacePage from '@/pages/WorkspacePage'
import Docs from '@/pages/Docs'
import Registry from '@/pages/Registry'
import Licenses from '@/pages/Licenses'
import '@/components/shared/buttons.css'

function App() {
  return (
    <>
      {/* Route-independent: the welcome/disclaimer popup must greet a visitor
          no matter which page they land on. */}
      <DisclaimerDialog />
      <Routes>
        {/* The workspace grid is the app: every visit lands on it, reading this
            browser's IndexedDB. There is no session and nothing to sign in to,
            so there is no wall and no account route. */}
        <Route path="/" element={<Navigate to="/workspaces" replace />} />
        <Route path="/workspaces" element={<Workspaces />} />
        <Route path="/workspaces/:workspaceId" element={<WorkspacePage />} />
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={<WorkspacePage />} />
        {/* Old links are redirected, not served: the document route was the
            single-document library and there is no live route by that name any
            more. */}
        <Route path="/documents" element={<Navigate to="/workspaces" replace />} />
        <Route path="/documents/:uuid" element={<Navigate to="/workspaces" replace />} />
        {/* Docs is a shell around reference pages. Bare /docs has no content of
            its own, so it redirects to the first page rather than rendering the
            sidebar beside an empty pane. */}
        <Route path="/docs" element={<Docs />}>
          <Route index element={<Navigate to="/docs/registry" replace />} />
          <Route path="registry" element={<Registry />} />
          <Route path="licenses" element={<Licenses />} />
        </Route>
        {/* The docs area answered to /help until it was renamed. Bookmarks and
            the shipped disclaimer outlive a rename, so the old path redirects
            rather than 404s. */}
        <Route path="/help" element={<Navigate to="/docs" replace />} />
        <Route path="/help/registry" element={<Navigate to="/docs/registry" replace />} />
      </Routes>
    </>
  )
}

export default App
