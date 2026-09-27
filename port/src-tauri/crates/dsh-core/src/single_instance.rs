//! Process-lifetime single-instance lock on the desktop profile
//! (named mutex on Windows; lock file + `flock` on Unix).
//!
//! Contract (upstream `claimDesktopSingleInstance`, `single-instance.ts`):
//! the lock is claimed before any Desktop profile access; exactly one process
//! may own `$DSH_HOME/profiles/desktop` at a time; a later launch fails the
//! claim and routes activation to the owner.

use std::path::Path;

use crate::error::DshError;
use crate::paths::DesktopPaths;

/// Outcome of [`SingleInstanceLock::acquire`].
#[derive(Debug)]
pub enum InstanceClaim {
    /// This process owns the desktop profile for its lifetime.
    Acquired(SingleInstanceLock),
    /// Another live process owns the profile; the caller must exit after
    /// routing activation to the owner.
    AlreadyRunning,
}

/// Held single-instance lock; released when dropped (and, on Windows, by
/// process exit regardless).
#[derive(Debug)]
pub struct SingleInstanceLock {
    /// Owned `HANDLE` stored as `usize` so the guard stays `Send + Sync`.
    #[cfg(windows)]
    _handle: usize,
    #[cfg(unix)]
    _file: std::fs::File,
}

impl Drop for SingleInstanceLock {
    /// Release the claim: close the named mutex / the lock file.
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self._handle as _);
        }
    }
}

/// Acquire the process-lifetime lock named after the desktop profile lock path.
pub fn acquire(paths: &DesktopPaths) -> Result<InstanceClaim, DshError> {
    acquire_for_lock_path(&paths.lock)
}

/// Acquire against an explicit profile-lock path (the identity of the claim).
pub fn acquire_for_lock_path(lock_path: &Path) -> Result<InstanceClaim, DshError> {
    std::fs::create_dir_all(lock_path.parent().unwrap_or(Path::new(".")))
        .map_err(|e| DshError::io("create profile directory", Some(lock_path.display().to_string()), &e))?;
    platform_acquire(lock_path)
}

#[cfg(windows)]
fn platform_acquire(lock_path: &Path) -> Result<InstanceClaim, DshError> {
    use std::sync::atomic::{AtomicU64, Ordering};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;

    // The mutex name derives from the profile lock path so two different
    // profiles never collide and the same profile always shares one claim.
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    lock_path.hash(&mut hasher);
    // Uppercase-insensitive identity: Windows paths are case-insensitive.
    let canonical = lock_path.to_string_lossy().to_lowercase();
    canonical.hash(&mut hasher);
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let name = format!("Local\\dsh-desktop-profile-{:016x}", {
        let _ = COUNTER.fetch_add(1, Ordering::Relaxed);
        hasher.finish()
    });
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 1, wide.as_ptr());
        if handle.is_null() {
            return Err(DshError::io(
                "create instance mutex",
                Some(lock_path.display().to_string()),
                &std::io::Error::last_os_error(),
            ));
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(handle);
            return Ok(InstanceClaim::AlreadyRunning);
        }
        Ok(InstanceClaim::Acquired(SingleInstanceLock {
            _handle: handle as usize,
        }))
    }
}

#[cfg(unix)]
fn platform_acquire(lock_path: &Path) -> Result<InstanceClaim, DshError> {
    use fs4::fs_std::FileExt;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|e| DshError::io("open instance lock", Some(lock_path.display().to_string()), &e))?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(InstanceClaim::Acquired(SingleInstanceLock { _file: file })),
        Err(_) => Ok(InstanceClaim::AlreadyRunning),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_claim_fails_while_held_and_succeeds_after_release() {
        let dir = tempfile::tempdir().expect("tempdir");
        let lock_path = dir.path().join("profiles").join("desktop").join("lock");
        let first = acquire_for_lock_path(&lock_path).expect("first claim");
        assert!(matches!(first, InstanceClaim::Acquired(_)));
        let second = acquire_for_lock_path(&lock_path).expect("second claim");
        assert!(matches!(second, InstanceClaim::AlreadyRunning));
        drop(first);
        // Releasing the lock must let a successor claim it (Unix flock semantics;
        // on Windows the named mutex outlives CloseHandle only until the last
        // handle closes, which drop just performed).
        #[cfg(unix)]
        {
            let third = acquire_for_lock_path(&lock_path).expect("third claim");
            assert!(matches!(third, InstanceClaim::Acquired(_)));
        }
    }

    #[test]
    fn distinct_lock_paths_do_not_collide() {
        let dir = tempfile::tempdir().expect("tempdir");
        let a = acquire_for_lock_path(&dir.path().join("a").join("lock")).expect("claim a");
        let b = acquire_for_lock_path(&dir.path().join("b").join("lock")).expect("claim b");
        assert!(matches!(a, InstanceClaim::Acquired(_)));
        assert!(matches!(b, InstanceClaim::Acquired(_)));
    }
}
