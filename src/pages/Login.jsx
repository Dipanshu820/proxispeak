import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AlertCircle, ArrowRight, Loader2 } from 'lucide-react'
import AuthFrame from '../components/AuthFrame.jsx'
import PasswordInput, { fieldClass } from '../components/PasswordInput.jsx'
import { useAuth } from '../auth/AuthContext.jsx'
import { messageFor, normalizeEmail, validateEmail } from '../utils/validation.js'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const from = location.state?.from
  const destination =
    from && typeof from.pathname === 'string' && !['/login', '/signup'].includes(from.pathname)
      ? `${from.pathname}${from.search || ''}`
      : '/office'

  function validate() {
    const errors = {}
    const emailCode = validateEmail(email)
    if (emailCode) errors.email = messageFor(emailCode)
    if (!password) errors.password = 'Enter your password.'
    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  async function onSubmit(event) {
    event.preventDefault()
    setFormError(null)
    if (submitting) return
    if (!validate()) return

    setSubmitting(true)
    try {
      await login({ email: normalizeEmail(email), password })
      navigate(destination, { replace: true })
    } catch (error) {
      setFormError(messageFor(error?.code))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthFrame
      eyebrow="Welcome back"
      title="Sign in to your office"
      subtitle="Use the email and password you registered with."
      footer={
        <>
          New to ProxiSpeak?{' '}
          <Link
            to="/signup"
            state={location.state}
            className="font-bold text-mint underline-offset-4 hover:underline"
          >
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {formError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-3 text-xs font-medium text-rose-200"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{formError}</span>
          </div>
        )}

        <div>
          <label htmlFor="login-email" className="mb-1.5 block text-xs font-bold text-slate-200">
            Email
          </label>
          <input
            id="login-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onBlur={() => {
              if (!email) return
              const code = validateEmail(email)
              setFieldErrors((current) => ({ ...current, email: code ? messageFor(code) : undefined }))
            }}
            placeholder="you@company.com"
            disabled={submitting}
            aria-invalid={fieldErrors.email ? 'true' : undefined}
            aria-describedby={fieldErrors.email ? 'login-email-error' : undefined}
            className={`${fieldClass} ${fieldErrors.email ? 'border-rose-500/70' : 'border-white/12'}`}
          />
          {fieldErrors.email && (
            <p id="login-email-error" className="mt-1.5 text-xs font-medium text-rose-300">
              {fieldErrors.email}
            </p>
          )}
        </div>

        <PasswordInput
          id="login-password"
          label="Password"
          value={password}
          onChange={setPassword}
          error={fieldErrors.password}
          autoComplete="current-password"
          disabled={submitting}
        />

        <button
          type="submit"
          disabled={submitting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-mint px-4 py-3 text-sm font-extrabold text-ink transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Signing in…
            </>
          ) : (
            <>
              Sign in
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </>
          )}
        </button>

        <p className="rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3 text-[11px] leading-5 text-slate-400">
          Password recovery is not enabled in this deployment because no transactional email
          service is configured. Ask an administrator to reset your account if you are locked out.
        </p>
      </form>
    </AuthFrame>
  )
}
