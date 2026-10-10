//! Trusted packaged inputs for mandatory-policy checks. Loading is inert.
//!
//! The UI build records its exact inlined client version and the application
//! package's policy field. Runtime identity comes only from the upstream-format
//! desktop runtime descriptor, with release-owned package metadata consistency
//! checks. This does not verify the descriptor's file inventory or signatures.

use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::Path;

use serde_json::Value;

use crate::mandatory_update::{
    resolve_policy_config, DesktopPolicyConfig, DesktopPolicyIdentity, PolicyArch, PolicyPlatform,
};

const INPUT_LIMIT: u64 = 1024 * 1024;
// The upstream descriptor inventories the complete production dependency tree.
const DESCRIPTOR_LIMIT: u64 = 64 * 1024 * 1024;
const RELEASE_PACKAGES: [&str; 2] = ["@deepseek-ai/dsh", "@deepseek-ai/dsh-desktop-host"];

#[derive(Debug, Clone)]
pub(super) struct PackagedPolicy {
    pub config: DesktopPolicyConfig,
    pub identity: DesktopPolicyIdentity,
    pub client_version: String,
}

/// Read only shell-resolved resource paths, never a renderer-supplied path.
/// An absent policy starts no work and does not require runtime identity. Missing
/// or invalid present inputs fail instead of using environment or Cargo versions.
///
/// The bootstrap document and the runtime payload have separate roots: the shell
/// UI directory is not inside the bundled runtime directory in a packaged build.
pub(super) fn load_packaged_policy_paths(
    bootstrap_file: &Path,
    runtime_root: &Path,
) -> Result<Option<PackagedPolicy>, String> {
    load_from_paths(bootstrap_file, runtime_root, native_target())
}

fn native_target() -> Option<(PolicyPlatform, PolicyArch)> {
    let platform = match std::env::consts::OS {
        "windows" => PolicyPlatform::Win32,
        "macos" => PolicyPlatform::Darwin,
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => PolicyArch::X64,
        "aarch64" => PolicyArch::Arm64,
        _ => return None,
    };
    Some((platform, arch))
}

fn load_from_paths(
    bootstrap_file: &Path,
    runtime_root: &Path,
    target: Option<(PolicyPlatform, PolicyArch)>,
) -> Result<Option<PackagedPolicy>, String> {
    let bootstrap = read_json(bootstrap_file, INPUT_LIMIT)?;
    let bootstrap = bootstrap
        .as_object()
        .filter(|object| object.get("schemaVersion") == Some(&Value::from(1)))
        .ok_or_else(|| "desktop policy: invalid packaged bootstrap schema".to_string())?;
    let Some(config) = resolve_policy_config(bootstrap.get("dshMandatoryUpdatePolicy"), false)?
    else {
        return Ok(None);
    };
    let client_version = bootstrap
        .get("clientVersion")
        .and_then(Value::as_str)
        .filter(|version| crate::update_security::is_valid_semver(version))
        .ok_or_else(|| "desktop policy: missing or invalid packaged UI client version".to_string())?
        .to_string();
    let (platform, arch) =
        target.ok_or_else(|| "desktop policy: unsupported native target".to_string())?;
    let runtime = read_json(&runtime_root.join("desktop-runtime.json"), DESCRIPTOR_LIMIT)?;
    let version = runtime_version(&runtime, platform, arch)?;
    let identity = DesktopPolicyIdentity {
        platform,
        arch,
        bundled_dsh_version: version,
    };
    identity.validate()?;
    for name in RELEASE_PACKAGES {
        let package = read_json(
            &runtime_root
                .join("node_modules")
                .join(name)
                .join("package.json"),
            INPUT_LIMIT,
        )?;
        if package.get("name").and_then(Value::as_str) != Some(name)
            || package.get("version").and_then(Value::as_str)
                != Some(identity.bundled_dsh_version.as_str())
        {
            return Err(format!(
                "desktop policy: runtime package identity mismatch for {name}"
            ));
        }
    }
    Ok(Some(PackagedPolicy {
        config,
        identity,
        client_version,
    }))
}

fn runtime_version(
    runtime: &Value,
    platform: PolicyPlatform,
    arch: PolicyArch,
) -> Result<String, String> {
    let invalid = || "desktop policy: invalid or mismatched desktop runtime metadata".to_string();
    let expected_platform = match platform {
        PolicyPlatform::Win32 => "win32",
        PolicyPlatform::Darwin => "darwin",
    };
    let expected_arch = match arch {
        PolicyArch::X64 => "x64",
        PolicyArch::Arm64 => "arm64",
    };
    if runtime.get("schemaVersion") != Some(&Value::from(1))
        || runtime.get("platform").and_then(Value::as_str) != Some(expected_platform)
        || runtime.get("arch").and_then(Value::as_str) != Some(expected_arch)
        || !runtime.get("files").is_some_and(Value::is_array)
    {
        return Err(invalid());
    }
    let release = runtime
        .get("release")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    if release.get("schemaVersion") != Some(&Value::from(1))
        || release.get("hostProtocolVersion").and_then(Value::as_u64)
            != Some(u64::from(dsh_core::protocol::PROTOCOL_GENERATION))
    {
        return Err(invalid());
    }
    for field in ["version", "nodeVersion", "pnpmVersion"] {
        if !release
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(crate::update_security::is_valid_semver)
        {
            return Err(invalid());
        }
    }
    let version = release["version"].as_str().ok_or_else(invalid)?;
    let packages = runtime
        .get("sharedPackages")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let mut names = BTreeSet::new();
    for package in packages {
        let name = package
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        let package_version = package
            .get("version")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        if !names.insert(name)
            || !crate::update_security::is_valid_semver(package_version)
            || package.get("path").and_then(Value::as_str)
                != Some(format!("node_modules/{name}").as_str())
        {
            return Err(invalid());
        }
        if RELEASE_PACKAGES.contains(&name) && package_version != version {
            return Err(invalid());
        }
    }
    if RELEASE_PACKAGES.iter().any(|name| !names.contains(name)) {
        return Err(invalid());
    }
    Ok(version.to_string())
}

fn read_json(path: &Path, limit: u64) -> Result<Value, String> {
    let invalid = || {
        format!(
            "desktop policy: unreadable or invalid packaged input {}",
            path.display()
        )
    };
    let metadata = fs::symlink_metadata(path).map_err(|_| invalid())?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| invalid())?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() as u64 > limit {
        return Err(invalid());
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    const UI_VERSION: &str = "4.1.0-ui.2";
    const RUNTIME_VERSION: &str = "3.2.1-runtime.5";
    /// Packaged layout relative to one resource root, as the fixture builds it.
    const BOOTSTRAP_FILE: &str = "ui/desktop-policy-bootstrap.json";
    const RUNTIME_DIR: &str = "dsh";
    const RUNTIME_FILE: &str = "dsh/desktop-runtime.json";
    const TARGET: Option<(PolicyPlatform, PolicyArch)> =
        Some((PolicyPlatform::Win32, PolicyArch::X64));

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("dsh-policy-bootstrap-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            let fixture = Self(root);
            fixture.write(BOOTSTRAP_FILE, &bootstrap());
            fixture.write(RUNTIME_FILE, &descriptor());
            fixture.write("dsh/package.json", &json!({"version":"9.9.9"}));
            for name in RELEASE_PACKAGES {
                fixture.write(
                    &format!("dsh/node_modules/{name}/package.json"),
                    &json!({"name":name,"version":RUNTIME_VERSION}),
                );
            }
            assert!(
                fixture.load(TARGET).unwrap().is_some(),
                "the configured fixture must pass all input checks"
            );
            fixture
        }
        fn write(&self, relative: &str, value: &Value) {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
        }
        /// Load the fixture for an explicit native target, exercising the same
        /// production entry point the shell uses with its own resolved paths.
        fn load(
            &self,
            target: Option<(PolicyPlatform, PolicyArch)>,
        ) -> Result<Option<PackagedPolicy>, String> {
            load_from_paths(
                &self.0.join(BOOTSTRAP_FILE),
                &self.0.join(RUNTIME_DIR),
                target,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn bootstrap() -> Value {
        serde_json::from_str(include_str!(
            "../tests/fixtures/policy-bootstrap-configured.json"
        ))
        .unwrap()
    }
    fn descriptor() -> Value {
        json!({
            "schemaVersion":1, "platform":"win32", "arch":"x64", "files":[],
            "release":{"schemaVersion":1,"version":RUNTIME_VERSION,"nodeVersion":"22.20.0","pnpmVersion":"11.7.0","hostProtocolVersion":dsh_core::protocol::PROTOCOL_GENERATION},
            "sharedPackages":RELEASE_PACKAGES.map(|name| json!({"name":name,"version":RUNTIME_VERSION,"path":format!("node_modules/{name}")}))
        })
    }

    #[test]
    fn configured_fixture_keeps_ui_runtime_and_wrapper_versions_distinct() {
        let fixture = Fixture::new();
        let policy = fixture.load(TARGET).unwrap().unwrap();
        assert_eq!(policy.client_version, UI_VERSION);
        assert_eq!(policy.identity.bundled_dsh_version, RUNTIME_VERSION);
        assert_eq!(policy.config.origin.as_str(), "https://policy.example.test");
    }

    #[test]
    fn absent_policy_does_not_read_runtime_or_require_supported_target() {
        let fixture = Fixture::new();
        fixture.write(
            BOOTSTRAP_FILE,
            &json!({"schemaVersion":1,"clientVersion":null}),
        );
        fixture.write(RUNTIME_FILE, &json!("invalid runtime"));
        assert!(fixture.load(TARGET).unwrap().is_none());
        assert!(fixture.load(None).unwrap().is_none());
    }

    #[test]
    fn invalid_present_policy_is_never_absence() {
        let fixture = Fixture::new();
        for value in [
            Value::Null,
            json!(false),
            json!(""),
            json!([]),
            json!({"origin":"http://invalid.example.test"}),
        ] {
            let mut input = bootstrap();
            input["dshMandatoryUpdatePolicy"] = value;
            fixture.write(BOOTSTRAP_FILE, &input);
            assert!(fixture.load(TARGET).is_err());
        }
        let mut input = bootstrap();
        input["dshMandatoryUpdatePolicy"]["origin"] = json!("http://127.0.0.1");
        fixture.write(BOOTSTRAP_FILE, &input);
        assert!(
            fixture.load(TARGET).unwrap_err().contains("HTTPS"),
            "packaged inputs must reject the unpackaged loopback exception"
        );
    }

    #[test]
    fn configured_policy_requires_actual_ui_version_without_fallback() {
        let fixture = Fixture::new();
        for value in [Value::Null, json!(""), json!("invalid"), json!(1)] {
            let mut input = bootstrap();
            input["clientVersion"] = value;
            fixture.write(BOOTSTRAP_FILE, &input);
            assert!(fixture
                .load(TARGET)
                .unwrap_err()
                .contains("UI client version"));
        }
        let mut input = bootstrap();
        input.as_object_mut().unwrap().remove("clientVersion");
        fixture.write(BOOTSTRAP_FILE, &input);
        assert!(fixture.load(TARGET).is_err());
    }

    #[test]
    fn missing_or_corrupt_descriptor_does_not_use_wrapper_version() {
        let fixture = Fixture::new();
        let path = fixture.0.join(RUNTIME_FILE);
        fs::remove_file(&path).unwrap();
        assert!(fixture.load(TARGET).is_err());
        fs::write(&path, b"{corrupt").unwrap();
        assert!(fixture.load(TARGET).is_err());
    }

    #[test]
    fn mismatched_release_metadata_and_shared_packages_are_rejected() {
        let fixture = Fixture::new();
        for (pointer, value) in [
            ("/schemaVersion", json!(2)),
            ("/platform", json!("darwin")),
            ("/arch", json!("arm64")),
            ("/release/schemaVersion", json!(2)),
            ("/release/hostProtocolVersion", json!(999)),
            ("/release/version", json!("invalid")),
            ("/release/nodeVersion", json!("invalid")),
            ("/release/pnpmVersion", json!("invalid")),
            ("/sharedPackages/0/version", json!("7.0.0")),
            ("/sharedPackages/0/path", json!("../elsewhere")),
            ("/sharedPackages/1/name", json!("unrelated")),
            ("/files", Value::Null),
        ] {
            let mut runtime = descriptor();
            *runtime.pointer_mut(pointer).unwrap() = value;
            fixture.write(RUNTIME_FILE, &runtime);
            assert!(fixture.load(TARGET).is_err(), "accepted {pointer}");
        }
        let mut runtime = descriptor();
        runtime["sharedPackages"][1] = runtime["sharedPackages"][0].clone();
        fixture.write(RUNTIME_FILE, &runtime);
        assert!(fixture.load(TARGET).is_err());
    }

    #[test]
    fn actual_release_owned_package_mismatch_is_rejected() {
        let fixture = Fixture::new();
        fixture.write(
            "dsh/node_modules/@deepseek-ai/dsh/package.json",
            &json!({"name":"@deepseek-ai/dsh","version":"7.0.0"}),
        );
        assert!(fixture
            .load(TARGET)
            .unwrap_err()
            .contains("package identity mismatch"));
    }

    #[test]
    fn invalid_bootstrap_and_non_regular_or_oversized_resources_are_rejected() {
        let fixture = Fixture::new();
        for value in [json!([]), json!({"schemaVersion":2}), Value::Null] {
            fixture.write(BOOTSTRAP_FILE, &value);
            assert!(fixture.load(TARGET).is_err());
        }
        let path = fixture.0.join(BOOTSTRAP_FILE);
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(fixture.load(TARGET).is_err());
        fs::remove_dir(&path).unwrap();
        fs::write(&path, vec![b' '; INPUT_LIMIT as usize + 1]).unwrap();
        assert!(fixture.load(TARGET).is_err());
    }

    #[test]
    fn configured_policy_cannot_run_on_an_unsupported_native_target() {
        let fixture = Fixture::new();
        assert!(fixture
            .load(None)
            .unwrap_err()
            .contains("unsupported native target"));
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        assert_eq!(native_target(), TARGET);
        // The public loader uses compiled native target facts, not environment selectors.
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        assert!(load_packaged_policy_paths(
            &fixture.0.join(BOOTSTRAP_FILE),
            &fixture.0.join(RUNTIME_DIR),
        )
        .unwrap()
        .is_some());
    }
}
