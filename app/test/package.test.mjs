import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { join, posix, resolve } from 'node:path'
import { FileMatcher, getNodeModuleFileMatcher } from 'app-builder-lib/out/fileMatcher.js'
import { parse } from 'yaml'

test('packaged auto-updates use the Fei-Craft GitHub release feed', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  assert.deepEqual(config.publish, { provider: 'github', owner: 'Fei-Craft', repo: 'DS-Bot' })
})

const linkedPackagePath = (packages, location) => {
  let path = location
  while (packages[path]?.link === true) path = packages[path].resolved
  return path
}

const resolveLockedDependency = (packages, ownerPath, name) => {
  let owner = linkedPackagePath(packages, ownerPath)
  while (true) {
    const candidate = owner ? `${owner}/node_modules/${name}` : `node_modules/${name}`
    if (packages[candidate] !== undefined) return candidate
    if (!owner) return undefined
    owner = posix.dirname(owner)
    if (owner === '.') owner = ''
  }
}

const productionClosure = (packages) => {
  const root = packages['']
  const queue = []
  const visited = new Set()
  for (const name of [...Object.keys(root.dependencies ?? {}), ...Object.keys(root.optionalDependencies ?? {})]) {
    const path = resolveLockedDependency(packages, '', name)
    assert.ok(path !== undefined, `missing production dependency ${name}`)
    queue.push(path)
  }
  while (queue.length > 0) {
    const requestedPath = queue.pop()
    const path = linkedPackagePath(packages, requestedPath)
    if (visited.has(path)) continue
    visited.add(path)
    const entry = packages[path]
    assert.ok(entry !== undefined, `missing linked package ${path}`)
    for (const name of Object.keys(entry.dependencies ?? {})) {
      const dependency = resolveLockedDependency(packages, path, name)
      if (dependency === undefined && entry.optional) continue
      assert.ok(dependency !== undefined, `${path} is missing production dependency ${name}`)
      queue.push(dependency)
    }
    for (const name of Object.keys(entry.optionalDependencies ?? {})) {
      const dependency = resolveLockedDependency(packages, path, name)
      if (dependency !== undefined) queue.push(dependency)
    }
  }
  return visited
}

const peerOnlyPackages = (packages) => {
  const production = productionClosure(packages)
  return Object.entries(packages)
    .filter(([path, entry]) => path !== '' && entry.peer && !entry.dev && !entry.devOptional && !production.has(linkedPackagePath(packages, path)))
    .map(([path, entry]) => `${path.replace(/^.*node_modules\//u, '')}@${entry.version}`)
    .sort()
}

test('peer-only packages are excluded from the packaged production dependency graph', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
  assert.deepEqual(peerOnlyPackages(lock.packages), [], 'add these to "dependencies" in app/package.json')
})

test('peer-only check distinguishes packages also present in the production graph', () => {
  const packages = {
    '': { dependencies: { consumer: '1.0.0' } },
    'node_modules/consumer': { version: '1.0.0', peerDependencies: { runtime: '*' } },
    'node_modules/runtime': { version: '1.0.0', peer: true },
  }
  assert.deepEqual(peerOnlyPackages(packages), ['runtime@1.0.0'])

  packages[''].dependencies.runtime = '1.0.0'
  assert.deepEqual(peerOnlyPackages(packages), [])
})

test('production dependency check keeps missing required dependencies visible', () => {
  const packages = {
    '': { dependencies: { runtime: '1.0.0' } },
    'node_modules/runtime': { version: '1.0.0', dependencies: { native: '1.0.0' } },
  }
  assert.throws(() => peerOnlyPackages(packages), /missing production dependency native/u)
  packages['node_modules/runtime'].optional = true
  assert.deepEqual(peerOnlyPackages(packages), [])
})

test('sharp native modules and versioned libvips libraries are unpacked together', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  const root = resolve('app-fixture')
  const filter = new FileMatcher(root, root, value => value, config.asarUnpack).createFilter()
  const stat = { isDirectory: () => false }
  for (const file of [
    '@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.5.node',
    '@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.7',
    '@img/sharp-linux-arm64/lib/sharp-linux-arm64.node',
    '@img/sharp-libvips-linux-arm64/lib/libvips-cpp.so.8.18.7',
    '@img/sharp-libvips-linuxmusl-x64/lib/libvips-cpp.so.8.18.7',
    '@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.7.dylib',
    '@img/sharp-win32-x64/lib/libvips-42.dll',
    'pnpm/bin/pnpm.cjs',
    'ds-bot/src/host/skills/ds-bot-maintenance/references/online-inspection.md',
    'ds-bot/src/host/skills/ds-bot-plugin-dev/references/capabilities-and-mcp.md',
    'ds-bot/src/host/skills/ds-bot-manual/SKILL.md',
    'ds-bot/src/host/skills/ds-bot-manual/references/settings.md',
  ]) assert.equal(filter(join(root, 'node_modules', file), stat), true, file)
  assert.equal(filter(join(root, 'node_modules/yaml/dist/index.js'), stat), false)
})

// The kit resolves its engine package and starts the program in it. Electron cannot start a
// program by a path inside the asar, so every file preview failed (#679).
test('the LibreOffice engine ships as plain files beside the asar, the kit inside it', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  const root = resolve('app-fixture')
  const stat = { isDirectory: () => false }
  const modules = getNodeModuleFileMatcher(root, root, value => value, {}, { config, debugLogger: { isEnabled: false } }).createFilter()
  const packed = file => modules(join(root, 'node_modules', file), { ...stat, moduleFullFilePath: join('node_modules', file) })
  for (const engine of ['win32-x64', 'win32-arm64', 'darwin-arm64', 'darwin-x64', 'wasm']) {
    assert.equal(packed(`@deepseek-ai/libreoffice-kit-${engine}/package.json`), false, engine)
  }
  assert.equal(packed('@deepseek-ai/libreoffice-kit/lib/index.js'), true)
  assert.equal(packed('yaml/dist/index.js'), true)

  const beside = config.extraResources.find(set => set.to === 'node_modules/@deepseek-ai')
  const extra = new FileMatcher(join(root, beside.from), beside.to, value => value, beside.filter).createFilter()
  assert.equal(extra(join(root, beside.from, 'libreoffice-kit-win32-x64/bin/libreoffice-kit.exe'), stat), true)
  assert.equal(extra(join(root, beside.from, 'libreoffice-kit/lib/index.js'), stat), false)
})

// The Cua Driver SDK passes its DLL's path, derived from its own module, to Windows' loader,
// which cannot open a file inside the asar (#1025).
test('on Windows the Cua Driver SDK and its runtime ship as plain files beside the asar', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  const root = resolve('app-fixture')
  const stat = { isDirectory: () => false }
  const modules = getNodeModuleFileMatcher(root, root, value => value, config.win, { config, debugLogger: { isEnabled: false } }).createFilter()
  const packed = file => modules(join(root, 'node_modules', file), { ...stat, moduleFullFilePath: join('node_modules', file) })
  for (const file of ['@trycua/cua-driver/dist/native/node-runtime.js', '@trycua/cua-driver-win32-x64-msvc/cua_driver_sdk.dll', '@ubjs/node/index.js', '@ubjs/core/package.json']) {
    assert.equal(packed(file), false, file)
  }
  assert.equal(packed('@deepseek-ai/dsh-experimental-computer-use-cua-driver-native/lib/index.js'), true)
  for (const scope of ['@trycua', '@ubjs']) {
    const beside = config.win.extraResources.find(set => set.to === `node_modules/${scope}`)
    assert.equal(beside?.from, `node_modules/${scope}`, scope)
  }
})

test('Linux leaves the Host and its dependencies readable by plain Node', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  assert.equal(config.linux.asar, false)
  assert.notEqual(config.mac.asar, false)
  assert.notEqual(config.win.asar, false)
})

// A release is tagged with the version of ds-bot, and the installed apps compare their own
// version with the one in the release's latest.yml.
test('the app has the version of ds-bot', () => {
  const version = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')).version
  assert.equal(version('../package.json'), version('../../ds-bot/package.json'))
})

// Tool processes (bash, scripts a Bot runs) connect to devices on the local network;
// macOS blocks them outright when Info.plist has no NSLocalNetworkUsageDescription.
test('the mac package asks macOS for local network access', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  assert.equal(typeof config.mac?.extendInfo?.NSLocalNetworkUsageDescription, 'string')
  assert.notEqual(config.mac.extendInfo.NSLocalNetworkUsageDescription.trim(), '')
})
