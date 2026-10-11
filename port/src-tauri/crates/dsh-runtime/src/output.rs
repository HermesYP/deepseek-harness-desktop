//! Host output observation without unbounded lines or dependence on a terminal.
//! The app's observer redacts records before passing them to its durable logger.

use std::sync::Arc;

use dsh_core::diagnostics::StderrTail;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

const MAX_LINE_BYTES: usize = 8 * 1024;
const OVERSIZED_LINE: &str = "[Host output line omitted: exceeded 8192 bytes]";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOutputStream {
    Stdout,
    Stderr,
}

impl HostOutputStream {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

/// Called only with complete, bounded lines, including the last line at EOF.
/// Implementations must redact before persisting; logging is not an auth input.
pub type OutputObserver = Arc<dyn Fn(HostOutputStream, &str) + Send + Sync>;

#[derive(Default)]
struct OutputLines {
    pending: Vec<u8>,
    oversized: bool,
}

impl OutputLines {
    fn push(&mut self, bytes: &[u8], emit: &mut impl FnMut(&str)) {
        for byte in bytes {
            if *byte == b'\n' {
                self.finish(emit);
            } else if !self.oversized {
                if self.pending.len() == MAX_LINE_BYTES {
                    self.pending.clear();
                    self.oversized = true;
                } else {
                    self.pending.push(*byte);
                }
            }
        }
    }

    fn finish(&mut self, emit: &mut impl FnMut(&str)) {
        if self.oversized {
            emit(OVERSIZED_LINE);
        } else if !self.pending.is_empty() {
            emit(String::from_utf8_lossy(&self.pending).trim_end_matches('\r'));
        }
        self.pending.clear();
        self.oversized = false;
    }
}

pub(crate) async fn drain_output(
    mut pipe: impl AsyncRead + Unpin,
    stream: HostOutputStream,
    tail: Option<Arc<Mutex<StderrTail>>>,
    observer: Option<OutputObserver>,
    forward_stdout: bool,
) {
    let mut lines = OutputLines::default();
    let mut buffer = [0u8; 8192];
    let mut emit = |line: &str| {
        if let Some(observer) = &observer {
            observer(stream, line);
        }
    };
    loop {
        match pipe.read(&mut buffer).await {
            Ok(0) => break,
            Ok(count) => {
                let bytes = &buffer[..count];
                if let Some(tail) = &tail {
                    tail.lock().await.push(&String::from_utf8_lossy(bytes));
                }
                lines.push(bytes, &mut emit);
                if forward_stdout {
                    // Preserve the original optional terminal forwarding. The
                    // durable observer is independent of a missing console.
                    let _ = tokio::io::stdout().write_all(bytes).await;
                }
            }
            Err(error) => {
                emit(&format!("[Host output read failed: {}]", error.kind()));
                break;
            }
        }
    }
    lines.finish(&mut emit);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_lines_keep_utf8_and_credentials_together_across_chunks() {
        let mut framer = OutputLines::default();
        let mut lines = Vec::new();
        let mut emit = |line: &str| lines.push(line.to_string());
        framer.push(b"token=split", &mut emit);
        framer.push(b"-value\r\nstatus=403 \xe2", &mut emit);
        framer.push(b"\x82\xac\nlast line", &mut emit);
        framer.finish(&mut emit);
        assert_eq!(lines, ["token=split-value", "status=403 €", "last line"]);
    }

    #[test]
    fn oversized_lines_are_discarded_whole_then_observation_resumes() {
        let mut framer = OutputLines::default();
        let mut lines = Vec::new();
        let mut emit = |line: &str| lines.push(line.to_string());
        framer.push(&vec![b'x'; MAX_LINE_BYTES + 1], &mut emit);
        assert!(framer.pending.is_empty());
        framer.push(b"secret-tail\nnext\n", &mut emit);
        assert_eq!(lines, [OVERSIZED_LINE, "next"]);
    }

    #[tokio::test]
    async fn piped_stdout_is_observed_without_a_terminal_and_flushes_at_eof() {
        let (mut producer, consumer) = tokio::io::duplex(128);
        let records = Arc::new(std::sync::Mutex::new(Vec::new()));
        let collected = records.clone();
        let observer: OutputObserver = Arc::new(move |stream, line| {
            collected
                .lock()
                .expect("records")
                .push((stream, line.to_string()));
        });
        let drain = tokio::spawn(drain_output(
            consumer,
            HostOutputStream::Stdout,
            None,
            Some(observer),
            false,
        ));
        producer
            .write_all(b"profile status=403\nbalance status=200")
            .await
            .expect("write");
        drop(producer);
        drain.await.expect("drain");
        assert_eq!(
            *records.lock().expect("records"),
            [
                (HostOutputStream::Stdout, "profile status=403".to_string()),
                (HostOutputStream::Stdout, "balance status=200".to_string()),
            ]
        );
    }
}
