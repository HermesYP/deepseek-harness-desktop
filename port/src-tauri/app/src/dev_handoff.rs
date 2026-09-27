//! Opt-in development handoff for assembled acceptance tests; never enabled by default.

use std::path::PathBuf;

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

fn write_owner_only_file(
    path: &std::path::Path,
    bytes: &[u8],
    label: &str,
) -> Result<(), DshError> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| {
        DshError::io(
            format!("write {label}"),
            Some(path.display().to_string()),
            &error,
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| {
                DshError::io(
                    format!("secure {label}"),
                    Some(path.display().to_string()),
                    &error,
                )
            })?;
    }
    #[cfg(windows)]
    restrict_to_owner(path)?;
    use std::io::Write;
    file.write_all(bytes).map_err(|error| {
        DshError::io(
            format!("write {label}"),
            Some(path.display().to_string()),
            &error,
        )
    })?;
    file.flush().map_err(|error| {
        DshError::io(
            format!("flush {label}"),
            Some(path.display().to_string()),
            &error,
        )
    })
}

#[cfg(windows)]
fn restrict_to_owner(path: &std::path::Path) -> Result<(), DshError> {
    use std::process::{Command, Stdio};

    let system_root = std::env::var_os("SystemRoot").ok_or_else(|| {
        DshError::other(
            "secure_development_url",
            "SystemRoot is unavailable for ACL setup",
        )
    })?;
    let icacls = PathBuf::from(system_root)
        .join("System32")
        .join("icacls.exe");
    let status = Command::new(icacls)
        .arg(path)
        .args(["/inheritance:r", "/grant:r", "*S-1-3-4:(F)"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| {
            DshError::io(
                "secure development gateway URL",
                Some(path.display().to_string()),
                &error,
            )
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(DshError::other(
            "secure_development_url",
            "Windows refused to restrict the development gateway URL file to its owner.",
        ))
    }
}
