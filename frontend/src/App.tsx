import { Routes, Route, Navigate } from 'react-router-dom'
import DisclaimerDialog from '@/components/dialogs/DisclaimerDialog'
import Documents from '@/pages/Documents'
import DocumentPage from '@/pages/DocumentPage'
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
        {/* The app is the library: every visit lands on the documents page,
            which reads this browser's IndexedDB. There is no session and
            nothing to sign in to, so there is no wall and no account route. */}
        <Route path="/" element={<Navigate to="/documents" replace />} />
        <Route path="/documents" element={<Documents />} />
        <Route path="/documents/:uuid" element={<DocumentPage />} />
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
