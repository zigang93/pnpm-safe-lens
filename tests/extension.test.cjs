const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { test } = require('node:test')
const vm = require('node:vm')

// Exercise the bundled provider and registered update command with a fake VS Code host.
test('countdowns refresh, unlock into clickable updates, and stop on disposal', async () => {
  let provider, tick, intervalCleared = false, fires = 0, appliedText
  let now = 10_000_000
  const commands = new Map()
  const context = { exports: {} }
  const disposable = { dispose() {} }
  const document = {
    uri: { fsPath: '/demo/pnpm-workspace.yaml' },
    getText: () => 'minimumReleaseAge: 60\ncatalog:\n  demo: 1.0.0\n',
    positionAt: offset => offset,
  }
  const vscode = {
    EventEmitter: class { event = () => {}; fire() { fires++ } dispose() {} },
    Range: class {},
    CodeLens: class { constructor(range, command) { this.command = command } },
    Uri: { joinPath: () => ({ fsPath: '/unused/pnpm-safe-lens-test-cache.json' }) },
    languages: { registerCodeLensProvider: (_, value) => { provider = value; return disposable } },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable } },
    WorkspaceEdit: class { replace(uri, range, text) { this.text = text } },
    workspace: {
      getConfiguration: () => ({ get: (_, fallback) => fallback }),
      onDidChangeConfiguration: () => disposable,
      openTextDocument: async () => document,
      applyEdit: async edit => { appliedText = edit.text; return true },
    },
  }
  class Clock extends Date { static now() { return now } }
  vm.runInNewContext(readFileSync(new URL('../dist/extension.js', `file://${__filename}`), 'utf8'), {
    module: context, exports: context.exports,
    require: name => name === 'vscode' ? vscode : require(name),
    process, console, Buffer, Date: Clock,
    setTimeout: () => 2, clearTimeout() {},
    setInterval: (callback, milliseconds) => { assert.equal(milliseconds, 60_000); tick = callback; return 1 },
    clearInterval: () => { intervalCleared = true },
  })
  const subscriptions = []
  context.exports.activate({ globalStorageUri: {}, globalState: { get() {}, update: async () => {} }, subscriptions })
  await provider.registry.loaded
  provider.pnpmConfigs.set('/demo', { version: '12.0.0', minimumReleaseAge: 60, exclude: [], registry: 'https://registry.npmjs.org/' })
  provider.pnpmRefreshed.add('/demo')
  provider.registry.get = () => ({
    latest: '1.1.0', versions: ['1.0.0', '1.1.0'],
    time: new Map([['1.0.0', 2_800_000], ['1.1.0', 6_460_000]]), deprecated: new Set(),
  })

  const before = provider.provideCodeLenses(document)
  assert.equal(before[0].command.title, '$(check) up to date')
  assert.match(before[1].command.title, /1.1.0 blocked · unlocks in 1m/)
  assert.equal(before[1].command.command, '')
  now += 30_000
  tick()
  assert.match(provider.provideCodeLenses(document)[1].command.title, /unlocks in <1m/)
  now += 30_000
  const previousFires = fires
  tick()
  assert.equal(fires, previousFires + 1)
  const after = provider.provideCodeLenses(document)
  assert.equal(after.length, 1)
  assert.equal(after[0].command.title, '$(arrow-up) update to 1.1.0')
  assert.equal(after[0].command.command, 'pnpmSafeLens.apply')
  await commands.get('pnpmSafeLens.apply')(...after[0].command.arguments)
  assert.equal(appliedText, '1.1.0')
  assert.ok(subscriptions.includes(provider))
  provider.dispose()
  assert.equal(intervalCleared, true)
})
