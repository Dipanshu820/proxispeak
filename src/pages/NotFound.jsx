import { Link } from 'react-router-dom'
import { ArrowLeft, Compass } from 'lucide-react'
import Brand from '../components/Brand.jsx'
import { useAuth } from '../auth/AuthContext.jsx'

export default function NotFound() {
  const { user } = useAuth()

  return (
    <div className="flex min-h-screen flex-col bg-[#05111d] text-slate-100">
      <header className="border-b border-white/10 px-5 py-4 sm:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <Brand subtitle="Geospatial proximity audio" />
          <Link
            to={user ? '/office' : '/'}
            className="rounded-xl border border-white/15 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-white/5"
          >
            {user ? 'Office' : 'Home'}
          </Link>
        </div>
      </header>

      <main className="grid flex-1 place-items-center px-5 py-16">
        <div className="max-w-lg text-center">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-mint/25 bg-mint/10 text-mint">
            <Compass className="h-8 w-8" aria-hidden="true" />
          </div>
          <p className="mt-6 text-[11px] font-extrabold uppercase tracking-[.22em] text-mint">404 — off the floor plan</p>
          <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">This room does not exist</h1>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            The page you asked for is not part of ProxiSpeak. Check the address, or head back to a
            room that does.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              to={user ? '/office' : '/'}
              className="inline-flex items-center gap-2 rounded-xl bg-mint px-5 py-3 text-sm font-extrabold text-ink hover:bg-teal-200"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {user ? 'Back to the office' : 'Back to home'}
            </Link>
            {!user && (
              <Link
                to="/login"
                className="rounded-xl border border-white/20 px-5 py-3 text-sm font-semibold text-white hover:bg-white/5"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
