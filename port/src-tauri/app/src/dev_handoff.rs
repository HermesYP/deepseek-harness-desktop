//! Opt-in development handoff for assembled acceptance tests; never enabled by default.
//!
//! Both artifacts carry live session material: the authenticated gateway URL
//! carries the launch token, and the boot inputs carry the stream base URL and
//! the bootstrap batch. They are therefore written through
//! [`write_owner_only_file`], which
//!
//! * creates the file **exclusively** (`CREATE_NEW` / `O_CREAT|O_EXCL`): an
//!   existing file of any kind — including an unrelated user file or a
//!   dangling link at the requested path — is never truncated, replaced, or
//!   deleted, and the request fails with `development_handoff_exists` instead;
//! * installs the intended **owner-only DACL at creation**. On Windows the
//!   descriptor is passed through the native `SECURITY_ATTRIBUTES` of
//!   `CreateFileW`, so there is no window in which the file exists with a
//!   wider (inherited) DACL and no `icacls` child process whose environment
//!   could be influenced. On Unix the creation mode `0o600` does the same;
//! * writes token-bearing bytes only **after** creation succeeded with that
//!   DACL, and if a later write fails it removes exactly the file it created
//!   (creation is exclusive, so nothing else can be at that path).

use std::io::Write;
use std::path::{Path, PathBuf};

use dsh_core::error::DshError;
use dsh_core::protocol::{BootPayload, IndexInjection};
use dsh_gateway::GatewayHandle;

/// Write the process-local authenticated gateway URL only when explicitly requested.
pub fn write_gateway_url(gateway: &GatewayHandle) -> Result<(), DshError> {
    let Some(path) = std::env::var_os("DSH_DESKTOP_DEV_URL_FILE") else {
        return Ok(());
    };
    let path = PathBuf::from(path);
    let url = gateway.authenticated_url();
    write_owner_only_file(&path, url.as_bytes(), "development gateway URL")
}

/// Write boot inputs for the assembled acceptance harness, but only when the
/// authenticated-URL handoff is explicitly enabled. This file excludes the
/// token-bearing `authenticatedUrl` field.
pub fn write_boot_payload(payload: &BootPayload) -> Result<(), DshError> {
    let Some(url_file) = std::env::var_os("DSH_DESKTOP_DEV_URL_FILE") else {
        return Ok(());
    };
    let url_file = PathBuf::from(url_file);
    let path = std::env::var_os("DSH_DESKTOP_DEV_BOOT_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let mut path = url_file;
            path.set_extension("boot.json");
            path
        });
    let bootstrap_batch_url = payload
        .injections
        .iter()
        .find_map(|injection| match injection {
            IndexInjection::ScriptSrc { src, .. }
                if src.contains("@deepseek-ai/dsh-client-modules/client.js") =>
            {
                Some(src.as_str())
            }
            _ => None,
        })
        .ok_or_else(|| {
            DshError::other(
                "desktop_boot_handoff",
                "The client-modules bootstrap batch is missing from the boot injection table.",
            )
        })?;
    let graph_revision = bootstrap_batch_url
        .split_once("rev=")
        .map(|(_, revision)| revision.split(['&', '#']).next().unwrap_or_default())
        .filter(|revision| !revision.is_empty())
        .ok_or_else(|| {
            DshError::other(
                "desktop_boot_handoff",
                "The client-modules bootstrap batch has no revision.",
            )
        })?;
    let bytes = serde_json::to_vec(&serde_json::json!({
        "streamBaseUrl": payload.stream_base_url,
        "bootstrapBatchUrl": bootstrap_batch_url,
        "graphRevision": graph_revision,
    }))
    .map_err(|error| DshError::other("desktop_boot_handoff", error.to_string()))?;
    write_owner_only_file(&path, &bytes, "development boot inputs")
}

/// Create `path` exclusively with an owner-only DACL and write `bytes` into it.
///
/// The path is used exactly as given: nothing is created besides `path` itself,
/// and no environment variable decides *how* the file is protected (the DACL is
/// built in-process, so `SystemRoot`, `PATH` and friends cannot influence it).
fn write_owner_only_file(path: &Path, bytes: &[u8], label: &str) -> Result<(), DshError> {
    let mut file = create_owner_only_new(path, label)?;
    let write_result = file.write_all(bytes).and_then(|()| file.flush());
    if let Err(error) = write_result {
        // Only a file this call created can be at `path` (creation is
        // exclusive), so removing it repairs our own partial artifact and can
        // never delete a pre-existing or unrelated file.
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(DshError::io(
            format!("write {label}"),
            Some(path.display().to_string()),
            &error,
        ));
    }
    Ok(())
}

/// Map a failed exclusive creation onto the contract error, naming the refusal
/// to overwrite as such instead of reporting an opaque I/O failure.
fn creation_error(path: &Path, label: &str, error: &std::io::Error) -> DshError {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        return DshError::other(
            "development_handoff_exists",
            format!(
                "Refusing to overwrite the existing {label} at {}; the development handoff never replaces an existing path.",
                path.display()
            ),
        );
    }
    DshError::io(
        format!("create {label}"),
        Some(path.display().to_string()),
        error,
    )
}

#[cfg(unix)]
fn create_owner_only_new(path: &Path, label: &str) -> Result<std::fs::File, DshError> {
    use std::os::unix::fs::OpenOptionsExt;

    // `create_new` is `O_CREAT|O_EXCL` (never truncates, never follows an
    // existing path) and `mode` applies the owner-only permissions during the
    // create itself, before the first token byte is written.
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| creation_error(path, label, &error))
}

#[cfg(windows)]
fn create_owner_only_new(path: &Path, label: &str) -> Result<std::fs::File, DshError> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_WRITE, FILE_SHARE_MODE,
    };

    /// SDDL for "protected DACL, file-all-access for the owner-rights SID"
    /// (`S-1-3-4`). This is the descriptor form of the previous shell-out
    /// `icacls <path> /inheritance:r /grant:r *S-1-3-4:(F)`, but it is built
    /// in-process and applied by the create call itself.
    const OWNER_ONLY_SDDL: &str = "D:P(A;;FA;;;OW)";

    let sddl: Vec<u16> = OWNER_ONLY_SDDL
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // SDDL_REVISION_1 == 1.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            1,
            &mut descriptor,
            None,
        )
        .map_err(|error| {
            DshError::other(
                "secure_development_handoff",
                format!("the owner-only DACL for the {label} could not be built: {error}"),
            )
        })?;
    }

    /// The conversion API returns a `LocalAlloc`-owned descriptor; free it once
    /// the kernel has copied the DACL into the new file.
    struct OwnedDescriptor(PSECURITY_DESCRIPTOR);
    impl Drop for OwnedDescriptor {
        fn drop(&mut self) {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.0 .0)));
            }
        }
    }
    let descriptor = OwnedDescriptor(descriptor);

    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0 .0,
        bInheritHandle: windows::Win32::Foundation::FALSE,
    };
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // `CREATE_NEW` with share mode 0: the file cannot already exist, nothing is
    // truncated, and the DACL above is installed by this create. Token bytes
    // are written only after it returns.
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_GENERIC_WRITE.0,
            FILE_SHARE_MODE(0),
            Some(&attributes),
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    };
    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            return Err(creation_error(
                path,
                label,
                &std::io::Error::from_raw_os_error(win32_error_code(&error)),
            ))
        }
    };
    // The raw handle is now owned by the `File`; dropping it closes the handle
    // (which also releases the exclusive share mode).
    Ok(unsafe { std::fs::File::from_raw_handle(handle.0 as _) })
}

#[cfg(not(any(unix, windows)))]
fn create_owner_only_new(path: &Path, label: &str) -> Result<std::fs::File, DshError> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| creation_error(path, label, &error))
}

/// Translate a `windows` crate error back into the Win32 code it carries.
///
/// `CreateFileW`'s wrapper reports `Error::from_win32()`, whose `HRESULT` keeps
/// the original Win32 code in its low 16 bits; restoring it lets
/// [`creation_error`] classify `ERROR_FILE_EXISTS`/`ERROR_ALREADY_EXISTS` as
/// `AlreadyExists` and produce an accurate OS message otherwise.
#[cfg(windows)]
fn win32_error_code(error: &windows::core::Error) -> i32 {
    let code = error.code().0 as u32;
    if code & 0xFFFF_0000 == 0x8007_0000 {
        (code & 0xFFFF) as i32
    } else {
        code as i32
    }
}

#[cfg(all(test, windows))]
mod windows_dacl {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSidToSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows::Win32::Security::{
        EqualSid, GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
        ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        SE_DACL_PROTECTED,
    };

    /// Render a SID as its `S-1-…` string form for readable assertions.
    fn sid_to_string(sid: PSID) -> String {
        let mut text = windows::core::PWSTR::null();
        unsafe { ConvertSidToStringSidW(sid, &mut text).expect("SID to string") };
        let rendered = unsafe { text.to_string() }.unwrap_or_default();
        unsafe {
            let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(text.0 as *mut _)));
        }
        rendered
    }

    /// Read the DACL actually stored on `path` and assert it is the intended
    /// owner-only, non-inheriting DACL: one allow ACE for `S-1-3-4` with full
    /// control, and the `SE_DACL_PROTECTED` control bit set.
    pub(super) fn assert_owner_only(path: &Path) {
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(wide.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut dacl),
                None,
                &mut descriptor,
            )
        };
        assert_eq!(status.0, 0, "GetNamedSecurityInfoW failed");
        let _free = DescriptorGuard(descriptor);

        let mut control = 0u16;
        let mut revision = 0u32;
        unsafe {
            GetSecurityDescriptorControl(descriptor, &mut control, &mut revision)
                .expect("security descriptor control");
        }
        assert_ne!(
            control & SE_DACL_PROTECTED.0,
            0,
            "the handoff DACL must not inherit ACEs"
        );

        let mut present = windows::core::BOOL(0);
        let mut defaulted = windows::core::BOOL(0);
        let mut read_back: *mut ACL = std::ptr::null_mut();
        unsafe {
            GetSecurityDescriptorDacl(descriptor, &mut present, &mut read_back, &mut defaulted)
                .expect("security descriptor DACL");
        }
        assert!(present.as_bool(), "the handoff file must carry a DACL");
        assert_eq!(
            unsafe { (*read_back).AceCount },
            1,
            "owner-only means exactly one ACE"
        );

        let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
        unsafe { GetAce(read_back, 0, &mut ace).expect("first ACE") };
        let ace = ace as *const ACCESS_ALLOWED_ACE;
        assert_eq!(
            unsafe { (*ace).Mask },
            0x001F_01FF,
            "the owner ACE must grant file-all-access"
        );
        let mut owner_rights = PSID(std::ptr::null_mut());
        let owner_rights_wide: Vec<u16> =
            "S-1-3-4".encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            ConvertStringSidToSidW(PCWSTR(owner_rights_wide.as_ptr()), &mut owner_rights)
                .expect("owner-rights SID")
        };
        // The SID lives in the ACE itself, immediately after the header and
        // mask. `addr_of!` yields that place's address; a value expression
        // (`&(*ace).SidStart`) would take the address of a copy instead.
        let ace_sid =
            PSID(unsafe { std::ptr::addr_of!((*ace).SidStart) } as *mut core::ffi::c_void);
        assert_eq!(
            sid_to_string(ace_sid),
            sid_to_string(owner_rights),
            "the single ACE must name the owner-rights SID"
        );
        unsafe {
            EqualSid(ace_sid, owner_rights).expect("the ACE must name the owner-rights SID");
        }
        unsafe {
            let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(owner_rights.0)));
        }
    }

    struct DescriptorGuard(PSECURITY_DESCRIPTOR);
    impl Drop for DescriptorGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(self.0 .0)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique scratch directory for one test; never the live handoff path.
    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!(
            "dsh-dev-handoff-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn writes_the_bytes_and_never_leaves_a_second_file() {
        let dir = temp_dir("write");
        let path = dir.join("gateway-url.private");
        write_owner_only_file(&path, b"http://127.0.0.1:1/?token=t", "test artifact")
            .expect("write");
        assert_eq!(
            std::fs::read(&path).expect("read back"),
            b"http://127.0.0.1:1/?token=t"
        );
        let entries: Vec<_> = std::fs::read_dir(&dir)
            .expect("list")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(entries.len(), 1, "only the requested path may be created");
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    /// The defect this guards: the previous `truncate(true)` open destroyed an
    /// existing unrelated file before the ACL was applied.
    #[test]
    fn never_truncates_or_replaces_an_existing_file() {
        let dir = temp_dir("existing");
        let path = dir.join("gateway-url.private");
        std::fs::write(&path, b"unrelated content").expect("seed");
        let error = write_owner_only_file(&path, b"token", "test artifact")
            .expect_err("an existing path must be refused");
        assert!(
            matches!(&error, DshError::Other { code, .. } if code == "development_handoff_exists"),
            "unexpected error: {error:?}"
        );
        assert_eq!(
            std::fs::read(&path).expect("read back"),
            b"unrelated content",
            "the existing file must be byte-identical"
        );
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn a_failed_write_removes_only_the_file_it_created() {
        let dir = temp_dir("cleanup");
        let path = dir.join("gateway-url.private");
        write_owner_only_file(&path, b"first", "test artifact").expect("first write");
        // The second attempt is refused, so the first artifact stays intact.
        assert!(write_owner_only_file(&path, b"second", "test artifact").is_err());
        assert_eq!(std::fs::read(&path).expect("read back"), b"first");
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn unix_creation_mode_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("mode");
        let path = dir.join("gateway-url.private");
        write_owner_only_file(&path, b"token", "test artifact").expect("write");
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "mode {mode:o} must be owner-only");
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[cfg(windows)]
    #[test]
    fn windows_dacl_is_the_intended_owner_only_protected_dacl() {
        let dir = temp_dir("dacl");
        let path = dir.join("gateway-url.private");
        write_owner_only_file(&path, b"token", "test artifact").expect("write");
        super::windows_dacl::assert_owner_only(&path);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    /// The handoff stays off unless the harness opts in.
    #[test]
    fn no_handoff_write_without_the_explicit_environment_request() {
        let previous_url = std::env::var_os("DSH_DESKTOP_DEV_URL_FILE");
        let previous_boot = std::env::var_os("DSH_DESKTOP_DEV_BOOT_FILE");
        std::env::remove_var("DSH_DESKTOP_DEV_URL_FILE");
        std::env::remove_var("DSH_DESKTOP_DEV_BOOT_FILE");
        let payload = BootPayload {
            injections: Vec::new(),
            stream_base_url: "http://127.0.0.1:1/stream".to_string(),
            authenticated_url: "http://127.0.0.1:1/?token=secret".to_string(),
        };
        // No file path is requested, so the payload shape is never inspected
        // and nothing is written anywhere.
        assert!(write_boot_payload(&payload).is_ok());
        if let Some(value) = previous_url {
            std::env::set_var("DSH_DESKTOP_DEV_URL_FILE", value);
        }
        if let Some(value) = previous_boot {
            std::env::set_var("DSH_DESKTOP_DEV_BOOT_FILE", value);
        }
    }
}
