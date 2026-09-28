import { APP_TAGLINE } from '../config/gameConfig.js'
import amonguscharacter from '../assets/amonguscharacter.png'

export default function Header() {
  return (
    <header className="text-center">
      <div className="flex items-center justify-center gap-4">
        <img
          src={amonguscharacter}
          alt=""
          aria-hidden
          className="h-12 w-12 object-contain sm:h-[3.75rem] sm:w-[3.75rem] md:h-[4.5rem] md:w-[4.5rem]"
        />
        <h1 className="font-display font-bold text-5xl leading-none tracking-wide text-gradient-gold text-shadow-pirate sm:text-6xl md:text-7xl">
          Vent-Roullete
        </h1>
      </div>
      <p className="mt-4 text-lg font-medium text-slate-400">{APP_TAGLINE}</p>
      <div aria-hidden className="mx-auto mt-6 h-px w-40 bg-gradient-to-r from-transparent via-gold to-transparent" />
    </header>
  )
}