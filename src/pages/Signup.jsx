import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AlertCircle, ArrowRight, Loader2 } from 'lucide-react'
import AuthFrame from '../components/AuthFrame.jsx'
import PasswordInput, { fieldClass } from '../components/PasswordInput.jsx'
import { useAuth } from '../auth/AuthContext.jsx'
import {
  MAX_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  messageFor,
  normalizeEmail,
  validateConfirmPassword,
  validateEmail,
  validateName,
  validatePassword,
} from '../utils/validation.js'

export default function Signup() {
  const { signup } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [values, setValues] = useState({ name: '', email: '', password: '', confirmPassword: '' })
  const [fieldErrors, setFieldErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const destination = location.state?.from?.pathname || '/office'

  function setField(name, value) {
    setValues((current) => ({ ...current, [name]: value }))
    if (fieldErrors[name]) {
      setFieldErrors((current) => ({ ...current, [name]: undefined }))
    }
  }

  function validate() {
    const errors = {}
    const nameCode = validateName(values.name)
    if (nameCode) errors.name = messageFor(nameCode)

    const emailCode = validateEmail(values.email)
    if (emailCode) errors.email = messageFor(emailCode)

    const passwordCode = validatePassword(values.password)
    if (passwordCode) errors.password = messageFor(passwordCode)

    const confirmCode = validateConfirmPassword(values.password, values.confirmPassword)
    if (confirmCode) errors.confirmPassword = messageFor(confirmCode)

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
      await signup({
        name: values.name,
        email: normalizeEmail(values.email),
        password: values.password,
        confirmPassword: values.confirmPassword,
      })
      navigate(destination, { replace: true })
    } catch (error) {
      const code = error?.code
      if (code === 'EMAIL_TAKEN') {
        setFieldErrors((current) => ({ ...current, email: messageFor(code) }))
      } else {
        setFormError(messageFor(code))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthFrame
      eyebrow="Create your account"
      title="Get your office key"
      subtitle="One account, one identity in the room. Your display name is set here and cannot be spoofed from the client."
      footer={
        <>
          Already have an account?{' '}
          <Link
            to="/login"
            state={location.state}
            className="font-bold text-mint underline-offset-4 hover:underline"
          >
            Sign in
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
          <label htmlFor="signup-name" className="mb-1.5 block text-xs font-bold text-slate-200">
            Name
          </label>
          <input
            id="signup-name"
            name="name"
            type="text"
            autoComplete="name"
            value={values.name}
            onChange={(event) => setField('name', event.target.value)}
            onBlur={() => {
              const code = validateName(values.name)
              setFieldErrors((current) => ({ ...current, name: code ? messageFor(code) : undefined }))
            }}
            placeholder="Ada Lovelace"
            maxLength={MAX_NAME_LENGTH}
            disabled={submitting}
            aria-invalid={fieldErrors.name ? 'true' : undefined}
            aria-describedby={fieldErrors.name ? 'signup-name-error' : undefined}
            className={`${fieldClass} ${fieldErrors.name ? 'border-rose-500/70' : 'border-white/12'}`}
          />
          {fieldErrors.name && (
            <p id="signup-name-error" className="mt-1.5 text-xs font-medium text-rose-300">
              {fieldErrors.name}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="signup-email" className="mb-1.5 block text-xs font-bold text-slate-200">
            Email
          </label>
          <input
            id="signup-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={values.email}
            onChange={(event) => setField('email', event.target.value)}
            onBlur={() => {
              if (!values.email) return
              const code = validateEmail(values.email)
              setFieldErrors((current) => ({ ...current, email: code ? messageFor(code) : undefined }))
            }}
            placeholder="you@company.com"
            disabled={submitting}
            aria-invalid={fieldErrors.email ? 'true' : undefined}
            aria-describedby={fieldErrors.email ? 'signup-email-error' : undefined}
            className={`${fieldClass} ${fieldErrors.email ? 'border-rose-500/70' : 'border-white/12'}`}
          />
          {fieldErrors.email && (
            <p id="signup-email-error" className="mt-1.5 text-xs font-medium text-rose-300">
              {fieldErrors.email}
            </p>
          )}
        </div>

        <PasswordInput
          id="signup-password"
          label="Password"
          name="new-password"
          value={values.password}
          onChange={(value) => setField('password', value)}
          error={fieldErrors.password}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters, with one letter and one number.`}
          autoComplete="new-password"
          disabled={submitting}
        />

        <PasswordInput
          id="signup-confirm"
          label="Confirm password"
          name="confirm-password"
          value={values.confirmPassword}
          onChange={(value) => setField('confirmPassword', value)}
          error={fieldErrors.confirmPassword}
          autoComplete="new-password"
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
              Creating account…
            </>
          ) : (
            <>
              Create account
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </>
          )}
        </button>

        <p className="text-[11px] leading-5 text-slate-500">
          By creating an account you agree to use the office respectfully. Microphone audio is only
          captured after you enable it in the office, and it is never recorded by ProxiSpeak.
        </p>
      </form>
    </AuthFrame>
  )
}
