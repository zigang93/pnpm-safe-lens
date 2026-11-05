# Changelog

## 0.4.1

- Shorter labels show up-to-date status or clickable safe updates, without release ages.
- Blocked updates show an unblock countdown that refreshes every minute and becomes a clickable update once allowed.
- Updated demo screenshot and animation show a real one-click update alongside blocked versions.

## 0.4.0

First public release.

- Code lenses on every `catalog:` and `catalogs:` entry in `pnpm-workspace.yaml` showing the newest version pnpm will install under `minimumReleaseAge`.
- The release-age window comes from `pnpm-workspace.yaml`, then your pnpm config, then pnpm's built-in default.
- Honours `minimumReleaseAgeExclude`, including `@scope/*` and `name@version` entries.
- Supports `npm:` aliases, `^`/`~` ranges and prerelease tracks, and skips deprecated versions and snapshot builds.
- One click updates the entry in place.
- Package data is cached on disk and revalidated with ETags, so lenses appear in about 30 ms after a window reload.
