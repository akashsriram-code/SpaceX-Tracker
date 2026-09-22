import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

type Tone =
  | 'neutral'
  | 'accent'
  | 'amber'
  | 'emerald'
  | 'crimson'
  | 'violet'

const TONES: Record<Tone, string> = {
  neutral: 'bg-white/5 text-white/60 border-white/10',
  accent: 'bg-accent/10 text-accent border-accent/25',
  amber: 'bg-amber/10 text-amber border-amber/25',
  emerald: 'bg-emerald/10 text-emerald border-emerald/25',
  crimson: 'bg-crimson/10 text-crimson border-crimson/25',
  violet: 'bg-violet/10 text-violet border-violet/25',
}

export function Badge({
  children,
  tone = 'neutral',
  className,
  mono,
  title,
}: {
  children: ReactNode
  tone?: Tone
  className?: string
  mono?: boolean
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[0.68rem] font-semibold leading-tight whitespace-nowrap',
        mono && 'font-mono tnum',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
