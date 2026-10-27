import { Link } from 'react-router-dom'
import { AudioLines } from 'lucide-react'

export default function Brand({ to = '/', subtitle = null, size = 'md' }) {
  const mark = size === 'sm' ? 'h-8 w-8' : 'h-10 w-10'
  const title = size === 'sm' ? 'text-base' : 'text-lg'

  return (
    <Link to={to} className="group inline-flex items-center gap-3 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-mint">
      <span
        className={`${mark} grid place-items-center rounded-xl bg-gradient-to-br from-mint to-teal-500 text-ink shadow-lg shadow-mint/10`}
        aria-hidden="true"
      >
        <AudioLines className="h-5 w-5" strokeWidth={2.5} />
      </span>
      <span className="leading-tight">
        <span className={`${title} block font-extrabold tracking-tight text-white`}>
          Proxi<span className="text-mint">Speak</span>
        </span>
        {subtitle && <span className="block text-[11px] font-medium text-slate-400">{subtitle}</span>}
      </span>
    </Link>
  )
}
