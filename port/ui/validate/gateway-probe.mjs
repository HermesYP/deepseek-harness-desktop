// Gateway bundle-route probe for the assembled run: distinguishes the
// `client-modules: HTML did not preload ...` failure class.
//
// The bundle URL format is upstream's own (comboSearch()/comboUrl() emit
// `plugins/??<spec>&rev=<rev>` — the doubled `??` and the query-position
// specifier are intentional). `rev` is the live graph's revision
// (build-derived — identical builds share it across instances; the test
// placeholder `fx` never matches a live graph): a request under the wrong
// revision answers 404, which says nothing about the fallback. This probe
// therefore requires the real revision (or the exact row URL) and reports
// three outcomes separately:
//
//   javascript      200 + content-type JavaScript   → PASS for this check
//   shell-document  200 + text/html + <!doctype     → the fallback case; the
//                     ONLY outcome that supports the "HTML did not preload"
//                     explanation
//   not-found       404 (empty content-type)        → resource absent at this
//                     exact row URL — most likely the revision does not match
//                     the live graph. NOT the fallback, NOT crash evidence.
//   unexpected      anything else                   → draw no conclusion.
//
// REQUIRED FIRST STEP — baseline against a known-good reference instance; the
// probe may only judge a port after it passes there:
//
//   node validate/gateway-probe.mjs --base http://127.0.0.1:<reference-port> --token <reference token> --rev <reference live revision>
//
// The port under test (same shape):
//
//   node validate/gateway-probe.mjs --base http://127.0.0.1:<gateway-port> --token <launch token> --rev <live revision>
//
// Alternatives for the bundle URL source, in precedence order:
//   --src "<batch.url>"   the exact injection-row URL (e.g. from the dev-only
//                         handoff), resolved as a browser resolves the
//                         `script-src` row against the page URL;
//   --rev <rev>           builds upstream's `plugins/??<spec>&rev=<rev>`;
//   discovered            when the index is readable (token given), the real
//                         `script-src` row of the served page is used.
// With none of these, the probe fails fast instead of issuing a request that
// can only misreport.
const args = process.argv.slice(2)
const option = (name) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const base = option('base')
if (base === undefined) {
  console.error('usage: node validate/gateway-probe.mjs --base http://127.0.0.1:PORT [--token TOKEN] (--rev REV | --src URL)')
  process.exitCode = 2
} else {
  const token = option('token')
  const rev = option('rev')
  const explicitSrc = option('src')
  if (explicitSrc === undefined && (rev === undefined || rev === '') && token === undefined) {
    console.error("revision not supplied: pass --rev <live revision> (the graph's build-derived revision; the row URL is `plugins/??<spec>&rev=<rev>`) or --src <batch.url>, or a token so the served row can be discovered. Refusing to probe without one: a stale revision can only produce a misleading 404.")
    process.exit(2)
  }
  const auth = token === undefined ? '' : `?token=${encodeURIComponent(token)}`
  const pageUrl = `${base}/${auth}`
  const failures = []

  // 1. Read the page the browser reads: the token exchange answers 303 +
  // set-cookie, and the authenticated document (carrying the rendered rows)
  // is the follow-up request with that cookie.
  let index = await fetch(pageUrl, { redirect: 'manual' })
  let cookie = (index.headers.get('set-cookie') ?? '').split(';')[0]
  if (index.status === 303 && cookie !== '') {
    index = await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' })
  }
  const indexBody = await index.text()
  const cookieHeaders = cookie === '' ? {} : { cookie }
  const finalPageUrl = `${base}/`
  let indexVerdict
  if (index.status === 200) {
    indexVerdict = indexBody.includes('__DSH_BOOT_READY__')
      ? 'carries __DSH_BOOT_READY__'
      : (failures.push('the served index does not carry the __DSH_BOOT_READY__ literal'), 'MISSING __DSH_BOOT_READY__')
  } else {
    indexVerdict = `SKIPPED (HTTP ${index.status}; pass --token to verify the index)`
  }
  console.log(`probe: index → ${indexVerdict}`)

  // 2. Determine the bundle request URL without changing upstream's format.
  let bundleUrl
  if (explicitSrc !== undefined) {
    bundleUrl = new URL(explicitSrc, finalPageUrl)
  } else if (rev !== undefined && rev !== '') {
    bundleUrl = new URL(`plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=${encodeURIComponent(rev)}`, finalPageUrl)
  } else if (index.status === 200) {
    // Rendered attributes are HTML-escaped (`escapeHtmlAttribute` in
    // packages/host/webserver/src/injections.ts); a browser decodes entities
    // before resolving `script.src`, so the extraction must too.
    const decodeAttribute = value => value
      .replaceAll('&amp;', '&').replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    const rows = [...indexBody.matchAll(/<script[^>]*\ssrc="([^"]+)"/gu)].map(match => decodeAttribute(match[1]))
    const row = rows.find(candidate => candidate.includes('dsh-client-modules/client.js'))
    if (row !== undefined) bundleUrl = new URL(row, finalPageUrl)
  }
  if (bundleUrl === undefined) {
    console.error('no bundle row URL: the served page carries no bootstrap script-src row and no --rev/--src was given. Refusing to probe without one: a stale revision can only produce a misleading 404.')
    process.exit(2)
  } else {
    // 3. Classify the response strictly.
    const bundle = await fetch(bundleUrl, { headers: cookieHeaders })
    const body = await bundle.text()
    const type = bundle.headers.get('content-type') ?? ''
    const looksLikeHtml = type.includes('text/html') || /^\s*<(!doctype|html)/iu.test(body)
    const looksLikeJs = type.includes('javascript') && !looksLikeHtml
    let outcome
    if (bundle.status === 200 && looksLikeJs) outcome = 'javascript'
    else if (bundle.status === 200 && looksLikeHtml) outcome = 'shell-document'
    else if (bundle.status === 404) outcome = 'not-found'
    else outcome = 'unexpected'
    console.log(`probe: ${bundleUrl.href} → HTTP ${bundle.status} content-type=${JSON.stringify(type)} outcome=${outcome} first-bytes=${JSON.stringify(body.slice(0, 40))}`)
    if (outcome === 'javascript') {
      if (!body.includes('createClientModuleSystem')) {
        failures.push('200/JavaScript but the body is not the module-system client bundle')
      } else {
        console.log('probe: bootstrap bundle route returns JavaScript — the fallback discriminator did not fire')
      }
    }
    if (outcome === 'shell-document') {
      failures.push('the bootstrap row URL answered with the SHELL DOCUMENT (200 + text/html + <!doctype body) — this is the fallback case and reproduces "client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js"')
    }
    if (outcome === 'not-found') {
      failures.push(`the bootstrap row URL answered HTTP 404 with an empty content-type — the resource is absent at exactly ${bundleUrl.href}. Most likely the revision does not match this instance's live graph (rev is build-derived; the placeholder 'fx' never matches). This is NOT the shell-document fallback and is NOT evidence of the crash.`)
    }
    if (outcome === 'unexpected') {
      failures.push(`unexpected response (HTTP ${bundle.status}, content-type ${JSON.stringify(type)}). Neither served JavaScript nor the shell-document fallback; draw no conclusion from this.`)
    }
  }

  if (failures.length > 0) {
    console.error(`gateway-probe: FAILED\n${failures.join('\n')}`)
    process.exitCode = 1
  } else {
    console.log('gateway-probe: PASS — bootstrap row URL returns JavaScript (and the index checks, where readable)')
  }
}
