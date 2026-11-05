import { execFile } from 'node:child_process'

/** What pnpm itself reports for a workspace folder. */
export interface IPnpmConfig {
  /** Undefined when pnpm isn't on PATH. */
  version: string | undefined
  /** From pnpm config (global rc, .npmrc, env). Undefined when unset. */
  minimumReleaseAge: number | undefined
  exclude: string[]
  registry: string
}

export interface IAgePolicy {
  minutes: number
  /** Human-readable origin of the value, shown in lens tooltips. */
  source: string
}

const FALLBACK_REGISTRY = 'https://registry.npmjs.org/'

function run(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'pnpm',
      args,
      { cwd, timeout: 10_000, shell: process.platform === 'win32' },
      (error, stdout) => resolve(error ? undefined : stdout.trim())
    )
  })
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Runs the pnpm queries in parallel, about 25 ms each. */
export async function readPnpmConfig(cwd: string): Promise<IPnpmConfig> {
  const [version, age, exclude, registry] = await Promise.all([
    run(cwd, ['--version']),
    run(cwd, ['config', 'get', 'minimumReleaseAge', '--json']),
    run(cwd, ['config', 'get', 'minimumReleaseAgeExclude', '--json']),
    run(cwd, ['config', 'get', 'registry']),
  ])
  const ageValue = parseJson(age)
  const excludeValue = parseJson(exclude)
  return {
    version,
    minimumReleaseAge: typeof ageValue === 'number' ? ageValue : undefined,
    exclude: Array.isArray(excludeValue) ? excludeValue.map(String) : [],
    registry: registry && /^https?:\/\//.test(registry) ? registry : FALLBACK_REGISTRY,
  }
}

/**
 * The same order pnpm uses: the workspace file, then pnpm config, then
 * pnpm's built-in default (1 day since pnpm 11, off before that).
 */
export function resolveAgePolicy(fromWorkspaceFile: number | undefined, pnpm: IPnpmConfig | undefined): IAgePolicy {
  if (fromWorkspaceFile !== undefined) {
    return { minutes: fromWorkspaceFile, source: 'minimumReleaseAge in pnpm-workspace.yaml' }
  }
  if (pnpm?.minimumReleaseAge !== undefined) {
    return { minutes: pnpm.minimumReleaseAge, source: 'minimumReleaseAge in your pnpm config' }
  }
  if (!pnpm?.version) {
    return { minutes: 1440, source: 'pnpm not found on PATH, assuming the pnpm 11+ default of 1 day' }
  }
  const major = Number(pnpm.version.split('.')[0])
  return major >= 11
    ? { minutes: 1440, source: `pnpm ${pnpm.version} default (1 day)` }
    : { minutes: 0, source: `pnpm ${pnpm.version} has no default release-age check` }
}
