import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { http } from '@/utils/core/httpClient'
import { hasBackend } from '@/config/capabilities'

export interface User {
  id: number
  username: string
  email: string | null
  must_change_password: boolean
  is_admin: boolean
  is_active: boolean
}

interface AuthContextType {
  user: User | null  // null = guest / not signed in; this is the default session
  loading: boolean
  online: boolean  // is the cloud server reachable right now; only meaningful while signed in
  setUser: (user: User | null) => void
  setOnline: (online: boolean) => void
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  online: true,
  setUser: () => {},
  setOnline: () => {},
  logout: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  // One session concept, guest by default. There is no synthetic local user: the
  // app is fully functional as a guest (null). Signing in only ADDS the cloud
  // domain on top, it is never a wall. On a zero-backend build there is no server
  // to sign in to, so the session simply stays guest forever -- static IS the
  // not-logged-in state (see static-build-notes: guest-first session).
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(hasBackend)
  // Cloud reachability. Starts optimistic; flips to false when a cloud call hits a
  // connection error (the document library reports it) or the browser goes offline.
  // Losing the server while signed in is a deliberate state, not a crash: the app
  // keeps working on the local library (session-logout-offline).
  const [online, setOnline] = useState(true)

  useEffect(() => {
    if (!hasBackend) return  // no server: stay a guest, never touch the network
    // Restore an existing cloud session if the browser already holds one; a
    // 401/failure just means "still a guest", not an error.
    http.getJson<{ user: User }>('/api/auth/me')
      .then(data => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!hasBackend) return  // no cloud to lose on a static build
    // The browser's own connectivity signal is a coarse hint (it means a network
    // interface returned, not that OUR server is up); a failed cloud call is the
    // authoritative "offline" report. Coming back online makes the cloud domain
    // available again -- the switch reappears; the library re-fetches it on the next
    // domain switch, not eagerly here (if the server is still down the next cloud
    // list just flips back offline).
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  const logout = async () => {
    if (!hasBackend) return  // nothing to log out of locally
    await http.postJson('/api/auth/logout').catch(() => undefined)
    setUser(null)  // drops the credential only; the local library is untouched
    setOnline(true)  // reset connectivity for the next sign-in; nothing is cleared
  }

  return (
    <AuthContext.Provider value={{ user, loading, online, setUser, setOnline, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext)
}
