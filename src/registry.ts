import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface IPackageMeta {
  latest: string | undefined
  versions: string[]
  /** Publish time per version, epoch ms. */
  time: Map<string, number>
  deprecated: Set<string>
}

/** What goes to disk: the few fields the lens needs, not the full packument. */
interface IStored {
  fetchedAt: number
  etag: string | undefined
  latest: string | undefined
  versions: string[]
  time: Record<string, number>
  deprecated: string[]
}

interface IFullPackument {
  'dist-tags'?: Record<string, string>
  time?: Record<string, string>
  versions?: Record<string, { deprecated?: unknown }>
}

interface IEntry {
  stored: IStored | undefined
  meta: IPackageMeta | undefined
  error: Error | undefined
  pending: boolean
}

const CACHE_VERSION = 1
const MAX_CONCURRENT = 12

function toMeta(stored: IStored): IPackageMeta {
  return {
    latest: stored.latest,
    versions: stored.versions,
    time: new Map(Object.entries(stored.time)),
    deprecated: new Set(stored.deprecated),
  }
}

/**
 * Package metadata with a disk cache.
 *
 * Cached entries are served immediately, even when stale, so lenses show
 * right after a window reload. Stale entries revalidate in the background with
 * `If-None-Match`, which turns an unchanged 30 MB packument into a 304.
 */
export class Registry {
  private entries = new Map<string, IEntry>()
  private active = 0
  private queue: Array<() => void> = []
  private saveTimer: NodeJS.Timeout | undefined
  readonly loaded: Promise<void>

  constructor(
    private cacheFile: string,
    private ttlMs: () => number,
    private onSettled: () => void
  ) {
    this.loaded = this.load()
  }

  /** Cached metadata, an Error, or undefined while the first fetch runs. */
  get(pkg: string, registry: string): IPackageMeta | Error | undefined {
    const base = registry.replace(/\/?$/, '/')
    const key = base + pkg
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { stored: undefined, meta: undefined, error: undefined, pending: false }
      this.entries.set(key, entry)
    }
    if (entry.stored && !entry.meta) entry.meta = toMeta(entry.stored)

    const stale = !entry.stored || Date.now() - entry.stored.fetchedAt > this.ttlMs()
    if (stale && !entry.pending) void this.revalidate(base, pkg, entry)

    return entry.meta ?? entry.error
  }

  clear() {
    this.entries.clear()
    this.scheduleSave()
  }

  private async revalidate(base: string, pkg: string, entry: IEntry) {
    entry.pending = true
    try {
      const result = await this.schedule(() => this.fetch(base, pkg, entry.stored?.etag))
      if (result === 'not-modified' && entry.stored) {
        entry.stored.fetchedAt = Date.now()
      } else if (result instanceof Error) {
        // Keep serving the last good data when offline or the registry errors.
        if (!entry.stored) entry.error = result
      } else if (result !== 'not-modified') {
        entry.stored = result
        entry.meta = toMeta(result)
        entry.error = undefined
      }
    } finally {
      entry.pending = false
      this.scheduleSave()
      this.onSettled()
    }
  }

  private async fetch(base: string, pkg: string, etag: string | undefined): Promise<IStored | Error | 'not-modified'> {
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (etag) headers['If-None-Match'] = etag
      const res = await fetch(base + pkg.replace('/', '%2f'), { headers })
      if (res.status === 304) return 'not-modified'
      if (!res.ok) return new Error(`${res.status} ${res.statusText}`)
      const doc = (await res.json()) as IFullPackument

      const time: Record<string, number> = {}
      for (const [version, iso] of Object.entries(doc.time ?? {})) {
        if (version !== 'created' && version !== 'modified') time[version] = Date.parse(iso)
      }
      const versions = Object.keys(doc.versions ?? {})
      return {
        fetchedAt: Date.now(),
        etag: res.headers.get('etag') ?? undefined,
        latest: doc['dist-tags']?.latest,
        versions,
        time,
        deprecated: versions.filter((v) => doc.versions?.[v]?.deprecated),
      }
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }

  private async schedule<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }

  private async load() {
    try {
      const raw = JSON.parse(await readFile(this.cacheFile, 'utf8')) as {
        version: number
        packages: Record<string, IStored>
      }
      if (raw.version !== CACHE_VERSION) return
      for (const [key, stored] of Object.entries(raw.packages)) {
        if (!this.entries.has(key)) {
          this.entries.set(key, { stored, meta: undefined, error: undefined, pending: false })
        }
      }
    } catch {
      // No cache yet, or unreadable. Start empty.
    }
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.save(), 2000)
  }

  private async save() {
    const packages: Record<string, IStored> = {}
    for (const [key, entry] of this.entries) {
      if (entry.stored) packages[key] = entry.stored
    }
    try {
      await mkdir(dirname(this.cacheFile), { recursive: true })
      await writeFile(this.cacheFile, JSON.stringify({ version: CACHE_VERSION, packages }))
    } catch {
      // The cache is an optimisation; failing to write it is not an error.
    }
  }

  /** Writes any pending cache changes, for deactivate. */
  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      await this.save()
    }
  }
}
