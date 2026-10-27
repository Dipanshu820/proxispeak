// Route guards.
//
// While the initial `/api/auth/me` check is in flight we render a calm loading
// state rather than bouncing the user to /login (which would flash for every
// refresh). The intended destination is preserved in router state so signing in
// returns the user where they were going.
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext.jsx'

export function FullPageLoader({ label = 'Loading your workspace…' }) {
  return (
    <div className="grid min-h-screen place-items-center bg-ink text-slate-200" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-4">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/15 border-t-mint" aria-hidden="true" />
        <p className="text-sm text-slate-400">{label}</p>
      </div>
    </div>
  )
}

export function RequireAuth({ children }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) return <FullPageLoader />
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  return children
}

export function RedirectIfAuthenticated({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <FullPageLoader label="Checking your session…" />
  if (user) return <Navigate to="/office" replace />
  return children
}
