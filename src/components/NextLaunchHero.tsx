import { format } from 'date-fns'
import { Clock, MapPin, Radio, Rocket } from 'lucide-react'
import { pad2, useCountdown } from '../hooks/useCountdown'
import { hasPreciseNet, isStarlinkMission, primaryCustomer } from '../lib/launch'
import type { Launch } from '../lib/types'
import { Badge } from './ui/Badge'

function Digit({ value, unit }: { value: string; unit: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="font-mono text-3xl font-bold tnum text-accent sm:text-5xl">
        {value}
      </span>
      <span className="label-caps mt-1">{unit}</span>
    </div>
  )
}

const Sep = () => (
  <span
    aria-hidden
    className="font-mono text-2xl font-bold text-white/15 sm:text-4xl"
  >
    :
  </span>
)

export function NextLaunchHero({
  launch,
  onOpen,
}: {
  launch: Launch | null
  onOpen: (launch: Launch) => void
}) {
  // A "Quarter 2 2027"-precision NET can't honestly drive a second-by-second
  // clock, so only tick when LL2 says the time is actually pinned down.
  const precise = launch ? hasPreciseNet(launch) : false
  const countdown = useCountdown(precise && launch ? launch.net : null)

  if (!launch) {
    return (
      <section className="panel p-6">
        <span className="label-caps">Next Launch</span>
        <p className="mt-3 text-sm text-white/50">
          No upcoming SpaceX launch in the current snapshot.
        </p>
      </section>
    )
  }

  const netDate = new Date(launch.net)
  const validDate = !Number.isNaN(netDate.getTime())
  const isStarlink = isStarlinkMission(launch)

  return (
    <section className="panel relative overflow-hidden p-5 sm:p-7">
      {/* Accent wash behind the countdown */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full bg-accent/10 blur-3xl"
      />

      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label-caps">Next Launch</span>
            <Badge tone="accent">
              <Radio className="size-3" aria-hidden />
              {launch.status.name}
            </Badge>
            {isStarlink && (
              <Badge tone="violet">
                <Satellite />
                Starlink
              </Badge>
            )}
          </div>

          <button
            onClick={() => onOpen(launch)}
            className="mt-2 block max-w-full text-left"
          >
            <h2 className="truncate text-xl font-bold text-white transition-colors hover:text-accent sm:text-3xl">
              {launch.missionName ?? launch.name}
            </h2>
          </button>

          <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-white/55">
            <div className="flex items-center gap-1.5">
              <Rocket className="size-3.5 text-white/30" aria-hidden />
              <dt className="sr-only">Rocket</dt>
              <dd>{launch.rocketFullName ?? launch.rocketName ?? 'TBD'}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <MapPin className="size-3.5 text-white/30" aria-hidden />
              <dt className="sr-only">Launch site</dt>
              <dd>{launch.padName ?? 'TBD'}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <Clock className="size-3.5 text-white/30" aria-hidden />
              <dt className="sr-only">Launch time</dt>
              <dd className="font-mono tnum">
                {validDate
                  ? `${format(netDate, "d MMM yyyy · HH:mm")} UTC`
                  : 'TBD'}
              </dd>
            </div>
          </dl>

          <p className="mt-3 text-[0.7rem] text-white/35">
            Customer (derived):{' '}
            <span className="text-white/60">{primaryCustomer(launch)}</span>
            {validDate && (
              <>
                {' · '}Local:{' '}
                <span className="font-mono tnum text-white/60">
                  {format(netDate, 'd MMM HH:mm zzz')}
                </span>
              </>
            )}
          </p>
        </div>

        {/* T-minus readout */}
        <div className="shrink-0 lg:pl-8 lg:border-l lg:border-white/10">
          {countdown ? (
            <>
              <p className="label-caps mb-2 text-center lg:text-left">
                {countdown.elapsed ? 'T-plus (awaiting update)' : 'T-minus'}
              </p>
              <div className="flex items-end justify-center gap-2 sm:gap-3">
                <Digit value={pad2(countdown.days)} unit="days" />
                <Sep />
                <Digit value={pad2(countdown.hours)} unit="hrs" />
                <Sep />
                <Digit value={pad2(countdown.minutes)} unit="min" />
                <Sep />
                <Digit value={pad2(countdown.seconds)} unit="sec" />
              </div>
            </>
          ) : (
            <div className="text-center lg:text-left">
              <p className="label-caps mb-2">Target</p>
              <p className="font-mono text-2xl font-bold text-amber">
                {launch.netPrecision ?? 'TBD'}
              </p>
              <p className="mt-1 max-w-[16rem] text-[0.7rem] leading-snug text-white/40">
                Date not yet precise enough for a countdown.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

/** Small inline satellite glyph (lucide's Satellite, sized for a badge). */
function Satellite() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3"
      aria-hidden
    >
      <path d="M13 7 9 3 5 7l4 4" />
      <path d="m17 11 4 4-4 4-4-4" />
      <path d="m8 12 4 4" />
      <path d="m16 8-4-4" />
      <path d="M9 21a6 6 0 0 0-6-6" />
    </svg>
  )
}
