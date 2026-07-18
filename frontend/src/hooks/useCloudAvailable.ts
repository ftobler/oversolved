import { backendBundle } from '@/adapters/backend'
import { useAuth } from '@/contexts/AuthContext'

// The one rule for whether the cloud domain exists right now: this build has a
// server, a session is signed in, AND the server is reachable. Shared by the
// documents page, the insert-part browser and the assembly editor so the rule
// cannot drift between them (session-logout-offline).
export function useCloudAvailable(): boolean {
  const { user, online } = useAuth()
  return backendBundle.cloudDocuments != null && user != null && online
}
