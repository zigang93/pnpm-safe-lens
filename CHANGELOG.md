# Changelog

## 0.4.0

First public release.

- Code lenses on every `catalog:` and `catalogs:` entry in `pnpm-workspace.yaml` showing the newest version pnpm will install under `minimumReleaseAge`.
- The release-age window comes from `pnpm-workspace.yaml`, then your pnpm config, then pnpm's built-in default.
- Honours `minimumReleaseAgeExclude`, including `@scope/*` and `name@version` entries.
- Supports `npm:` aliases, `^`/`~` ranges and prerelease tracks, and skips deprecated versions and snapshot builds.
- One click updates the entry in place.
- Package data is cached on disk and revalidated with ETags, so lenses appear in about 30 ms after a window reload.
