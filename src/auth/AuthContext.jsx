// Account state for the whole app.
//
// The browser never holds an account token: the server sets an HttpOnly cookie
// and `GET /api/auth/me` is the source of truth for who is signed in. `user` is
// therefore only a cache for rendering, not a credential.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  getCurrentAccount,
  loginAccount,
  logoutAccount,
  signupAccount,
  updateAccount,
} from '../utils/auth.js'

// Defaults make the provider optional for component tests that render a single
// page (the office is rendered directly by several suites).
const defaultContext = {
  user: null,
  loading: false,
  error: null,
  isAuthenticated: false,
  login: async () => {
    throw new Error('AuthProvider is not mounted')
  },
  signup: async () => {
    throw new Error('AuthProvider is not mounted')
  },
  logout: async () => {},
  updateProfile: async () => null,
  refresh: async () => null,
}

const AuthContext = createContext(defaultContext)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // The initial `/me` probe races any auth action the user takes immediately
  // (e.g. submitting the form while the check is still in flight). The probe
  // must never overwrite a newer login/signup/logout result.
  const actionVersionRef = useRef(0)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const current = await getCurrentAccount()
      setUser(current)
      return current
    } catch (refreshError) {
      // A network failure must not sign an existing user out locally; it only
      // means the check could not complete.
      setError(refreshError?.code || 'NETWORK_ERROR')
      return null
    }
  }, [])

  useEffect(() => {
    let alive = true
    const version = actionVersionRef.current
    ;(async () => {
      try {
        const current = await getCurrentAccount()
        if (alive && version === actionVersionRef.current) setUser(current)
      } catch (refreshError) {
        if (alive) setError(refreshError?.code || 'NETWORK_ERROR')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const login = useCallback(async (credentials) => {
    actionVersionRef.current += 1
    const payload = await loginAccount(credentials)
    setUser(payload.user)
    setError(null)
    return payload.user
  }, [])

  const signup = useCallback(async (details) => {
    actionVersionRef.current += 1
    const payload = await signupAccount(details)
    setUser(payload.user)
    setError(null)
    return payload.user
  }, [])

  const logout = useCallback(async () => {
    actionVersionRef.current += 1
    try {
      await logoutAccount()
    } finally {
      // Even if the request failed (server unreachable), drop the local view of
      // the session so the UI cannot keep pretending to be signed in.
      setUser(null)
    }
  }, [])

  const updateProfile = useCallback(async (changes) => {
    actionVersionRef.current += 1
    const payload = await updateAccount(changes)
    setUser(payload.user)
    return payload.user
  }, [])

  const value = useMemo(
    () => ({
      user,
      loading,
      error,
      isAuthenticated: Boolean(user),
      login,
      signup,
      logout,
      updateProfile,
      refresh,
    }),
    [user, loading, error, login, signup, logout, updateProfile, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
