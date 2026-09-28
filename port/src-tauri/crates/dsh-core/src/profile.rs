//! Initialization of the Desktop-owned profile under `$DSH_HOME`.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use crate::error::DshError;

/// Desktop's bundle layers, including the port-owned desktop bundle layer.
///
/// This intentionally extends upstream `PROFILE_TEMPLATES.web.bundles` from
/// `packages/boot/app-boot/src/profile.ts`; keep the divergence documented in
/// `port/ui/README.md` and synchronize upstream bundle changes deliberately.
///
/// The listed package is a BUNDLE, not the client plugin itself. A browser row
/// is served only when the Host resolves the row's package through "the nearest
/// ancestor manifest declaring the name" (`packages/client/modules/src/index.ts`,
/// `resolveMeta`); a package cannot declare itself, so the row lives in a bundle
/// whose manifest depends on the plugin (`packages/client/AGENTS.md`, the three
/// registration surfaces for a client plugin).
pub const DESKTOP_PROFILE_BUNDLES: &[&str] = &[
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "@dsh-port/dsh-desktop-updates-bundle",
];

const PROFILE_PATCH: &str = "# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n";
const PROFILE_WORKSPACE: &str =
    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";

/// Create Desktop profile files with the port-owned defaults without changing existing files.
///
/// @param profile - Desktop profile directory resolved from [`crate::paths::DesktopPaths`].
/// @returns success after every expected profile file exists as a regular file.
pub fn initialize_desktop_profile(profile: &Path) -> Result<(), DshError> {
    fs::create_dir_all(profile).map_err(|error| {
        DshError::io(
            "create desktop profile directory",
            Some(profile.display().to_string()),
            &error,
        )
    })?;

    let manifest = serde_json::json!({
        "name": "dsh-profile-desktop",
        "private": true,
        "dependencies": {},
        "dsh": { "profile": { "bundles": DESKTOP_PROFILE_BUNDLES } },
    });
    let manifest_contents = format!(
        "{}\n",
        serde_json::to_string_pretty(&manifest)
            .map_err(|error| { DshError::other("desktop_profile_manifest", error.to_string()) })?
    );
    create_profile_file(
        &profile.join("package.json"),
        "create desktop profile manifest",
        manifest_contents.as_bytes(),
    )?;
    create_profile_file(
        &profile.join("cordis.patch.yml"),
        "create desktop profile patch",
        PROFILE_PATCH.as_bytes(),
    )?;
    create_profile_file(
        &profile.join("pnpm-workspace.yaml"),
        "create desktop profile pnpm workspace",
        PROFILE_WORKSPACE.as_bytes(),
    )?;
    Ok(())
}

fn create_profile_file(path: &Path, operation: &str, contents: &[u8]) -> Result<(), DshError> {
    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::metadata(path).map_err(|error| {
                DshError::io(operation, Some(path.display().to_string()), &error)
            })?;
            if metadata.is_file() {
                return Ok(());
            }
            return Err(DshError::other(
                "desktop_profile_path_not_file",
                format!("{operation}: expected a regular file at {}", path.display()),
            ));
        }
        Err(error) => {
            return Err(DshError::io(
                operation,
                Some(path.display().to_string()),
                &error,
            ));
        }
    };
    file.write_all(contents)
        .map_err(|error| DshError::io(operation, Some(path.display().to_string()), &error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_desktop_profile_files_with_port_bundles() {
        let temp = tempfile::tempdir().expect("temporary home");
        let profile = temp.path().join("profiles").join("desktop");

        initialize_desktop_profile(&profile).expect("initialize profile");

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(profile.join("package.json")).expect("manifest"))
                .expect("valid manifest JSON");
        assert_eq!(manifest["name"], "dsh-profile-desktop");
        assert_eq!(manifest["private"], true);
        assert_eq!(manifest["dependencies"], serde_json::json!({}));
        assert_eq!(
            DESKTOP_PROFILE_BUNDLES,
            &[
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-web-app",
                "@dsh-port/dsh-desktop-updates-bundle",
            ]
        );
        assert_eq!(
            manifest["dsh"]["profile"]["bundles"],
            serde_json::json!(DESKTOP_PROFILE_BUNDLES)
        );
        assert_eq!(
            fs::read_to_string(profile.join("cordis.patch.yml")).expect("patch"),
            PROFILE_PATCH
        );
        assert_eq!(
            fs::read_to_string(profile.join("pnpm-workspace.yaml")).expect("workspace"),
            PROFILE_WORKSPACE
        );
    }

    #[test]
    fn preserves_existing_profile_files() {
        let temp = tempfile::tempdir().expect("temporary home");
        let profile = temp.path().join("desktop");
        fs::create_dir_all(&profile).expect("profile directory");
        let manifest = b"user plugin declarations\n";
        let patch = b"user patch\n";
        let workspace = b"user workspace settings\n";
        fs::write(profile.join("package.json"), manifest).expect("manifest");
        fs::write(profile.join("cordis.patch.yml"), patch).expect("patch");
        fs::write(profile.join("pnpm-workspace.yaml"), workspace).expect("workspace");

        initialize_desktop_profile(&profile).expect("prepare existing profile");

        assert_eq!(
            fs::read(profile.join("package.json")).expect("manifest"),
            manifest
        );
        assert_eq!(
            fs::read(profile.join("cordis.patch.yml")).expect("patch"),
            patch
        );
        assert_eq!(
            fs::read(profile.join("pnpm-workspace.yaml")).expect("workspace"),
            workspace
        );
    }

    #[test]
    fn repeated_initialization_is_idempotent() {
        let temp = tempfile::tempdir().expect("temporary home");
        let profile = temp.path().join("desktop");

        initialize_desktop_profile(&profile).expect("first initialization");
        let first: Vec<_> = ["package.json", "cordis.patch.yml", "pnpm-workspace.yaml"]
            .map(|name| fs::read(profile.join(name)).expect("profile file"))
            .into();
        initialize_desktop_profile(&profile).expect("second initialization");
        let second: Vec<_> = ["package.json", "cordis.patch.yml", "pnpm-workspace.yaml"]
            .map(|name| fs::read(profile.join(name)).expect("profile file"))
            .into();

        assert_eq!(first, second);
    }

    #[test]
    fn reports_a_file_instead_of_profile_directory() {
        let temp = tempfile::tempdir().expect("temporary home");
        let profile = temp.path().join("not-a-directory");
        fs::write(&profile, "blocking file").expect("create blocking file");

        let error =
            initialize_desktop_profile(&profile).expect_err("profile path must be a directory");

        match error {
            DshError::Io {
                operation,
                path: Some(path),
                ..
            } => {
                assert_eq!(operation, "create desktop profile directory");
                assert_eq!(path, profile.display().to_string());
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }
}
