import { Link } from 'react-router-dom'
import {
  ArrowRight,
  AudioLines,
  Boxes,
  Check,
  Headphones,
  Keyboard,
  Lock,
  MapPin,
  Mic,
  MousePointerClick,
  ShieldCheck,
  Sparkles,
  Users,
  Volume2,
} from 'lucide-react'
import Brand from '../components/Brand.jsx'
import OfficePreview from '../components/OfficePreview.jsx'
import { useAuth } from '../auth/AuthContext.jsx'

const NAV = [
  { label: 'Product', href: '#product' },
  { label: 'How it works', href: '#how' },
  { label: 'Spatial audio', href: '#audio' },
  { label: 'Security', href: '#security' },
]

const FEATURES = [
  {
    icon: Boxes,
    title: 'A real 3D office',
    body: 'Five connected zones rendered with Three.js: workstations, a meeting room, a lounge and a quiet studio. Orbit the room, then walk your avatar in.',
  },
  {
    icon: Volume2,
    title: 'Proximity voice',
    body: 'Peer audio is attenuated by the distance between avatars through the Web Audio API. Walk closer to hear someone, step away and the voice fades out smoothly.',
  },
  {
    icon: Users,
    title: 'Live presence',
    body: 'Socket.IO keeps positions, room membership, speaking and mute state in sync. Colleagues appear and disappear as they join and leave the floor.',
  },
  {
    icon: Mic,
    title: 'Microphone on your terms',
    body: 'Your browser only asks for the mic after you press Enable mic. Mute instantly, and the room sees the real track state rather than a decorative indicator.',
  },
]

const STEPS = [
  {
    icon: Lock,
    title: 'Create an account',
    body: 'Register with a name, email and a hashed password. Sessions are signed and stored in an HttpOnly cookie.',
  },
  {
    icon: MapPin,
    title: 'Enter the office',
    body: 'Your account is bound to a room token, so the server knows exactly who is on the floor — no client-supplied identity.',
  },
  {
    icon: Headphones,
    title: 'Talk where you stand',
    body: 'Enable the mic and move near a colleague. The closer you are, the louder their voice; outside earshot they are silent.',
  },
]

const SECURITY = [
  'Passwords are hashed with scrypt (N=16384, r=8) and a per-account random salt. Plaintext is never stored or logged.',
  'Account sessions are HMAC-signed, expiring, and delivered in an HttpOnly, SameSite=Lax cookie. No account token is kept in localStorage.',
  'Socket connections require a separate signed room token tied to your account, and logout revokes both layers.',
  'Room membership, avatar identity, positions and WebRTC signaling are validated server-side. Clients cannot rename or impersonate another participant.',
  'Microphone audio travels peer-to-peer over WebRTC. ProxiSpeak does not record or store audio.',
]

export default function Landing() {
  const { user } = useAuth()
  const primaryHref = user ? '/office' : '/signup'
  const primaryLabel = user ? 'Open your office' : 'Get started'

  return (
    <div className="min-h-screen bg-[#05111d] text-slate-100">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-mint focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-ink"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#05111d]/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Brand subtitle="Geospatial proximity audio" />
          <nav aria-label="Main" className="hidden items-center gap-7 text-sm text-slate-300 md:flex">
            {NAV.map((item) => (
              <a key={item.href} href={item.href} className="transition hover:text-mint">
                {item.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            {!user && (
              <Link
                to="/login"
                className="hidden rounded-xl px-3.5 py-2 text-sm font-semibold text-slate-200 transition hover:bg-white/5 sm:block"
              >
                Sign in
              </Link>
            )}
            <Link
              to={primaryHref}
              data-testid="enter-office"
              className="rounded-xl bg-mint px-4 py-2 text-sm font-extrabold text-ink transition hover:bg-teal-200"
            >
              {primaryLabel}
            </Link>
          </div>
        </div>
      </header>

      <main id="main">
        {/* Hero */}
        <section className="relative overflow-hidden px-5 pb-16 pt-14 sm:px-8 sm:pb-24 sm:pt-20">
          <div
            className="pointer-events-none absolute inset-0"
            aria-hidden="true"
            style={{
              background:
                'radial-gradient(55% 45% at 78% 8%, rgba(69,224,192,.16), transparent 65%), radial-gradient(40% 40% at 8% 40%, rgba(56,189,248,.10), transparent 70%)',
            }}
          />
          <div className="relative mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1.02fr_.98fr]">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-mint/25 bg-mint/10 px-3.5 py-1.5 text-xs font-semibold text-teal-100">
                <Sparkles className="h-3.5 w-3.5 text-mint" aria-hidden="true" />
                Spatial voice for remote teams
              </span>
              <h1 className="mt-6 text-4xl font-black leading-[1.05] tracking-tight sm:text-6xl">
                Work together.
                <br />
                <span className="bg-gradient-to-r from-mint to-sky-300 bg-clip-text text-transparent">
                  Hear who&apos;s nearby.
                </span>
              </h1>
              <p className="mt-6 max-w-xl text-base leading-7 text-slate-300 sm:text-lg">
                ProxiSpeak is a virtual office you actually walk around. Your avatar moves through a
                3D floor, and conversations fade in when colleagues are close — no &ldquo;join a
                call&rdquo; step, no unmuting rituals.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  to={primaryHref}
                  data-testid="enter-office"
                  className="inline-flex items-center gap-2 rounded-xl bg-mint px-5 py-3 text-sm font-extrabold text-ink shadow-lg shadow-mint/10 transition hover:bg-teal-200"
                >
                  {primaryLabel}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
                <Link
                  to={user ? '/office' : '/login'}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/20 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/5"
                >
                  <MapPin className="h-4 w-4 text-mint" aria-hidden="true" />
                  Explore the office
                </Link>
              </div>

              <ul className="mt-9 flex flex-wrap gap-x-6 gap-y-3 text-xs font-medium text-slate-400">
                {['3D rendered floor', 'Proximity WebRTC audio', 'Account-secured rooms'].map((item) => (
                  <li key={item} className="flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 text-mint" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <div className="relative">
              <div className="rounded-3xl border border-white/12 bg-[#081a27]/90 p-3 shadow-2xl shadow-black/40 sm:p-4">
                <div className="mb-3 flex items-center justify-between px-1">
                  <div>
                    <p className="text-sm font-bold text-white">Design Team Floor</p>
                    <p className="text-[11px] text-slate-400">Isometric layout preview</p>
                  </div>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                    Live scene
                  </span>
                </div>
                <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#07151f]">
                  <OfficePreview className="h-auto w-full" />
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                  {[
                    ['5', 'zones'],
                    ['18', 'desks & sofas'],
                    ['1', 'shared floor'],
                  ].map(([value, label]) => (
                    <div key={label} className="rounded-xl border border-white/5 bg-white/[0.03] py-2">
                      <dt className="sr-only">{label}</dt>
                      <dd className="text-lg font-black text-white">{value}</dd>
                      <dd className="text-[10px] uppercase tracking-wide text-slate-500">{label}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <p className="mt-3 text-center text-[11px] text-slate-500">
                Illustration generated from the same layout the 3D office renders.
              </p>
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="product" className="border-y border-white/10 bg-[#071827] px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <div className="max-w-2xl">
              <p className="text-[11px] font-extrabold uppercase tracking-[.22em] text-mint">Product</p>
              <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
                Presence you can feel, not just a green dot
              </h2>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                Every part of the room is real: rendered geometry, server-authoritative presence, and
                audio that follows the distance between two avatars.
              </p>
            </div>
            <div className="mt-10 grid gap-4 sm:grid-cols-2">
              {FEATURES.map(({ icon: Icon, title, body }) => (
                <article
                  key={title}
                  className="rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.05] to-transparent p-6 transition hover:border-mint/30"
                >
                  <span className="grid h-11 w-11 place-items-center rounded-xl border border-mint/20 bg-mint/10 text-mint">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-4 text-base font-bold text-white">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-400">{body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="text-[11px] font-extrabold uppercase tracking-[.22em] text-mint">How it works</p>
                <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Three steps to the floor</h2>
              </div>
              <p className="max-w-sm text-sm leading-6 text-slate-400">
                Movement is keyboard-first (WASD or arrow keys) with click-to-walk and a collidable
                furniture model, on desktop and touch.
              </p>
            </div>

            <div className="mt-10 grid gap-4 md:grid-cols-3">
              {STEPS.map(({ icon: Icon, title, body }, index) => (
                <article key={title} className="relative rounded-2xl border border-white/10 bg-[#081a27] p-6">
                  <span className="absolute right-5 top-5 text-4xl font-black text-white/5" aria-hidden="true">
                    0{index + 1}
                  </span>
                  <span className="grid h-10 w-10 place-items-center rounded-lg bg-white/5 text-mint">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-4 text-base font-bold">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-400">{body}</p>
                </article>
              ))}
            </div>

            <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-4 text-xs text-slate-400">
              <span className="flex items-center gap-2">
                <Keyboard className="h-4 w-4 text-mint" aria-hidden="true" /> WASD / arrow keys
              </span>
              <span className="flex items-center gap-2">
                <MousePointerClick className="h-4 w-4 text-mint" aria-hidden="true" /> Click to walk
              </span>
              <span className="flex items-center gap-2">
                <AudioLines className="h-4 w-4 text-mint" aria-hidden="true" /> Delta-time movement
              </span>
            </div>
          </div>
        </section>

        {/* Spatial audio */}
        <section id="audio" className="border-y border-white/10 bg-[#071827] px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-2">
            <div>
              <p className="text-[11px] font-extrabold uppercase tracking-[.22em] text-mint">Spatial audio</p>
              <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
                Distance is the volume knob
              </h2>
              <p className="mt-4 text-sm leading-7 text-slate-400">
                Each remote microphone is routed through its own Web Audio gain node. On every
                position update the client recomputes the distance between avatars and applies a
                smooth attenuation curve, so a colleague at the edge of earshot is barely audible
                instead of cutting in and out.
              </p>
              <ul className="mt-6 space-y-3 text-sm text-slate-300">
                {[
                  'Earshot radius of about one zone — roughly 11% of the floor width.',
                  'Gains ramp continuously with distance; no clicks, no hard cuts.',
                  'People in other rooms never enter your audio mix.',
                  'Muting disables the outgoing track and updates the room state.',
                ].map((item) => (
                  <li key={item} className="flex gap-2.5">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-mint" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <div className="relative mx-auto w-full max-w-md rounded-2xl border border-white/10 bg-[#081a27] p-6">
              <div className="relative mx-auto grid h-64 w-64 place-items-center">
                {[
                  { size: '100%', opacity: 'border-mint/15', label: null },
                  { size: '66%', opacity: 'border-mint/25', label: null },
                  { size: '34%', opacity: 'border-mint/40', label: null },
                ].map((ring, index) => (
                  <span
                    key={index}
                    className={`absolute rounded-full border ${ring.opacity}`}
                    style={{ width: ring.size, height: ring.size }}
                    aria-hidden="true"
                  />
                ))}
                <span className="grid h-12 w-12 place-items-center rounded-full border-2 border-mint bg-mint/15 text-sm font-black text-mint">
                  You
                </span>
                <span className="absolute left-[72%] top-[38%] grid h-10 w-10 place-items-center rounded-full border border-white/20 bg-[#10293a] text-xs font-bold">
                  Ana
                </span>
                <span className="absolute left-[18%] top-[68%] grid h-10 w-10 place-items-center rounded-full border border-white/20 bg-[#10293a] text-xs font-bold text-slate-400">
                  Ben
                </span>
                <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-[#0d2a38] px-3 py-1 text-[10px] font-semibold text-mint">
                  earshot boundary
                </span>
              </div>
              <dl className="mt-4 space-y-2 text-xs">
                <div className="flex items-center justify-between rounded-lg bg-white/[0.04] px-3 py-2">
                  <dt className="text-slate-400">Ana · close</dt>
                  <dd className="font-bold text-mint">high gain</dd>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2">
                  <dt className="text-slate-500">Ben · outside earshot</dt>
                  <dd className="font-semibold text-slate-500">silent</dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        {/* Security */}
        <section id="security" className="px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-[11px] font-extrabold uppercase tracking-[.22em] text-mint">Security</p>
                <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">What is actually in place</h2>
              </div>
              <span className="inline-flex w-fit items-center gap-2 rounded-full border border-white/15 px-3 py-1.5 text-[11px] font-semibold text-slate-300">
                <ShieldCheck className="h-4 w-4 text-mint" aria-hidden="true" />
                Account-based, server-authoritative
              </span>
            </div>

            <ul className="mt-8 grid gap-3 md:grid-cols-2">
              {SECURITY.map((item) => (
                <li
                  key={item}
                  className="flex gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3.5 text-xs leading-6 text-slate-300"
                >
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-mint" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>

            <p className="mt-5 max-w-3xl text-[11px] leading-5 text-slate-500">
              Honest scope: audio is full-mesh WebRTC and is relayed only when a TURN server is
              configured. Signal handing and credentials are validated server-side, but ProxiSpeak
              does not claim end-to-end encryption beyond WebRTC&apos;s DTLS-SRTP transport, nor
              enterprise SSO, audit logging or compliance certification.
            </p>
          </div>
        </section>

        {/* CTA */}
        <section className="px-5 pb-20 sm:px-8">
          <div className="mx-auto max-w-6xl overflow-hidden rounded-3xl border border-mint/20 bg-gradient-to-br from-[#0d3541] via-[#0a2433] to-[#081a27] p-8 sm:p-12">
            <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-2xl font-black tracking-tight sm:text-3xl">Your desk is already on the floor</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">
                  Create an account, walk in, and enable your mic when you are ready to talk. Nothing
                  is recorded, and you can leave at any time.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Link
                  to={primaryHref}
                  data-testid="enter-office"
                  className="rounded-xl bg-mint px-5 py-3 text-sm font-extrabold text-ink transition hover:bg-teal-200"
                >
                  {primaryLabel}
                </Link>
                {!user && (
                  <Link
                    to="/login"
                    className="rounded-xl border border-white/25 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/5"
                  >
                    Sign in
                  </Link>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 bg-[#041019] px-5 py-10 sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <Brand subtitle="Geospatial proximity audio" />
            <p className="mt-3 text-xs leading-5 text-slate-500">
              An open virtual-office project: React, Three.js, Socket.IO, WebRTC and Express. Built to
              be inspected, not just demoed.
            </p>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 gap-y-2 text-xs text-slate-400">
            <a href="#product" className="hover:text-mint">Product</a>
            <a href="#how" className="hover:text-mint">How it works</a>
            <a href="#audio" className="hover:text-mint">Spatial audio</a>
            <a href="#security" className="hover:text-mint">Security</a>
            <Link to="/signup" className="hover:text-mint">Create account</Link>
            <Link to="/login" className="hover:text-mint">Sign in</Link>
          </nav>
        </div>
        <div className="mx-auto mt-8 flex max-w-6xl flex-col justify-between gap-2 border-t border-white/5 pt-6 text-[11px] text-slate-600 sm:flex-row">
          <p>© 2026 ProxiSpeak. Virtual office prototype.</p>
          <p>No audio is recorded. Microphone access is requested only on demand.</p>
        </div>
      </footer>
    </div>
  )
}
