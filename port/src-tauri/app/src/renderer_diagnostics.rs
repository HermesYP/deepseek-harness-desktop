//! Meaningful renderer and load diagnostics: the bounded error-level console
//! tail, the load/crash message format, and the redaction applied before any of
//! it reaches a crash report.
//!
//! Two independent observation paths feed this module, and JavaScript cannot
//! manufacture either one:
//!
//! - the injected console bridge ([`crate::renderer_bridge`]) forwards
//!   `console.error`, uncaught errors and unhandled rejections, which is why
//!   this module only ever records **error-level** output;
//! - on Windows, [`crate::renderer_native`] registers WebView2 COM hooks for
//!   `NavigationCompleted` and `ProcessFailed` and builds [`RendererFailure`]
//!   directly from the native status. There is no Electron `did-fail-load` or
//!   `render-process-gone` event to classify here, so this module owns the
//!   message format and the redaction, not the trigger condition.
//!
//! Mirrors `_upstream/apps/desktop/src/main.ts:1040-1057` and
//! `crash-report.ts:63-86` for the retained text and message shapes.
//!
//! ## Untrusted input
//!
//! Everything here arrives from the renderer, which is the process the report
//! is *about* — a renderer that has already been compromised must not be able
//! to poison the diagnostic with credentials or with unbounded text. Three
//! bounds are applied to every accepted line before it is retained:
//!
//! 1. **length** — one line is truncated to [`MAX_CONSOLE_LINE_CHARS`]; the
//!    retained total stays under the `RendererConsoleTail` byte cap;
//! 2. **control characters** — a line is flattened to one physical line, so a
//!    console message cannot forge a section header in the plain-text report;
//! 3. **secret shapes** — bearer/basic authorization values, `key=value` pairs
//!    whose key names a secret, and long high-entropy base64/hex runs are
//!    replaced by a fixed marker. This is a defence in depth, not a guarantee:
//!    the report never contains a credential the shell itself handled, because
//!    `credential_store` is the only command that accepts one and it never
//!    logs it.

use dsh_core::diagnostics::RendererConsoleTail;

/// Longest single console line retained, in characters.
pub const MAX_CONSOLE_LINE_CHARS: usize = 8 * 1024;

/// Replacement for a redacted value.
pub const REDACTED: &str = "[redacted]";

/// Why a renderer-level failure is fatal, if it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RendererFailure {
    /// The main frame could not load the document.
    Load {
        /// Page URL the renderer was navigating to.
        url: String,
        /// Native navigation status code.
        code: i32,
        /// Native description of the code.
        description: String,
    },
    /// The renderer process ended without a clean exit.
    ProcessGone {
        /// Native reason string.
        reason: String,
    },
}

impl RendererFailure {
    /// A main-frame load failure, as WebView2's `NavigationCompleted` reports it.
    ///
    /// The native `COREWEBVIEW2_WEB_ERROR_STATUS` is kept distinct from
    /// Chromium's `-3`/`ERR_ABORTED` convention: these enum values are not net
    /// codes. The caller must already have excluded
    /// `COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED`, which is a
    /// superseded navigation and not a failure.
    pub fn native_load(url: String, status: i32) -> Self {
        Self::Load {
            url,
            code: status,
            description: format!("WebView2 navigation status {status}"),
        }
    }

    /// A renderer or browser process exit, as WebView2's `ProcessFailed` reports
    /// it. `kind` and `reason` are the raw native enum values.
    pub fn native_process_gone(kind: i32, reason: i32) -> Self {
        Self::ProcessGone {
            reason: format!("WebView2 abnormal process exit (kind {kind}, reason {reason})"),
        }
    }

    /// The exact message recorded in the crash report and shown in the dialog.
    pub fn message(&self) -> String {
        let message = match self {
            Self::Load {
                url,
                code,
                description,
            } => format!(
                "Desktop page failed to load: {} ({code}: {})",
                sanitize_field(&redact(url)),
                sanitize_field(&redact(description))
            ),
            Self::ProcessGone { reason } => {
                format!(
                    "Desktop renderer exited: {}",
                    sanitize_field(&redact(reason))
                )
            }
        };
        sanitize_field(&message)
    }
}

/// Bound one renderer string used as a single report field: truncate, flatten
/// to one physical line, and mark a cut with an ellipsis.
///
/// Truncation keeps **both ends**. A console message is either a single
/// sentence (where the head carries the meaning) or a `Error: … at frame`
/// stack (where the head names the failure and the tail names the innermost
/// frame), and neither end alone is a usable diagnostic. The middle is what is
/// dropped.
pub fn sanitize_field(value: &str) -> String {
    let flattened: String = value
        .chars()
        .map(|c| match c {
            '\r' | '\n' | '\u{2028}' | '\u{2029}' => ' ',
            c if c.is_control() && c != '\t' => ' ',
            c => c,
        })
        .collect();
    let flattened = flattened.trim();
    if flattened.chars().count() <= MAX_CONSOLE_LINE_CHARS {
        return flattened.to_string();
    }
    let content_budget = MAX_CONSOLE_LINE_CHARS - 1; // The ellipsis uses one character.
    let head_budget = content_budget / 2;
    let tail_budget = content_budget - head_budget;
    let head: String = flattened.chars().take(head_budget).collect();
    let tail: String = flattened
        .chars()
        .rev()
        .take(tail_budget)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{head}…{tail}")
}

/// Keys whose value is a secret whenever they appear as `key=value` or
/// `key: value`; matched case-insensitively.
const SECRET_KEYS: [&str; 12] = [
    "api_key",
    "apikey",
    "api-key",
    "access_token",
    "refresh_token",
    "authorization",
    "auth",
    "secret",
    "password",
    "passwd",
    "token",
    "cookie",
];

/// Redact secret-shaped substrings from one renderer line.
///
/// This intentionally over-redacts: a diagnostic that drops a benign `token=`
/// fragment is still useful, while one that carries a live credential is not.
pub fn redact(line: &str) -> String {
    let mut out = redact_authorization(line);
    out = redact_key_values(&out);
    redact_long_runs(&out)
}

fn redact_authorization(line: &str) -> String {
    let mut result = line.to_string();
    // Each scheme scans the complete result, not only the suffix left by the
    // previous scheme. Otherwise an earlier Basic credential can leak.
    for scheme in ["bearer ", "basic "] {
        let line = result.as_str();
        let lower = line.to_ascii_lowercase();
        let mut out = String::with_capacity(line.len());
        let mut cursor = 0;
        while let Some(relative) = lower[cursor..].find(scheme) {
            let start = cursor + relative;
            // Boundary check: the scheme must start a word.
            let boundary = start == 0
                || !line[..start]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
            if !boundary {
                out.push_str(&line[cursor..start + scheme.len()]);
                cursor = start + scheme.len();
                continue;
            }
            out.push_str(&line[cursor..start]);
            out.push_str(scheme);
            out.push_str(REDACTED);
            let rest = &line[start + scheme.len()..];
            let end = rest
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',' || c == ';')
                .unwrap_or(rest.len());
            cursor = start + scheme.len() + end;
        }
        out.push_str(&line[cursor..]);
        result = out;
    }
    result
}

fn redact_key_values(line: &str) -> String {
    let mut result = line.to_string();
    // Restart from the beginning for each key: source order is independent of
    // SECRET_KEYS order, and one line may contain several credential types.
    for key in SECRET_KEYS {
        let line = result.as_str();
        let lower = line.to_ascii_lowercase();
        let bytes = line.as_bytes();
        let mut out = String::with_capacity(line.len());
        let mut cursor = 0;
        let mut search = 0;
        while let Some(relative) = lower[search..].find(key) {
            let start = search + relative;
            // The key must start a word and be followed by a separator.
            let word_start =
                start == 0 || !bytes[start - 1].is_ascii_alphanumeric() && bytes[start - 1] != b'_';
            if !word_start {
                search = start + key.len();
                continue;
            }
            let after_key = start + key.len();
            let separator = line[after_key..].find(['=', ':']);
            let Some(separator) = separator else {
                search = after_key;
                continue;
            };
            // Only an immediate separator counts (`token = x` and `token=x`).
            let separator_index = after_key + separator;
            if !line[after_key..separator_index]
                .trim()
                .trim_matches(['\'', '"'])
                .is_empty()
            {
                search = after_key;
                continue;
            }
            let value_start = separator_index + 1;
            // A URL scheme separator (`https:`) is not a key/value pair.
            if line[separator_index..].starts_with("://") {
                search = value_start;
                continue;
            }
            // `token: value` and `token = value` both name a secret; the space
            // after the separator belongs to the separator, not to the value.
            let rest = &line[value_start..];
            let skipped = rest.len() - rest.trim_start().len();
            let mut value_at = value_start + skipped;
            let quote = line[value_at..]
                .chars()
                .next()
                .filter(|c| *c == '\'' || *c == '"');
            if quote.is_some() {
                value_at += 1;
            }
            let rest = &line[value_at..];
            let value_end = if key == "cookie" {
                // A Cookie header contains multiple semicolon-separated secrets.
                rest.len()
            } else if let Some(quote) = quote {
                let mut escaped = false;
                rest.char_indices()
                    .find_map(|(index, character)| {
                        if escaped {
                            escaped = false;
                        } else if character == '\\' {
                            escaped = true;
                        } else if character == quote {
                            return Some(index);
                        }
                        None
                    })
                    .unwrap_or(rest.len())
            } else {
                rest.find(|c: char| c.is_whitespace() || c == ',' || c == ';')
                    .unwrap_or(rest.len())
            };
            if value_end == 0 {
                search = value_at;
                continue;
            }
            out.push_str(&line[cursor..value_at]);
            out.push_str(REDACTED);
            cursor = value_at + value_end;
            search = cursor;
        }
        out.push_str(&line[cursor..]);
        result = out;
    }
    result
}

/// Replace long unbroken base64/hex runs (a bare token with no key in front of
/// it). Ordinary identifiers, file paths and hashes in prose stay readable
/// because the run must be at least 32 characters and look like an encoding.
fn redact_long_runs(line: &str) -> String {
    const MIN_RUN: usize = 32;
    let mut out = String::with_capacity(line.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.len() >= MIN_RUN && looks_encoded(run) {
            out.push_str(REDACTED);
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for character in line.chars() {
        if character.is_ascii_alphanumeric()
            || character == '+'
            || character == '/'
            || character == '='
            || character == '-'
            || character == '_'
        {
            run.push(character);
        } else {
            flush(&mut run, &mut out);
            out.push(character);
        }
    }
    flush(&mut run, &mut out);
    out
}

fn looks_encoded(run: &str) -> bool {
    let has_upper = run.chars().any(|c| c.is_ascii_uppercase());
    let has_lower = run.chars().any(|c| c.is_ascii_lowercase());
    let has_digit = run.chars().any(|c| c.is_ascii_digit());
    // A long run mixing all three character classes is an encoded blob far more
    // often than it is prose; a lowercase-only path segment or a hex digest
    // without digits stays readable.
    has_upper && has_lower && has_digit
}

/// The primary window's diagnostic accumulator.
#[derive(Debug, Default)]
pub struct RendererDiagnostics {
    console: RendererConsoleTail,
}

impl RendererDiagnostics {
    /// Fresh accumulator with the upstream console budget.
    pub fn new() -> Self {
        Self {
            console: RendererConsoleTail::default(),
        }
    }

    /// Record one error-level console line, formatted
    /// `"<sourceId>:<lineNumber> <message>"` and bounded by
    /// [`dsh_core::diagnostics::RendererConsoleTail`].
    ///
    /// The injected bridge only ever forwards `console.error`, uncaught errors
    /// and unhandled rejections, so there is no severity to select here.
    ///
    /// `source_id` and `line` are bounded and redacted before retention; the
    /// message is flattened to a single line so it cannot forge a report
    /// section.
    pub fn push_console(&mut self, source_id: &str, line: u32, message: &str) {
        // Redact before truncation, so retaining a long value's tail cannot
        // detach it from the secret key that identifies it.
        let location = format!("{}:{}", sanitize_field(&redact(source_id)), line);
        let message = sanitize_field(&redact(message));
        self.console
            .push(&sanitize_field(&format!("{location} {message}")));
    }

    /// The retained error-level console lines, oldest first.
    pub fn console_snapshot(&self) -> &[String] {
        self.console.snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn console_lines_are_formatted_as_source_line_message() {
        let mut diagnostics = RendererDiagnostics::new();
        diagnostics.push_console("app.js", 4, "boom");
        diagnostics.push_console("app.js", 5, "second");
        assert_eq!(
            diagnostics.console_snapshot(),
            &["app.js:4 boom".to_string(), "app.js:5 second".to_string()]
        );
    }

    #[test]
    fn console_lines_are_single_line_and_bounded() {
        let mut diagnostics = RendererDiagnostics::new();
        let huge = format!(
            "start{}\n--- error ---\nfake",
            "x".repeat(MAX_CONSOLE_LINE_CHARS * 2)
        );
        diagnostics.push_console("app.js", 9, &huge);
        let lines = diagnostics.console_snapshot();
        assert_eq!(lines.len(), 1, "one pushed line is one retained line");
        let line = &lines[0];
        assert!(
            !line.contains('\n'),
            "a message cannot forge a report section"
        );
        assert!(
            line.chars().count() <= MAX_CONSOLE_LINE_CHARS + 64,
            "line must be bounded: {}",
            line.chars().count()
        );
        assert!(
            line.contains("--- error ---"),
            "content survives, flattened"
        );
    }

    #[test]
    fn control_characters_are_flattened() {
        let mut diagnostics = RendererDiagnostics::new();
        diagnostics.push_console("a\rb", 1, "x\u{0000}y\u{2028}z");
        let line = &diagnostics.console_snapshot()[0];
        assert!(!line.contains('\u{0000}'), "{line}");
        assert!(!line.contains('\u{2028}'), "{line}");
        assert!(line.starts_with("a b:1 "), "{line}");
    }

    #[test]
    fn mixed_secret_order_quoted_values_and_cookie_lists_are_redacted() {
        for (input, secrets) in [
            ("token=early password=late", vec!["early", "late"]),
            (
                "Basic basic-secret Bearer bearer-secret",
                vec!["basic-secret", "bearer-secret"],
            ),
            (
                r#"{"token": "secret with spaces", "password": "second-secret"}"#,
                vec!["secret with spaces", "second-secret"],
            ),
            (
                "Cookie: session=one-secret; other=two-secret",
                vec!["one-secret", "two-secret"],
            ),
            (
                r#"token='a \' quoted secret' password=another-secret"#,
                vec!["quoted secret", "another-secret"],
            ),
        ] {
            let output = redact(input);
            for secret in secrets {
                assert!(
                    !output.contains(secret),
                    "{input} -> {output} leaked {secret}"
                );
            }
        }
    }

    #[test]
    fn source_credentials_and_long_secret_tails_are_redacted_before_truncation() {
        let mut diagnostics = RendererDiagnostics::new();
        diagnostics.push_console(
            "http://127.0.0.1/?token=source-secret",
            1,
            &format!(
                "password={}secret-tail",
                "x".repeat(MAX_CONSOLE_LINE_CHARS * 2)
            ),
        );
        let output = &diagnostics.console_snapshot()[0];
        assert!(!output.contains("source-secret"));
        assert!(!output.contains("secret-tail"));
        assert!(output.chars().count() <= MAX_CONSOLE_LINE_CHARS);
    }

    #[test]
    fn secrets_are_redacted_before_retention() {
        for (input, must_not_contain) in [
            (
                "fetch failed Authorization: Bearer abc123def456",
                "abc123def456",
            ),
            (
                "sent basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
                "QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
            ),
            ("api_key=sk-live-9999", "sk-live-9999"),
            (
                "token: abcdefghijklmnopqrstuvwxyz0123456789",
                "abcdefghijklmnopqrstuvwxyz0123456789",
            ),
            ("password=hunter2", "hunter2"),
        ] {
            let redacted = redact(input);
            assert!(
                !redacted.contains(must_not_contain),
                "{input} -> {redacted} leaked {must_not_contain}"
            );
            assert!(redacted.contains(REDACTED), "{input} -> {redacted}");
        }
    }

    #[test]
    fn redaction_keeps_ordinary_diagnostics_readable() {
        for input in [
            "network error loading /assets/index-9f2.js",
            "TypeError: cannot read properties of undefined",
            "https://127.0.0.1:3085/api/session/follow failed",
            "3 communities followed", // the word "communities" contains no secret key
        ] {
            assert_eq!(redact(input), input, "{input} must survive redaction");
        }
        // A short hex digest is not an encoded secret.
        assert_eq!(redact("sha256 ab12cd34"), "sha256 ab12cd34");
    }

    #[test]
    fn native_load_and_exit_failures_carry_usable_messages() {
        // These are the exact constructors `renderer_native` calls from the
        // WebView2 `NavigationCompleted` and `ProcessFailed` hooks, so this
        // covers the native construction path without needing a COM apartment.
        let load = RendererFailure::native_load("http://x/index.html".to_string(), -2147023174);
        assert_eq!(
            load.message(),
            "Desktop page failed to load: http://x/index.html \
             (-2147023174: WebView2 navigation status -2147023174)"
        );
        let exited = RendererFailure::native_process_gone(0, 0);
        assert_eq!(
            exited.message(),
            "Desktop renderer exited: WebView2 abnormal process exit (kind 0, reason 0)"
        );
        // The native status is kept distinct from Chromium's -3 net code.
        assert_ne!(load.message(), "Desktop page failed to load: (0: )");
    }

    #[test]
    fn failure_messages_are_bounded_and_flattened() {
        let failure = RendererFailure::ProcessGone {
            reason: format!("bad\nreason{}", "z".repeat(MAX_CONSOLE_LINE_CHARS * 2)),
        };
        let message = failure.message();
        assert!(!message.contains('\n'));
        assert!(message.chars().count() <= MAX_CONSOLE_LINE_CHARS + 64);
    }

    #[test]
    fn complete_records_include_metadata_and_ellipsis_within_the_limit() {
        let mut diagnostics = RendererDiagnostics::new();
        let text = "ordinary words ".repeat(MAX_CONSOLE_LINE_CHARS);
        diagnostics.push_console(&text, u32::MAX, &text);
        assert_eq!(
            diagnostics.console_snapshot()[0].chars().count(),
            MAX_CONSOLE_LINE_CHARS
        );
        let failure = RendererFailure::Load {
            url: text.clone(),
            code: -105,
            description: text,
        };
        assert_eq!(failure.message().chars().count(), MAX_CONSOLE_LINE_CHARS);
    }

    #[test]
    fn failure_credentials_are_redacted_before_middle_truncation() {
        let failure = RendererFailure::ProcessGone {
            reason: format!(
                "password={} secret tail'",
                "ordinary words ".repeat(MAX_CONSOLE_LINE_CHARS)
            ),
        };
        let quoted = RendererFailure::ProcessGone {
            reason: format!(
                "password='{}secret-tail'",
                "ordinary words ".repeat(MAX_CONSOLE_LINE_CHARS)
            ),
        };
        assert!(!quoted.message().contains("secret-tail"));
        assert!(!failure.message().contains("password=ordinary"));
    }
}
