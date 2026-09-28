import { NavLink } from 'react-router-dom'
import { APP_NAME } from '../config/gameConfig.js'
import amongus from '../assets/amonguscharacter.png'

const brandLinkClass = 'flex items-center gap-2'
const navLinkClass = ({ isActive }) =>
  `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
    isActive
      ? 'bg-gold/15 text-gold-light'
      : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
  }`

export default function Layout({ children }) {
  return (
    <div className="relative min-h-screen bg-abyss-900 text-slate-300">
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 bg-[url('/ocean-bg.svg')] bg-cover bg-center opacity-25" />
        <div className="absolute inset-0 bg-gradient-to-b from-abyss-900/70 via-transparent to-abyss-900/80" />
      </div>

      <nav className="sticky top-0 z-20 border-b border-white/10 bg-abyss-950/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3">
          <NavLink to="/" className={brandLinkClass}>
            <img src={amongus} alt="" aria-hidden className="h-6 w-6 object-contain" />
            <span className="font-display text-xl tracking-wide text-gradient-gold">
              {APP_NAME}
            </span>
          </NavLink>
          <div className="flex gap-1">
            <NavLink to="/" className={navLinkClass} end>
              Claim
            </NavLink>
            <NavLink to="/admin" className={navLinkClass}>
              Admin Deck
            </NavLink>
          </div>
        </div>
      </nav>

      <main className="relative z-10 mx-auto w-full max-w-6xl px-4 pb-20 pt-10">
        {children}
      </main>

      <footer className="relative z-10 border-t border-white/10 py-6 text-center text-xs text-slate-500">
        <img src={amongus} alt="" aria-hidden className="mr-1 -mt-0.5 inline-block h-3 w-3 object-contain" />
        ReQuest — Guess who fired the shot! · Fair winds and empty pockets
      </footer>
    </div>
  )
}