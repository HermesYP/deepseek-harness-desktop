//! Probe-only stand-in for the `dirs` crate (**TEST ONLY**).
//!
//! ## Why this substitution exists
//!
//! The included production text resolves its artifact cache through
//! `dirs::cache_dir()` (`app/src/update_flow.rs`, `artifact_cache_dir`). The
//! shipped `dirs` crate answers that from the platform's KnownFolder API, and on
//! Windows that value ignores a plain `LOCALAPPDATA` environment redirect: it
//! points at the live, shared updater cache
//! (`...\LocalAppData\dsh-desktop-updater`). A standalone test run must never
//! read or write that directory, because a shared cache is another
//! installation's state.
//!
//! The probe therefore maps its `dirs` dependency key onto this crate, which
//! answers with a probe-owned directory under the **current process temp
//! directory**. `temp_dir()` honours `TEMP`/`TMP`, so the parent runner can
//! point it at a fresh, attested directory outside the repository.
//!
//! ## Boundaries, stated plainly
//!
//! * The production source that calls `dirs::cache_dir()` is **unmodified**; the
//!   dependency substitution is the only difference, and it is a test-only
//!   dependency in a crate that is not a product artifact.
//! * This is **not** a claim about the production cache path and **not** any
//!   form of account or cache acceptance: no shipped build uses this crate, and
//!   nothing here exercises the real KnownFolder resolution.
//! * Only `cache_dir` is provided, because it is the only `dirs` symbol the
//!   included production text names. A future production use of another `dirs`
//!   function must fail to compile here rather than silently answer wrongly.
//!
//! `cache_dir` is a pure path computation: it performs no I/O, creates no
//! directory, and touches no platform global state.

use std::path::PathBuf;

/// Name of the probe-owned artifact cache directory.
pub const PROBE_ARTIFACT_CACHE_DIR: &str = "dsh-updater-probe-artifact-cache";

/// Resolve the probe's artifact cache directory.
///
/// Mirrors the shipped `dirs::cache_dir()` signature (`Option<PathBuf>`), but
/// always answers with a probe-owned directory under the current process temp
/// directory.
/// @returns the probe artifact cache path; always `Some`.
pub fn cache_dir() -> Option<PathBuf> {
    Some(std::env::temp_dir().join(PROBE_ARTIFACT_CACHE_DIR))
}

#[cfg(test)]
mod tests {
    use super::{cache_dir, PROBE_ARTIFACT_CACHE_DIR};
    use std::ffi::OsStr;

    /// Purely a path assertion: the value is under the current process temp
    /// directory, names the probe directory, never the production cache name,
    /// and is stable across calls (so it writes no global state).
    #[test]
    fn cache_dir_is_the_probe_directory_under_the_current_temp_dir() {
        let temporary = std::env::temp_dir();
        let cache = cache_dir().expect("the probe facade always answers");

        assert!(
            cache.starts_with(&temporary),
            "probe cache {cache:?} must live under the current temp dir {temporary:?}"
        );
        assert_eq!(
            cache.file_name(),
            Some(OsStr::new(PROBE_ARTIFACT_CACHE_DIR)),
            "probe cache must name the probe-owned directory"
        );
        assert!(
            !cache.to_string_lossy().contains("dsh-desktop-updater"),
            "the probe must never resolve the production/shared updater cache: {cache:?}"
        );
        assert_eq!(
            cache_dir(),
            Some(cache),
            "cache_dir must be a stable pure path"
        );
    }
}
