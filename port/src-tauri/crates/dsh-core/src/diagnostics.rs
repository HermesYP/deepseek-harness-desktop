//! Structured diagnostic logging and the crash-report writer mirroring
//! `_upstream/apps/desktop/src/crash-report.ts`.
//!
//! Crash-report contract (upstream README "Before the first fatal dialog"):
//! - File `crash-<UTC time>-<source>.log`, source ∈ {`host`, `web-boot`,
//!   `renderer`, `main`}.
//! - Records whether the backend reached ready (phase `startup`/`running`),
//!   app + runtime versions, the error with its enumerable properties and cause
//!   chain (cut at 256 KiB), the Host's inspected error (≤ 64 KiB) when it
//!   reported a startup failure over the control channel, and the primary
//!   window's recent error-level console output (≤ 64 KiB).
//! - Owner-only file permissions where the platform supports them.
//! - Startup keeps the ten newest reports and deletes older ones, touching no
//!   other file in the directory. Selection parses the generated name back into
//!   its timestamp and source ([`parse_crash_report_name`]), so `web-boot` — the
//!   one source whose spelling contains a separator — is retained and pruned
//!   exactly like the rest.
//! - Host stderr retention is capped at the last 64 Ki characters
//!   ([`StderrTail`]); a fatal host-exit report therefore carries exactly that tail.
//!
//! Logging contract: [`init_diagnostics`] installs the process-wide subscriber
//! once and returns a [`DiagnosticsGuard`] the application owns and flushes at
//! shutdown. A repeat is intentional and inert; a first install that fails
//! because another component already owns the subscriber is an explicit error.

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::DshError;

/// Where a fatal failure surfaced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashReportSource {
    Host,
    WebBoot,
    Renderer,
    Main,
}

impl CrashReportSource {
    /// Every source this module generates, in wire order.
    pub const ALL: [CrashReportSource; 4] = [
        CrashReportSource::Host,
        CrashReportSource::WebBoot,
        CrashReportSource::Renderer,
        CrashReportSource::Main,
    ];

    /// Wire spelling used in file names and the report header.
    pub fn as_str(self) -> &'static str {
        match self {
            CrashReportSource::Host => "host",
            CrashReportSource::WebBoot => "web-boot",
            CrashReportSource::Renderer => "renderer",
            CrashReportSource::Main => "main",
        }
    }

    /// Parse the wire spelling back to its source; `None` for anything else.
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|source| source.as_str() == value)
    }
}

/// Whether the backend had reached ready when the failure surfaced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashReportPhase {
    Startup,
    Running,
}

impl CrashReportPhase {
    fn as_str(self) -> &'static str {
        match self {
            CrashReportPhase::Startup => "startup",
            CrashReportPhase::Running => "running",
        }
    }
}

/// Facts about the running application recorded in every report header.
#[derive(Debug, Clone)]
pub struct CrashReportApp {
    pub name: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    /// Bundled runtime version (upstream records `electron` and `node`).
    pub runtime: String,
    pub locale: String,
}

/// One error's enumerable properties and cause chain (the Rust counterpart of
/// `util.inspect(error, { depth: 6 })`).
#[derive(Debug, Clone)]
pub struct ErrorReport {
    /// Rendered message of this error.
    pub message: String,
    /// Enumerable own properties as `(name, rendered value)` pairs.
    pub properties: Vec<(String, String)>,
    /// `cause` chain, cut at [`ERROR_CAUSE_DEPTH`].
    pub cause: Option<Box<ErrorReport>>,
}

/// Maximum cause-chain depth rendered (upstream `inspect` depth 6).
pub const ERROR_CAUSE_DEPTH: usize = 6;

impl ErrorReport {
    /// Build a report from an error-like value rendered elsewhere.
    pub fn message(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            properties: Vec::new(),
            cause: None,
        }
    }

    /// Attach one enumerable property.
    pub fn with_property(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.properties.push((name.into(), value.into()));
        self
    }

    /// Attach the cause chain.
    pub fn with_cause(mut self, cause: ErrorReport) -> Self {
        self.cause = Some(Box::new(cause));
        self
    }
}

/// File name prefix every report shares.
pub const CRASH_REPORT_PREFIX: &str = "crash-";

/// File name suffix every report shares.
pub const CRASH_REPORT_SUFFIX: &str = ".log";

/// Fixed width of the UTC stamp in a generated report name
/// (`YYYY-MM-DDTHH-MM-SS-mmmZ`).
const CRASH_REPORT_STAMP_LEN: usize = 24;

/// Separator between the stamp and the source token in a generated report name.
const CRASH_REPORT_SOURCE_SEPARATOR: char = '-';

/// Reports kept after pruning, newest first by file name.
pub const CRASH_REPORTS_RETAINED: usize = 10;

/// Retained bytes of renderer error-level console output.
pub const RENDERER_CONSOLE_MAX_BYTES: usize = 64 * 1024;

/// Upper bound of the rendered error section (upstream `ERROR_SECTION_MAX_CHARS`).
pub const ERROR_SECTION_MAX_CHARS: usize = 256 * 1024;

/// Upper bound of the Host's inspected error kept verbatim.
pub const HOST_DIAGNOSTIC_MAX_CHARS: usize = 64 * 1024;

/// Host stderr retention cap (upstream `MAX_HOST_DIAGNOSTIC_CHARS`).
pub const STDERR_TAIL_MAX_CHARS: usize = 64 * 1024;

/// Bounded tail of host stderr: the last {@link STDERR_TAIL_MAX_CHARS}
/// characters are retained however long the process runs.
#[derive(Debug, Default)]
pub struct StderrTail {
    text: String,
}

impl StderrTail {
    /// Fresh empty tail.
    pub fn new() -> Self {
        Self::default()
    }

    /// Append one chunk, discarding from the head once the cap is exceeded.
    pub fn push(&mut self, chunk: &str) {
        self.text.push_str(chunk);
        if self.text.len() > STDERR_TAIL_MAX_CHARS {
            let excess = self.text.len() - STDERR_TAIL_MAX_CHARS;
            // Trim on a char boundary so multi-byte output is never cut mid-char.
            let mut cut = excess;
            while cut < self.text.len() && !self.text.is_char_boundary(cut) {
                cut += 1;
            }
            self.text.drain(..cut);
        }
    }

    /// The retained tail (at most {@link STDERR_TAIL_MAX_CHARS} chars).
    pub fn snapshot(&self) -> &str {
        &self.text
    }
}

/// Bounded tail of renderer error-level console lines. Lines are dropped from
/// the head once the retained byte total exceeds the cap; one oversized line is
/// kept whole so a long stack is never cut mid-line.
#[derive(Debug)]
pub struct RendererConsoleTail {
    lines: Vec<String>,
    bytes: usize,
    max_bytes: usize,
}

impl Default for RendererConsoleTail {
    fn default() -> Self {
        Self::new(RENDERER_CONSOLE_MAX_BYTES)
    }
}

impl RendererConsoleTail {
    /// Retained byte cap across all lines.
    pub fn new(max_bytes: usize) -> Self {
        Self {
            lines: Vec::new(),
            bytes: 0,
            max_bytes,
        }
    }

    /// Append one console line.
    pub fn push(&mut self, line: &str) {
        self.lines.push(line.to_string());
        self.bytes += line.len();
        while self.lines.len() > 1 && self.bytes > self.max_bytes {
            let dropped = self.lines.remove(0);
            self.bytes -= dropped.len();
        }
    }

    /// The retained lines, oldest first.
    pub fn snapshot(&self) -> &[String] {
        &self.lines
    }
}

/// The report file name: sortable by time, then the source
/// (`crash-<ISO time with ':' and '.' as '-'>-<source>.log`).
pub fn crash_report_file_name(
    time: &chrono::DateTime<chrono::Utc>,
    source: CrashReportSource,
) -> String {
    let stamp = time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    format!(
        "{CRASH_REPORT_PREFIX}{}-{}{CRASH_REPORT_SUFFIX}",
        stamp.replace([':', '.'], "-"),
        source.as_str()
    )
}

/// Parse one generated report file name back into its timestamp and source —
/// the exact inverse of [`crash_report_file_name`].
///
/// The stamp is fixed width, so the source token is whatever follows its
/// [`CRASH_REPORT_STAMP_LEN`] characters. Splitting on the **last** `-` instead
/// would read `web-boot` as the source `boot`, which silently excluded every
/// web-boot report from pruning. The timestamp is reconstructed and parsed
/// rather than shape-checked so that only names this module could have written
/// parse, which is what makes deletion safe.
pub fn parse_crash_report_name(
    name: &str,
) -> Option<(chrono::DateTime<chrono::Utc>, CrashReportSource)> {
    let rest = name.strip_prefix(CRASH_REPORT_PREFIX)?;
    let rest = rest.strip_suffix(CRASH_REPORT_SUFFIX)?;
    let (stamp, source) = rest.split_at_checked(CRASH_REPORT_STAMP_LEN)?;
    let source = source.strip_prefix(CRASH_REPORT_SOURCE_SEPARATOR)?;
    Some((
        parse_crash_report_stamp(stamp)?,
        CrashReportSource::parse(source)?,
    ))
}

/// Digits of `range`, or `None` when the slice is absent or not all digits.
fn stamp_digits(stamp: &str, range: std::ops::Range<usize>) -> Option<&str> {
    let text = stamp.get(range)?;
    text.bytes()
        .all(|byte| byte.is_ascii_digit())
        .then_some(text)
}

/// Rebuild the RFC 3339 timestamp from a generated stamp.
fn parse_crash_report_stamp(stamp: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let bytes = stamp.as_bytes();
    if bytes.len() != CRASH_REPORT_STAMP_LEN
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b'-'
        || bytes[16] != b'-'
        || bytes[19] != b'-'
        || bytes[23] != b'Z'
    {
        return None;
    }
    let (year, month) = (stamp_digits(stamp, 0..4)?, stamp_digits(stamp, 5..7)?);
    let (day, hour) = (stamp_digits(stamp, 8..10)?, stamp_digits(stamp, 11..13)?);
    let (minute, second) = (stamp_digits(stamp, 14..16)?, stamp_digits(stamp, 17..19)?);
    let millis = stamp_digits(stamp, 20..23)?;
    chrono::DateTime::parse_from_rfc3339(&format!(
        "{year}-{month}-{day}T{hour}:{minute}:{second}.{millis}Z"
    ))
    .ok()
    .map(|time| time.with_timezone(&chrono::Utc))
}

/// Whether a file name is exactly one this module generates (pruning touches
/// only names that match).
pub fn is_crash_report_name(name: &str) -> bool {
    parse_crash_report_name(name).is_some()
}

/// Inputs of [`render_crash_report`] and [`write_crash_report`].
pub struct CrashReportInput<'a> {
    pub source: CrashReportSource,
    pub phase: CrashReportPhase,
    pub error: &'a ErrorReport,
    /// The Host's own inspected error when it reported the failure over the
    /// control channel before exiting; truncated to `HOST_DIAGNOSTIC_MAX_CHARS`.
    pub host_diagnostic: Option<&'a str>,
    /// Recent renderer console lines at error level, oldest first.
    pub renderer_console: &'a [String],
    pub app: &'a CrashReportApp,
    pub time: chrono::DateTime<chrono::Utc>,
}

/// Render the error section: message, enumerable properties, cause chain, cut
/// at {@link ERROR_SECTION_MAX_CHARS} with a truncation note.
pub fn bounded_error_section(error: &ErrorReport) -> String {
    let mut rendered = String::new();
    render_error(error, 0, &mut rendered);
    if rendered.chars().count() <= ERROR_SECTION_MAX_CHARS {
        return rendered;
    }
    let cut: String = rendered.chars().take(ERROR_SECTION_MAX_CHARS).collect();
    format!("{cut}\n… (error section cut at {ERROR_SECTION_MAX_CHARS} characters)")
}

fn render_error(error: &ErrorReport, depth: usize, out: &mut String) {
    out.push_str(&error.message);
    for (name, value) in &error.properties {
        out.push_str(&format!("\n  {name}: {value}"));
    }
    if let Some(cause) = &error.cause {
        if depth + 1 >= ERROR_CAUSE_DEPTH {
            out.push_str("\n[cause chain cut]");
            return;
        }
        out.push_str("\ncaused by: ");
        render_error(cause, depth + 1, out);
    }
}

/// Render one report as plain text: a header of facts, the inspected error,
/// the Host's own diagnostic when it reported one, and the renderer console tail.
pub fn render_crash_report(input: &CrashReportInput<'_>) -> String {
    let header = [
        format!(
            "time: {}",
            input
                .time
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        ),
        format!("source: {}", input.source.as_str()),
        format!("phase: {}", input.phase.as_str()),
        format!("app: {} {}", input.app.name, input.app.version),
        format!("platform: {} {}", input.app.platform, input.app.arch),
        format!("runtime: {}", input.app.runtime),
        format!("locale: {}", input.app.locale),
        format!("shell pid: {}", std::process::id()),
    ];
    let console_section = if input.renderer_console.is_empty() {
        "(no error-level renderer console output was captured)".to_string()
    } else {
        input.renderer_console.join("\n")
    };
    let host_section: Vec<String> = match input.host_diagnostic {
        Some(diagnostic) => {
            let bounded: String = diagnostic.chars().take(HOST_DIAGNOSTIC_MAX_CHARS).collect();
            vec![
                "--- host diagnostic (as reported by the Host process) ---".to_string(),
                bounded,
                String::new(),
            ]
        }
        None => Vec::new(),
    };
    [
        header.join("\n"),
        String::new(),
        "--- error ---".to_string(),
        bounded_error_section(input.error),
        String::new(),
        host_section.join("\n"),
        "--- renderer console (error level, oldest first) ---".to_string(),
        console_section,
        String::new(),
    ]
    .join("\n")
}

/// Write and sync a private temporary file before publishing the final name.
/// A failed or interrupted write never presents a partial report as complete.
/// Failure is returned to the recovery dialog without replacing an older report.
pub fn write_crash_report(
    directory: &Path,
    input: &CrashReportInput<'_>,
) -> Result<PathBuf, DshError> {
    std::fs::create_dir_all(directory).map_err(|e| {
        DshError::io(
            "create directory",
            Some(directory.display().to_string()),
            &e,
        )
    })?;
    set_directory_owner_only(directory);
    let path = directory.join(crash_report_file_name(&input.time, input.source));
    let content = render_crash_report(input);
    publish_crash_report(&path, |file| file.write_all(content.as_bytes()))
}

fn publish_crash_report(
    path: &Path,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> Result<PathBuf, DshError> {
    let pending = path.with_file_name(format!(".dsh-crash-{}.pending", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    set_file_owner_only(&mut options);
    let mut file = options
        .open(&pending)
        .map_err(|e| DshError::io("create crash report", Some(path.display().to_string()), &e))?;
    // The guard is armed only after exclusive creation succeeded. It can never
    // delete an unrelated file on a failed create_new or a final-name collision.
    let pending_guard = PendingCrashReport(pending);
    let result = write(&mut file).and_then(|()| file.sync_all());
    drop(file);
    result.map_err(|e| DshError::io("write crash report", Some(path.display().to_string()), &e))?;
    // Same-directory linking publishes complete bytes without overwriting a
    // previous report. Unsupported filesystems fail explicitly. A kill before
    // this operation leaves only an unadvertised pending file; after it the
    // final report already contains synced bytes.
    std::fs::hard_link(&pending_guard.0, path)
        .map_err(|e| DshError::io("publish crash report", Some(path.display().to_string()), &e))?;
    Ok(path.to_path_buf())
}

struct PendingCrashReport(PathBuf);

impl Drop for PendingCrashReport {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Delete the oldest reports beyond `retained` and leave every other file in the
/// directory alone. A missing directory is not a failure.
///
/// Selection is by parsed timestamp, so **every** source this module generates
/// participates — including `web-boot`, whose hyphenated spelling a last-`-`
/// split cannot read. A tie on the timestamp breaks on the file name so the
/// retained set is deterministic.
pub fn prune_crash_reports(directory: &Path, retained: usize) -> Result<(), DshError> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(DshError::io(
                "list crash reports",
                Some(directory.display().to_string()),
                &e,
            ))
        }
    };
    let mut reports: Vec<(chrono::DateTime<chrono::Utc>, String)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            parse_crash_report_name(&name).map(|(time, _)| (time, name))
        })
        .collect();
    reports.sort();
    let excess = reports.len().saturating_sub(retained);
    for (_, name) in reports.into_iter().take(excess) {
        let _ = std::fs::remove_file(directory.join(name));
    }
    Ok(())
}

#[cfg(unix)]
fn set_file_owner_only(options: &mut std::fs::OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(unix)]
fn set_directory_owner_only(directory: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn set_file_owner_only(_options: &mut std::fs::OpenOptions) {
    // Windows applies the creating user's profile ACL by default (owner-only
    // semantics for a per-user directory); POSIX modes do not exist.
}

#[cfg(not(unix))]
fn set_directory_owner_only(_directory: &Path) {}

/// Keeps the structured-log writer alive for as long as the process needs it.
///
/// The application owns exactly one of these for the process lifetime. Call
/// [`flush`](Self::flush) at shutdown (dropping the guard does the same) to send
/// the writer its shutdown message, let it drain the records already queued, and
/// join its thread; a guard that is never dropped can lose the last records.
///
/// A repeated [`init_diagnostics`] returns an *inert* guard
/// ([`owns_writer`](Self::owns_writer) is `false`): a global subscriber can only
/// be installed once per process, so the repeat owns nothing to flush.
pub struct DiagnosticsGuard {
    /// The writer ownership, or `None` for the inert guard a repeated
    /// initialization returns.
    inner: Option<tracing_appender::non_blocking::WorkerGuard>,
}

impl DiagnosticsGuard {
    /// Flush the records already queued and stop the writer thread. Idempotent.
    ///
    /// Dropping the inner `WorkerGuard` sends the shutdown message (waiting up to
    /// 100 ms for the worker to drain) and joins the writer thread.
    pub fn flush(&mut self) {
        self.inner.take();
    }

    /// Whether this guard owns the process's log writer. `false` for the inert
    /// guard of a repeated initialization.
    pub fn owns_writer(&self) -> bool {
        self.inner.is_some()
    }
}

impl Drop for DiagnosticsGuard {
    fn drop(&mut self) {
        self.flush();
    }
}

impl std::fmt::Debug for DiagnosticsGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DiagnosticsGuard")
            .field("owns_writer", &self.owns_writer())
            .finish()
    }
}

/// Whether **this process** installed the global tracing subscriber from
/// [`init_diagnostics`]. A foreign subscriber leaves this `false`.
static DIAGNOSTICS_INSTALLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Run one initialization step against `installed`: install the subscriber
/// unless this process already installed one.
///
/// The flag and installer are parameters so the three outcomes are testable
/// without touching the process-wide subscriber:
/// - a fresh install that succeeds is `Ok(true)` — the caller owns the writer;
/// - a repeat of *our own* install is `Ok(false)` and never calls the installer,
///   which is what makes a second intentional initialization harmless;
/// - an installer failure is an explicit error. `set_global_default` fails only
///   when another component already owns the global subscriber, so this is the
///   first-subscriber failure that must not look like a success. The flag is
///   reset so a later retry can still install.
fn install_subscriber_once(
    installed: &std::sync::atomic::AtomicBool,
    install: impl FnOnce() -> Result<(), String>,
) -> Result<bool, DshError> {
    use std::sync::atomic::Ordering;
    if installed
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(false);
    }
    match install() {
        Ok(()) => Ok(true),
        Err(message) => {
            installed.store(false, Ordering::SeqCst);
            Err(DshError::other("diagnostics_subscriber", message))
        }
    }
}

/// Install structured diagnostic logging: daily-rolling files under `logs_dir`,
/// owner-only where supported.
///
/// The returned guard must be kept alive for the process lifetime, and flushed
/// (or dropped) at shutdown. A repeated call is intentional and returns an inert
/// guard rather than failing. A call whose `set_global_default` fails — meaning
/// some other component already installed a global subscriber — is an explicit
/// error instead of a silent loss of every log record; so is a `logs_dir` that
/// cannot be created.
pub fn init_diagnostics(logs_dir: &Path) -> Result<DiagnosticsGuard, DshError> {
    std::fs::create_dir_all(logs_dir).map_err(|e| {
        DshError::io(
            "create log directory",
            Some(logs_dir.display().to_string()),
            &e,
        )
    })?;
    let appender = tracing_appender::rolling::daily(logs_dir, "dsh-desktop.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(appender);
    let subscriber = tracing_subscriber::fmt()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(false)
        .finish();
    let owns_writer = install_subscriber_once(&DIAGNOSTICS_INSTALLED, || {
        tracing::subscriber::set_global_default(subscriber)
            .map_err(|error| format!("a global tracing subscriber was already installed: {error}"))
    })?;
    Ok(DiagnosticsGuard {
        inner: owns_writer.then_some(guard),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> CrashReportApp {
        CrashReportApp {
            name: "DeepSeek Harness".into(),
            version: "0.1.7-rc.2".into(),
            platform: "win32".into(),
            arch: "x64".into(),
            runtime: "25.4.0".into(),
            locale: "en".into(),
        }
    }

    #[test]
    fn file_name_matches_upstream_shape() {
        let time = chrono::DateTime::parse_from_rfc3339("2026-03-04T05:06:07.089Z")
            .expect("time")
            .with_timezone(&chrono::Utc);
        let name = crash_report_file_name(&time, CrashReportSource::Host);
        assert_eq!(name, "crash-2026-03-04T05-06-07-089Z-host.log");
        assert!(is_crash_report_name(&name));
        for bad in [
            "crash-x-host.log",
            "crash-2026-03-04T05-06-07-089Z-other.log",
            "notes.log",
            "crash-2026-03-04T05-06-07-089Z-host.log.bak",
        ] {
            assert!(!is_crash_report_name(bad), "{bad} must not match");
        }
    }

    #[test]
    fn every_generated_name_round_trips_including_web_boot() {
        let time = chrono::DateTime::parse_from_rfc3339("2026-03-04T05:06:07.089Z")
            .expect("time")
            .with_timezone(&chrono::Utc);
        for source in CrashReportSource::ALL {
            let name = crash_report_file_name(&time, source);
            let (parsed_time, parsed_source) =
                parse_crash_report_name(&name).unwrap_or_else(|| panic!("{name} must parse"));
            assert_eq!(parsed_time, time, "{name}");
            assert_eq!(parsed_source, source, "{name}");
            assert_eq!(CrashReportSource::parse(source.as_str()), Some(source));
        }
        // The hyphenated spelling is the regression: reading the source as the
        // text after the LAST `-` yields `boot`, which no source parses as.
        let web_boot = crash_report_file_name(&time, CrashReportSource::WebBoot);
        assert_eq!(web_boot, "crash-2026-03-04T05-06-07-089Z-web-boot.log");
        assert!(is_crash_report_name(&web_boot));
        assert_eq!(
            parse_crash_report_name(&web_boot).map(|(_, source)| source),
            Some(CrashReportSource::WebBoot)
        );
        // A name only the shape (not the value) of which matches is not pruned:
        // the stamp must also be a real timestamp.
        for bad in [
            "crash-2026-13-45T99-99-99-999Z-main.log",
            "crash-2026-03-04T05-06-07-089Z-web-boot.txt",
            "crash-2026-03-04T05-06-07-089Z-.log",
            "crash-2026-03-04T05-06-07-089Z-web-boot-extra.log",
        ] {
            assert!(!is_crash_report_name(bad), "{bad} must not match");
        }
    }

    #[test]
    fn error_section_is_cut_at_the_bound() {
        let huge = "x".repeat(ERROR_SECTION_MAX_CHARS + 1000);
        let error = ErrorReport::message(huge.clone());
        let bounded = bounded_error_section(&error);
        assert!(
            bounded.len() <= ERROR_SECTION_MAX_CHARS + 80,
            "must respect the cap"
        );
        assert!(bounded.ends_with(&format!(
            "… (error section cut at {ERROR_SECTION_MAX_CHARS} characters)"
        )));
        // Under the bound there is no truncation note.
        let small = bounded_error_section(&ErrorReport::message("boom"));
        assert_eq!(small, "boom");
    }

    #[test]
    fn error_section_keeps_properties_and_cause_chain() {
        let error = ErrorReport::message("top")
            .with_property("code", "E")
            .with_cause(ErrorReport::message("inner"));
        assert_eq!(
            bounded_error_section(&error),
            "top\n  code: E\ncaused by: inner"
        );
    }

    #[test]
    fn cause_chain_depth_is_bounded() {
        let mut error = ErrorReport::message("level0");
        for depth in 1..10 {
            error = ErrorReport::message(format!("level{depth}")).with_cause(error);
        }
        let bounded = bounded_error_section(&error);
        assert!(
            bounded.ends_with("[cause chain cut]"),
            "deep chains must be cut: {bounded}"
        );
    }

    #[test]
    fn stderr_tail_keeps_last_64_k_chars_and_multibyte_safe() {
        let mut tail = StderrTail::new();
        tail.push("héllo ✓ ");
        let chunk = "a".repeat(STDERR_TAIL_MAX_CHARS);
        tail.push(&chunk);
        assert!(tail.snapshot().chars().count() <= STDERR_TAIL_MAX_CHARS);
        assert!(tail
            .snapshot()
            .ends_with(&"a".repeat(STDERR_TAIL_MAX_CHARS - "héllo ✓ ".chars().count())));
        // Multi-byte input must never cut a char in half.
        let mut tail = StderrTail::new();
        tail.push(&"é".repeat(STDERR_TAIL_MAX_CHARS));
        assert!(tail.snapshot().ends_with('é'));
        assert!(tail.snapshot().chars().count() <= STDERR_TAIL_MAX_CHARS);
    }

    #[test]
    fn console_tail_keeps_one_oversized_line_whole() {
        let mut tail = RendererConsoleTail::new(16);
        tail.push("one");
        tail.push(&"x".repeat(100));
        let snapshot = tail.snapshot();
        assert_eq!(snapshot.len(), 1, "the head is dropped first");
        assert_eq!(snapshot[0].len(), 100, "one oversized line is kept whole");
    }

    #[test]
    fn console_tail_drops_from_the_head_at_the_byte_cap() {
        let mut tail = RendererConsoleTail::new(10);
        tail.push("aaaa");
        tail.push("bbbb");
        tail.push("cccc");
        let snapshot = tail.snapshot();
        assert!(snapshot.len() >= 2);
        assert!(snapshot.iter().any(|line| line == "cccc"));
        let bytes: usize = snapshot.iter().map(|line| line.len()).sum();
        assert!(bytes <= 10 || snapshot.len() == 1);
    }

    #[test]
    fn report_layout_carries_all_contract_fields() {
        let input = CrashReportInput {
            source: CrashReportSource::Host,
            phase: CrashReportPhase::Running,
            error: &ErrorReport::message("dsh desktop host exited with 1"),
            host_diagnostic: Some("host says"),
            renderer_console: &["console line".to_string()],
            app: &app(),
            time: chrono::Utc::now(),
        };
        let rendered = render_crash_report(&input);
        for expected in [
            "source: host",
            "phase: running",
            "app: DeepSeek Harness 0.1.7-rc.2",
            "platform: win32 x64",
            "runtime: 25.4.0",
            "locale: en",
            "--- error ---",
            "dsh desktop host exited with 1",
            "--- host diagnostic (as reported by the Host process) ---",
            "host says",
            "console line",
        ] {
            assert!(rendered.contains(expected), "missing {expected:?}");
        }
    }

    #[test]
    fn host_diagnostic_is_cut_at_64_kib() {
        let huge = "d".repeat(HOST_DIAGNOSTIC_MAX_CHARS + 500);
        let input = CrashReportInput {
            source: CrashReportSource::Host,
            phase: CrashReportPhase::Startup,
            error: &ErrorReport::message("x"),
            host_diagnostic: Some(&huge),
            renderer_console: &[],
            app: &app(),
            time: chrono::Utc::now(),
        };
        let rendered = render_crash_report(&input);
        let start = rendered.find("--- host diagnostic").expect("section");
        let end = rendered.find("--- renderer console").expect("section");
        let section = &rendered[start..end];
        assert!(section.chars().count() < HOST_DIAGNOSTIC_MAX_CHARS + 100);
    }

    #[test]
    fn crash_report_is_not_visible_until_its_contents_are_complete() {
        let directory = tempfile::tempdir().expect("owned fixture");
        let path = directory.path().join("crash-final.log");
        let published = publish_crash_report(&path, |file| {
            assert!(
                !path.exists(),
                "a reader must not see a partial final report"
            );
            file.write_all(b"complete diagnostic")
        })
        .expect("publish complete report");
        assert_eq!(
            std::fs::read(published).expect("read"),
            b"complete diagnostic"
        );
        assert_eq!(
            std::fs::read_dir(directory.path()).expect("list").count(),
            1
        );
    }

    #[test]
    fn failed_crash_report_write_leaves_no_empty_or_partial_report() {
        let directory = tempfile::tempdir().expect("owned fixture");
        let path = directory.path().join("crash-final.log");
        let error = publish_crash_report(&path, |file| {
            file.write_all(b"partial")?;
            Err(std::io::Error::other("injected write failure"))
        })
        .expect_err("write failure is reported");
        assert!(matches!(error, DshError::Io { .. }));
        assert!(!path.exists());
        assert_eq!(
            std::fs::read_dir(directory.path()).expect("list").count(),
            0
        );
    }

    #[test]
    fn crash_report_collision_preserves_the_existing_report() {
        let directory = tempfile::tempdir().expect("owned fixture");
        let path = directory.path().join("crash-final.log");
        std::fs::write(&path, b"original report").expect("seed");
        publish_crash_report(&path, |file| file.write_all(b"new report"))
            .expect_err("never overwrite an existing report");
        assert_eq!(std::fs::read(path).expect("read"), b"original report");
        assert_eq!(
            std::fs::read_dir(directory.path()).expect("list").count(),
            1
        );
    }

    #[test]
    fn write_and_prune_retain_ten_newest_across_every_source() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("keep-me.txt"), "x").expect("seed");
        // A name only the shape of which matches is not a report this module
        // could have written, so pruning must leave it alone.
        std::fs::write(
            dir.path().join("crash-2026-13-45T99-99-99-999Z-main.log"),
            "x",
        )
        .expect("seed look-alike");
        let base = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00.000Z")
            .expect("time")
            .with_timezone(&chrono::Utc);
        for index in 0..12u32 {
            let time = base + chrono::Duration::seconds(i64::from(index));
            let source = CrashReportSource::ALL[index as usize % CrashReportSource::ALL.len()];
            let input = CrashReportInput {
                source,
                phase: CrashReportPhase::Startup,
                error: &ErrorReport::message("boom"),
                host_diagnostic: None,
                renderer_console: &[],
                app: &app(),
                time,
            };
            write_crash_report(dir.path(), &input).expect("write");
        }
        prune_crash_reports(dir.path(), CRASH_REPORTS_RETAINED).expect("prune");
        let mut names: Vec<String> = std::fs::read_dir(dir.path())
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert!(
            names.contains(&"keep-me.txt".to_string()),
            "unrelated files untouched"
        );
        assert!(
            names.contains(&"crash-2026-13-45T99-99-99-999Z-main.log".to_string()),
            "a value-invalid look-alike is not ours to delete"
        );
        assert_eq!(names.len(), CRASH_REPORTS_RETAINED + 2);
        for name in &names {
            if name.ends_with(".txt") || name.contains("13-45T99") {
                continue;
            }
            assert!(
                name.as_str() >= "crash-2026-01-01T00-00-02",
                "only the two oldest reports may be pruned: {names:?}"
            );
        }
        // The hyphenated source participates: the writing loop produced
        // `web-boot` reports, and pruning must have kept the newest of them.
        assert!(
            names.iter().any(|name| name.ends_with("-web-boot.log")),
            "web-boot reports are not excluded from retention: {names:?}"
        );
    }

    #[test]
    fn first_subscriber_failure_is_explicit_and_repeat_init_is_inert() {
        use std::cell::Cell;
        use std::sync::atomic::{AtomicBool, Ordering};
        // A fresh install that succeeds owns the writer.
        let installed = AtomicBool::new(false);
        assert!(install_subscriber_once(&installed, || Ok(())).expect("fresh install"));
        assert!(installed.load(Ordering::SeqCst));

        // A repeat of our own install never calls the installer again.
        let calls = Cell::new(0);
        let repeated = install_subscriber_once(&installed, || {
            calls.set(calls.get() + 1);
            Ok(())
        })
        .expect("a repeat is intentional");
        assert!(!repeated);
        assert_eq!(
            calls.get(),
            0,
            "a repeat must not install a second subscriber"
        );

        // A foreign subscriber makes the FIRST install fail explicitly, and the
        // failure resets the flag so a later retry can still install.
        let foreign = AtomicBool::new(false);
        let error = install_subscriber_once(&foreign, || Err("foreign subscriber".to_string()))
            .expect_err("a foreign subscriber is an explicit failure");
        assert_eq!(
            error,
            DshError::other("diagnostics_subscriber", "foreign subscriber")
        );
        assert!(
            !foreign.load(Ordering::SeqCst),
            "a failed first install must not look installed"
        );
        assert!(install_subscriber_once(&foreign, || Ok(())).expect("retry"));
    }

    #[test]
    fn init_diagnostics_installs_once_and_repeated_init_is_inert() {
        let dir = tempfile::tempdir().expect("tempdir");
        let logs = dir.path().join("logs");
        let mut first = init_diagnostics(&logs).expect("the first install in this binary succeeds");
        assert!(first.owns_writer(), "the first call owns the writer");
        let second = init_diagnostics(&logs).expect("a repeated init is intentional");
        assert!(!second.owns_writer(), "a repeated init owns nothing");
        first.flush();
        first.flush();
        assert!(!first.owns_writer(), "flush is idempotent");
        assert!(logs.is_dir(), "the log directory is created");
    }

    #[test]
    fn init_diagnostics_fails_loudly_when_the_log_directory_cannot_be_created() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("not-a-directory");
        std::fs::write(&file, b"x").expect("seed");
        let error = init_diagnostics(&file).expect_err("an existing file is not a log directory");
        assert!(matches!(error, DshError::Io { .. }), "{error:?}");
    }
}
