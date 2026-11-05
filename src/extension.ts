import { dirname } from "node:path";

import semver from "semver";
import * as vscode from "vscode";

import { readPnpmConfig, resolveAgePolicy, type IPnpmConfig } from "./pnpm";
import { Registry } from "./registry";
import { analyze, formatDuration, type IVersionInfo } from "./resolve";
import { parseWorkspace, type ICatalogEntry } from "./workspace";

const SELECTOR: vscode.DocumentSelector = { language: "yaml", pattern: "**/pnpm-workspace.yaml" };
const APPLY = "pnpmSafeLens.apply";
const PNPM_CONFIG_KEY = "pnpmConfig:";

function config() {
  return vscode.workspace.getConfiguration("pnpmSafeLens");
}

class SafeLensProvider implements vscode.CodeLensProvider {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private timer: NodeJS.Timeout | undefined;
  private cacheLoaded = false;
  private readonly countdownTimer: NodeJS.Timeout;
  /** pnpm config per workspace folder. Read once per session, persisted for the next boot. */
  private pnpmConfigs = new Map<string, IPnpmConfig>();
  private pnpmRefreshed = new Set<string>();
  readonly registry: Registry;

  constructor(
    cacheFile: string,
    private state: vscode.Memento,
  ) {
    // Recompute eligibility as time passes, even when registry data is cached.
    this.countdownTimer = setInterval(() => this.changed.fire(), 60_000);
    this.registry = new Registry(
      cacheFile,
      // At least a minute, or every redraw would start another fetch.
      () => Math.max(1, config().get("cacheTtlMinutes", 30)) * 60_000,
      () => this.refreshSoon(),
    );
    void this.registry.loaded.then(() => {
      this.cacheLoaded = true;
      this.changed.fire();
    });
  }

  refreshSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.changed.fire(), 150);
  }

  dispose() {
    clearInterval(this.countdownTimer);
    clearTimeout(this.timer);
    this.changed.dispose();
  }

  reset() {
    this.registry.clear();
    this.pnpmConfigs.clear();
    this.pnpmRefreshed.clear();
    this.refreshSoon();
  }

  private pnpmConfig(folder: string): IPnpmConfig | undefined {
    if (!this.pnpmRefreshed.has(folder)) {
      this.pnpmRefreshed.add(folder);
      void readPnpmConfig(folder).then((value) => {
        this.pnpmConfigs.set(folder, value);
        void this.state.update(PNPM_CONFIG_KEY + folder, value);
        this.refreshSoon();
      });
    }
    return this.pnpmConfigs.get(folder) ?? this.state.get<IPnpmConfig>(PNPM_CONFIG_KEY + folder);
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!config().get("enabled", true)) return [];
    // Wait for the disk cache (a few ms) and, on the very first run, pnpm's config.
    const pnpm = this.pnpmConfig(dirname(document.uri.fsPath));
    if (!this.cacheLoaded || !pnpm) return [];

    let workspace;
    try {
      workspace = parseWorkspace(document.getText());
    } catch {
      return [];
    }

    const policy = resolveAgePolicy(workspace.policy.minimumReleaseAge, pnpm);
    const exclude = [...workspace.policy.exclude, ...pnpm.exclude];
    const tooltip = `Release-age window: ${formatDuration(policy.minutes * 60_000)} (${policy.source})`;

    return workspace.entries.flatMap((entry) => {
      const position = document.positionAt(entry.keyOffset);
      const range = new vscode.Range(position, position);
      const lens = (title: string, command = "", args?: unknown[]) =>
        new vscode.CodeLens(range, { title, command, arguments: args, tooltip });

      const meta = this.registry.get(entry.pkg, pnpm.registry);
      if (meta === undefined) return [lens(`$(sync~spin) checking ${entry.pkg}…`)];
      if (meta instanceof Error) return [lens(`$(error) ${entry.pkg}: ${meta.message}`)];

      const result = analyze(meta, entry.pkg, entry.spec, policy.minutes, exclude);
      const apply = (version: string) => [document.uri, entry, nextSpec(entry.spec, version)];
      const unlocksIn = (info: IVersionInfo) => {
        if (!info.publishedAt) return "no publish time";
        const clearsAt = info.publishedAt.getTime() + policy.minutes * 60_000;
        return `unlocks in ${formatDuration(clearsAt - Date.now())}`;
      };
      const waits = (info: IVersionInfo) => `${info.version} blocked · ${unlocksIn(info)}`;
      const { current, safe, newest } = result;
      const blockedNewer =
        newest && safe && semver.gt(newest.version, safe.version) ? newest : undefined;

      // Range entries, e.g. ^6.0.2
      if (!current) {
        if (!safe)
          return [lens(`$(warning) ${entry.spec} blocked · too new for pnpm`)];
        const lenses = [lens(`$(check) resolves to ${safe.version}`)];
        if (blockedNewer) lenses.push(lens(`$(clock) ${waits(blockedNewer)}`));
        return lenses;
      }

      if (result.currentBlocked) {
        const lenses = [
          lens(`$(warning) too new for pnpm · ${unlocksIn(current)}`),
        ];
        if (safe)
          lenses.push(
            lens(`$(arrow-down) use ${safe.version}`, APPLY, apply(safe.version)),
          );
        return lenses;
      }

      const lenses = [];
      if (safe && semver.gt(safe.version, current.version)) {
        lenses.push(
          lens(`$(arrow-up) update to ${safe.version}`, APPLY, apply(safe.version)),
        );
      } else {
        lenses.push(lens(`$(check) up to date`));
      }
      if (blockedNewer && semver.gt(blockedNewer.version, current.version)) {
        lenses.push(lens(`$(clock) ${waits(blockedNewer)}`));
      }
      return lenses;
    });
  }
}

/** Keeps a leading ^ or ~ when the entry is a range. */
function nextSpec(spec: string, version: string): string {
  const operator = /^[\^~]/.exec(spec)?.[0] ?? "";
  return operator + version;
}

let activeProvider: SafeLensProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  const provider = new SafeLensProvider(
    vscode.Uri.joinPath(context.globalStorageUri, "registry-cache.json").fsPath,
    context.globalState,
  );
  activeProvider = provider;

  context.subscriptions.push(
    provider,
    vscode.languages.registerCodeLensProvider(SELECTOR, provider),
    vscode.commands.registerCommand(
      APPLY,
      async (uri: vscode.Uri, entry: ICatalogEntry, spec: string) => {
        const document = await vscode.workspace.openTextDocument(uri);
        const range = new vscode.Range(
          document.positionAt(entry.valueStart),
          document.positionAt(entry.valueEnd),
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, range, `${entry.quote}${entry.aliasPrefix}${spec}${entry.quote}`);
        await vscode.workspace.applyEdit(edit);
      },
    ),
    vscode.commands.registerCommand("pnpmSafeLens.refresh", () => provider.reset()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("pnpmSafeLens")) provider.refreshSoon();
    }),
  );
}

export async function deactivate() {
  await activeProvider?.registry.flush();
}
