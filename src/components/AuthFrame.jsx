import { Link } from 'react-router-dom'
import { ArrowLeft, Check, Headphones, MapPin, ShieldCheck } from 'lucide-react'
import Brand from './Brand.jsx'

const POINTS = [
  { icon: MapPin, title: 'Walk the floor', text: 'Move your avatar through a real 3D office with desks, meeting rooms and a lounge.' },
  { icon: Headphones, title: 'Talk by proximity', text: 'Voices fade in as colleagues get closer and out again as they walk away.' },
  { icon: ShieldCheck, title: 'Account-based access', text: 'Hashed passwords, HttpOnly sessions, and server-enforced room identity.' },
]

export default function AuthFrame({ eyebrow, title, subtitle, children, footer }) {
  return (
    <div className="min-h-screen bg-[#05111d] text-slate-100 lg:grid lg:grid-cols-[1.05fr_.95fr]">
      <aside className="relative hidden overflow-hidden border-r border-white/10 bg-[#071827] p-10 lg:flex lg:flex-col">
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          aria-hidden="true"
          style={{
            background:
              'radial-gradient(60% 50% at 20% 10%, rgba(69,224,192,.20), transparent 70%), radial-gradient(50% 40% at 90% 85%, rgba(56,189,248,.14), transparent 70%)',
          }}
        />
        <div className="relative">
          <Brand subtitle="Geospatial proximity audio" />
        </div>

        <div className="relative mt-auto">
          <p className="text-[11px] font-extrabold uppercase tracking-[.22em] text-mint/90">Spatial voice for remote teams</p>
          <h2 className="mt-4 max-w-md text-3xl font-black leading-tight tracking-tight">
            The office you can walk through, not the grid you stare at.
          </h2>
          <ul className="mt-8 space-y-5">
            {POINTS.map(({ icon: Icon, title: pointTitle, text }) => (
              <li key={pointTitle} className="flex gap-3">
                <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/5 text-mint">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-sm font-bold text-white">{pointTitle}</span>
                  <span className="mt-0.5 block max-w-sm text-xs leading-5 text-slate-400">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative mt-10 flex items-center gap-2 text-[11px] text-slate-500">
          <Check className="h-3.5 w-3.5 text-mint" aria-hidden="true" />
          Audio is peer-to-peer and never recorded.
        </p>
      </aside>

      <main className="flex min-h-screen flex-col px-5 py-8 sm:px-10">
        <div className="mb-8 flex items-center justify-between lg:hidden">
          <Brand subtitle="Proximity audio office" />
          <Link
            to="/"
            className="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/5"
          >
            Home
          </Link>
        </div>

        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
          <Link
            to="/"
            className="mb-8 hidden items-center gap-2 text-xs font-semibold text-slate-400 hover:text-mint lg:inline-flex"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Back to home
          </Link>

          <p className="text-[11px] font-extrabold uppercase tracking-[.22em] text-mint">{eyebrow}</p>
          <h1 className="mt-3 text-3xl font-black tracking-tight text-white">{title}</h1>
          {subtitle && <p className="mt-2 text-sm leading-6 text-slate-400">{subtitle}</p>}

          <div className="mt-8">{children}</div>
          {footer && <div className="mt-6 text-sm text-slate-400">{footer}</div>}
        </div>

        <p className="mx-auto mt-8 w-full max-w-md text-[11px] leading-5 text-slate-600">
          ProxiSpeak uses your microphone only after you press Enable mic in the office. No audio is stored.
        </p>
      </main>
    </div>
  )
}
