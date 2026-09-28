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
//!   other file in the directory.
//! - Host stderr retention is capped at the last 64 Ki characters
//!   ([`StderrTail`]); a fatal host-exit report therefore carries exactly that tail.

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
    /// Wire spelling used in file names and the report header.
    pub fn as_str(self) -> &'static str {
        match self {
            CrashReportSource::Host => "host",
            CrashReportSource::WebBoot => "web-boot",
            CrashReportSource::Renderer => "renderer",
            CrashReportSource::Main => "main",
        }
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
        "{CRASH_REPORT_PREFIX}{}-{}.log",
        stamp.replace([':', '.'], "-"),
        source.as_str()
    )
}

/// Whether a file name is exactly one this module generates (pruning touches
/// only names that match).
pub fn is_crash_report_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(CRASH_REPORT_PREFIX) else {
        return false;
    };
    let Some(rest) = rest.strip_suffix(".log") else {
        return false;
    };
    let Some((stamp, source)) = rest.rsplit_once('-') else {
        return false;
    };
    let source_ok = matches!(source, "host" | "web-boot" | "renderer" | "main");
    // stamp = YYYY-MM-DDTHH-MM-SS-mmmZ
    let stamp_ok = stamp.len() == 24
        && stamp.as_bytes()[4] == b'-'
        && stamp.as_bytes()[7] == b'-'
        && stamp.as_bytes()[10] == b'T'
        && stamp.as_bytes()[13] == b'-'
        && stamp.as_bytes()[16] == b'-'
        && stamp.as_bytes()[19] == b'-'
        && stamp.ends_with('Z');
    source_ok && stamp_ok
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

/// Write one report into `directory`, creating it when absent. Failure is
/// returned to the caller, which shows the recovery dialog without a path
/// rather than failing over a diagnostic aid.
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
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    set_file_owner_only(&mut options);
    let mut file = options
        .open(&path)
        .map_err(|e| DshError::io("create crash report", Some(path.display().to_string()), &e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| DshError::io("write crash report", Some(path.display().to_string()), &e))?;
    Ok(path)
}

/// Delete the oldest reports beyond `retained`, judged by file-name order, and
/// leave every other file in the directory alone. A missing directory is not a failure.
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
    let mut reports: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| is_crash_report_name(name))
        .collect();
    reports.sort();
    let excess = reports.len().saturating_sub(retained);
    for name in reports.into_iter().take(excess) {
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

/// Install structured diagnostic logging: daily-rolling files under `logs_dir`,
/// owner-only where supported. The returned guard must be kept alive for the
/// lifetime of the process.
pub fn init_diagnostics(
    logs_dir: &Path,
) -> Result<tracing_appender::non_blocking::WorkerGuard, DshError> {
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
    // A global subscriber can only be set once per process; a second install
    // (tests, restart-in-process) keeps the first and still returns a guard.
    let _ = tracing::subscriber::set_global_default(subscriber);
    Ok(guard)
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
    fn write_and_prune_retain_ten_newest_matching_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("keep-me.txt"), "x").expect("seed");
        let base = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00.000Z")
            .expect("time")
            .with_timezone(&chrono::Utc);
        for index in 0..12 {
            let time = base + chrono::Duration::seconds(index);
            let input = CrashReportInput {
                source: CrashReportSource::Main,
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
        assert_eq!(names.len(), CRASH_REPORTS_RETAINED + 1);
        assert!(
            names
                .iter()
                .all(|n| n == "keep-me.txt" || n.as_str() >= "crash-2026-01-01T00-00-02"),
            "only the two oldest reports may be pruned: {names:?}"
        );
    }
}
