import { Routes, Route, Navigate } from 'react-router-dom'
import DisclaimerDialog from '@/components/dialogs/DisclaimerDialog'
import Workspaces from '@/pages/Workspaces'
import WorkspacePage from '@/pages/WorkspacePage'
import Help from '@/pages/Help'
import Registry from '@/pages/Registry'
import '@/components/shared/buttons.css'
import '@/App.css'

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
        {/* Help is a shell around reference pages. Bare /help has no content of
            its own, so it redirects to the first page rather than rendering the
            sidebar beside an empty pane. */}
        <Route path="/help" element={<Help />}>
          <Route index element={<Navigate to="/help/registry" replace />} />
          <Route path="registry" element={<Registry />} />
        </Route>
      </Routes>
    </>
  )
}

export default App
