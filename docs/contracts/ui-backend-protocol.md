# UI ↔ Backend Protocol (SHARED INTERFACE SPECIFICATION)

Binding wire contract between the preserved React UI (`apps/web`, `packages/client/*`) and the DeepSeek Harness backend ("Host"), traced from the reference checkout `_upstream/` at commit `477b4f420553e8a52c2fbccc464d7561b239c443`. All paths are relative to `_upstream/` unless prefixed otherwise. Anything not determinable from source is marked **NOT DETERMINED FROM SOURCE**.

## 1. Transport summary

The browser UI talks to the Host over exactly three carriers: (a) unary RPC as JSON `POST` requests below the `/api` prefix (`packages/client/connection/src/api-path.ts:7`, `packages/client/connection/src/rpc-host.ts:222-268`); (b) exact HTTP "Fetch routes" below `/api` (and a few named webserver routes) for binary upload/download and streaming bodies (`packages/client/connection/src/rpc.ts:137-163`); and (c) one multiplexed WebSocket at `/api/remote.mux` carrying every long-lived Remote stream, each multiplexed into logical streams keyed by a client-minted `streamId` (`packages/api/gateway/src/stream-protocol.ts:7`, `packages/api/gateway/src/client/stream-client.ts`). Authentication is a browser-session cookie issued through a one-time launch-token exchange on `GET /` (`packages/client/connection/src/browser-auth.ts:223-300`); every `/api` request and the WebSocket upgrade passes a Host/Origin trust fence plus that cookie (`packages/client/connection/src/api-request-trust.ts:91-118`, `packages/client/connection/src/rpc-host.ts:104-113`). Session streaming (assistant chunks, tool calls, journal events) rides logical Remote streams whose items are correlated by per-Session `seq` numbers and per-attempt `attemptId`/`revision`/`index` fields (`packages/api/session-controller/src/types.ts:425-563`).

## 2. HTTP API surface

The "remote BFF" is `@deepseek-ai/dsh-api-gateway` (`packages/api/gateway/`), which claims unary endpoints on the shared `/api` RPC channel via `ctx.connection.rpc.intercept('/api', ...)` (`packages/api/gateway/src/index.ts:232-238`) and opens its Remote stream mux as a webserver upgrade route (`packages/api/gateway/src/index.ts:239-276`). The HTTP server itself is `@deepseek-ai/dsh-host-webserver` (`packages/host/webserver/src/index.ts`), which matches exact routes first, then longest prefix, then one fallback seat (`packages/host/webserver/src/index.ts:318-328`); the fallback seat in the shipped Web composition is `@deepseek-ai/dsh-host-frontend-static`, which serves the SPA dist and the rendered index (`packages/host/frontend-static/src/index.ts:108-140`).

### 2.1 Route table (Host webserver)

| Method(s) | Path | Kind | Owner | Request | Response | Auth |
|---|---|---|---|---|---|---|
| POST | `/api/<namespace>/<method>` | prefix `/api` | `client-connection` + `api-gateway` interceptor (`packages/client/connection/src/index.ts:144-158`, `packages/api/gateway/src/index.ts:232-238`) | JSON `ClientRequest` envelope (§3.1) | JSON `ServerResponse` envelope (§3.2), or `multipart/form-data` when the result carries binary attachments (§3.3) | trust fence + cookie (`packages/client/connection/src/rpc-host.ts:181-188`) |
| POST | `/api/$events/result` | prefix `/api` | `api-gateway` (endpoint constant `REMOTE_EVENT_RESULT_ENDPOINT`, `packages/api/gateway/src/stream-protocol.ts:13`) | JSON `ClientRequest` whose `payload.args` is a `RemoteEventResult` (§5.2) | JSON `ServerResponse` with `result.value` absent on success | trust fence + cookie |
| GET, HEAD | `/api/file` | exact Fetch route | `SessionMediaReferences` (`packages/api/session-controller/src/media-references.ts:66-77`) | query-addressed file reference (media/image read; body `buffered`, unused) | file bytes with MIME; error statuses 413/499/500 mapping (`packages/api/session-controller/src/media-references.ts:55-58`) | trust fence + cookie (all `/api` Fetch routes run behind `connection.admit`, `packages/client/connection/src/rpc-host.ts:130-150`) |
| POST | `/api/session/uploadFileBinary` | exact Fetch route | `FileUploads` (`packages/client/file-upload/src/index.ts:72-80`; path constant `FILE_UPLOAD_PATH`, `packages/client/file-upload/src/protocol.ts:2`) | raw request body, `requestBody: 'streaming'` (no aggregate body cap; backpressure applies, `packages/client/connection/src/rpc.ts:149`) | upload receipt JSON — exact response fields **NOT DETERMINED FROM SOURCE** (handler `handleFileUploadHttp`, `packages/client/file-upload/src/index.ts:77`) | trust fence + cookie |
| GET, HEAD | `/api/session.export` | exact Fetch route | `session-log-export` (`packages/session-query/session-log-export/src/index.ts:87-101`; path constant `packages/session-query/session-log-export/src/routes.ts:8`) | query selects Session (see `sessionLogExportResponse`, `packages/session-query/session-log-export/src/index.ts:108+`) | ZIP archive bytes; HEAD returns status+headers only | trust fence + cookie |
| GET | `/api/present.host` | exact Fetch route | `registerPresentOpen` (`packages/client/ui-deliverables/src/present-open.ts:21-25`) | none | JSON `PresentedHost` (`packages/client/ui-deliverables/src/presented.ts:25-29`) with `cache-control: no-store` | trust fence + cookie |
| GET, POST | `/api/present.open` | exact Fetch route | `packages/client/ui-deliverables/src/present-open.ts:36-53` | query `sessionId`, `seq`, `index`, `action=open|reveal`, optional `application` (`present-open.ts:104-128`) | GET: JSON application list; POST: `204` empty; `400/404/409/422/500` failures (`present-open.ts:62-70`) | trust fence + cookie |
| GET | `/api/changes.summary` | exact Fetch route | `packages/client/ui-deliverables/src/present-open.ts:26-29` | query `sessionId`, `seq` | JSON `ChangesSummary` (`packages/client/ui-deliverables/src/changes.ts:29-30`), `404` when unknown | trust fence + cookie |
| GET | `/api/changes.diff` | exact Fetch route | `packages/client/ui-deliverables/src/present-open.ts:36-53` | query `sessionId`, `seq`, `index` | JSON `WorkspaceFileDiff` (type in `@deepseek-ai/dsh-workspace-changes/types`, imported `packages/client/ui-deliverables/src/changes.ts:4`) | trust fence + cookie |
| GET, POST | `/api/changes.open` | exact Fetch route | `packages/client/ui-deliverables/src/present-open.ts:36-53` | query coordinates + `action=open|reveal` | like `/api/present.open` | trust fence + cookie |
| GET (Upgrade) | `/api/remote.mux` | exact upgrade route | `api-gateway` (`REMOTE_STREAM_MUX_PATH`, `packages/api/gateway/src/stream-protocol.ts:7`; registered `packages/api/gateway/src/index.ts:250-262`) | HTTP Upgrade; frames per §4 | WebSocket text frames per §4 | `connection.admit(req)` on the upgrade; `401/403` HTTP rejection otherwise (`packages/api/gateway/src/index.ts:253-257`, `packages/api/gateway/src/stream-server.ts:433-444`) |
| GET | `/plugins/<resource>` | prefix `/plugins` | `client-modules` bundle server (`PLUGIN_ROUTE = '/plugins'`, `packages/client/modules/src/index.ts:225`, registered `:649`) | revisioned combo script / source-map URLs from the boot graph | JS bundle bytes with immutable cache headers (Electron strips `cache-control` for `/plugins/`, `apps/desktop/src/web-document.ts:64-71`) | none beyond the Electron forwarding (see §7.3); served web deployment: route is behind the same webserver, but non-index assets are documented public (`packages/host/frontend-static/src/index.ts:8-10`) |
| GET | `/plugins/events` | exact route | `client-hmr` SSE (`EVENTS_ENDPOINT`, `packages/client/hmr/src/events.ts:44`; registered `packages/client/hmr/src/index.ts:181`) | SSE stream | SSE frames `PluginsEventFrame` = `{type:'graph',graph}` | {type:'rebuilt',id,rev}` (`packages/client/hmr/src/events.ts:11-14`) | **NOT DETERMINED FROM SOURCE** (registration body not fully read) |
| GET | `/open-in-app/apps` | exact route | `host-open-in-app` (`packages/host/open-in-app/src/index.ts:193-204`) | none | JSON `{ apps: string[] }` (`packages/host/open-in-app/src/shared.ts:29-31`) | `connection.requestRejection` fence (401/403), `packages/host/open-in-app/src/index.ts:185-191` |
| GET | `/open-in-app/icon/<id>` | prefix route | `packages/host/open-in-app/src/index.ts:206-239` | application id in path | PNG bytes (`cache-control: public, max-age=3600`) or JSON 404 `{code,message}` | same fence |
| POST | `/open-in-app/open` | exact route | `packages/host/open-in-app/src/index.ts:241+` | JSON `OpenInAppOpenPayload` (`packages/host/open-in-app/src/shared.ts:34-35`) | **NOT DETERMINED FROM SOURCE** (response body not read) | same fence |
| GET | `/oauth/callback` | exact route | `deepseek-account-platform` sign-in callback (`packages/credentials/deepseek-account-platform/src/index.ts:526-544`) | query `code`, `state` (constant-time state check) | holds response until sign-in settles; `400/410` on invalid/stale | state parameter, not the cookie fence (it is reached by the platform redirect) |
| any | `/webhook/...` (github) | route registered per config | `webhook-github` (`packages/webhook/webhook-github/src/index.ts:59`) | **NOT DETERMINED FROM SOURCE** | **NOT DETERMINED FROM SOURCE** | **NOT DETERMINED FROM SOURCE** |
| GET, HEAD | `/`, `/index.html`, everything unmatched | fallback seat | `frontend-static` (`packages/host/frontend-static/src/index.ts:121-139`) | pathname | rendered `index.html` (§7) or static dist bytes; `405` non-GET/HEAD, `403` traversal, `404` miss (`packages/host/frontend-static/src/index.ts:71-106`) | index only: `connection.authorizeIndex` (§2.2); other static assets are public (`packages/host/frontend-static/src/index.ts:8-10`) |

### 2.2 Authentication (exact behaviour)

`ctx.connection.authenticatedUrl(baseUrl)` appends exactly one `token` query parameter carrying the process launch token (`packages/client/connection/src/rpc.ts:231-237`, `packages/client/connection/src/browser-auth.ts:223-227`; query name `TOKEN_QUERY = 'token'`, `browser-auth.ts:15`). `authorizeIndex()` (`browser-auth.ts:238-280`): on `GET /` with exactly one `token` whose value matches the process launch token (timing-safe compare, `browser-auth.ts:100-104`), it mints an HMAC-SHA256-signed, authority-bound session cookie and answers `303` to `./` with `set-cookie` (`browser-auth.ts:244-264`); on `GET /` with a valid cookie plus any token it answers `303` to `./` without a cookie (`browser-auth.ts:265-273`); every other request receives `401` with body `dsh web authentication required; reopen the URL printed by dsh web.` (`browser-auth.ts:302-310`); a request with a valid cookie and no token serves the index (`browser-auth.ts:277`). The cookie is `dsh-auth-<base64url(sha256(authority))>=v1.<base64url(payload)>.<base64url(hmac)>` with payload `{version:1, authority, issuedAt, expiresAt}`, `HttpOnly; SameSite=Strict; Path=/`, lifetime `cookieMaxAgeDays` (default 30) (`browser-auth.ts:27-32,106-131`, `packages/client/connection/src/index.ts:113`). `/api` admission is `requestRejection()`: Host/Origin trust fence first (`isTrustedApiRequest`, `packages/client/connection/src/api-request-trust.ts:91-118` — Host header must be loopback or a declared `trustedHosts` authority, `sec-fetch-site: cross-site` refused, `Origin` when present must equal the Host authority), then cookie verification (`isAuthenticated`, `browser-auth.ts:287-300`); results in `403` (fence) or `401` (no valid cookie) with body `forbidden`/`unauthorized` (`packages/client/connection/src/index.ts:150-154`).

## 3. Unary RPC protocol (`/api` channel)

### 3.1 Request envelope (browser → Host)

Declared `ClientRequest` in `packages/client/connection/src/rpc.ts:79-85`, validated by `clientRequestSchema` (`packages/client/connection/src/rpc-schema.ts:35-40`):

```typescript
export interface ClientRequest {
  readonly type: 'client-request'
  readonly rpcId: RpcId          // Branded<'rpc-id'>; client-minted UUID (packages/client/connection/src/client/rpc.ts:39, random-uuid.ts)
  readonly method: string        // MUST equal the request path below /api (rpc-host.ts:252-258)
  readonly payload: unknown      // for Remote calls: exactly { args: { <wireField>: value, ... } } (packages/api/gateway/src/index.ts:1125-1133)
}
```

Example (`POST /api/session/follow` — note the payload wraps named wire arguments in `args`):

```json
{ "type": "client-request", "rpcId": "b3c1…uuid", "method": "session/follow", "payload": { "args": { "address": { "kind": "session", "sessionId": "s-1" }, "assistantStream": true } } }
```

The endpoint is the path below `/api`, exactly `<namespace>/<method>` with each segment matching `[A-Za-z0-9_$.-]+` (`packages/client/connection/src/rpc-host.ts:36,280-289`); the Gateway claims exactly the two-segment endpoints it has Typert definitions for (`packages/api/gateway/src/index.ts:313-320`), so the endpoint catalog itself is generated from `@Remote` declarations (see `_upstream/docs/api-gateway.md`); enumerating every concrete `<namespace>/<method>` pair from source is **NOT DETERMINED FROM SOURCE** at spec time (it is composition-dependent). Request media type must be `application/json` or the response is `415` (`rpc-host.ts:235-238`); a non-JSON body is `400` (`rpc-host.ts:241-245`); a malformed envelope is answered with a `server-response` carrying `rpcId: "invalid-request"` (or the raw string id) and error `gateway/bad-request` (`rpc-host.ts:270-278`). Content-type mismatch of `message.method` vs path yields error `gateway/bad-request` (`rpc-host.ts:252-258`).

### 3.2 Response envelope (Host → browser)

Declared `ServerResponse`/`ConnectionRpcResult`/`ConnectionRpcFailure` in `packages/client/connection/src/rpc.ts:19-28,87-92`:

```typescript
export interface ConnectionRpcFailure { readonly code: string; readonly message: string; readonly details: object }
export type ConnectionRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ConnectionRpcFailure }
export interface ServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcId        // echoed from the request (correlation; mismatch throws client-side, packages/client/connection/src/client/rpc.ts:66-68)
  readonly result: ConnectionRpcResult<unknown>
}
```

```json
{ "type": "server-response", "rpcId": "b3c1…uuid", "result": { "ok": true, "value": { "header": { "id": "s-1" }, "cursor": 42 } } }
```

A void/absent business result omits `value` entirely (JSON has no `undefined`) (`packages/api/gateway/src/index.ts:676-679`). Failures use the shared Remote vocabulary; Gateway infrastructure codes are `gateway/ambiguous-endpoint`, `gateway/arguments-invalid`, `gateway/binding-invalid`, `gateway/context-{failed,not-found,unavailable}`, `gateway/definition-unavailable`, `gateway/input-invalid`, `gateway/invocation-unavailable`, `gateway/lookup-{failed,not-found,unavailable}`, `gateway/method-unavailable`, `gateway/protocol`, `gateway/provider-mismatch`, `gateway/result-invalid`, `gateway/service-unavailable`, `gateway/signature-invalid`, `gateway/uplink-overflow`, plus `gateway/bad-request`, `gateway/internal`, `gateway/cancelled` at the carriers (`packages/api/gateway/src/remote-error-codes.ts:15-36`, `packages/client/connection/src/rpc.ts:56-65`, `packages/api/gateway/src/index.ts:1202-1205`); business error codes are owner-defined (`RemoteError` in `@deepseek-ai/dsh-typert-protocol`).

### 3.3 Binary attachments (multipart success)

When a result contains `Uint8Array` values they are replaced by `null` placeholders at recorded paths and the response becomes `multipart/form-data` with one `bytes-<n>` part per attachment plus a `metadata` JSON string carrying the envelope and `attachments: [{path, codec:'bytes', part}]` (`packages/client/connection/src/rpc-host.ts:295-312`). The client rehydrates each placeholder at `path` (relative to `result.value`) with the part bytes and rejects any structural violation (`packages/client/connection/src/client/rpc.ts:83-139`). Correlation stays `rpcId`-based in both forms.

## 4. WebSocket stream protocol (`/api/remote.mux`)

### 4.1 URL, handshake, auth, subprotocols

URL: `ws(s)://<authority>/api/remote.mux`, resolved document-relative from `document.baseURI`, or against `globalThis.__DSH_TRANSPORT__.streamBaseUrl` when a shell supplies one (`packages/api/gateway/src/client/stream-client.ts:472-480`); `http(s):` maps to `ws(s):`. No WebSocket subprotocols are negotiated: the client constructs `new WebSocket(url)` with no protocol list (`stream-client.ts:227`) and the `ws` `WebSocketServer({noServer:true})` accepts without a `handleProtocols` hook (`packages/api/gateway/src/stream-server.ts:44,71-88`) — **no `Sec-WebSocket-Protocol` header is required or returned** (protocol negotiation behaviour beyond this is NOT DETERMINED FROM SOURCE). Admission is HTTP-level: the Host upgrade handler runs `connection.admit(req)` (Host/Origin fence + cookie, §2.2) and refuses with `HTTP/1.1 401 Unauthorized` or `403 Forbidden` written to the socket (`packages/api/gateway/src/index.ts:250-259`, `packages/api/gateway/src/stream-server.ts:433-444`). In the Electron shell the WebSocket leaves the page origin `dsh-app://app` and Chromium cannot carry the Host cookie, so Electron's session hook rewrites `Origin` to the Host origin and injects the stored cookie for `ws://127.0.0.1/*` before the request leaves (`apps/desktop/src/main.ts:665-676`) — a Rust shell must reproduce this or equivalent cookie/origin handling.

Keepalive: the Host sends WebSocket Ping every `websocketHeartbeatIntervalMs` (default 2000 ms) and terminates a socket after `MAX_MISSED_HEARTBEATS = 2` unanswered pings (`packages/api/gateway/src/stream-server.ts:40,104-124`, `packages/api/gateway/src/index.ts:136,146-150`). Only text (JSON) frames are legal; a binary frame closes the socket with `1003` and an unparsable request closes with `1008` (`stream-server.ts:150-160`). Client close codes observed: `4000` on manual reconnect, `4002` on an invalid server frame, `1000` on dispose (`stream-client.ts:82,320,221`); server close codes: `1001 'peer left'` when the admitted Peer's scope is disposed (`stream-server.ts:410-420`), `1011` when a terminal failure frame cannot be delivered (`stream-server.ts:263-272`).

### 4.2 Message envelope and correlation

Every frame is a JSON object typed by `RemoteStreamClientMessage` / `RemoteStreamServerMessage` (`packages/api/gateway/src/stream-protocol.ts:234-257`), validated exactly (no extra keys) by `parseRemoteStreamClientMessage` / `parseRemoteStreamServerMessage` (`stream-protocol.ts:264-315`). Logical streams are correlated by a client-minted non-empty `streamId` (UUID, `stream-client.ts:106`); multiple concurrent logical streams share one socket (the "mux"); each stream carries at most one in-flight downlink item sequence and an optional client uplink. There are no sequence numbers on the mux itself — ordering per `streamId` is the socket's send order, and retransmission/gap repair belongs to the domain layer (§6).

```typescript
// packages/api/gateway/src/stream-protocol.ts:234-257
export type RemoteStreamClientMessage =
  | { readonly type: 'open'; readonly streamId: string; readonly endpoint: string; readonly payload: unknown }
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }   // one uplink item
  | { readonly type: 'end'; readonly streamId: string }                              // uplink half-close
  | { readonly type: 'cancel'; readonly streamId: string }                           // cancel the logical stream
export interface RemoteStreamFailure { readonly code: string; readonly message: string; readonly details: object }
export type RemoteStreamServerMessage =
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }   // one downlink item
  | { readonly type: 'error'; readonly streamId: string; readonly error: RemoteStreamFailure }  // terminal
  | { readonly type: 'end'; readonly streamId: string }                              // terminal success
```

```json
{ "type": "open", "streamId": "f00…uuid", "endpoint": "session/follow", "payload": { "args": { "address": { "kind": "session", "sessionId": "s-1" }, "assistantStream": true } } }
```

```json
{ "type": "item", "streamId": "f00…uuid", "value": { "type": "snapshot", "header": { "id": "s-1" }, "cursor": 42, "records": [], "hasMore": false, "projections": {} } }
```

Protocol rules (all from `packages/api/gateway/src/stream-server.ts`): `open.payload` must be exactly one plain-object `args` field (`packages/api/gateway/src/index.ts:1114-1134`); a duplicate `open` for the same `streamId` is the one violation that closes the whole socket (throw → `1008`), while `item`/`end`/`cancel` for an unknown (already finished) stream are dropped (`stream-server.ts:168-223`); uplink items after the client's `end` fail the logical stream with `gateway/protocol`, and buffered uplink bytes beyond `streamInboxBytes` (default 262 144) fail it with `gateway/uplink-overflow` (`stream-server.ts:324-345`, `packages/api/gateway/src/index.ts:137,148-149`); each terminal downlink (`end` or `error`) stops the uplink immediately (`stream-client.ts:314-315`); when a logical stream ends without a terminal frame the client sends `cancel` as a courtesy (`stream-client.ts:139-141`). A stream `error` frame reconstructs a `RemoteError` from `{code,message,details}` (`stream-client.ts:130-132`).

### 4.3 Reconnection semantics (client)

Physical carrier loss surfaces as `RemoteStreamCarrierError` and is retried by `RemoteStream` (generation-supervised reconnection in `packages/api/gateway/src/client/remote-stream.ts:39-157`); each physical attempt is a numbered `generation` and every delivered item is annotated with `{generation, value, signal, accept()}` (`remote-stream.ts:7-17`). The single-consumer journal/snapshot helpers (`RemoteJournalStream`, `RemoteSnapshotStream`, `packages/api/gateway/src/client/journal-stream.ts`, `snapshot-stream.ts`) demand exactly one opening frame per generation and repair cursor gaps through domain page reads (§6). Connection-level retry timing is `ConnectionRecoveryConfig` (`packages/client/connection/src/recovery-config.ts:5-31`): `backoffBaseMs=500` (delay is 50–100% of cap), `backoffFactor=2`, `backoffMaxMs=10000`, `generationReadyWarnMs=3000`, `generationReadyTimeoutMs=15000`; the Host may inject overrides into the page as `__DSH_CONNECTION_RECOVERY__` (`packages/client/connection/src/index.ts:141-143`).

## 5. Forwarded Remote events (Host → Client push)

### 5.1 `$events` logical stream

Application-selected Cordis events are forwarded on a Gateway-internal logical stream opened like any Remote stream with `endpoint: "$events"` and `payload: {"args":{}}` (`REMOTE_EVENT_STREAM_ENDPOINT`, `REMOTE_EVENT_STREAM_PAYLOAD`, `packages/api/gateway/src/stream-protocol.ts:10,16`; opener `packages/api/gateway/src/index.ts:442-507`; client owner `packages/api/gateway/src/client/remote-events.ts`). The first downlink item is the ready frame binding this generation:

```typescript
// packages/api/gateway/src/stream-protocol.ts:22-71
export interface RemoteEventHostInfo { readonly home: string }
export interface RemoteEventReadyFrame { readonly type: 'ready'; readonly clientId: RemoteEventClientId; readonly host: RemoteEventHostInfo }
export interface RemoteEventEmitFrame { readonly type: 'emit'; readonly event: string; readonly args: readonly unknown[] }
export interface RemoteEventInvocationFrame {
  readonly type: 'waterfall'; readonly event: string; readonly eventId: RemoteEventId
  readonly agentId: RemoteEventAgentId; readonly request: Readonly<Record<string, unknown>>
}
export interface RemoteEventCancellationFrame { readonly type: 'cancel'; readonly eventId: RemoteEventId }
export type RemoteEventDownlinkFrame = RemoteEventReadyFrame | RemoteEventEmitFrame | RemoteEventInvocationFrame | RemoteEventCancellationFrame
```

`RemoteEventClientId` (one per event-stream generation) and `RemoteEventId` (one per pending Host→Client waterfall) are branded opaque non-empty strings (`stream-protocol.ts:22-25,212-223`). `emit` frames are fire-and-forget notifications; `waterfall` frames are Agent-scoped invocations that await a Client outcome; `cancel` retires a pending `eventId` (`packages/api/gateway/src/index.ts:526-655`).

### 5.2 `$events/result` (Client → Host reply)

The Client answers each `waterfall` with one unary RPC to endpoint `$events/result` whose `payload.args` is exactly (`packages/api/gateway/src/stream-protocol.ts:87-138`):

```typescript
export interface RemoteEventResult {
  readonly clientId: RemoteEventClientId
  readonly eventId: RemoteEventId
  readonly outcome:
    | { readonly kind: 'next' }                                       // delegate to the Host chain
    | { readonly kind: 'result'; readonly value?: unknown }           // claim with a JSON value
    | { readonly kind: 'rejected'; readonly error: RemoteEventRejection }  // {name,message,code?,details?}
}
```

Results from a completed or superseded delivery are idempotent no-ops (`packages/api/gateway/src/index.ts:601-620`); correlation is purely `(clientId, eventId)`.

## 6. Session streaming: assistant chunks, tool calls, session events

All three ride one logical Remote stream opened at endpoint `session/follow` (`packages/api/session-controller/src/client/transport.ts:172-217`) — i.e. the mux frames of §4 carry `SessionFollowFrame` items. The envelope types are declared in `packages/api/session-controller/src/types.ts:425-563`:

```typescript
// types.ts:458-468 — every durable Session event (this includes tool call/result events)
export interface SessionWireEvent {
  readonly type: string                 // merge-extensible event names (e.g. tool events); owner-defined
  readonly seq: number                  // per-Session monotone log sequence number (THE correlation id)
  readonly time: number
  readonly data: JsonValue
  readonly ignorable?: true
  readonly sourceEventSeqs?: JsonValue  // earlier source seqs on surface events
  readonly surfaceOp?: JsonValue        // 'append' | {op:'replace', startSeq, endSeq} (types.ts:446-448)
}
// types.ts:552-563
export type SessionFollowFrame =
  | { readonly type: 'snapshot'; readonly header: SessionWireHeader; readonly cursor: number
      readonly records: readonly SessionEventEntry[]; readonly hasMore: boolean
      readonly projections: SessionProjectionBaseline; readonly assistantStream?: SessionAssistantStreamBaseline }
  | { readonly type: 'event'; readonly event: SessionWireEvent }
  | { readonly type: 'assistant-stream'; readonly frame: SessionAssistantStreamFrame }
```

Tool calls and their results are ordinary `SessionWireEvent` journal rows correlated by `seq` (event names are merge-extensible; the exact tool event name set is **NOT DETERMINED FROM SOURCE** here — durable readers own recognition, `types.ts:456-457`). Streaming assistant chunks are process-local presentation frames correlated by `(attemptId, revision, index)` with dense `index` per attempt and the durable landing point in `end.outcome` (`types.ts:493-543`):

```typescript
// types.ts:513-543
export type SessionAssistantStreamFrame =
  | { readonly type: 'start'; readonly attemptId: LlmAttemptId; readonly revision: number
      readonly startedAfterSeq: SessionSeqCursor; readonly turn: number; readonly step: number }
  | { readonly type: 'chunk'; readonly attemptId: LlmAttemptId; readonly revision: number
      readonly index: number; readonly time: number; readonly chunk: JsonValue }
  | { readonly type: 'end'; readonly attemptId: LlmAttemptId; readonly revision: number; readonly index: number
      readonly outcome: { readonly kind: 'committed'; readonly eventType: 'assistant/message' | 'assistant/attempt'; readonly seq: number }
                      | { readonly kind: 'abandoned' } }
```

User prompt correlation uses a client-minted `SessionRequestId` carried as the user message source `rpcId` (`types.ts:397-405`). History pagination (`SessionPageRequest`, `types.ts:470-484`) is anchored on `throughSeq` (from the follow opening frame) and `beforeSeq`, and the client journal adapter (`RemoteJournalStream`, `packages/api/gateway/src/client/journal-stream.ts`) enforces cursor contiguity (`follows`, gap repair via page reads) — so **`seq` is the single durable ordering and correlation axis**, `attemptId/revision/index` the streaming-chunk axis, `rpcId`/`SessionRequestId` the request axis, and `streamId`/`rpcId`/`(clientId,eventId)` the transport axes. Wire validation of each event: `assertSessionWireEvent` (`packages/api/session-controller/src/client/session-wire-event.ts:14-46`). The Host-wide control stream (`SessionControlFrame` baseline + per-projection updates each carrying its own `seq` watermark, `types.ts:565-581`) correlates session projection state the same way.

## 7. Web page serving and index injections

### 7.1 `collectIndexInjections()` and the injection table

`WebServer.collectIndexInjections()` (`packages/host/webserver/src/index.ts:342-352`) emits one `webserver/index-inject` event over a mutable `IndexInjection[]` table; every listener pushes its current rows at emit time (activation order = row order) (`packages/host/webserver/src/index.ts:26-36`). The row vocabulary (`packages/host/webserver/src/injections.ts:11-31`):

```typescript
export type IndexInjectionPlacement = 'head' | 'body'
export type IndexInjection =
  | { kind: 'global'; name: string; value: unknown }                          // globalThis[name] = value, head
  | { kind: 'script'; placement: IndexInjectionPlacement; text: string }      // inline classic script
  | { kind: 'script-src'; placement: IndexInjectionPlacement; src: string }   // external classic script, table order
  | { kind: 'script-preload'; src: string }                                   // <link rel="preload" as="script">
  | { kind: 'style'; text: string }                                           // <style> in head
  | { kind: 'html'; placement: IndexInjectionPlacement; html: string }        // raw markup
```

Known producers: `client-connection` pushes `{kind:'global', name:'__DSH_CONNECTION_RECOVERY__', value: recovery}` (`packages/client/connection/src/index.ts:141-143`); `client-modules` pushes the boot protocol rows `bootInjections(graph)` — an inline `window.__ModuleLoader__` registration-queue script, `script-preload` rows for application batches, blocking `script-src` rows for bootstrap batches, and the `{kind:'global', name:'__DSH_BOOT__', value: graph}` row (`packages/client/modules/src/index.ts:552-587`).

### 7.2 Two renderers, both authoritative

`renderIndexInjections(html, rows)` splices head rows after `<head>` and body rows after `<body>` and appends the readiness tail `READY_MARKUP = '<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>'` (`packages/host/webserver/src/injections.ts:86-119`). The Host's own webserver applies it: `WebServer.renderIndex` = rows then raw `tapIndex` transforms (`packages/host/webserver/src/index.ts:354-362`), and `frontend-static` calls it for `/` and the configured index and inserts `<base href="./">` (`packages/host/frontend-static/src/index.ts:116-120`). The Electron packaged static server does **not** render rows into HTML: `apps/desktop/src/web-document.ts:10,31-32` only injects `globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()` into `<head>` of the packaged `index.html`, and the page-side interpreter `applyIndexInjections(rows, loadScript)` (`packages/client/web/src/apply-injections.ts:18-52`) executes the Host's collected table at runtime after `dshDesktopBoot.ready()` resolves (`apps/web/src/main.ts:24-35`) — the table itself travels over IPC from the Host's `collectIndexInjections()` (`apps/desktop-host/src/index.ts:103-104`, `apps/desktop/src/main.ts:640-645`). Desktop and WebWorker share that interpreter (`_upstream/packages/client/web/README.md` "Static application pages install `__DSH_BOOT_READY__`…").

### 7.3 What a non-Electron webview must do to boot the client

Two supported boot paths, both requiring `window.__DSH_BOOT__` (REQUIRED: `parseBootManifest` throws `client-modules: window.__DSH_BOOT__ is missing or not an object` — `packages/client/modules/src/client/manifest.ts:217-230`; the shell entry reads it at `packages/client/web/src/boot.ts:72`) and `window.__ModuleLoader__` (REQUIRED: `boot.ts:59-62` throws `web boot: window.__ModuleLoader__ bootstrap facade is missing`; facade installed by the `bootInjections` queue script, `packages/client/modules/src/index.ts:554-575`).

1. **Served path (plain webview)**: navigate to the Host's root URL opened with `ctx.connection.authenticatedUrl` (one `?token=`) so the cookie exchange completes (§2.2), and let `frontend-static` serve the rendered `index.html`; the rendered rows supply `__DSH_BOOT__`, `__ModuleLoader__`, bundle scripts and `__DSH_CONNECTION_RECOVERY__`, and `READY_MARKUP` resolves `__DSH_BOOT_READY__` before the entry awaits it (`packages/host/frontend-static/src/index.ts:88-91`, `injections.ts:86-104`, `boot.ts:51-57`). No preload globals are needed.
2. **Shell-owned path (custom scheme / packaged dist)**: serve the packaged `dsh-web-frontend/dist` `index.html` and `/assets/*`, `/favicon.svg`, `/manifest.webmanifest` locally exactly as Electron does (`apps/desktop/src/main.ts:617-632`); insert `globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()` into the literal `<head>` of `index.html` (`apps/desktop/src/web-document.ts:10,31-32`); expose `globalThis.dshDesktopBoot = { ready(): Promise<{ injections: IndexInjection[]; streamBaseUrl: string }>, failed(message: string) }` where `ready()` returns the Host's `collectIndexInjections()` output and Host origin (Electron's `boot` IPC contract, `apps/desktop/src/main.ts:640-645`, consumed `apps/web/src/main.ts:5-36`); the entry then sets `__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }`, applies the rows via `applyIndexInjections`, and resolves the gate (`apps/web/src/main.ts:24-35`). Forward every other request to the Host with the session cookie and `Origin: <host origin>` (Electron: `forwardWebRequest`, `apps/desktop/src/web-document.ts:77-93`, which strips inbound `host/origin/cookie/sec-fetch-site` and sets the stored cookie), and give WebSocket requests to `/api/remote.mux` the Host cookie plus Host `Origin` (Electron: `apps/desktop/src/main.ts:665-676`). Boot failures must be reported through `dshDesktopBoot.failed(message)` (→ main-process fatal path) or they render on the built-in boot page (`apps/web/src/main.ts:12-15`, `packages/client/web/src/boot.ts:98-102`).

`window.__DSH_BOOT__` is therefore required in every path; only "dsh web" (the Host webserver render) and a shell applying the injection table can supply it (compare `_upstream/packages/bundle/web-app/src/index.ts:144`: "only dsh web injects window.__DSH_BOOT__"). The boot graph wire format is `WebBootGraph` (`packages/client/modules/src/client/manifest.ts:52-97`: `{rev, entries: WebBootEntry[{id,url,rev,inject?,immediately?,external?}], batches: WebBootBatch[{phase:'bootstrap'|'application', url, rev, entries}]}`).

## 8. Desktop preload markers read by the client

The Rust shell must supply equivalent markers. The single product bridge is `DshDesktopProductApi` (`apps/desktop/src/ipc.ts:71-81`):

```typescript
export interface DshDesktopProductApi {
  readonly protocolVersion: 1
  readonly browser: DesktopBrowserBridge   // packages/client/ui-sidebar-browser/types
  readonly keyboard: DesktopKeyboardApi    // packages/client/shortcuts/protocol
  readonly shortcuts: DesktopShortcutsApi  // packages/client/shortcuts/protocol
  readonly updates: {
    status(): Promise<DesktopUpdatePresentation>   // {phase, version?, percent?, failure?} (apps/desktop/src/ipc.ts:63-68)
    open(): Promise<void>
    subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
  }
}
```

| Global | Exposed by | Read by (client) | Behaviour when present | Behaviour when absent |
|---|---|---|---|---|
| `dshDesktop` | `apps/desktop/src/preload-app.ts:99` (full API only for `dsh-app://app` main frame; otherwise stub `{protocolVersion: 1}`) | `packages/client/ui-sidebar-browser/src/client/index.ts:70-71` (`browser` bridge); `packages/client/ui-settings-general/src/client/index.ts:89` (`updates` bridge → update settings UI); `packages/client/shortcuts/src/client/index.ts:45` + `storage.ts:39` (`keyboard`/`shortcuts` → desktop shortcut engine); presence checks `packages/client/ui-settings-models/src/client/index.ts:81,147`, `packages/client/ui-settings-account/src/client/index.ts:43,211` | marks "desktop shell": sidebar browser guest bridge, desktop keyboard/shortcuts, updates settings entry; web-only credential onboarding is suppressed (`ui-settings-models/src/client/index.ts:81` `!('dshDesktop' in globalThis)`) | web mode: browser/shortcuts/updates bridges disabled; web onboarding slots register |
| `dshDesktopBoot` | `apps/desktop/src/preload-app.ts:84-87` (`ready()` = `DESKTOP_IPC.boot`, `failed()` = `DESKTOP_IPC.bootFailed`) | `apps/web/src/main.ts:5-37` | desktop boot path: awaits `ready()` → `{injections, streamBaseUrl}`, sets `__DSH_TRANSPORT__`, applies index injections, resolves `__DSH_BOOT_READY__`; failures route to native fatal recovery via `failed()` | served-web boot path: entry runs immediately and trusts the served HTML injections |
| `window.__DSH_BOOT__` | injection row `{kind:'global', name:'__DSH_BOOT__', value: graph}` (`packages/client/modules/src/index.ts:585`) | `packages/client/web/src/boot.ts:72`; validated `packages/client/modules/src/client/manifest.ts:217-306` | provides the client entry graph (module table + plugin composition) | boot fails loudly (`window.__DSH_BOOT__ is missing or not an object`) |
| `window.__ModuleLoader__` | inline queue script from `bootInjections` (`packages/client/modules/src/index.ts:554-575`) | `packages/client/web/src/boot.ts:59-76` | bundle-registration queue → live module system at `create()` | boot fails loudly (`web boot: window.__ModuleLoader__ bootstrap facade is missing`) |
| `__DSH_BOOT_READY__` | Electron static server (`apps/desktop/src/web-document.ts:10`) or served `READY_MARKUP` (`packages/host/webserver/src/injections.ts:86`) | awaited `packages/client/web/src/boot.ts:57`; required in desktop path `apps/web/src/main.ts:22-23` | gates entry on completion of async injection application | plain pages: nothing to wait for (`boot.ts:55-57` "absent global means no bootstrap owns the document"); in the desktop path its absence throws `desktop web: boot readiness is missing` |
| `__DSH_TRANSPORT__` | shell/test hosts (`apps/web/src/main.ts:25-26` sets `{ownsHost: true, streamBaseUrl}`; worker runtime `packages/experimental/webworker-runtime/src/client/index.ts:157`) | `packages/client/connection/src/client/index.ts:318-325` (fields `rpc`, `fetch`, `openStream`, `loadBundle`, `ownsHost`, `streamBaseUrl`; type `ClientTransportHooks` `:79-107`); WS URL `packages/api/gateway/src/client/stream-client.ts:476-477` | replaces transport: `streamBaseUrl` rebases the mux WebSocket; `ownsHost: true` makes `ctx.connection.isLoopback` true (`client/index.ts:248`); `rpc`/`openStream` replace HTTP/WS outright (worker/test carriers) | standard carrier: HTTP `fetch` document-relative + WS on `document.baseURI` |
| `__DSH_CONNECTION_RECOVERY__` | injection row from `client-connection` (`packages/client/connection/src/index.ts:142`) | `packages/client/connection/src/client/index.ts:323` | overrides reconnect/backoff timing (§4.3) | built-in defaults (`packages/client/connection/src/recovery-config.ts:25-31`) |
| `__DSH_HOST_PATHS__` | `apps/desktop/src/preload-app.ts:81-83` (`{ pathFor(file: File): string }` via `webUtils.getPathForFile`) | `packages/client/ui-conversation/src/client/apply.ts:107` | dropped/picked/pasted files with a real host path are cited as `@path` references instead of uploaded | `pathFor` answers `''` and files upload as before (`preload-app.ts:78-80`) |
| `__DSH_DIRECTORY_PICKER__` | `apps/desktop/src/preload-app.ts:75-77` (`{ pick(): Promise<string \| null> }`) | `packages/client/ui-directory-picker-native/src/client/index.ts:22-23` | native directory picking flow | non-native picker fallback (browse flow) |
| `__DSH_LOCALE__` | `apps/desktop/src/preload-app.ts:102-105` (`{ read(): Promise<…>; onChange(locale): void }`; `read` returns `{languages, preference}` per `apps/desktop/src/main.ts:703-709`) | `packages/client/locale/src/client/index.ts:564`, `bootstrap.ts:11` | desktop locale bootstrap: system languages + stored preference drive the UI locale; changes report back | ordinary browser locale detection |
| `dshOnboarding` | `apps/desktop/src/preload-app.ts:61-64` (`{ hasApiKey(): Promise<boolean>; setActive(active: boolean): void }`) | `packages/client/ui-settings-account/src/client/onboarding-credentials.ts:9-10`, `DesktopOnboardingEntry.tsx:31-32` | desktop API-key onboarding status/active signalling | web credential onboarding path |
| `dshPlatform` | `apps/desktop/src/preload-app.ts:88-92` (`{ open(page:'usage'\|'top-up', bounds), setBounds(bounds), close() }`) | `packages/client/ui-settings-account/src/client/index.ts:135` | native Platform usage/top-up views | web/absent: Platform surface unavailable |
| `dshWelcome` | `apps/desktop/src/preload-welcome.ts:25` (welcome window only, `WelcomeApi`) | welcome-window app (not the main client) | localized welcome copy + write-only credential actions | n/a outside the welcome window |
| `dshUpdateDialog`, `dshMandatoryUpdate` | `apps/desktop/src/preload-update-dialog.ts:14`, `preload-mandatory.ts:16` (shell-owned dialog pages) | those shell pages only | desktop update dialogs | n/a |
| DOM markers (not globals) | `preload-platform.ts:10-31` sets `html[data-platform=<process.platform>]` and `data-fullscreen` (macOS); `preload-windows.ts:8-62` sets `html[data-windows-titlebar]` + `--dsh-windows-titlebar-height` and the caption menu; `preload-theme.ts:18-34` mirrors `html[data-ds-theme-source]` to native theme | shared UI CSS (`html[data-platform]` scoping) and `preload-menu.ts` | desktop-only CSS/layout rules and native chrome sync | plain web layout |

`__DSH_DESKTOP__`: **NOT DETERMINED FROM SOURCE** — the identifier does not occur anywhere in `_upstream/` at this commit; the desktop marker the client actually tests is `'dshDesktop' in globalThis` (citations above). IPC channel names (`DESKTOP_IPC`, `apps/desktop/src/ipc.ts:8-33`) and the `dsh-app` scheme (`SCHEME`, `apps/desktop/src/ipc.ts:84`) are private shell wiring; the preserved UI reaches them only through the globals above.
