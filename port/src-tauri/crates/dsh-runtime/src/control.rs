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
//! - the first line on the connection is the raw transport token (not JSON),
//!   compared in constant time; only then do generation-4 messages flow.
//!
//! Framing contract: each message is one compact JSON object followed by `\n`.
//! A partial frame is buffered until complete; a line that is not valid JSON of
//! a known message type is a protocol violation and is fatal to the child
//! (`isDesktopHostEvent` strictness, `host-process.ts:206-212`).

use std::collections::HashMap;
#[cfg(unix)]
use std::path::PathBuf;
use std::time::Duration;

use dsh_core::protocol::IndexInjection;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// Pinned lifecycle protocol generation (`DESKTOP_HOST_PROTOCOL_VERSION`).
pub const PROTOCOL_GENERATION: u32 = dsh_core::protocol::PROTOCOL_GENERATION;

/// Environment variables of the control-socket handover.
pub const CONTROL_SOCKET_ENV: &str = "DSH_DESKTOP_CONTROL_SOCKET";
/// One-time transport token shared with the child.
pub const CONTROL_TOKEN_ENV: &str = "DSH_DESKTOP_CONTROL_TOKEN";
/// Pinned protocol generation shared with the child.
pub const CONTROL_GENERATION_ENV: &str = "DSH_DESKTOP_CONTROL_GENERATION";

/// Maximum accepted frame size (bytes, excluding the newline). Injection
/// tables ride `ready`, so this is generous.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Control-channel failures.
#[derive(Debug, thiserror::Error)]
pub enum ControlError {
    /// The peer sent a line that is not valid JSON of a known message type.
    #[error("control channel: malformed frame: {0}")]
    MalformedFrame(String),
    /// A frame exceeded {@link MAX_FRAME_BYTES}.
    #[error("control channel: frame exceeded {MAX_FRAME_BYTES} bytes")]
    FrameTooLarge,
    /// The transport failed (socket closed, write failed).
    #[error("control channel: transport failed: {0}")]
    Transport(String),
    /// The connecting child presented the wrong transport token.
    #[error("control channel: authentication failed")]
    Authentication,
    /// The child negotiated a different protocol generation.
    #[error("control channel: protocol generation mismatch (expected {expected}, got {actual})")]
    GenerationMismatch { expected: u32, actual: u32 },
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    bytes.push(b'\n');
    Ok(bytes)
}

/// Decode one complete line (without the trailing newline) into a Host event.
pub fn decode_line(line: &str) -> Result<HostEvent, ControlError> {
    serde_json::from_str(line).map_err(|e| ControlError::MalformedFrame(e.to_string()))
}

/// Incremental NDJSON frame decoder: partial-frame reassembly and malformed
/// line rejection.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    /// Fresh decoder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Append one transport chunk.
    pub fn push(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    /// Pop the next complete line, or `None` while the frame is still partial.
    /// `Err(FrameTooLarge)` fires once the buffer exceeds {@link MAX_FRAME_BYTES}
    /// without a newline.
    pub fn next_line(&mut self) -> Option<Result<String, ControlError>> {
        match self.buffer.iter().position(|b| *b == b'\n') {
            Some(end) => {
                let line: Vec<u8> = self.buffer.drain(..=end).collect();
                let content = &line[..line.len() - 1];
                match std::str::from_utf8(content) {
                    Ok(text) => Some(Ok(text.to_string())),
                    Err(e) => Some(Err(ControlError::MalformedFrame(e.to_string()))),
                }
            }
            None if self.buffer.len() > MAX_FRAME_BYTES => {
                self.buffer.clear();
                Some(Err(ControlError::FrameTooLarge))
            }
            None => None,
        }
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
    first: std::sync::Mutex<Option<tokio::net::windows::named_pipe::NamedPipeServer>>,
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
            use tokio::net::windows::named_pipe::ServerOptions;
            let first = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&endpoint.socket_name)
                .map_err(|e| ControlError::Transport(e.to_string()))?;
            Ok(Self {
                endpoint,
                first: std::sync::Mutex::new(Some(first)),
            })
        }
    }

    /// Endpoint handed to the child.
    pub fn endpoint(&self) -> &ControlEndpoint {
        &self.endpoint
    }

    /// Accept one child connection and authenticate its transport token.
    pub async fn accept(&self) -> Result<ControlLink, ControlError> {
        let stream = wrap_accepted(self.accept_stream().await?);
        let (read_half, mut write_half) = tokio::io::split(stream);
        let mut reader = tokio::io::BufReader::new(read_half);
        let mut token_line = String::new();
        let read = tokio::time::timeout(Duration::from_secs(30), reader.read_line(&mut token_line))
            .await
            .map_err(|_| ControlError::Authentication)?;
        let count = read.map_err(|e| ControlError::Transport(e.to_string()))?;
        if count == 0
            || !token_matches(
                token_line.trim_end_matches(['\r', '\n']),
                &self.endpoint.token,
            )
        {
            return Err(ControlError::Authentication);
        }
        write_half
            .write_all(b"\n")
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))?;
        write_half
            .flush()
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))?;
        Ok(ControlLink::new(reader, write_half))
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
/// twins emulating `runtime/adapter.mjs`): authenticates the transport token
/// and returns the raw channel.
pub async fn connect(endpoint: &ControlEndpoint) -> Result<RawChannel, ControlError> {
    let stream = wrap_connected(platform_connect(endpoint).await?);
    let (read_half, mut write_half) = tokio::io::split(stream);
    write_half
        .write_all(format!("{}\n", endpoint.token).as_bytes())
        .await
        .map_err(|e| ControlError::Transport(e.to_string()))?;
    write_half
        .flush()
        .await
        .map_err(|e| ControlError::Transport(e.to_string()))?;
    let mut reader = tokio::io::BufReader::new(read_half);
    let mut ack = String::new();
    let acknowledged = tokio::time::timeout(Duration::from_secs(30), reader.read_line(&mut ack))
        .await
        .map_err(|_| ControlError::Authentication)?
        .map_err(|e| ControlError::Transport(e.to_string()))?;
    // The server acknowledges with one empty line; EOF means the token was refused.
    if acknowledged == 0 {
        return Err(ControlError::Authentication);
    }
    Ok(RawChannel {
        reader,
        writer: write_half,
    })
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
    responder: tokio::sync::oneshot::Sender<HostEvent>,
}

/// The raw child-side channel (used by tests and protocol twins to emulate the
/// Node adapter): sends `HostEvent` frames and receives `ShellMessage` frames.
pub struct RawChannel {
    reader: BufReader<LinkReadHalf>,
    writer: LinkWriteHalf,
}

impl RawChannel {
    /// Send one Host→Shell frame.
    pub async fn send_event(&mut self, event: &HostEvent) -> Result<(), ControlError> {
        let mut bytes =
            serde_json::to_vec(event).map_err(|e| ControlError::MalformedFrame(e.to_string()))?;
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

    /// Receive one Shell→Host frame; `None` on clean EOF.
    pub async fn recv_message(&mut self) -> Result<Option<ShellMessage>, ControlError> {
        let mut line = String::new();
        let count = tokio::io::AsyncBufReadExt::read_line(&mut self.reader, &mut line)
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))?;
        if count == 0 {
            return Ok(None);
        }
        serde_json::from_str(line.trim_end_matches(['\r', '\n']))
            .map(Some)
            .map_err(|e| ControlError::MalformedFrame(e.to_string()))
    }
}

/// One authenticated control connection (shell side). FIFO per direction;
/// correlated responses resolve their `requestId` waiter; unsolicited events
/// are delivered on the event channel.
pub struct ControlLink {
    outgoing: tokio::sync::Mutex<LinkWriteHalf>,
    events: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<HostEvent>>,
    pending: std::sync::Arc<std::sync::Mutex<HashMap<u64, Pending>>>,
    closed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    next_request_id: std::sync::atomic::AtomicU64,
}

impl ControlLink {
    fn new(reader: BufReader<LinkReadHalf>, write_half: LinkWriteHalf) -> Self {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let pending: std::sync::Arc<std::sync::Mutex<HashMap<u64, Pending>>> =
            std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let pending_reader = pending.clone();
        let closed = std::sync::atomic::AtomicBool::new(false);
        let closed = std::sync::Arc::new(closed);
        let closed_reader = closed.clone();
        tokio::spawn(async move {
            let mut reader = reader;
            let mut decoder = FrameDecoder::new();
            let mut line = Vec::new();
            'outer: loop {
                line.clear();
                let read = tokio::io::AsyncBufReadExt::read_until(&mut reader, b'\n', &mut line)
                    .await
                    .unwrap_or(0);
                if read == 0 {
                    break;
                }
                decoder.push(&line);
                while let Some(next) = decoder.next_line() {
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
                            match waiter {
                                Some(waiter) => {
                                    let _ = waiter.responder.send(event);
                                }
                                // A late response finds no pending entry and is
                                // dropped (upstream `request?.resolve(...)`).
                                None => continue,
                            }
                        }
                        Ok(event) => {
                            if tx.send(event).is_err() {
                                break 'outer;
                            }
                        }
                        Err(_) => {
                            // A malformed Host→shell frame is fatal (protocol
                            // violation): drop every waiter and the channel.
                            pending_reader.lock().expect("pending lock").clear();
                            break 'outer;
                        }
                    }
                }
            }
            // EOF/teardown: reject new requests and fail all existing waiters.
            closed_reader.store(true, std::sync::atomic::Ordering::SeqCst);
            pending_reader.lock().expect("pending lock").clear();
        });
        Self {
            outgoing: tokio::sync::Mutex::new(write_half),
            events: tokio::sync::Mutex::new(rx),
            pending,
            closed,
            next_request_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    /// Send one shell message (FIFO).
    pub async fn send(&self, message: &ShellMessage) -> Result<(), ControlError> {
        let frame = encode_frame(message)?;
        let mut writer = self.outgoing.lock().await;
        writer
            .write_all(&frame)
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))?;
        writer
            .flush()
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))
    }

    /// Reject every in-flight correlated request after terminal Host failure.
    pub fn fail_pending(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        self.pending.lock().expect("pending lock").clear();
    }

    /// Next unsolicited event (`ready`, `fatal`, `platform-session`,
    /// `shutdown-complete`, or a response whose waiter is gone).
    pub async fn next_event(&self) -> Option<HostEvent> {
        self.events.lock().await.recv().await
    }

    /// Send a correlated control request and await its response within
    /// `deadline`. A late response finds no pending entry and is dropped
    /// (upstream `controlRequests` semantics).
    pub async fn request(
        &self,
        build: impl FnOnce(u64) -> ShellMessage,
        deadline: Duration,
    ) -> Result<HostEvent, ControlError> {
        let request_id = self
            .next_request_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut pending = self.pending.lock().expect("pending lock");
            if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(ControlError::Transport("control channel closed".into()));
            }
            pending.insert(request_id, Pending { responder: tx });
        }
        self.send(&build(request_id)).await?;
        let outcome = tokio::time::timeout(deadline, rx).await;
        self.pending
            .lock()
            .expect("pending lock")
            .remove(&request_id);
        match outcome {
            Ok(Ok(event)) => Ok(event),
            Ok(Err(_)) => Err(ControlError::Transport("control channel closed".into())),
            Err(_) => Err(ControlError::Transport(format!(
                "request {request_id} missed its {deadline:?} deadline"
            ))),
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
        decoder.push(b"{\"type\":\"ready\",\"url");
        assert!(decoder.next_line().is_none(), "partial frame must wait");
        decoder.push(b"\":\"http://127.0.0.1:1\"}\n{\"type\":\"shutdown-com");
        assert_eq!(
            decoder.next_line().unwrap().unwrap(),
            "{\"type\":\"ready\",\"url\":\"http://127.0.0.1:1\"}"
        );
        assert!(decoder.next_line().is_none());
        decoder.push(b"plete\"}\n");
        assert_eq!(
            decoder.next_line().unwrap().unwrap(),
            "{\"type\":\"shutdown-complete\"}"
        );
    }

    #[test]
    fn decoder_rejects_malformed_and_oversized_lines() {
        let mut decoder = FrameDecoder::new();
        decoder.push(b"not json\n");
        let line = decoder.next_line().unwrap().expect("transport-valid line");
        assert!(
            decode_line(&line).is_err(),
            "malformed JSON is rejected at decode"
        );
        let mut decoder = FrameDecoder::new();
        let huge = vec![b'x'; MAX_FRAME_BYTES + 1];
        decoder.push(&huge);
        assert!(matches!(
            decoder.next_line(),
            Some(Err(ControlError::FrameTooLarge))
        ));
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
    async fn wrong_token_is_refused() {
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
}
