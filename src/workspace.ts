import semver from 'semver'
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml'

export interface ICatalogEntry {
  /** Registry package name, with any `npm:` alias resolved. */
  pkg: string
  /** Version or range, without the alias prefix. */
  spec: string
  /** `npm:<pkg>@` for aliased entries, empty otherwise. */
  aliasPrefix: string
  quote: '' | "'" | '"'
  /** Offset of the entry's key, where the lens goes. */
  keyOffset: number
  /** Offsets of the value as written, quotes included. */
  valueStart: number
  valueEnd: number
}

export interface IPolicy {
  /** From `minimumReleaseAge` in minutes, undefined when the file doesn't set it. */
  minimumReleaseAge: number | undefined
  exclude: string[]
}

export interface IWorkspace {
  entries: ICatalogEntry[]
  policy: IPolicy
}

const SKIPPED_PROTOCOLS = /^(workspace|link|file|catalog|git|github|https?|portal):/

function parseSpec(value: string): Pick<ICatalogEntry, 'pkg' | 'spec' | 'aliasPrefix'> | null {
  if (value.startsWith('npm:')) {
    const rest = value.slice(4)
    const at = rest.lastIndexOf('@')
    if (at <= 0) return null
    const pkg = rest.slice(0, at)
    return { pkg, spec: rest.slice(at + 1), aliasPrefix: `npm:${pkg}@` }
  }
  if (SKIPPED_PROTOCOLS.test(value)) return null
  return { pkg: '', spec: value, aliasPrefix: '' }
}

function collect(map: YAMLMap, text: string, out: ICatalogEntry[]) {
  for (const pair of map.items) {
    if (!isScalar(pair.key) || !isScalar(pair.value)) continue
    const name = String(pair.key.value)
    const keyRange = pair.key.range
    const valueRange = pair.value.range
    if (!keyRange || !valueRange) continue

    const parsed = parseSpec(String(pair.value.value))
    if (!parsed || !semver.validRange(parsed.spec)) continue

    const first = text[valueRange[0]]
    out.push({
      ...parsed,
      pkg: parsed.pkg || name,
      quote: first === "'" || first === '"' ? first : '',
      keyOffset: keyRange[0],
      valueStart: valueRange[0],
      valueEnd: valueRange[1],
    })
  }
}

export function parseWorkspace(text: string): IWorkspace {
  const doc = parseDocument(text)
  const entries: ICatalogEntry[] = []

  const catalog = doc.get('catalog', true)
  if (isMap(catalog)) collect(catalog, text, entries)

  const catalogs = doc.get('catalogs', true)
  if (isMap(catalogs)) {
    for (const pair of catalogs.items) {
      if (isMap(pair.value)) collect(pair.value, text, entries)
    }
  }

  const age = doc.get('minimumReleaseAge')
  const exclude = doc.get('minimumReleaseAgeExclude', true)

  return {
    entries,
    policy: {
      minimumReleaseAge: typeof age === 'number' ? age : undefined,
      exclude: isSeq(exclude)
        ? exclude.items.flatMap((item) => (isScalar(item) ? [String(item.value)] : []))
        : [],
    },
  }
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/**
 * Mirrors pnpm's `minimumReleaseAgeExclude`: `name`, `@scope/*`, or
 * `name@1.2.3 || 1.2.4` to exempt specific versions only.
 */
export function isExcluded(exclude: string[], pkg: string, version: string): boolean {
  return exclude.some((entry) => {
    const at = entry.lastIndexOf('@')
    if (at <= 0) return wildcard(entry).test(pkg)
    const versions = entry.slice(at + 1).split('||').map((v) => v.trim())
    return wildcard(entry.slice(0, at)).test(pkg) && versions.includes(version)
  })
}
