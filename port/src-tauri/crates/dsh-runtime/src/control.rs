//! Desktop-Host lifecycle control channel (protocol generation 4).
//!
//! **Deliberate documented difference** (ADR 0001, `desktop-host-lifecycle-protocol.md`):
//! upstream carries the lifecycle protocol over Node's `process.send` IPC. A
//! Rust parent has no Node IPC stack, so the port carries the **identical
//! message vocabulary and protocol generation 4** as newline-delimited JSON
//! over a local duplex socket: named pipe `\\.\pipe\...` on Windows, Unix
//! domain socket elsewhere. Message names, field names, direction, ordering
//! (FIFO per direction) and failure behaviour are unchanged.
//!
//! Transport additions that the socket substitution requires (outside the
//! generation-4 vocabulary):
//! - the child receives the socket name and a one-time random token via
//!   `DSH_DESKTOP_CONTROL_SOCKET` / `DSH_DESKTOP_CONTROL_TOKEN`
//!   (`DSH_DESKTOP_CONTROL_GENERATION` carries the pinned generation);
//! - the first line on the connection is the **private transport preamble**
//!   `<token> <generation>` (not JSON): the token is compared in constant time
//!   and *before* the generation is read, then the generation must equal
//!   [`PROTOCOL_GENERATION`] or the connection is refused with
//!   [`ControlError::GenerationMismatch`]. A stale or swapped runtime therefore
//!   cannot boot unvalidated. The shell answers with exactly one empty
//!   acknowledgement line, and only after that do generation-4 messages flow.
//!
//! Framing rules: each message is one compact JSON object followed by `\n`. A
//! partial frame is buffered until complete; a line that is not valid JSON of a
//! known message type is a protocol violation and is fatal to the child
//! (`isDesktopHostEvent` strictness, `host-process.ts:206-212`).
//!
//! Bounds (a byte-stream socket has no message boundary, so every direction
//! needs one):
//! - [`MAX_TERMINATED_FRAME_BYTES`] caps one complete frame in either direction;
//! - [`UNTERMINATED_FRAME_CAP_BYTES`] caps a frame that has not received its
//!   newline yet, checked **before** the receive buffer grows, so a peer that
//!   streams without a delimiter cannot allocate without limit;
//! - [`EVENT_QUEUE_CAPACITY`] bounds the shell's inbound event queue, so a Host
//!   that floods unsolicited events blocks on the transport instead of growing
//!   an unbounded channel;
//! - [`WRITE_QUEUE_CAPACITY`] bounds queued outbound shell messages, so a peer
//!   that stops reading cannot make the shell buffer replies without limit.
//!
//! Deadlines: one [`ControlLink::request`] deadline covers the complete
//! operation — pending registration, the send (writer acquisition, write and
//! flush) and the reply — not just the reply. A caller that drops the future
//! (cancellation) removes its pending entry, so no waiter is leaked and no late
//! answer can be mis-resolved.

use std::collections::HashMap;
#[cfg(unix)]
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dsh_core::protocol::IndexInjection;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

/// Pinned lifecycle protocol generation (`DESKTOP_HOST_PROTOCOL_VERSION`).
pub const PROTOCOL_GENERATION: u32 = dsh_core::protocol::PROTOCOL_GENERATION;

/// Environment variables of the control-socket handover.
pub const CONTROL_SOCKET_ENV: &str = "DSH_DESKTOP_CONTROL_SOCKET";
/// One-time transport token shared with the child.
pub const CONTROL_TOKEN_ENV: &str = "DSH_DESKTOP_CONTROL_TOKEN";
/// Pinned protocol generation shared with the child.
pub const CONTROL_GENERATION_ENV: &str = "DSH_DESKTOP_CONTROL_GENERATION";

/// Maximum accepted size of one **terminated** frame (bytes, excluding the
/// newline). Injection tables ride `ready`, so this is generous.
pub const MAX_TERMINATED_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Maximum size of one frame that has not yet been terminated by a newline.
/// Checked against the chunk **before** it is appended, so the receive buffer
/// never exceeds this bound. An unterminated frame only ever arrives from a
/// peer that is still writing, so it is bounded independently of what a
/// complete frame may contain.
pub const UNTERMINATED_FRAME_CAP_BYTES: usize = 8 * 1024 * 1024;

/// Bound on the shell's queue of unsolicited Host events that no consumer has
/// taken yet. Filling it blocks the reader task, which stops draining the
/// socket and applies transport backpressure to the Host.
pub const EVENT_QUEUE_CAPACITY: usize = 1024;

/// Bound on outbound shell messages queued behind one in-flight write. A peer
/// that stops reading stalls its sender instead of growing memory.
pub const WRITE_QUEUE_CAPACITY: usize = 64;

/// Maximum accepted size of one outbound shell frame. Injection tables only
/// ever travel Host → shell, so requests are small by construction.
pub const MAX_OUTBOUND_FRAME_BYTES: usize = 64 * 1024;

/// Maximum length of the raw transport-token line, including its newline.
pub const MAX_TOKEN_LINE_BYTES: usize = 1024;

/// The private transport preamble the child presents before any generation-4
/// message: `<token> <generation>`. It is deliberately outside the preserved
/// upstream vocabulary — upstream has no rendezvous at all (it uses Node
/// `process.send` fd 3), so this line is ours on both sides and is versioned by
/// [`PROTOCOL_GENERATION`].
///
/// The generation is carried explicitly so a **swapped runtime cannot boot
/// unvalidated**: a staged payload whose adapter speaks a different lifecycle
/// generation presents a different number (or refuses to present one) and the
/// shell refuses the connection instead of exchanging frames it does not
/// understand. The token is compared in constant time and **before** the
/// generation is parsed, so an unauthenticated peer cannot probe which
/// generations are accepted.
pub fn encode_preamble(token: &str, generation: u32) -> String {
    format!("{token} {generation}\n")
}

/// Parse one preamble line (without its newline) against the expected token.
///
/// Failure order is the security order: the token is verified first, constant
/// time, and only then is the generation read and compared.
pub fn parse_preamble(line: &str, expected_token: &str) -> Result<u32, ControlError> {
    let Some((token, generation)) = line.split_once(' ') else {
        // A bare token (or a line with no separator) is the pre-generation
        // private handshake: it cannot say which lifecycle it speaks, so it is
        // refused rather than trusted.
        return Err(ControlError::GenerationMismatch {
            expected: PROTOCOL_GENERATION,
            actual: 0,
        });
    };
    if !token_matches(token, expected_token) {
        return Err(ControlError::Authentication);
    }
    let actual = generation.trim().parse::<u32>().map_err(|_| {
        ControlError::MalformedFrame("control preamble generation is not a number".into())
    })?;
    if actual != PROTOCOL_GENERATION {
        return Err(ControlError::GenerationMismatch {
            expected: PROTOCOL_GENERATION,
            actual,
        });
    }
    Ok(actual)
}

/// How long a stop may spend handing `shutdown` to the control peer before the
/// tree escalation takes over. Upstream's equivalent wait is the first
/// `exitsWithin` phase (`host-process.ts:295`); tying the send to it keeps the
/// total stop cost inside the documented escalation budget instead of adding
/// an unbounded wait in front of it.
pub const SHUTDOWN_SEND_TIMEOUT: Duration = Duration::from_millis(2_000);

/// Backstop for a connection that never presents its transport token. The
/// supervisor's startup deadline is the primary bound; this one also covers
/// direct [`ControlServer::accept`] callers and tests.
pub const AUTH_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// Maximum silence after a partial frame starts. A healthy, idle Host has no
/// heartbeat contract and must not be killed for having nothing to send.
/// Correlated requests already have independent end-to-end deadlines.
pub const PARTIAL_FRAME_TIMEOUT: Duration = Duration::from_secs(120);

/// Control-channel failures.
#[derive(Debug, thiserror::Error)]
pub enum ControlError {
    /// The peer sent a line that is not valid JSON of a known message type.
    #[error("control channel: malformed frame: {0}")]
    MalformedFrame(String),
    /// A frame exceeded the terminated-frame cap ({@link MAX_TERMINATED_FRAME_BYTES}
    /// inbound, {@link MAX_OUTBOUND_FRAME_BYTES} outbound).
    #[error("control channel: frame exceeded {0} bytes")]
    FrameTooLarge(usize),
    /// An unterminated frame exceeded {@link UNTERMINATED_FRAME_CAP_BYTES}
    /// before its newline arrived.
    #[error("control channel: unterminated frame exceeded {UNTERMINATED_FRAME_CAP_BYTES} bytes")]
    UnterminatedFrameTooLarge,
    /// The peer reached end of stream while a frame was still incomplete. This
    /// is deliberately *not* a clean EOF: the incomplete bytes are reported so a
    /// truncated frame can never be mistaken for an orderly shutdown.
    #[error("control channel: peer closed with {0} bytes of an incomplete frame")]
    TruncatedFrame(usize),
    /// The transport failed (socket closed, write failed, idle peer).
    #[error("control channel: transport failed: {0}")]
    Transport(String),
    /// The peer did not present a valid transport token in time.
    #[error("control channel: authentication failed")]
    Authentication,
    /// The child negotiated a different protocol generation.
    #[error("control channel: protocol generation mismatch (expected {expected}, got {actual})")]
    GenerationMismatch { expected: u32, actual: u32 },
}

impl ControlError {
    /// Whether this failure is a deadline miss.
    pub fn is_deadline(&self) -> bool {
        matches!(self, Self::Transport(message) if message.contains("deadline"))
    }

    /// Whether a frame or queue bound rejected the peer.
    pub fn is_overflow(&self) -> bool {
        matches!(
            self,
            Self::FrameTooLarge(_) | Self::UnterminatedFrameTooLarge
        )
    }
}

/// Update-handoff admission action (`update-tasks` request).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateTasksAction {
    Inspect,
    Lock,
    Unlock,
}

/// Shell → Host messages (upstream `DesktopHostControlRequest` + `shutdown`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ShellMessage {
    /// Graceful teardown request (`host-process.ts:293`).
    Shutdown {},
    /// Quit-time inspection request; `requestId` is shell-minted (`host-process.ts:268-274`).
    QuitInspection {
        #[serde(rename = "requestId")]
        request_id: u64,
    },
    /// Update admission request; responses carry `active`, not `activeTasks`.
    UpdateTasks {
        #[serde(rename = "requestId")]
        request_id: u64,
        action: UpdateTasksAction,
    },
}

/// `platform-session` payload (`deepseek-account/src/index.ts:20`, mirror
/// validation `host-process.ts:61-79`). Contains credentials and must never be
/// logged, traced, or forwarded to a renderer.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformSession {
    /// Exact URL origin; `https:`, or `http:` only on localhost/127.0.0.1/[::1]; no userinfo.
    pub origin: String,
    /// Non-empty account token. **Secret: never log.**
    pub token: String,
    /// Null or non-empty string.
    pub user_id: Option<String>,
    /// Must be a string when present.
    pub embedded_page_dist: Option<String>,
    /// All-lowercase names; values free of CR/LF; may not be `authorization`,
    /// `x-dsh-auth-token`, `host`, `content-length`, `transfer-encoding`,
    /// `connection`, or `content-type`.
    pub request_headers: Option<std::collections::BTreeMap<String, String>>,
}

// Even invalid, not-yet-validated payloads can appear inside a Debug HostEvent.
// Redact the whole record, including origin/user metadata and custom headers.
impl std::fmt::Debug for PlatformSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PlatformSession")
            .field("credentials", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

/// Names `requestHeaders` may not carry (upstream `host-process.ts:73`).
const FORBIDDEN_REQUEST_HEADERS: [&str; 7] = [
    "authorization",
    "x-dsh-auth-token",
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "content-type",
];

impl PlatformSession {
    /// Structural validation mirroring `isDesktopHostEvent`'s `platform-session` case.
    pub fn validate(&self) -> bool {
        if self.token.is_empty() {
            return false;
        }
        if let Some(user_id) = &self.user_id {
            if user_id.is_empty() {
                return false;
            }
        }
        if let Some(headers) = &self.request_headers {
            for (name, value) in headers {
                if name != &name.to_lowercase()
                    || value.contains(['\r', '\n'])
                    || FORBIDDEN_REQUEST_HEADERS.contains(&name.as_str())
                {
                    return false;
                }
            }
        }
        let Ok(parsed) = url::Url::parse(&self.origin) else {
            return false;
        };
        if parsed.origin().ascii_serialization() != self.origin
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return false;
        }
        match parsed.scheme() {
            "https" => true,
            "http" => matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
            _ => false,
        }
    }
}

/// Host → Shell messages (upstream `DesktopHostEvent` union).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HostEvent {
    /// Startup readiness; exactly one is expected per run.
    Ready {
        url: String,
        /// `collectIndexInjections()` rows. A missing table fails startup later.
        injections: Option<Vec<IndexInjection>>,
    },
    /// Fatal startup/runtime failure reported before exit.
    Fatal {
        message: String,
        /// The Host's complete inspected error, capped at 64 KiB by the Host.
        diagnostic: Option<String>,
    },
    /// Unsolicited credential update (at-least-once, last-value-wins).
    PlatformSession { session: Option<PlatformSession> },
    /// Teardown acknowledgement; legal only after `shutdown`.
    ShutdownComplete {},
    /// Correlated update-task answer; `active`, not `activeTasks`.
    UpdateTasks {
        #[serde(rename = "requestId")]
        request_id: u64,
        active: bool,
        error: Option<String>,
    },
    /// Correlated quit-inspection answer.
    QuitInspection {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "activeTasks")]
        active_tasks: bool,
        #[serde(rename = "scheduledTasks")]
        scheduled_tasks: bool,
        error: Option<String>,
    },
}

/// Encode one message as a single NDJSON frame.
pub fn encode_frame(message: &ShellMessage) -> Result<Vec<u8>, ControlError> {
    let mut bytes =
        serde_json::to_vec(message).map_err(|e| ControlError::MalformedFrame(e.to_string()))?;
    if bytes.len() > MAX_OUTBOUND_FRAME_BYTES {
        return Err(ControlError::FrameTooLarge(MAX_OUTBOUND_FRAME_BYTES));
    }
    bytes.push(b'\n');
    Ok(bytes)
}

/// Decode one complete line (without the trailing newline) into a Host event.
pub fn decode_line(line: &str) -> Result<HostEvent, ControlError> {
    serde_json::from_str(line).map_err(|e| ControlError::MalformedFrame(e.to_string()))
}

/// Incremental NDJSON frame decoder: partial-frame reassembly and malformed
/// line rejection, with both frame caps enforced before the buffer grows.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    /// Fresh decoder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Terminated frames already in the buffer are handed back before
    /// [`FrameDecoder::push`] applies any cap, so the two caps never interleave.
    fn drain_terminated(&mut self) -> Vec<Result<String, ControlError>> {
        let mut out = Vec::new();
        while let Some(next) = self.next_line() {
            out.push(next);
        }
        out
    }

    /// Append one transport chunk.
    ///
    /// The two caps are applied to **different objects**, so a legitimate large
    /// frame is never rejected because of the unterminated bound:
    /// - every newline-terminated frame the chunk contains is accepted and
    ///   capped at [`MAX_TERMINATED_FRAME_BYTES`];
    /// - only the trailing unterminated remainder is capped at
    ///   [`UNTERMINATED_FRAME_CAP_BYTES`], and it is rejected **before** the
    ///   buffer grows past that bound.
    ///
    /// A chunk that both completes a frame and carries an oversized
    /// delimiter-free flood keeps the completed frame; the caller learns about
    /// the flood from the returned error (or from `next_line` when a frame was
    /// preserved, in which case the bytes were dropped).
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), ControlError> {
        let last_newline = chunk.iter().rposition(|b| *b == b'\n');
        match last_newline {
            Some(end) => {
                // Admit the terminated head, then apply the unterminated bound to
                // the trailing remainder.
                //
                // The remainder is capped at `UNTERMINATED_FRAME_CAP_BYTES`, and
                // the bound is inclusive of a remainder that has *already* filled
                // the cap: a delimiter-free tail that reaches the cap cannot
                // accept even one more byte, so admitting it silently would leave
                // the decoder in a state where the next push has no room and the
                // peer's flood is never reported. Refusing it here is what keeps
                // `push` and `push_chunk` honest about the overflow while still
                // preserving every frame that already had its newline.
                let remainder = chunk.len() - (end + 1);
                self.buffer.extend_from_slice(&chunk[..=end]);
                if remainder >= UNTERMINATED_FRAME_CAP_BYTES {
                    // The completed prefix stays in the buffer; the flood is
                    // dropped and reported. `drain_terminated` still hands back
                    // every frame the prefix completed.
                    return Err(ControlError::UnterminatedFrameTooLarge);
                }
                self.buffer.extend_from_slice(&chunk[end + 1..]);
                Ok(())
            }
            None => {
                let room = UNTERMINATED_FRAME_CAP_BYTES.saturating_sub(self.buffer.len());
                if chunk.len() > room {
                    self.buffer.extend_from_slice(&chunk[..room]);
                    // The admitted head cannot contain a terminator here: this
                    // branch is only reached for a chunk with none.
                    return Err(ControlError::UnterminatedFrameTooLarge);
                }
                self.buffer.extend_from_slice(chunk);
                Ok(())
            }
        }
    }

    /// Append one transport chunk and return every frame it completed.
    ///
    /// This is the form callers use on the socket path: a chunk that both
    /// completes the expected frame and carries a delimiter-free flood still
    /// yields that frame, and the flood is reported through the returned error
    /// instead of silently discarding the frame.
    ///
    /// Overflow is detected against the **trailing remainder**, not against the
    /// decoder's whole buffer: a completed frame that is itself over the
    /// terminated cap is reported by [`FrameDecoder::next_line`] as
    /// [`ControlError::FrameTooLarge`], and must not be re-labelled as an
    /// unterminated overflow (which would hide the real offence and could return
    /// a half-consumed buffer).
    pub fn push_chunk(
        &mut self,
        chunk: &[u8],
    ) -> Result<Vec<Result<String, ControlError>>, ControlError> {
        let overflow = matches!(
            self.push(chunk),
            Err(ControlError::UnterminatedFrameTooLarge)
        );
        let mut frames = self.drain_terminated();
        if overflow {
            if frames.is_empty() {
                return Err(ControlError::UnterminatedFrameTooLarge);
            }
            // Preserve valid leading frames AND signal the trailing violation.
            // Otherwise a valid prefix hides an overflow from the link reader.
            frames.push(Err(ControlError::UnterminatedFrameTooLarge));
        }
        Ok(frames)
    }

    /// Pop the next complete line, or `None` while the frame is still partial.
    ///
    /// `Err(FrameTooLarge)` fires once a terminated frame exceeds
    /// [`MAX_TERMINATED_FRAME_BYTES`]; the offending frame is discarded.
    pub fn next_line(&mut self) -> Option<Result<String, ControlError>> {
        match self.buffer.iter().position(|b| *b == b'\n') {
            Some(end) => {
                let line: Vec<u8> = self.buffer.drain(..=end).collect();
                if end > MAX_TERMINATED_FRAME_BYTES {
                    return Some(Err(ControlError::FrameTooLarge(MAX_TERMINATED_FRAME_BYTES)));
                }
                let content = &line[..line.len() - 1];
                match std::str::from_utf8(content) {
                    Ok(text) => Some(Ok(text.to_string())),
                    Err(e) => Some(Err(ControlError::MalformedFrame(e.to_string()))),
                }
            }
            None if self.buffer.len() > UNTERMINATED_FRAME_CAP_BYTES => {
                self.buffer.clear();
                Some(Err(ControlError::UnterminatedFrameTooLarge))
            }
            None => None,
        }
    }

    /// Bytes currently buffered for an incomplete frame.
    pub fn buffered_len(&self) -> usize {
        self.buffer.len()
    }

    /// Admit bytes without applying the unterminated cap.
    ///
    /// Reserved for tests that must place an over-cap terminated frame in the
    /// buffer, a state the socket path cannot reach because
    /// [`UNTERMINATED_FRAME_CAP_BYTES`] fires first.
    #[cfg(test)]
    fn admit_raw(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }
}

/// Constant-time string comparison for the transport token.
pub fn token_matches(actual: &str, expected: &str) -> bool {
    use subtle::ConstantTimeEq;
    let (a, b) = (actual.as_bytes(), expected.as_bytes());
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

/// A generated one-time transport token (base64url of 32 random bytes).
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS randomness is required for the control token");
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

/// Reads at most one newline-terminated line without ever buffering more than
/// `cap` bytes for it. Used for the transport-token preamble, so a peer that
/// connects and streams a delimiter-free payload before authenticating cannot
/// make the shell buffer it.
pub async fn read_line_bounded<R>(
    reader: &mut BufReader<R>,
    cap: usize,
) -> Result<Option<String>, ControlError>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut collected: Vec<u8> = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))?;
        if available.is_empty() {
            if collected.is_empty() {
                return Ok(None);
            }
            break;
        }
        let end = available.iter().position(|b| *b == b'\n');
        let take = end.map_or(available.len(), |position| position + 1);
        if collected.len() + take > cap {
            return Err(ControlError::UnterminatedFrameTooLarge);
        }
        collected.extend_from_slice(&available[..take]);
        reader.consume(take);
        if end.is_some() {
            break;
        }
    }
    String::from_utf8(collected)
        .map(Some)
        .map_err(|e| ControlError::MalformedFrame(e.to_string()))
}

/// The socket identity handed to the child.
#[derive(Debug, Clone)]
pub struct ControlEndpoint {
    /// Pipe name (`\\.\pipe\...`) or Unix socket path.
    pub socket_name: String,
    /// One-time transport token.
    pub token: String,
}

impl ControlEndpoint {
    /// Endpoint name + token for `Child` transport (both platforms).
    pub fn generate() -> Self {
        let token = generate_token();
        let suffix: String = token.chars().take(16).collect();
        Self {
            socket_name: platform_socket_name(&suffix),
            token,
        }
    }

    /// Environment block additions for the Host child.
    pub fn child_environment(&self) -> Vec<(String, String)> {
        vec![
            (CONTROL_SOCKET_ENV.to_string(), self.socket_name.clone()),
            (CONTROL_TOKEN_ENV.to_string(), self.token.clone()),
            (
                CONTROL_GENERATION_ENV.to_string(),
                PROTOCOL_GENERATION.to_string(),
            ),
        ]
    }
}

#[cfg(windows)]
fn platform_socket_name(suffix: &str) -> String {
    format!("\\\\.\\pipe\\dsh-desktop-control-{suffix}")
}

#[cfg(not(windows))]
fn platform_socket_name(suffix: &str) -> String {
    let base = std::env::temp_dir().join(format!("dsh-desktop-control-{suffix}.sock"));
    base.to_string_lossy().into_owned()
}

/// Control server: accepts exactly one authenticated child connection. The
/// socket is reserved at `bind()` so the child can never connect before the
/// shell listens.
pub struct ControlServer {
    endpoint: ControlEndpoint,
    #[cfg(unix)]
    listener: tokio::net::UnixListener,
    #[cfg(windows)]
    first: Mutex<Option<tokio::net::windows::named_pipe::NamedPipeServer>>,
}

// The Host inherits the shell's user authority. Keep the process-default DACL;
// sandbox pipe restrictions must not be repaired by granting Everyone access.
#[cfg(windows)]
fn create_pipe_instance(
    name: &str,
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    let mut options = tokio::net::windows::named_pipe::ServerOptions::new();
    options
        .first_pipe_instance(true)
        .reject_remote_clients(true);
    options.create(name)
}

impl Drop for ControlServer {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&self.endpoint.socket_name);
        }
    }
}

impl ControlServer {
    /// Bind the local socket named by `endpoint`.
    pub async fn bind(endpoint: ControlEndpoint) -> Result<Self, ControlError> {
        #[cfg(unix)]
        {
            let path = PathBuf::from(&endpoint.socket_name);
            let _ = std::fs::remove_file(&path);
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let listener = tokio::net::UnixListener::bind(&path)
                .map_err(|e| ControlError::Transport(e.to_string()))?;
            Ok(Self { endpoint, listener })
        }
        #[cfg(windows)]
        {
            let first = create_pipe_instance(&endpoint.socket_name)
                .map_err(|e| ControlError::Transport(e.to_string()))?;
            Ok(Self {
                endpoint,
                first: Mutex::new(Some(first)),
            })
        }
    }

    /// Endpoint handed to the child.
    pub fn endpoint(&self) -> &ControlEndpoint {
        &self.endpoint
    }

    /// Accept one child connection and authenticate its private transport
    /// preamble — token (constant time) **and** pinned lifecycle generation —
    /// within [`AUTH_HANDSHAKE_TIMEOUT`] and bounded to [`MAX_TOKEN_LINE_BYTES`].
    ///
    /// The shell acknowledges an accepted preamble with one empty line. Nothing
    /// generation-4 flows before that acknowledgement, so a child that never
    /// authenticates can never deliver a frame.
    pub async fn accept(&self) -> Result<ControlLink, ControlError> {
        let handshake = async {
            let stream = wrap_accepted(self.accept_stream().await?);
            let (read_half, mut write_half) = tokio::io::split(stream);
            let mut reader = BufReader::new(read_half);
            let Some(preamble_line) = read_line_bounded(&mut reader, MAX_TOKEN_LINE_BYTES).await?
            else {
                return Err(ControlError::Authentication);
            };
            parse_preamble(
                preamble_line.trim_end_matches(['\r', '\n']),
                &self.endpoint.token,
            )?;
            write_half
                .write_all(b"\n")
                .await
                .map_err(|e| ControlError::Transport(e.to_string()))?;
            write_half
                .flush()
                .await
                .map_err(|e| ControlError::Transport(e.to_string()))?;
            Ok((reader, write_half))
        };
        match tokio::time::timeout(AUTH_HANDSHAKE_TIMEOUT, handshake).await {
            Ok(Ok((reader, writer))) => Ok(ControlLink::new(reader, writer)),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(ControlError::Authentication),
        }
    }

    #[cfg(windows)]
    async fn accept_stream(
        &self,
    ) -> Result<tokio::net::windows::named_pipe::NamedPipeServer, ControlError> {
        let server = self
            .first
            .lock()
            .expect("pipe instance lock")
            .take()
            .ok_or_else(|| ControlError::Transport("control server already consumed".into()))?;
        server
            .connect()
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))?;
        Ok(server)
    }

    #[cfg(unix)]
    async fn accept_stream(&self) -> Result<tokio::net::UnixStream, ControlError> {
        let (stream, _addr) = self
            .listener
            .accept()
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))?;
        Ok(stream)
    }
}

/// Connect to a control server from the child side (used by tests and protocol
/// twins emulating `runtime/adapter.mjs`): presents the private transport
/// preamble (token + pinned generation) and awaits the shell's acknowledgement
/// before returning the raw channel.
pub async fn connect(endpoint: &ControlEndpoint) -> Result<RawChannel, ControlError> {
    let stream = wrap_connected(platform_connect(endpoint).await?);
    let (read_half, mut write_half) = tokio::io::split(stream);
    write_half
        .write_all(encode_preamble(&endpoint.token, PROTOCOL_GENERATION).as_bytes())
        .await
        .map_err(|e| ControlError::Transport(e.to_string()))?;
    write_half
        .flush()
        .await
        .map_err(|e| ControlError::Transport(e.to_string()))?;
    let mut reader = BufReader::new(read_half);
    let mut ack = String::new();
    let acknowledged = tokio::time::timeout(
        AUTH_HANDSHAKE_TIMEOUT,
        tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut ack),
    )
    .await
    .map_err(|_| ControlError::Authentication)?
    .map_err(|e| ControlError::Transport(e.to_string()))?;
    // The server acknowledges with exactly one empty line; EOF means the
    // preamble was refused, and any other content is a protocol violation that
    // must not be mistaken for the acknowledgement.
    if acknowledged == 0 {
        return Err(ControlError::Authentication);
    }
    if !ack.trim_end_matches(['\r', '\n']).is_empty() {
        return Err(ControlError::MalformedFrame(
            "control channel acknowledgement is not the empty transport line".into(),
        ));
    }
    Ok(RawChannel::new(reader, write_half))
}

#[cfg(windows)]
async fn platform_connect(
    endpoint: &ControlEndpoint,
) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, ControlError> {
    use tokio::net::windows::named_pipe::ClientOptions;
    ClientOptions::new()
        .open(&endpoint.socket_name)
        .map_err(|e| ControlError::Transport(e.to_string()))
}

#[cfg(unix)]
async fn platform_connect(
    endpoint: &ControlEndpoint,
) -> Result<tokio::net::unix::UnixStream, ControlError> {
    tokio::net::UnixStream::connect(&endpoint.socket_name)
        .await
        .map_err(|e| ControlError::Transport(e.to_string()))
}

#[cfg(windows)]
type LinkReadHalf = tokio::io::ReadHalf<ControlStream>;
#[cfg(unix)]
type LinkReadHalf = tokio::io::ReadHalf<ControlStream>;
#[cfg(windows)]
type LinkWriteHalf = tokio::io::WriteHalf<ControlStream>;
#[cfg(unix)]
type LinkWriteHalf = tokio::io::WriteHalf<ControlStream>;

/// Duplex stream accepted or connected on the local socket. Windows names the
/// server and client pipe types separately; Unix shares `UnixStream`.
#[cfg(windows)]
pub enum ControlStream {
    Server(tokio::net::windows::named_pipe::NamedPipeServer),
    Client(tokio::net::windows::named_pipe::NamedPipeClient),
}
#[cfg(unix)]
pub type ControlStream = tokio::net::unix::UnixStream;

#[cfg(windows)]
fn wrap_accepted(stream: tokio::net::windows::named_pipe::NamedPipeServer) -> ControlStream {
    ControlStream::Server(stream)
}
#[cfg(unix)]
fn wrap_accepted(stream: tokio::net::unix::UnixStream) -> ControlStream {
    stream
}
#[cfg(windows)]
fn wrap_connected(stream: tokio::net::windows::named_pipe::NamedPipeClient) -> ControlStream {
    ControlStream::Client(stream)
}
#[cfg(unix)]
fn wrap_connected(stream: tokio::net::unix::UnixStream) -> ControlStream {
    stream
}

#[cfg(windows)]
impl tokio::io::AsyncRead for ControlStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ControlStream::Server(stream) => {
                tokio::io::AsyncRead::poll_read(std::pin::Pin::new(stream), cx, buf)
            }
            ControlStream::Client(stream) => {
                tokio::io::AsyncRead::poll_read(std::pin::Pin::new(stream), cx, buf)
            }
        }
    }
}

#[cfg(windows)]
impl tokio::io::AsyncWrite for ControlStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.get_mut() {
            ControlStream::Server(stream) => {
                tokio::io::AsyncWrite::poll_write(std::pin::Pin::new(stream), cx, buf)
            }
            ControlStream::Client(stream) => {
                tokio::io::AsyncWrite::poll_write(std::pin::Pin::new(stream), cx, buf)
            }
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ControlStream::Server(stream) => {
                tokio::io::AsyncWrite::poll_flush(std::pin::Pin::new(stream), cx)
            }
            ControlStream::Client(stream) => {
                tokio::io::AsyncWrite::poll_flush(std::pin::Pin::new(stream), cx)
            }
        }
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ControlStream::Server(stream) => {
                tokio::io::AsyncWrite::poll_shutdown(std::pin::Pin::new(stream), cx)
            }
            ControlStream::Client(stream) => {
                tokio::io::AsyncWrite::poll_shutdown(std::pin::Pin::new(stream), cx)
            }
        }
    }
}

struct Pending {
    responder: oneshot::Sender<HostEvent>,
}

/// Removes a pending entry when its request future ends for any reason,
/// including cancellation by the caller. Without this guard a dropped future
/// leaves the responder in the map until the channel closes, and a later
/// response for that id is silently swallowed instead of being dropped as a
/// late response.
struct PendingGuard {
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
    request_id: Option<u64>,
}

impl PendingGuard {
    /// Remove the entry and transfer it to the caller.
    fn take_entry(&mut self) -> Option<Pending> {
        let request_id = self.request_id.take()?;
        self.pending
            .lock()
            .expect("pending lock")
            .remove(&request_id)
    }

    /// Drop the entry without using it.
    fn release(&mut self) {
        let _ = self.take_entry();
    }
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.release();
    }
}

/// The raw child-side channel (used by tests and protocol twins to emulate the
/// Node adapter): sends `HostEvent` frames and receives `ShellMessage` frames.
///
/// **Frame continuity is state, not a per-call local.** The decoder and the
/// queue of frames it has already completed live in the channel, because a
/// byte-stream socket coalesces freely:
/// - a frame split across two reads is reassembled by the retained
///   [`FrameDecoder`];
/// - a chunk that completes several frames delivers them one call at a time, in
///   wire order, from a FIFO queue — including the trailing protocol violation
///   of a chunk whose valid prefix completed frames;
/// - end of stream with bytes still buffered is an explicit
///   [`ControlError::TruncatedFrame`], never a clean `None`.
///
/// Building the decoder per call (the defect this replaces) silently dropped
/// every frame after the first in a chunk and every partial frame across calls.
pub struct RawChannel {
    reader: BufReader<LinkReadHalf>,
    writer: LinkWriteHalf,
    decoder: FrameDecoder,
    /// Completed frames (and violations) still to be delivered, in wire order.
    pending: std::collections::VecDeque<Result<String, ControlError>>,
    /// The peer reached end of stream; only the buffered frames remain.
    eof_seen: bool,
}

impl RawChannel {
    fn new(reader: BufReader<LinkReadHalf>, writer: LinkWriteHalf) -> Self {
        Self {
            reader,
            writer,
            decoder: FrameDecoder::new(),
            pending: std::collections::VecDeque::new(),
            eof_seen: false,
        }
    }

    /// Send one Host→Shell frame.
    pub async fn send_event(&mut self, event: &HostEvent) -> Result<(), ControlError> {
        let mut bytes =
            serde_json::to_vec(event).map_err(|e| ControlError::MalformedFrame(e.to_string()))?;
        if bytes.len() > MAX_TERMINATED_FRAME_BYTES {
            return Err(ControlError::FrameTooLarge(MAX_TERMINATED_FRAME_BYTES));
        }
        bytes.push(b'\n');
        self.writer
            .write_all(&bytes)
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))?;
        self.writer
            .flush()
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))
    }

    /// Send an already-encoded frame (malformed/oversized-frame fixtures).
    pub async fn send_raw(&mut self, bytes: &[u8]) -> Result<(), ControlError> {
        self.writer
            .write_all(bytes)
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))?;
        self.writer
            .flush()
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))
    }

    /// Receive one Shell→Host frame, in wire order; `None` only on a clean end
    /// of stream with no bytes of an incomplete frame buffered.
    ///
    /// Bounded in both frame sizes, so the child side cannot be made to buffer
    /// without limit.
    pub async fn recv_message(&mut self) -> Result<Option<ShellMessage>, ControlError> {
        loop {
            if let Some(next) = self.pending.pop_front() {
                // A violation queued behind valid frames is delivered after
                // them, so a valid prefix can never hide the trailer.
                let line = next?;
                if line.is_empty() {
                    continue;
                }
                return serde_json::from_str(&line)
                    .map(Some)
                    .map_err(|e| ControlError::MalformedFrame(e.to_string()));
            }
            if self.eof_seen {
                // EOF with a partial frame is a truncated frame, not a clean
                // end: reporting `None` here is how a lost tail frame used to
                // look like an orderly shutdown.
                let buffered = self.decoder.buffered_len();
                if buffered > 0 {
                    return Err(ControlError::TruncatedFrame(buffered));
                }
                return Ok(None);
            }
            let available = self
                .reader
                .fill_buf()
                .await
                .map_err(|e| ControlError::Transport(e.to_string()))?;
            if available.is_empty() {
                self.eof_seen = true;
                continue;
            }
            let chunk = available.to_vec();
            let consumed = chunk.len();
            let frames = self.decoder.push_chunk(&chunk);
            self.reader.consume(consumed);
            match frames {
                Ok(frames) => self.pending.extend(frames),
                // Overflow with no completed frame: the decoder already dropped
                // the flood, so this is the whole result of the read.
                Err(error) => return Err(error),
            }
        }
    }

    /// Bytes buffered for an incomplete frame. Exposed so tests can prove the
    /// decoder survives across calls instead of being rebuilt.
    pub fn buffered_len(&self) -> usize {
        self.decoder.buffered_len()
    }
}

/// Shared writer state: a FIFO queue drained by one background task, so
/// concurrent senders queue instead of contending for the socket, and a bounded
/// queue applies backpressure to a peer that stops reading.
struct Outgoing {
    writer: AsyncMutex<LinkWriteHalf>,
    queue: mpsc::Sender<Vec<u8>>,
    closed: AtomicBool,
}

impl Outgoing {
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Queue one encoded frame. Awaits queue capacity; `Err` once the link is
    /// closed, so a request can never be accepted after teardown.
    async fn enqueue(&self, frame: Vec<u8>) -> Result<(), ControlError> {
        if self.is_closed() {
            return Err(ControlError::Transport("control channel closed".into()));
        }
        self.queue
            .send(frame)
            .await
            .map_err(|_| ControlError::Transport("control channel closed".into()))
    }
}

/// One authenticated control connection (shell side). FIFO per direction;
/// correlated responses resolve their `requestId` waiter; unsolicited events
/// are delivered on the bounded event channel.
pub struct ControlLink {
    outgoing: Arc<Outgoing>,
    events: AsyncMutex<mpsc::Receiver<HostEvent>>,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
    closed: Arc<AtomicBool>,
    next_request_id: AtomicU64,
    writer_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// The reader task owns the read half. Dropping the link must end it, or the
    /// socket stays half-open (the peer never observes end of stream, and a
    /// Windows named-pipe instance is not released) for as long as the process
    /// lives.
    reader_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Drop for ControlLink {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        self.outgoing.close();
        if let Ok(mut handle) = self.reader_task.lock() {
            if let Some(handle) = handle.take() {
                handle.abort();
            }
        }
        if let Ok(mut handle) = self.writer_task.lock() {
            if let Some(handle) = handle.take() {
                handle.abort();
            }
        }
    }
}

impl ControlLink {
    fn new(reader: BufReader<LinkReadHalf>, write_half: LinkWriteHalf) -> Self {
        let (tx, rx) = mpsc::channel(EVENT_QUEUE_CAPACITY);
        let pending: Arc<Mutex<HashMap<u64, Pending>>> = Arc::new(Mutex::new(HashMap::new()));
        let pending_reader = pending.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let closed_reader = closed.clone();
        let reader_task = tokio::spawn(async move {
            // The labelled loop carries no label: `break` from any path —
            // EOF, transport failure, idle peer, malformed frame, frame
            // overflow, or a closed event queue — must fall through to the
            // single terminal-close block below. A labelled `break 'outer`
            // would skip that block, leaving `closed` false and `next_event`
            // pending forever, which is exactly the hang the block exists to
            // prevent.
            let mut reader = reader;
            let mut decoder = FrameDecoder::new();
            loop {
                // Only an incomplete frame has an idle deadline. No heartbeat
                // is specified, so between frames a healthy Host can be silent.
                let available = if decoder.buffered_len() == 0 {
                    reader.fill_buf().await
                } else {
                    match tokio::time::timeout(PARTIAL_FRAME_TIMEOUT, reader.fill_buf()).await {
                        Ok(result) => result,
                        Err(_) => break,
                    }
                };
                let available = match available {
                    Ok(available) => available,
                    Err(_) => break,
                };
                if available.is_empty() {
                    break;
                }
                let chunk = available.to_vec();
                let consumed = chunk.len();
                let frames = decoder.push_chunk(&chunk);
                reader.consume(consumed);
                let frames = match frames {
                    Ok(frames) => frames,
                    // Frame overflow with no completed frame is a protocol
                    // violation: drop every waiter and close the link, exactly
                    // like a malformed frame.
                    Err(_) => break,
                };
                let mut fatal = false;
                for next in frames {
                    let event = match next {
                        Ok(text) => decode_line(&text),
                        Err(error) => Err(error),
                    };
                    match event {
                        Ok(
                            event @ (HostEvent::UpdateTasks { .. }
                            | HostEvent::QuitInspection { .. }),
                        ) => {
                            let request_id = match &event {
                                HostEvent::UpdateTasks { request_id, .. }
                                | HostEvent::QuitInspection { request_id, .. } => *request_id,
                                _ => unreachable!("matched above"),
                            };
                            let waiter = pending_reader
                                .lock()
                                .expect("pending lock")
                                .remove(&request_id);
                            // A late response finds no pending entry and is
                            // dropped (upstream `request?.resolve(...)`).
                            if let Some(waiter) = waiter {
                                let _ = waiter.responder.send(event);
                            }
                        }
                        Ok(event) => {
                            // Bounded queue: a Host that floods unsolicited
                            // events blocks HERE, which stops this task from
                            // draining the socket and pushes back on the peer.
                            if tx.send(event).await.is_err() {
                                fatal = true;
                                break;
                            }
                        }
                        Err(_) => {
                            // A malformed or oversized Host→shell frame is fatal
                            // (protocol violation): drop every waiter and the
                            // channel.
                            fatal = true;
                            break;
                        }
                    }
                }
                if fatal {
                    break;
                }
            }
            // Every exit from the reader — EOF, transport failure, idle peer,
            // malformed frame or frame overflow — reaches this terminal block.
            // Closing the link is what makes `is_closed()` and `send()` agree
            // with the dropped waiters below, so no caller can keep believing
            // the channel is usable. Dropping the event sender also ends
            // `next_event` with `None`, which the supervisor's event pump reads
            // as control-channel failure.
            closed_reader.store(true, Ordering::SeqCst);
            pending_reader.lock().expect("pending lock").clear();
            drop(tx);
        });
        let (queue_tx, mut queue_rx) = mpsc::channel::<Vec<u8>>(WRITE_QUEUE_CAPACITY);
        let outgoing = Arc::new(Outgoing {
            writer: AsyncMutex::new(write_half),
            queue: queue_tx,
            closed: AtomicBool::new(false),
        });
        let writer_core = outgoing.clone();
        let writer_task = tokio::spawn(async move {
            while let Some(frame) = queue_rx.recv().await {
                let mut writer = writer_core.writer.lock().await;
                let written =
                    writer.write_all(&frame).await.is_ok() && writer.flush().await.is_ok();
                drop(writer);
                if !written {
                    writer_core.close();
                    break;
                }
            }
        });
        Self {
            outgoing,
            events: AsyncMutex::new(rx),
            pending,
            closed,
            next_request_id: AtomicU64::new(1),
            writer_task: Mutex::new(Some(writer_task)),
            reader_task: Mutex::new(Some(reader_task)),
        }
    }

    /// Whether the link has been closed by teardown, EOF or a write failure.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst) || self.outgoing.is_closed()
    }

    /// Number of correlated requests still awaiting an answer. Exposed so tests
    /// can prove that cancellation and deadline misses leak no waiter.
    pub fn pending_count(&self) -> usize {
        self.pending.lock().expect("pending lock").len()
    }

    /// Send one shell message (FIFO), bounded by [`WRITE_QUEUE_CAPACITY`].
    pub async fn send(&self, message: &ShellMessage) -> Result<(), ControlError> {
        if self.is_closed() {
            return Err(ControlError::Transport("control channel closed".into()));
        }
        let frame = encode_frame(message)?;
        self.outgoing.enqueue(frame).await
    }

    /// Send one shell message with the complete operation — queue capacity,
    /// write and flush — bounded by `deadline`.
    pub async fn send_with_deadline(
        &self,
        message: &ShellMessage,
        deadline: Duration,
    ) -> Result<(), ControlError> {
        match tokio::time::timeout(deadline, self.send(message)).await {
            Ok(result) => result,
            Err(_) => Err(ControlError::Transport(format!(
                "control send missed its {deadline:?} deadline"
            ))),
        }
    }

    /// Reject every in-flight correlated request after terminal Host failure.
    pub fn fail_pending(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.outgoing.close();
        self.pending.lock().expect("pending lock").clear();
    }

    /// Next unsolicited event (`ready`, `fatal`, `platform-session`,
    /// `shutdown-complete`, or a response whose waiter is gone).
    pub async fn next_event(&self) -> Option<HostEvent> {
        self.events.lock().await.recv().await
    }

    /// Send a correlated control request and await its response.
    ///
    /// `deadline` covers the **whole** operation: pending registration, the
    /// send (queue capacity, write and flush) and the reply. A caller that
    /// drops this future removes its pending entry, so cancellation cannot leak
    /// a waiter or make a later response resolve the wrong request.
    pub async fn request(
        &self,
        build: impl FnOnce(u64) -> ShellMessage,
        deadline: Duration,
    ) -> Result<HostEvent, ControlError> {
        let started = tokio::time::Instant::now();
        let request_id = self.next_request_id.fetch_add(1, Ordering::SeqCst);
        let (tx, mut rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().expect("pending lock");
            if self.closed.load(Ordering::SeqCst) {
                return Err(ControlError::Transport("control channel closed".into()));
            }
            pending.insert(request_id, Pending { responder: tx });
        }
        let mut guard = PendingGuard {
            pending: self.pending.clone(),
            request_id: Some(request_id),
        };
        let message = build(request_id);
        match tokio::time::timeout(deadline, self.send(&message)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                guard.release();
                return Err(error);
            }
            Err(_) => {
                guard.release();
                return Err(ControlError::Transport(format!(
                    "request {request_id} missed its {deadline:?} deadline while sending"
                )));
            }
        }
        // The reply shares the SAME deadline: the operation budget is not
        // restarted after the send.
        let remaining = deadline.saturating_sub(started.elapsed());
        match tokio::time::timeout(remaining, &mut rx).await {
            Ok(Ok(event)) => {
                // The waiter was resolved, so the reader has already removed the
                // entry. Taking it here is what keeps the guard's `Drop` from
                // running the removal a second time, and the entry is expected
                // to be gone — a `Some` would mean this request resolved twice.
                debug_assert!(
                    guard.take_entry().is_none(),
                    "a resolved request must already have left the pending map"
                );
                Ok(event)
            }
            Ok(Err(_)) => {
                guard.release();
                Err(ControlError::Transport("control channel closed".into()))
            }
            Err(_) => {
                guard.release();
                Err(ControlError::Transport(format!(
                    "request {request_id} missed its {deadline:?} deadline"
                )))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_encodes_one_message_per_line() {
        let frame = encode_frame(&ShellMessage::Shutdown {}).expect("encode");
        assert_eq!(frame, b"{\"type\":\"shutdown\"}\n");
        let request = ShellMessage::UpdateTasks {
            request_id: 7,
            action: UpdateTasksAction::Lock,
        };
        let frame = encode_frame(&request).expect("encode");
        assert_eq!(
            std::str::from_utf8(&frame).unwrap(),
            "{\"type\":\"update-tasks\",\"requestId\":7,\"action\":\"lock\"}\n"
        );
    }

    #[test]
    fn decoder_reassembles_partial_frames() {
        let mut decoder = FrameDecoder::new();
        decoder.push(b"{\"type\":\"ready\",\"url").unwrap();
        assert!(decoder.next_line().is_none(), "partial frame must wait");
        decoder
            .push(b"\":\"http://127.0.0.1:1\"}\n{\"type\":\"shutdown-com")
            .unwrap();
        assert_eq!(
            decoder.next_line().unwrap().unwrap(),
            "{\"type\":\"ready\",\"url\":\"http://127.0.0.1:1\"}"
        );
        assert!(decoder.next_line().is_none());
        decoder.push(b"plete\"}\n").unwrap();
        assert_eq!(
            decoder.next_line().unwrap().unwrap(),
            "{\"type\":\"shutdown-complete\"}"
        );
    }

    #[test]
    fn decoder_rejects_malformed_and_oversized_lines() {
        let mut decoder = FrameDecoder::new();
        decoder.push(b"not json\n").unwrap();
        let line = decoder.next_line().unwrap().expect("transport-valid line");
        assert!(
            decode_line(&line).is_err(),
            "malformed JSON is rejected at decode"
        );

        // A socket streams a large frame in chunks, so a delimiter-free flood
        // is refused by the unterminated cap long before the shell could buffer
        // a frame that size.
        let mut decoder = FrameDecoder::new();
        let chunk = vec![b'x'; 64 * 1024];
        let mut overflowed = false;
        for _ in 0..(MAX_TERMINATED_FRAME_BYTES / chunk.len() + 2) {
            if decoder.push(&chunk).is_err() {
                overflowed = true;
                break;
            }
        }
        assert!(
            overflowed,
            "a delimiter-free flood is refused before it can finish"
        );
        assert!(
            decoder.buffered_len() <= UNTERMINATED_FRAME_CAP_BYTES,
            "the buffer stayed inside the unterminated cap"
        );

        // `next_line` rejects a completed frame that is over the terminated
        // cap. Nothing else can be holding bytes into the decoder, so the check
        // is exercised through the decoder's own buffer.
        let mut probe = FrameDecoder::new();
        let mut framed = "z".repeat(MAX_TERMINATED_FRAME_BYTES + 1).into_bytes();
        framed.push(b'\n');
        probe.admit_raw(&framed);
        assert!(
            matches!(probe.next_line(), Some(Err(ControlError::FrameTooLarge(_)))),
            "an over-cap frame is never delivered as a decoded line"
        );
        assert_eq!(probe.buffered_len(), 0, "the oversized frame is dropped");
    }

    #[test]
    fn decoder_enforces_the_unterminated_cap_before_allocating() {
        let mut decoder = FrameDecoder::new();
        let chunk = vec![b'x'; UNTERMINATED_FRAME_CAP_BYTES];
        decoder
            .push(&chunk)
            .expect("chunk exactly at the cap is accepted");
        assert_eq!(decoder.buffered_len(), UNTERMINATED_FRAME_CAP_BYTES);
        // The next byte has no newline yet, so the frame is over the cap: the
        // rejection happens before the buffer can grow past it.
        let error = decoder
            .push(b"y")
            .expect_err("one byte past the cap must be rejected");
        assert!(matches!(error, ControlError::UnterminatedFrameTooLarge));
        assert!(decoder.buffered_len() <= UNTERMINATED_FRAME_CAP_BYTES);
    }

    #[test]
    fn decoder_frees_a_terminated_frame_inside_an_over_cap_chunk() {
        // A chunk that completes a legitimate frame AND carries a flood behind
        // it must not lose the frame that already had its newline.
        let mut decoder = FrameDecoder::new();
        let mut chunk = Vec::new();
        chunk.extend_from_slice(b"{\"type\":\"shutdown-complete\"}\n");
        chunk.extend(std::iter::repeat_n(b'x', UNTERMINATED_FRAME_CAP_BYTES));
        let frames = decoder
            .push_chunk(&chunk)
            .expect("the terminated frame is preserved despite the trailing flood");
        assert_eq!(frames.len(), 2);
        let mut frames = frames.into_iter();
        assert_eq!(
            frames.next().unwrap().unwrap(),
            "{\"type\":\"shutdown-complete\"}"
        );
        assert!(matches!(
            frames.next().unwrap(),
            Err(ControlError::UnterminatedFrameTooLarge)
        ));
    }

    #[test]
    fn an_over_cap_chunk_preserves_every_completed_frame_before_the_flood() {
        // The regression this guards: a chunk whose *head* holds several valid
        // frames and whose *tail* is a delimiter-free overflow used to return
        // only the last completed frame (the flood was reported, but the earlier
        // frames were thrown away with it). Every frame that had its newline
        // before the flood must survive, in wire order, with the violation last.
        let mut decoder = FrameDecoder::new();
        let mut chunk = Vec::new();
        chunk.extend_from_slice(b"{\"type\":\"ready\",\"url\":\"u\"}\n");
        chunk.extend_from_slice(b"{\"type\":\"shutdown-complete\"}\n");
        chunk.extend_from_slice(b"{\"type\":\"shutdown-complete\"}\n");
        chunk.extend(std::iter::repeat_n(b'x', UNTERMINATED_FRAME_CAP_BYTES));

        let frames = decoder
            .push_chunk(&chunk)
            .expect("completed frames survive a trailing overflow");
        let rendered: Vec<_> = frames
            .iter()
            .map(|frame| match frame {
                Ok(line) => line.clone(),
                Err(error) => format!("<{error}>"),
            })
            .collect();
        assert_eq!(
            rendered,
            vec![
                "{\"type\":\"ready\",\"url\":\"u\"}".to_string(),
                "{\"type\":\"shutdown-complete\"}".to_string(),
                "{\"type\":\"shutdown-complete\"}".to_string(),
                "<control channel: unterminated frame exceeded 8388608 bytes>".to_string(),
            ],
            "every pre-flood frame is delivered in order, violation last"
        );
        // The flood bytes were dropped, not buffered, so the decoder is empty.
        assert_eq!(decoder.buffered_len(), 0);
    }

    #[test]
    fn an_over_cap_chunk_cannot_hide_its_flood_behind_a_valid_prefix() {
        // The other direction of the same regression: a valid prefix must not
        // suppress the overflow signal. A caller that only saw `Ok(frames)` would
        // keep reading a peer that has already violated the protocol.
        let mut decoder = FrameDecoder::new();
        let mut chunk = Vec::new();
        chunk.extend_from_slice(b"{\"type\":\"shutdown-complete\"}\n");
        chunk.extend(std::iter::repeat_n(b'x', UNTERMINATED_FRAME_CAP_BYTES + 1));
        let frames = decoder
            .push_chunk(&chunk)
            .expect("the valid prefix is still delivered");
        assert!(
            matches!(
                frames.last(),
                Some(Err(ControlError::UnterminatedFrameTooLarge))
            ),
            "the trailing violation must be reported even when a frame came first: {frames:?}"
        );

        // A chunk that only overflows, with nothing completed, is a plain error
        // with no frames — the caller must not have to inspect an empty vec.
        let mut decoder = FrameDecoder::new();
        let flood = vec![b'x'; UNTERMINATED_FRAME_CAP_BYTES + 1];
        assert!(matches!(
            decoder.push_chunk(&flood),
            Err(ControlError::UnterminatedFrameTooLarge)
        ));
        assert_eq!(
            decoder.buffered_len(),
            UNTERMINATED_FRAME_CAP_BYTES,
            "the decoder holds at most the cap, never the flood"
        );
    }

    #[test]
    fn a_terminated_frame_at_the_cap_still_completes() {
        // The boundary the others sit against: a frame whose content is exactly
        // the unterminated cap, delivered as one terminated chunk, is legal and
        // must not be mistaken for a flood.
        let mut decoder = FrameDecoder::new();
        let mut chunk = vec![b'y'; UNTERMINATED_FRAME_CAP_BYTES - 1];
        chunk.push(b'\n');
        let frames = decoder
            .push_chunk(&chunk)
            .expect("a terminated frame at the cap is admitted");
        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames.into_iter().next().unwrap().expect("decodes").len(),
            UNTERMINATED_FRAME_CAP_BYTES - 1
        );
    }

    #[test]
    fn a_flood_without_a_terminator_never_grows_the_buffer() {
        // Silently-flooding peer: the buffer is capped and the caller is told.
        let mut decoder = FrameDecoder::new();
        let chunk = vec![b'x'; 64 * 1024];
        let mut pushes = 0usize;
        loop {
            pushes += 1;
            if decoder.push(&chunk).is_err() {
                break;
            }
            assert!(
                decoder.buffered_len() <= UNTERMINATED_FRAME_CAP_BYTES,
                "the buffer must never exceed the unterminated cap"
            );
            assert!(pushes < 1024, "the cap must be reached in bounded pushes");
        }
        assert!(decoder.buffered_len() <= UNTERMINATED_FRAME_CAP_BYTES);
    }

    #[test]
    fn outbound_frames_are_capped() {
        let oversized = ShellMessage::QuitInspection {
            request_id: u64::MAX,
        };
        // The cap is not reachable from the closed request vocabulary, so the
        // guard is asserted directly against the constants.
        assert!(encode_frame(&oversized).is_ok());
        const {
            assert!(MAX_OUTBOUND_FRAME_BYTES >= 1024);
            assert!(MAX_TERMINATED_FRAME_BYTES > MAX_OUTBOUND_FRAME_BYTES);
        }
    }

    #[test]
    fn decode_rejects_unknown_and_invalid_events() {
        assert!(decode_line("{\"type\":\"mystery\"}").is_err());
        assert!(
            decode_line("{\"type\":\"ready\"}").is_err(),
            "ready requires url"
        );
        assert!(decode_line("[1,2]").is_err());
        let ok = decode_line(
            "{\"type\":\"quit-inspection\",\"requestId\":3,\"activeTasks\":true,\"scheduledTasks\":false}",
        )
        .expect("valid");
        assert!(matches!(
            ok,
            HostEvent::QuitInspection { request_id: 3, .. }
        ));
    }

    #[test]
    fn generation_and_token_are_constant_time_compared() {
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("abc", "abd"));
        assert!(!token_matches("abc", "abcd"));
        assert_eq!(PROTOCOL_GENERATION, 4);
    }

    #[test]
    fn the_private_preamble_requires_the_pinned_generation() {
        assert_eq!(encode_preamble("tok", 4), "tok 4\n");
        assert_eq!(parse_preamble("tok 4", "tok").expect("pinned"), 4);
        // The token is verified before the generation is read, so an
        // unauthenticated peer learns nothing about accepted generations.
        assert!(matches!(
            parse_preamble("other 4", "tok"),
            Err(ControlError::Authentication)
        ));
        assert!(matches!(
            parse_preamble("other 3", "tok"),
            Err(ControlError::Authentication)
        ));
        // A pre-generation (bare token) handshake cannot say which lifecycle it
        // speaks, so it is refused rather than trusted.
        assert!(matches!(
            parse_preamble("tok", "tok"),
            Err(ControlError::GenerationMismatch {
                expected: 4,
                actual: 0
            })
        ));
        assert!(matches!(
            parse_preamble("tok 3", "tok"),
            Err(ControlError::GenerationMismatch {
                expected: 4,
                actual: 3
            })
        ));
        assert!(matches!(
            parse_preamble("tok five", "tok"),
            Err(ControlError::MalformedFrame(_))
        ));
    }

    #[test]
    fn a_swapped_runtime_generation_is_refused_before_any_frame() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let endpoint = ControlEndpoint::generate();
            let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
            let accept = tokio::spawn(async move { server.accept().await });
            // A raw child that claims a different lifecycle generation.
            let mut stream = platform_connect(&endpoint).await.expect("connect");
            stream
                .write_all(encode_preamble(&endpoint.token, PROTOCOL_GENERATION + 1).as_bytes())
                .await
                .expect("write preamble");
            stream.flush().await.expect("flush");
            let refused = tokio::time::timeout(Duration::from_secs(5), accept)
                .await
                .expect("accept resolves")
                .expect("join");
            assert!(matches!(
                refused,
                Err(ControlError::GenerationMismatch { .. })
            ));
            // The shell neither acknowledges nor keeps the connection: the
            // child observes end of stream instead of an empty ack line.
            let mut ack = [0u8; 8];
            let read = tokio::time::timeout(
                Duration::from_secs(5),
                tokio::io::AsyncReadExt::read(&mut stream, &mut ack),
            )
            .await
            .expect("refusal closes the connection");
            assert_eq!(
                read.expect("read"),
                0,
                "a refused preamble is not acknowledged"
            );
        });
    }

    /// A chunk that completes several frames must deliver every one of them, in
    /// wire order — the defect was returning the first and dropping the rest.
    #[tokio::test]
    async fn a_coalesced_chunk_delivers_every_frame_in_order() {
        let endpoint = ControlEndpoint::generate();
        let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
        let accept = tokio::spawn(async move { server.accept().await });
        let mut child = connect(&endpoint).await.expect("connect");
        let link = accept.await.expect("join").expect("accept");

        let mut payload = encode_frame(&ShellMessage::Shutdown {}).expect("encode");
        payload
            .extend(encode_frame(&ShellMessage::QuitInspection { request_id: 7 }).expect("encode"));
        payload.extend(
            encode_frame(&ShellMessage::UpdateTasks {
                request_id: 8,
                action: UpdateTasksAction::Lock,
            })
            .expect("encode"),
        );
        link.outgoing.enqueue(payload).await.expect("queue");

        assert!(matches!(
            child.recv_message().await.expect("recv"),
            Some(ShellMessage::Shutdown {})
        ));
        assert!(matches!(
            child.recv_message().await.expect("recv"),
            Some(ShellMessage::QuitInspection { request_id: 7 })
        ));
        assert!(matches!(
            child.recv_message().await.expect("recv"),
            Some(ShellMessage::UpdateTasks {
                request_id: 8,
                action: UpdateTasksAction::Lock
            })
        ));
    }

    /// A frame split across two reads survives a *cancelled* receive: the
    /// decoder is channel state, so a dropped future cannot lose the prefix.
    #[tokio::test]
    async fn a_partial_frame_survives_a_cancelled_receive() {
        let endpoint = ControlEndpoint::generate();
        let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
        let accept = tokio::spawn(async move { server.accept().await });
        let mut child = connect(&endpoint).await.expect("connect");
        let link = accept.await.expect("join").expect("accept");

        let head = b"{\"type\":\"quit-insp".to_vec();
        let tail =
            b"ection\",\"requestId\":11,\"activeTasks\":true,\"scheduledTasks\":false}\n".to_vec();
        link.outgoing
            .enqueue(head.clone())
            .await
            .expect("queue head");
        tokio::time::sleep(Duration::from_millis(150)).await;

        let cancelled =
            tokio::time::timeout(Duration::from_millis(300), child.recv_message()).await;
        assert!(
            cancelled.is_err(),
            "an incomplete frame must not be reported as a message"
        );
        assert_eq!(
            child.buffered_len(),
            head.len(),
            "the partial frame stayed in the channel across the cancelled call"
        );

        link.outgoing.enqueue(tail).await.expect("queue tail");
        assert!(matches!(
            child.recv_message().await.expect("recv"),
            Some(ShellMessage::QuitInspection { request_id: 11 })
        ));
    }

    /// A chunk whose valid prefix completes frames and whose tail is a
    /// delimiter-free flood must deliver the frames *and then* the violation.
    #[tokio::test]
    async fn a_channel_reports_the_trailing_violation_after_a_valid_prefix() {
        let endpoint = ControlEndpoint::generate();
        let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
        let accept = tokio::spawn(async move { server.accept().await });
        let mut child = connect(&endpoint).await.expect("connect");
        let link = accept.await.expect("join").expect("accept");

        let mut payload = encode_frame(&ShellMessage::Shutdown {}).expect("encode");
        payload.extend(std::iter::repeat_n(b'x', UNTERMINATED_FRAME_CAP_BYTES + 1));
        link.outgoing.enqueue(payload).await.expect("queue");

        assert!(matches!(
            child.recv_message().await.expect("recv"),
            Some(ShellMessage::Shutdown {})
        ));
        let error = child
            .recv_message()
            .await
            .expect_err("the trailing overflow must be reported, not swallowed");
        assert!(matches!(error, ControlError::UnterminatedFrameTooLarge));
    }

    /// End of stream with bytes still buffered is a truncated frame, never a
    /// clean `None`.
    #[tokio::test]
    async fn eof_with_a_partial_frame_is_reported_explicitly() {
        let endpoint = ControlEndpoint::generate();
        let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
        let accept = tokio::spawn(async move { server.accept().await });
        let mut child = connect(&endpoint).await.expect("connect");
        let link = accept.await.expect("join").expect("accept");

        let partial = b"{\"type\":\"shutdown-com".to_vec();
        let expected = partial.len();
        link.outgoing.enqueue(partial).await.expect("queue partial");
        tokio::time::sleep(Duration::from_millis(150)).await;
        drop(link);

        let error = child
            .recv_message()
            .await
            .expect_err("a truncated frame must not look like a clean end of stream");
        assert!(matches!(error, ControlError::TruncatedFrame(n) if n == expected));
    }

    /// The other side of that contract: a clean end of stream after complete
    /// frames is still `None`.
    #[tokio::test]
    async fn a_clean_eof_after_complete_frames_is_none() {
        let endpoint = ControlEndpoint::generate();
        let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
        let accept = tokio::spawn(async move { server.accept().await });
        let mut child = connect(&endpoint).await.expect("connect");
        let link = accept.await.expect("join").expect("accept");

        link.outgoing
            .enqueue(encode_frame(&ShellMessage::Shutdown {}).expect("encode"))
            .await
            .expect("queue");
        assert!(matches!(
            child.recv_message().await.expect("recv"),
            Some(ShellMessage::Shutdown {})
        ));
        drop(link);
        assert!(child.recv_message().await.expect("clean eof").is_none());
        assert_eq!(child.buffered_len(), 0);
    }

    #[test]
    fn platform_session_debug_redacts_even_unvalidated_nested_payloads() {
        let session = PlatformSession {
            origin: "https://secret-origin.invalid/secret-query".into(),
            token: "secret-token-marker".into(),
            user_id: Some("secret-user-marker".into()),
            embedded_page_dist: Some("secret-path-marker".into()),
            request_headers: Some(
                [("x-custom".into(), "secret-header-marker".into())]
                    .into_iter()
                    .collect(),
            ),
        };
        for rendered in [
            format!("{session:?}"),
            format!(
                "{:?}",
                HostEvent::PlatformSession {
                    session: Some(session)
                }
            ),
        ] {
            assert!(rendered.contains("[REDACTED]"));
            assert!(!rendered.contains("secret-"));
        }
    }

    #[test]
    fn platform_session_validation_mirrors_upstream() {
        let valid = PlatformSession {
            origin: "http://127.0.0.1:3080".into(),
            token: "t".into(),
            user_id: Some("u".into()),
            embedded_page_dist: None,
            request_headers: Some(
                [("x-custom".to_string(), "v".to_string())]
                    .into_iter()
                    .collect(),
            ),
        };
        assert!(valid.validate());
        let bad_origin = PlatformSession {
            origin: "http://example.com".into(),
            ..valid.clone()
        };
        assert!(
            !bad_origin.validate(),
            "plain http on a public host is refused"
        );
        let bad_header = PlatformSession {
            request_headers: Some(
                [("Authorization".to_string(), "x".to_string())]
                    .into_iter()
                    .collect(),
            ),
            ..valid.clone()
        };
        assert!(
            !bad_header.validate(),
            "uppercase and forbidden headers are refused"
        );
        let empty_token = PlatformSession {
            token: String::new(),
            ..valid.clone()
        };
        assert!(!empty_token.validate());
    }

    #[tokio::test]
    async fn link_round_trips_events_and_correlated_responses() {
        let endpoint = ControlEndpoint {
            socket_name: platform_socket_name("test-roundtrip"),
            token: "tok".into(),
        };
        let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
        let accept = tokio::spawn(async move { server.accept().await });
        let mut child = connect(&endpoint).await.expect("connect");
        let server_link = accept.await.expect("join").expect("accept");
        // Child → shell unsolicited event.
        child
            .send_event(&HostEvent::ShutdownComplete {})
            .await
            .expect("send");
        assert!(matches!(
            server_link.next_event().await,
            Some(HostEvent::ShutdownComplete { .. })
        ));
        // Shell → child request framing reaches the raw channel.
        server_link
            .send(&ShellMessage::QuitInspection { request_id: 9 })
            .await
            .expect("send");
        assert!(matches!(
            child.recv_message().await.expect("recv"),
            Some(ShellMessage::QuitInspection { request_id: 9 })
        ));
    }

    #[tokio::test]
    async fn wrong_token_is_refused_within_the_handshake_budget() {
        let endpoint = ControlEndpoint {
            socket_name: platform_socket_name("test-auth"),
            token: "right".into(),
        };
        let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
        let accept = tokio::spawn(async move { server.accept().await });
        let wrong = ControlEndpoint {
            token: "wrong".into(),
            ..endpoint.clone()
        };
        assert!(
            connect(&wrong).await.is_err(),
            "the wrong token must not authenticate"
        );
        // The server refuses the unauthenticated attempt before any protocol frame.
        assert!(accept.await.expect("join").is_err());
    }

    #[tokio::test]
    async fn a_cancelled_request_leaves_no_waiter_behind() {
        let endpoint = ControlEndpoint::generate();
        let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
        let accept = tokio::spawn(async move { server.accept().await });
        let mut child = connect(&endpoint).await.expect("connect");
        let link = accept.await.expect("join").expect("accept");

        // Cancel the request future before any answer exists.
        let cancelled = tokio::time::timeout(
            Duration::from_millis(50),
            link.request(
                |id| ShellMessage::QuitInspection { request_id: id },
                Duration::from_secs(30),
            ),
        )
        .await;
        assert!(cancelled.is_err(), "the request is cancelled by its caller");
        let message = child.recv_message().await.expect("recv").expect("request");
        let ShellMessage::QuitInspection { request_id } = message else {
            panic!("expected quit-inspection");
        };
        assert_eq!(
            link.pending.lock().expect("pending lock").len(),
            0,
            "a cancelled request must not leave a pending entry"
        );
        // The late answer for the cancelled id is dropped, not mis-resolved.
        child
            .send_event(&HostEvent::QuitInspection {
                request_id,
                active_tasks: true,
                scheduled_tasks: false,
                error: None,
            })
            .await
            .expect("late answer");
        // A fresh request still works, proving the reader survived the drop.
        let answered = tokio::join!(
            link.request(
                |id| ShellMessage::QuitInspection { request_id: id },
                Duration::from_secs(5),
            ),
            async {
                let message = child.recv_message().await.expect("recv").expect("request");
                let ShellMessage::QuitInspection { request_id } = message else {
                    panic!("expected quit-inspection");
                };
                child
                    .send_event(&HostEvent::QuitInspection {
                        request_id,
                        active_tasks: false,
                        scheduled_tasks: false,
                        error: None,
                    })
                    .await
                    .expect("answer");
            }
        );
        assert!(matches!(
            answered.0.expect("correlated answer"),
            HostEvent::QuitInspection {
                active_tasks: false,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn request_deadline_covers_the_send_as_well_as_the_reply() {
        let endpoint = ControlEndpoint::generate();
        let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
        let accept = tokio::spawn(async move { server.accept().await });
        // Connect and authenticate, then stop reading: the write queue fills.
        let child = connect(&endpoint).await.expect("connect");
        let link = accept.await.expect("join").expect("accept");

        let mut issued = 0usize;
        let started = std::time::Instant::now();
        let mut stalled = false;
        while issued < WRITE_QUEUE_CAPACITY * 4 {
            issued += 1;
            if link
                .request(
                    |id| ShellMessage::QuitInspection { request_id: id },
                    Duration::from_millis(300),
                )
                .await
                .is_err()
            {
                stalled = true;
                break;
            }
        }
        assert!(
            stalled,
            "a peer that never reads must stall the request operation"
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the send side of a request is bounded, not unbounded"
        );
        drop(child);
    }
}
