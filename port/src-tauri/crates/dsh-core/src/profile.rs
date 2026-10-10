//! Initialization of the Desktop-owned profile under `$DSH_HOME`.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use fs4::fs_std::FileExt;

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

/// Upgrade the Desktop-owned manifest's required bundle declarations without
/// rewriting dependency declarations, unknown fields, patch or workspace files.
/// A byte-for-byte recovery backup is published before an atomic replacement.
/// Invalid/foreign manifests and concurrent edits fail closed and remain intact.
/// Session files and Harness-managed migrations are deliberately not touched.
pub fn migrate_desktop_profile(profile: &Path) -> Result<(), DshError> {
    let manifest_path = profile.join("package.json");
    let lock_path = profile.join(".desktop-profile-migration.lock");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| {
            DshError::io(
                "open profile migration lock",
                Some(lock_path.display().to_string()),
                &error,
            )
        })?;
    lock.try_lock_exclusive().map_err(|error| {
        DshError::io(
            "acquire profile migration lock",
            Some(lock_path.display().to_string()),
            &error,
        )
    })?;

    let metadata = fs::symlink_metadata(&manifest_path).map_err(|error| {
        DshError::io(
            "inspect desktop profile manifest",
            Some(manifest_path.display().to_string()),
            &error,
        )
    })?;
    if !metadata.file_type().is_file() || metadata.len() > 8 * 1024 * 1024 {
        return Err(DshError::other(
            "desktop_profile_migration",
            "The desktop profile manifest must be a regular file of at most 8 MiB.",
        ));
    }
    let original = fs::read(&manifest_path).map_err(|error| {
        DshError::io(
            "read desktop profile manifest",
            Some(manifest_path.display().to_string()),
            &error,
        )
    })?;
    let mut manifest: serde_json::Value = serde_json::from_slice(&original).map_err(|_| {
        DshError::other(
            "desktop_profile_migration",
            "The existing desktop profile manifest is not valid JSON; it was not changed.",
        )
    })?;
    if manifest.get("name").and_then(serde_json::Value::as_str) != Some("dsh-profile-desktop") {
        return Err(DshError::other(
            "desktop_profile_migration",
            "The existing manifest is not a Desktop-owned profile; it was not changed.",
        ));
    }
    let bundles = manifest
        .pointer_mut("/dsh/profile/bundles")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| {
            DshError::other(
                "desktop_profile_migration",
                "The desktop profile bundle list is invalid; the manifest was not changed.",
            )
        })?;
    if !bundles.iter().all(serde_json::Value::is_string) {
        return Err(DshError::other("desktop_profile_migration", "The desktop profile bundle list must contain package names; the manifest was not changed."));
    }
    let mut changed = false;
    for (required_index, required) in DESKTOP_PROFILE_BUNDLES.iter().enumerate() {
        if bundles.iter().any(|entry| entry.as_str() == Some(required)) {
            continue;
        }
        // Never reorder existing layers. Place missing defaults in dependency
        // order among existing first-party layers; normally this also places
        // them before custom layers. The final user patch is never changed.
        let rank = |entry: &serde_json::Value| {
            DESKTOP_PROFILE_BUNDLES
                .iter()
                .position(|name| entry.as_str() == Some(name))
        };
        let index = bundles
            .iter()
            .position(|entry| rank(entry).is_some_and(|rank| rank > required_index))
            .unwrap_or_else(|| {
                bundles
                    .iter()
                    .rposition(|entry| rank(entry).is_some_and(|rank| rank < required_index))
                    .map_or(0, |index| index + 1)
            });
        bundles.insert(index, serde_json::Value::String((*required).to_owned()));
        changed = true;
    }
    if !changed {
        return Ok(());
    }
    let updated = format!(
        "{}\n",
        serde_json::to_string_pretty(&manifest)
            .map_err(|error| { DshError::other("desktop_profile_migration", error.to_string()) })?
    );
    let backup_path = profile.join(format!(
        ".package.json.desktop-migration-{}.bak",
        uuid::Uuid::new_v4()
    ));
    let mut backup_options = OpenOptions::new();
    backup_options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        backup_options.mode(0o600);
    }
    let mut backup = backup_options.open(&backup_path).map_err(|error| {
        DshError::io(
            "create desktop profile recovery backup",
            Some(backup_path.display().to_string()),
            &error,
        )
    })?;
    backup
        .write_all(&original)
        .and_then(|()| backup.sync_all())
        .map_err(|error| {
            DshError::io(
                "flush desktop profile recovery backup",
                Some(backup_path.display().to_string()),
                &error,
            )
        })?;
    drop(backup);
    if fs::read(&manifest_path).map_err(|error| {
        DshError::io(
            "recheck desktop profile manifest",
            Some(manifest_path.display().to_string()),
            &error,
        )
    })? != original
    {
        return Err(DshError::other("desktop_profile_migration", "The profile was edited during migration; it was not replaced. Retry after the edit completes."));
    }
    crate::settings::write_atomic(&manifest_path, &updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migration_backups(profile: &Path) -> Vec<std::path::PathBuf> {
        fs::read_dir(profile)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".package.json.desktop-migration-")
            })
            .collect()
    }

    #[test]
    fn migrates_old_desktop_profile_preserving_customizations_and_exact_backup() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path();
        let original = r#"{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {"custom-plugin": "1.2.3"},
  "custom-field": {"preserve": true},
  "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "custom-bundle", "second-custom-bundle"], "other": 7}}
}"#;
        fs::write(profile.join("package.json"), original).unwrap();
        fs::write(
            profile.join("cordis.patch.yml"),
            "- id: dsh-port-ui-updates\n  disabled: true\n",
        )
        .unwrap();
        fs::write(profile.join("pnpm-workspace.yaml"), "user settings\n").unwrap();
        migrate_desktop_profile(profile).unwrap();
        let updated: serde_json::Value =
            serde_json::from_slice(&fs::read(profile.join("package.json")).unwrap()).unwrap();
        assert_eq!(
            updated["dependencies"],
            serde_json::json!({"custom-plugin": "1.2.3"})
        );
        assert_eq!(updated["custom-field"]["preserve"], true);
        assert_eq!(updated["dsh"]["profile"]["other"], 7);
        assert_eq!(
            updated["dsh"]["profile"]["bundles"],
            serde_json::json!([
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-web-app",
                "@dsh-port/dsh-desktop-updates-bundle",
                "custom-bundle",
                "second-custom-bundle"
            ])
        );
        assert_eq!(
            fs::read_to_string(profile.join("cordis.patch.yml")).unwrap(),
            "- id: dsh-port-ui-updates\n  disabled: true\n"
        );
        assert_eq!(
            fs::read_to_string(profile.join("pnpm-workspace.yaml")).unwrap(),
            "user settings\n"
        );
        let backups = migration_backups(profile);
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read(&backups[0]).unwrap(), original.as_bytes());
        let first = fs::read(profile.join("package.json")).unwrap();
        migrate_desktop_profile(profile).unwrap();
        assert_eq!(fs::read(profile.join("package.json")).unwrap(), first);
        assert_eq!(migration_backups(profile).len(), 1);
    }

    #[test]
    fn migrates_missing_defaults_in_dependency_order() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("package.json"), r#"{"name":"dsh-profile-desktop","dsh":{"profile":{"bundles":["@deepseek-ai/dsh-web-app","custom"]}}}"#).unwrap();
        migrate_desktop_profile(temp.path()).unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.path().join("package.json")).unwrap()).unwrap();
        assert_eq!(
            value["dsh"]["profile"]["bundles"],
            serde_json::json!([
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-web-app",
                "@dsh-port/dsh-desktop-updates-bundle",
                "custom"
            ])
        );
    }

    #[test]
    fn invalid_or_foreign_profile_is_never_replaced() {
        for original in [
            "not JSON",
            r#"{"name":"user-profile","dsh":{"profile":{"bundles":[]}}}"#,
            r#"{"name":"dsh-profile-desktop","dsh":{"profile":{"bundles":{}}}}"#,
            r#"{"name":"dsh-profile-desktop","dsh":{"profile":{"bundles":[42]}}}"#,
        ] {
            let temp = tempfile::tempdir().unwrap();
            fs::write(temp.path().join("package.json"), original).unwrap();
            assert!(migrate_desktop_profile(temp.path()).is_err());
            assert_eq!(
                fs::read(temp.path().join("package.json")).unwrap(),
                original.as_bytes()
            );
            assert!(migration_backups(temp.path()).is_empty());
        }
    }

    #[test]
    fn current_profile_needs_no_recovery_backup() {
        let temp = tempfile::tempdir().unwrap();
        initialize_desktop_profile(temp.path()).unwrap();
        let original = fs::read(temp.path().join("package.json")).unwrap();
        migrate_desktop_profile(temp.path()).unwrap();
        assert_eq!(
            fs::read(temp.path().join("package.json")).unwrap(),
            original
        );
        assert!(migration_backups(temp.path()).is_empty());
    }

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
