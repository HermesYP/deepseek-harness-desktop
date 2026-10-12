/** The external browser cannot use the renderer gateway's private cookie. */
export function desktopCallbackOrigin(ctx, requestedOrigin, loginSource, environment = process.env) {
  if (loginSource !== 'desktop' || !environment.DSH_DESKTOP_CONTROL_SOCKET) return requestedOrigin
  const port = ctx.get('webServer')?.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('desktop account: callback listener unavailable')
  }
  // This is the existing Host route: state, code, method, duplicates, phase,
  // cancellation and the PKCE verifier remain checked by the account provider.
  return `http://127.0.0.1:${port}`
}
