import assert from 'node:assert/strict'
import { test } from 'node:test'
import { engineLaunchUrl } from '../src/launch-url.mjs'

const origin = 'http://127.0.0.1:4173'
const entry = (url = `${origin}/?token=test-only`, open = true) => ({ label: 'test provider', url, open })
function context(entries, base = origin) {
  const webServer = { getOrigin: () => base }
  const ctx = {
    emit(owner, event, root, target) {
      assert.equal(owner, webServer)
      assert.equal(event, 'webserver/entry-url')
      assert.equal(root, `${base}/`)
      target.push(...entries)
    },
  }
  return { ctx, webServer }
}

test('collects the local login URL from the WebServer Token provider', () => {
  const { ctx, webServer } = context([entry()])
  assert.equal(engineLaunchUrl(ctx, webServer), entry().url)
})

test('rejects entry URLs outside the local application or without one nonempty token', () => {
  for (const candidate of [
    entry('https://example.com/?token=test-only'),
    entry(`${origin}/other?token=test-only`),
    entry(`${origin}/`),
    entry(`${origin}/?token=`),
    entry(`${origin}/?token=a&token=b`),
    entry(`${origin}/?token=test-only`, false),
    entry('invalid url'),
  ]) {
    const { ctx, webServer } = context([candidate])
    assert.throws(() => engineLaunchUrl(ctx, webServer), /unique authenticated local launch URL/u)
  }
})

test('fails closed when no provider or multiple eligible providers contribute a login URL', () => {
  for (const entries of [[], [entry(), entry(`${origin}/?token=another-test-value`)]]) {
    const { ctx, webServer } = context(entries)
    assert.throws(() => engineLaunchUrl(ctx, webServer), /unique authenticated local launch URL/u)
  }
})

test('refuses a non-loopback WebServer origin', () => {
  const { ctx, webServer } = context([], 'https://example.com')
  assert.throws(() => engineLaunchUrl(ctx, webServer), /loopback/u)
})
