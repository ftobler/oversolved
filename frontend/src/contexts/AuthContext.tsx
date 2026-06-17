import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { http } from '@/utils/core/httpClient'
import { hasBackend } from '@/config/capabilities'

// In a static (zero-backend) build there is no account system. The app runs as
// a single local user so the auth wall never blocks access; login/logout are
// no-ops. Offline is first-class, not a degraded mode.
const LOCAL_USER: User = {
  id: 0,
  username: 'local',
  email: null,
  must_change_password: false,
  is_admin: false,
  is_active: true,
}

export interface User {
  id: number
  username: string
  email: string | null
  must_change_password: boolean
  is_admin: boolean
  is_active: boolean
}

interface AuthContextType {
  user: User | null
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
  const [user, setUser] = useState<User | null>(hasBackend ? null : LOCAL_USER)
  const [loading, setLoading] = useState(hasBackend)

  useEffect(() => {
    if (!hasBackend) return  // static build: local user, no auth endpoint to hit
    http.getJson<{ user: User }>('/api/auth/me')
      .then(data => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  const logout = async () => {
    if (!hasBackend) return  // nothing to log out of locally
    await http.postJson('/api/auth/logout').catch(() => undefined)
    setUser(null)
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
