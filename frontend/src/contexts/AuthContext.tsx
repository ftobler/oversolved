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
  setUser: (user: User | null) => void
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  setUser: () => {},
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

  useEffect(() => {
    if (!hasBackend) return  // no server: stay a guest, never touch the network
    // Restore an existing cloud session if the browser already holds one; a
    // 401/failure just means "still a guest", not an error.
    http.getJson<{ user: User }>('/api/auth/me')
      .then(data => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  const logout = async () => {
    if (!hasBackend) return  // nothing to log out of locally
    await http.postJson('/api/auth/logout').catch(() => undefined)
    setUser(null)  // drops the credential only; the local library is untouched
  }

  return (
    <AuthContext.Provider value={{ user, loading, setUser, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext)
}
