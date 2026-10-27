import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlertCircle, ArrowLeft, Check, Loader2, LogOut, Mail, ShieldCheck, User } from 'lucide-react'
import Brand from '../components/Brand.jsx'
import { fieldClass } from '../components/PasswordInput.jsx'
import { useAuth } from '../auth/AuthContext.jsx'
import { MAX_NAME_LENGTH, messageFor, validateName } from '../utils/validation.js'

const ROOM_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

function formatDate(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function Settings() {
  const { user, updateProfile, logout } = useAuth()
  const navigate = useNavigate()

  const [name, setName] = useState(user?.name || '')
  const [room, setRoom] = useState(user?.preferences?.defaultRoom || 'design-team')
  const [errors, setErrors] = useState({})
  const [status, setStatus] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setName(user?.name || '')
    setRoom(user?.preferences?.defaultRoom || 'design-team')
  }, [user?.name, user?.preferences?.defaultRoom])

  async function onSubmit(event) {
    event.preventDefault()
    setStatus(null)
    const nextErrors = {}

    const nameCode = validateName(name)
    if (nameCode) nextErrors.name = messageFor(nameCode)
    if (!ROOM_PATTERN.test(room.trim())) {
      nextErrors.room = 'Use 1–64 letters, numbers, dots, dashes or underscores.'
    }

    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    setSaving(true)
    try {
      await updateProfile({
        name: name.trim(),
        preferences: { defaultRoom: room.trim() },
      })
      setStatus({ tone: 'success', text: 'Settings saved.' })
    } catch (error) {
      setStatus({ tone: 'error', text: messageFor(error?.code) })
    } finally {
      setSaving(false)
    }
  }

  async function onLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-screen bg-[#05111d] text-slate-100">
      <header className="border-b border-white/10 bg-[#071827]/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-5 sm:px-8">
          <Brand subtitle="Account settings" />
          <Link
            to="/office"
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3.5 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/5"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Back to office
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
        <p className="text-[11px] font-extrabold uppercase tracking-[.22em] text-mint">Your account</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight">Settings</h1>
        <p className="mt-2 text-sm text-slate-400">
          Preferences are stored with your account, so they follow you to another browser.
        </p>

        <div className="mt-8 grid gap-5 lg:grid-cols-[1.3fr_.7fr]">
          <section className="rounded-2xl border border-white/10 bg-[#081a27] p-6">
            <h2 className="flex items-center gap-2 text-sm font-bold">
              <User className="h-4 w-4 text-mint" aria-hidden="true" />
              Profile
            </h2>

            <form onSubmit={onSubmit} noValidate className="mt-5 space-y-5">
              {status && (
                <div
                  role={status.tone === 'error' ? 'alert' : 'status'}
                  className={`flex items-start gap-2 rounded-xl border px-3.5 py-3 text-xs font-medium ${
                    status.tone === 'error'
                      ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
                      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  }`}
                >
                  {status.tone === 'error' ? (
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  )}
                  {status.text}
                </div>
              )}

              <div>
                <label htmlFor="settings-name" className="mb-1.5 block text-xs font-bold text-slate-200">
                  Display name
                </label>
                <input
                  id="settings-name"
                  name="name"
                  type="text"
                  value={name}
                  maxLength={MAX_NAME_LENGTH}
                  onChange={(event) => setName(event.target.value)}
                  disabled={saving}
                  aria-invalid={errors.name ? 'true' : undefined}
                  aria-describedby={errors.name ? 'settings-name-error' : 'settings-name-hint'}
                  className={`${fieldClass} ${errors.name ? 'border-rose-500/70' : 'border-white/12'}`}
                />
                {errors.name ? (
                  <p id="settings-name-error" className="mt-1.5 text-xs font-medium text-rose-300">
                    {errors.name}
                  </p>
                ) : (
                  <p id="settings-name-hint" className="mt-1.5 text-xs text-slate-500">
                    This is the name other people see on your avatar. Changing it applies the next
                    time you enter the office.
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="settings-room" className="mb-1.5 block text-xs font-bold text-slate-200">
                  Default office room
                </label>
                <input
                  id="settings-room"
                  name="room"
                  type="text"
                  value={room}
                  onChange={(event) => setRoom(event.target.value)}
                  disabled={saving}
                  aria-invalid={errors.room ? 'true' : undefined}
                  aria-describedby={errors.room ? 'settings-room-error' : 'settings-room-hint'}
                  className={`${fieldClass} ${errors.room ? 'border-rose-500/70' : 'border-white/12'}`}
                />
                {errors.room ? (
                  <p id="settings-room-error" className="mt-1.5 text-xs font-medium text-rose-300">
                    {errors.room}
                  </p>
                ) : (
                  <p id="settings-room-hint" className="mt-1.5 text-xs text-slate-500">
                    The office joins this room by default. Your deployment may restrict rooms with
                    ALLOWED_ROOMS.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-xl bg-mint px-4 py-2.5 text-sm font-extrabold text-ink transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
                <span className="text-[11px] text-slate-500">Saved to your account record.</span>
              </div>
            </form>
          </section>

          <div className="space-y-5">
            <section className="rounded-2xl border border-white/10 bg-[#081a27] p-6">
              <h2 className="flex items-center gap-2 text-sm font-bold">
                <Mail className="h-4 w-4 text-mint" aria-hidden="true" />
                Account
              </h2>
              <dl className="mt-4 space-y-3 text-xs">
                <div>
                  <dt className="text-slate-500">Email</dt>
                  <dd className="mt-0.5 break-all font-semibold text-slate-200">{user?.email}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Member since</dt>
                  <dd className="mt-0.5 font-semibold text-slate-200">{formatDate(user?.createdAt) || '—'}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Account id</dt>
                  <dd className="mt-0.5 break-all font-mono text-[10px] text-slate-400">{user?.id}</dd>
                </div>
              </dl>
              <p className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] leading-5 text-slate-400">
                Email changes and password resets are not implemented because no transactional email
                service is configured in this deployment.
              </p>
            </section>

            <section className="rounded-2xl border border-white/10 bg-[#081a27] p-6">
              <h2 className="flex items-center gap-2 text-sm font-bold">
                <ShieldCheck className="h-4 w-4 text-mint" aria-hidden="true" />
                Session
              </h2>
              <p className="mt-3 text-[11px] leading-5 text-slate-400">
                You are signed in with an HttpOnly cookie session. Signing out revokes the session and
                disconnects any open office socket.
              </p>
              <button
                type="button"
                onClick={onLogout}
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm font-bold text-rose-200 transition hover:bg-rose-500/20"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                Sign out
              </button>
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}
