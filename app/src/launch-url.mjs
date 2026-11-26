// Token login belongs to the engine's authentication provider. The shell only
// accepts one provider URL for its own loopback application.
export function engineLaunchUrl(ctx, webServer) {
  const root = new URL('/', webServer.getOrigin())
  if (!['http:', 'https:'].includes(root.protocol) || !['127.0.0.1', '[::1]'].includes(root.hostname)) {
    throw new Error('The engine web server must listen on a loopback origin')
  }
  const entries = []
  ctx.emit(webServer, 'webserver/entry-url', root.href, entries)
  const matches = entries.filter(entry => {
    if (entry.open !== true) return false
    try {
      const url = new URL(entry.url)
      return url.origin === root.origin && url.pathname === root.pathname
        && url.searchParams.getAll('token').length === 1 && Boolean(url.searchParams.get('token'))
    } catch { return false }
  })
  if (matches.length !== 1) throw new Error('The engine did not supply a unique authenticated local launch URL')
  return matches[0].url
}
