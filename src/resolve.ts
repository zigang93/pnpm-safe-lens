import semver from 'semver'

import type { IPackageMeta } from './registry'
import { isExcluded } from './workspace'

export interface IVersionInfo {
  version: string
  publishedAt: Date | undefined
}

export interface IAnalysis {
  /** The pinned version, when the spec is exact. */
  current: IVersionInfo | undefined
  /** True when pnpm would refuse to install the pinned version. */
  currentBlocked: boolean
  /** Newest version pnpm will install today. */
  safe: IVersionInfo | undefined
  /** Newest version overall on the same track, which may still be too new. */
  newest: IVersionInfo | undefined
}

/**
 * Stable entries stay on stable releases up to the `latest` dist-tag.
 * Prerelease entries (e.g. 1.0.0-rc.5) also see later prereleases with the
 * same tag and numeric ids, plus stable releases.
 */
function onTrack(meta: IPackageMeta, current: string | undefined, version: string): boolean {
  if (meta.deprecated.has(version)) return false
  const pre = semver.prerelease(version)
  if (!pre) {
    return !meta.latest || semver.prerelease(meta.latest) !== null || semver.lte(version, meta.latest)
  }
  const currentPre = current ? semver.prerelease(current) : null
  // Skip snapshot builds such as 1.0.0-rc.5-ab785fc: only rc.6-style ids count.
  const clean = pre.slice(1).every((id) => typeof id === 'number')
  return currentPre !== null && pre[0] === currentPre[0] && clean
}

export function analyze(
  meta: IPackageMeta,
  pkg: string,
  spec: string,
  minimumReleaseAgeMinutes: number,
  exclude: string[],
  now = Date.now()
): IAnalysis {
  const cutoff = now - minimumReleaseAgeMinutes * 60_000
  const info = (version: string): IVersionInfo => {
    const published = meta.time.get(version)
    return { version, publishedAt: published === undefined ? undefined : new Date(published) }
  }
  const oldEnough = (version: string) => {
    if (isExcluded(exclude, pkg, version)) return true
    const published = meta.time.get(version)
    return published !== undefined && published <= cutoff
  }

  const exact = semver.valid(spec) ?? undefined
  const track = meta.versions
    .filter((v) => semver.valid(v) && onTrack(meta, exact, v))
    .sort(semver.rcompare)
  // A range keeps its own bounds, so suggest only versions it accepts.
  const candidates = exact ? track : track.filter((v) => semver.satisfies(v, spec, { includePrerelease: false }))

  const safe = candidates.find(oldEnough)
  const newest = candidates[0]

  return {
    current: exact ? info(exact) : undefined,
    currentBlocked: exact ? !oldEnough(exact) : false,
    safe: safe ? info(safe) : undefined,
    newest: newest ? info(newest) : undefined,
  }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const UNITS: Array<[string, number]> = [
  ['y', 365 * DAY],
  ['mo', 30 * DAY],
  ['d', DAY],
  ['h', HOUR],
  ['m', MINUTE],
]

/** The two largest units: `1d 11h`, `2mo 3d`, `1y 2mo`, `45m`. */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return '<1m'
  const index = UNITS.findIndex(([, size]) => ms >= size)
  const [unit, size] = UNITS[index]!
  const major = Math.floor(ms / size)
  const next = UNITS[index + 1]
  const minor = next ? Math.floor((ms - major * size) / next[1]) : 0
  return next && minor > 0 ? `${major}${unit} ${minor}${next[0]}` : `${major}${unit}`
}
