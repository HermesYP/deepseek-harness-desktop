//! Standalone release regression for the shared development-handoff caller boundary.
//! Compile this file as an optimized executable with debug assertions disabled.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const URL_FILE: &str = "DSH_DESKTOP_DEV_URL_FILE";
const BOOT_FILE: &str = "DSH_DESKTOP_DEV_BOOT_FILE";
#[cfg(debug_assertions)]
const SYNTHETIC_BYTES: &[u8] = b"synthetic release handoff regression data";

#[allow(unused)]
#[path = "../../src/dev_handoff_boundary.rs"]
mod dev_handoff_boundary;

fn scratch_dir() -> PathBuf {
    let ticks = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "dsh-release-handoff-regression-{}-{ticks}",
        std::process::id()
    ));
    std::fs::create_dir(&path).expect("create unique owned regression directory");
    path
}

// Exercise the same shared compile-time boundary used by the two production
// callers. Inputs and bytes are synthetic; no session material is read.
fn gateway_url_caller() -> Result<(), String> {
    crate::dsh_debug_handoff! {
        if let Some(path) = std::env::var_os(URL_FILE) {
            std::fs::write(path, SYNTHETIC_BYTES)
                .map_err(|error| format!("startup handoff failure: {}", error.kind()))?;
        }
    };
    Ok(())
}

fn boot_payload_caller() -> Result<(), String> {
    crate::dsh_debug_handoff! {
        if std::env::var_os(URL_FILE).is_some() {
            if let Some(path) = std::env::var_os(BOOT_FILE) {
                std::fs::write(path, SYNTHETIC_BYTES)
                    .map_err(|error| format!("boot handoff failure: {}", error.kind()))?;
            }
        }
    };
    Ok(())
}

fn main() {
    if cfg!(debug_assertions) {
        eprintln!("FAIL: this regression must be compiled in Release mode");
        std::process::exit(2);
    }

    let root = scratch_dir();
    let url_path = root.join("gateway-url.synthetic");
    let boot_path = root.join("boot-payload.synthetic");
    std::env::set_var(URL_FILE, &url_path);
    std::env::set_var(BOOT_FILE, &boot_path);

    let mut failures = Vec::new();
    let url_result = gateway_url_caller();
    let boot_result = boot_payload_caller();
    if url_path.exists() {
        failures.push("DSH_DESKTOP_DEV_URL_FILE created an artifact".to_string());
    }
    if boot_path.exists() {
        failures.push("DSH_DESKTOP_DEV_BOOT_FILE created an artifact".to_string());
    }
    if url_result.is_err() {
        failures.push("gateway URL handoff introduced a startup error".to_string());
    }
    if boot_result.is_err() {
        failures.push("boot-payload handoff introduced a startup error".to_string());
    }

    // Force each operation to fail if it is still reachable. Release callers
    // must ignore both variables entirely, rather than report a handoff failure.
    let missing_parent = root.join("absent-parent");
    std::env::set_var(URL_FILE, missing_parent.join("gateway-url.synthetic"));
    std::env::set_var(BOOT_FILE, missing_parent.join("boot-payload.synthetic"));
    if gateway_url_caller().is_err() {
        failures.push("gateway URL env var still affects startup failure handling".to_string());
    }
    if boot_payload_caller().is_err() {
        failures.push("boot-payload env var still affects startup failure handling".to_string());
    }
    if missing_parent.exists() {
        failures.push("handoff created an unexpected parent directory".to_string());
    }

    if failures.is_empty() {
        println!("PASS: release handoff boundary ignored both synthetic environment variables");
    } else {
        for failure in &failures {
            eprintln!("FAIL: {failure}");
        }
        eprintln!("PROBE_ROOT={}", root.display());
        std::process::exit(1);
    }
}
