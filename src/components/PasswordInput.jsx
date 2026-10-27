import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

export const fieldClass =
  'w-full rounded-xl border bg-[#0a1f2e] px-3.5 py-3 pr-11 text-sm text-white placeholder:text-slate-500 transition focus:border-mint focus:outline-none focus:ring-2 focus:ring-mint/30'

export default function PasswordInput({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  autoComplete = 'current-password',
  placeholder = '••••••••••',
  name = 'password',
  disabled = false,
}) {
  const [visible, setVisible] = useState(false)
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-bold text-slate-200">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy}
          className={`${fieldClass} ${error ? 'border-rose-500/70' : 'border-white/12'} disabled:opacity-60`}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-xl text-slate-400 transition hover:text-mint focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-mint"
          // Deliberately different from the field label, so the toggle has a
          // unique accessible name and does not shadow the input when a user (or
          // a test) looks the field up by its label.
          aria-label={visible ? 'Hide characters' : 'Show characters'}
          aria-pressed={visible}
          disabled={disabled}
        >
          {visible ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs font-medium text-rose-300">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
