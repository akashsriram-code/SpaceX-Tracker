import { format } from 'date-fns'
import { ExternalLink, MapPin, Orbit, Play, Rocket } from 'lucide-react'
import {
  boosterLabel,
  hasKnownSerial,
  isStarlinkMission,
  outcomeOf,
  primaryCustomer,
} from '../lib/launch'
import type { Launch, Outcome } from '../lib/types'
import { cn, hostOf } from '../lib/utils'
import { vehicleColor } from '../lib/vehicles'
import { Badge } from './ui/Badge'

const OUTCOME_META: Record<
  Outcome,
  { label: string; tone: 'emerald' | 'crimson' | 'amber' | 'accent' }
> = {
  success: { label: 'Success', tone: 'emerald' },
  failure: { label: 'Failure', tone: 'crimson' },
  partial: { label: 'Partial', tone: 'amber' },
  pending: { label: 'Scheduled', tone: 'accent' },
}

/** Sleek rocket silhouette shown when LL2 has no mission patch. */
function PatchFallback() {
  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-gradient-to-br from-white/[0.07] to-transparent">
      <Rocket className="size-5 text-white/25" aria-hidden />
    </div>
  )
}

function Patch({ url, alt }: { url: string | null; alt: string }) {
  if (!url) return <PatchFallback />
  return (
    <img
      src={url}
      alt={`${alt} mission patch`}
      loading="lazy"
      className="size-12 shrink-0 rounded-lg object-contain"
      onError={(e) => {
        // Patch URLs occasionally 404 on LL2's CDN; degrade to the silhouette.
        e.currentTarget.style.display = 'none'
      }}
    />
  )
}

function linkIcon(url: string) {
  const h = hostOf(url)
  if (/youtube|youtu\.be/.test(h)) return { Icon: Play, label: 'Webcast' }
  if (/wikipedia/.test(h)) return { Icon: ExternalLink, label: 'Wikipedia' }
  if (/reddit/.test(h)) return { Icon: ExternalLink, label: 'Reddit' }
  return { Icon: ExternalLink, label: h }
}

export function LaunchCard({
  launch,
  onOpen,
}: {
  launch: Launch
  onOpen: (l: Launch) => void
}) {
  const outcome = outcomeOf(launch)
  const meta = OUTCOME_META[outcome]
  const spineColor = vehicleColor(launch.rocketName)
  const starlink = isStarlinkMission(launch)
  const netDate = new Date(launch.net)
  const validDate = !Number.isNaN(netDate.getTime())

  const booster = launch.boosters[0]
  const landingKnown = booster?.landingAttempt === true
  const landed = booster?.landingSuccess

  // One webcast + one reference link keeps the footer from wrapping.
  const webcast = launch.vidUrls[0]
  const info = launch.infoUrls[0]

  return (
    <article
      className={cn(
        'panel panel-hover group relative flex flex-col overflow-hidden text-left',
      )}
    >
      {/* Vehicle spine — colour encodes the launch vehicle (see the legend
          above the grid and the "Vehicle mix" chart, which share this
          palette). Outcome is carried by the badge in the header instead. */}
      <span
        aria-hidden
        className="absolute top-0 left-0 h-full w-[3px]"
        style={{ background: spineColor }}
      />

      <button
        onClick={() => onOpen(launch)}
        className="flex flex-1 flex-col gap-3 p-4 pl-5 text-left"
        aria-label={`Open details for ${launch.missionName ?? launch.name}`}
      >
        {/* Header: flight no. + date + outcome */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-[0.7rem] tnum text-white/35">
              {validDate ? format(netDate, 'd MMM yyyy · HH:mm') : 'Date TBD'}
              {validDate && <span className="text-white/20"> UTC</span>}
            </p>
            {validDate && (
              <p className="font-mono text-[0.65rem] tnum text-white/20">
                {format(netDate, 'HH:mm zzz')} local
              </p>
            )}
          </div>
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </div>

        {/* Patch + mission identity */}
        <div className="flex items-start gap-3">
          <Patch url={launch.patchUrl} alt={launch.missionName ?? launch.name} />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-white/90 transition-colors group-hover:text-accent">
              {launch.missionName ?? launch.name}
            </h3>
            {/* Vehicle is a primary axis of the grid now, so it's tinted to
                match the spine rather than rendered as muted metadata. */}
            <p
              className="mt-1 flex items-center gap-1 truncate text-[0.72rem] font-semibold"
              style={{ color: spineColor }}
            >
              <Rocket className="size-3 shrink-0 opacity-80" aria-hidden />
              {launch.rocketFullName ?? launch.rocketName ?? 'Unknown vehicle'}
            </p>
          </div>
        </div>

        {/* Tags */}
        <div className="flex flex-wrap gap-1.5">
          {starlink ? (
            <Badge tone="violet">Starlink</Badge>
          ) : (
            <Badge tone="neutral" title="Derived from mission metadata">
              {primaryCustomer(launch)}
            </Badge>
          )}
          {launch.orbitAbbrev && (
            <Badge tone="accent" mono>
              <Orbit className="size-3" aria-hidden />
              {launch.orbitAbbrev}
            </Badge>
          )}
          {hasKnownSerial(booster?.serial ?? null) && (
            <Badge
              tone={landed === true ? 'emerald' : landed === false ? 'crimson' : 'neutral'}
              mono
              title={
                landingKnown
                  ? `${booster.landingType ?? 'Landing'} · ${booster.landingLocation ?? 'unknown site'}`
                  : 'No landing attempt recorded'
              }
            >
              {boosterLabel(booster.serial, booster.flightNumber)}
            </Badge>
          )}
          {launch.boosters.length > 1 && (
            <Badge tone="neutral" mono>
              +{launch.boosters.length - 1} core
              {launch.boosters.length > 2 ? 's' : ''}
            </Badge>
          )}
        </div>

        {/* Pad + landing */}
        <div className="mt-auto space-y-1 text-[0.7rem] text-white/45">
          <p className="flex items-center gap-1.5 truncate">
            <MapPin className="size-3 shrink-0 text-white/25" aria-hidden />
            {launch.padName ?? 'Pad TBD'}
          </p>
          {landingKnown && (
            <p className="flex items-center gap-1.5 truncate">
              <span
                aria-hidden
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  landed === true
                    ? 'bg-emerald'
                    : landed === false
                      ? 'bg-crimson'
                      : 'bg-white/30',
                )}
              />
              {landed === true
                ? 'Recovered'
                : landed === false
                  ? 'Landing failed'
                  : 'Landing pending'}
              {booster?.landingType && (
                <span className="text-white/25">· {booster.landingType}</span>
              )}
            </p>
          )}
        </div>
      </button>

      {/* Media footer — outside the main button so links stay independently clickable */}
      {(webcast || info) && (
        <div className="flex items-center gap-3 border-t border-white/[0.07] px-5 py-2">
          {webcast && (
            <a
              href={webcast.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[0.68rem] text-white/40 transition-colors hover:text-accent"
            >
              {(() => {
                const { Icon } = linkIcon(webcast.url)
                return <Icon className="size-3" aria-hidden />
              })()}
              Webcast
            </a>
          )}
          {info && (
            <a
              href={info.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 truncate text-[0.68rem] text-white/40 transition-colors hover:text-accent"
            >
              <ExternalLink className="size-3 shrink-0" aria-hidden />
              {hostOf(info.url)}
            </a>
          )}
        </div>
      )}
    </article>
  )
}
