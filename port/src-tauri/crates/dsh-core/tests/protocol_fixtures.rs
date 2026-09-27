//! Canonical protocol fixtures (`port/fixtures/protocol/*.json`) are the
//! lockstep contract with the TypeScript mirror
//! (`port/ui/src/desktop-bridge/protocol.ts`, asserted by `port/ui/tests/protocol.spec.ts`).
//!
//! Naming (contract amendments A7/A8): `<type-name-kebab>.json`, one canonical
//! wire form per file, with variant arms in their own file where the lead
//! designated one (e.g. `picked-directory.null.json`,
//! `desktop-shortcut-input.<kind>.json`). Struct types hold one object; closed
//! unions/enum types hold the array of every variant. Each file must round-trip
//! **byte-identically** through the Rust types: compact JSON, struct field
//! order, `null` where the field is always emitted. Hard rule (A8): a type
//! upstream declares never absorbs fields the port invented.
//!
//! Fixtures are plain data; any token-like value is a fixture-only literal.

use std::fmt::Debug;
use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::Serialize;

use dsh_core::error::DshError;
use dsh_core::protocol::*;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join("fixtures")
        .join("protocol")
        .join(name)
}

/// Deserialize, re-serialize, and require byte-identical output.
fn round_trip<T>(name: &str)
where
    T: Serialize + DeserializeOwned + PartialEq + Debug,
{
    let path = fixture_path(name);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let expected = raw.trim_end();
    let value: T = serde_json::from_str(expected)
        .unwrap_or_else(|e| panic!("{name}: fixture does not deserialize: {e}"));
    let encoded = serde_json::to_string(&value).expect("serialize");
    assert_eq!(encoded, expected, "{name}: round-trip must be byte-identical");
    let again: T = serde_json::from_str(&encoded).expect("deserialize");
    assert_eq!(again, value, "{name}: round-trip must be stable");
}

/// The complete claimed set; the claim test requires exact equality so neither
/// side can leave an unclaimed or missing file behind.
const CLAIMED: &[(&str, &str)] = &[
    ("app-info.json", "AppInfo"),
    ("appearance.json", "Appearance"),
    ("boot-payload.json", "BootPayload"),
    ("clipboard-text.json", "ClipboardText"),
    ("credential-presence.json", "CredentialPresence"),
    ("credential-ref.json", "CredentialRef"),
    ("credential-store-request.json", "CredentialStoreRequest"),
    ("desktop-shortcut-input.keyboard.json", "DesktopShortcutInput"),
    ("desktop-shortcut-input.iframe.json", "DesktopShortcutInput"),
    ("desktop-shortcut-input.menu.json", "DesktopShortcutInput"),
    ("desktop-shortcut-input.webview.json", "DesktopShortcutInput"),
    ("desktop-update-presentation.json", "DesktopUpdatePresentation"),
    ("dsh-error.json", "DshError[]"),
    ("index-injection.json", "IndexInjection[]"),
    ("locale-apply-request.json", "LocaleApplyRequest"),
    ("locale-set-request.json", "LocaleSetRequest"),
    ("locale-state.json", "LocaleState"),
    ("menu-action-id.json", "MenuActionId[]"),
    ("onboarding-set-active-request.json", "OnboardingSetActiveRequest"),
    ("pick-directory-request.json", "PickDirectoryRequest"),
    ("picked-directory.json", "PickedDirectory"),
    ("picked-directory.null.json", "PickedDirectory"),
    ("quit-inspection.json", "QuitInspection"),
    ("runtime-status.json", "RuntimeStatus"),
    ("setting-value.json", "SettingValue[]"),
    ("settings-map.json", "SettingsMap"),
    ("shortcut-binding.json", "ShortcutBinding"),
    ("shortcut-binding-row.json", "ShortcutBindingRow"),
    ("shortcut-config-snapshot.json", "ShortcutConfigSnapshot"),
    ("shortcut-definition.json", "ShortcutDefinition"),
    ("shortcut-document.json", "ShortcutDocument"),
    ("shortcut-edit.json", "ShortcutEdit[]"),
    ("shortcut-save-result.json", "ShortcutSaveResult"),
    ("shell-close-window-request.json", "ShellCloseWindowRequest"),
    ("shortcuts-changed-event.json", "ShortcutsChangedEvent"),
    ("shortcuts-edit-request.json", "ShortcutsEditRequest"),
    ("shortcuts-get-request.json", "ShortcutsGetRequest"),
    ("shortcuts-recording-event.json", "ShortcutsRecordingEvent"),
    ("shortcuts-recording-request.json", "ShortcutsRecordingRequest"),
    ("shell-window-event.json", "ShellWindowEvent"),
    ("shell-quit-confirmed-event.json", "ShellQuitConfirmedEvent"),
];

#[test]
fn dsh_error_round_trips_all_variants() {
    round_trip::<Vec<DshError>>("dsh-error.json");
}

#[test]
fn index_injection_round_trips_every_row_kind() {
    round_trip::<Vec<IndexInjection>>("index-injection.json");
}

#[test]
fn update_presentation_round_trips() {
    round_trip::<DesktopUpdatePresentation>("desktop-update-presentation.json");
}

#[test]
fn identity_payloads_round_trip() {
    round_trip::<AppInfo>("app-info.json");
    round_trip::<LocaleState>("locale-state.json");
    round_trip::<Appearance>("appearance.json");
}

#[test]
fn runtime_payloads_round_trip() {
    round_trip::<BootPayload>("boot-payload.json");
    round_trip::<RuntimeStatus>("runtime-status.json");
    round_trip::<QuitInspection>("quit-inspection.json");
}

#[test]
fn settings_and_credentials_round_trip() {
    round_trip::<Vec<SettingValue>>("setting-value.json");
    round_trip::<SettingsMap>("settings-map.json");
    round_trip::<CredentialRef>("credential-ref.json");
    round_trip::<CredentialPresence>("credential-presence.json");
    round_trip::<CredentialStoreRequest>("credential-store-request.json");
}

#[test]
fn shell_io_payloads_round_trip() {
    round_trip::<ClipboardText>("clipboard-text.json");
    round_trip::<PickedDirectory>("picked-directory.json");
    round_trip::<PickedDirectory>("picked-directory.null.json");
    round_trip::<PickDirectoryRequest>("pick-directory-request.json");
}

#[test]
fn shortcut_types_round_trip() {
    round_trip::<ShortcutBinding>("shortcut-binding.json");
    round_trip::<ShortcutBindingRow>("shortcut-binding-row.json");
    round_trip::<ShortcutDocument>("shortcut-document.json");
    round_trip::<ShortcutDefinition>("shortcut-definition.json");
    round_trip::<ShortcutConfigSnapshot>("shortcut-config-snapshot.json");
    round_trip::<ShortcutSaveResult>("shortcut-save-result.json");
    round_trip::<Vec<ShortcutEdit>>("shortcut-edit.json");
}

#[test]
fn request_shapes_round_trip() {
    round_trip::<LocaleSetRequest>("locale-set-request.json");
    round_trip::<LocaleApplyRequest>("locale-apply-request.json");
    round_trip::<ShortcutsGetRequest>("shortcuts-get-request.json");
    round_trip::<ShortcutsEditRequest>("shortcuts-edit-request.json");
    round_trip::<ShortcutsRecordingRequest>("shortcuts-recording-request.json");
    round_trip::<ShellCloseWindowRequest>("shell-close-window-request.json");
    round_trip::<OnboardingSetActiveRequest>("onboarding-set-active-request.json");
}

#[test]
fn event_payloads_round_trip() {
    // A8 hard rule: `DesktopShortcutInput` is upstream's exact shape — no
    // `commandId`, no menu fields; menu dispatch lives in `ShortcutsMenuEvent`.
    for name in [
        "desktop-shortcut-input.keyboard.json",
        "desktop-shortcut-input.iframe.json",
        "desktop-shortcut-input.menu.json",
        "desktop-shortcut-input.webview.json",
    ] {
        round_trip::<DesktopShortcutInput>(name);
    }
    round_trip::<ShortcutsChangedEvent>("shortcuts-changed-event.json");
    round_trip::<ShortcutsRecordingEvent>("shortcuts-recording-event.json");
    round_trip::<ShellWindowEvent>("shell-window-event.json");
    round_trip::<ShellQuitConfirmedEvent>("shell-quit-confirmed-event.json");
}

#[test]
fn menu_action_id_round_trips_every_value() {
    round_trip::<Vec<MenuActionId>>("menu-action-id.json");
}

#[test]
fn every_fixture_file_is_claimed_with_its_type_name() {
    let directory = fixture_path("");
    let mut unclaimed: Vec<String> = std::fs::read_dir(&directory)
        .unwrap_or_else(|e| panic!("cannot list {}: {e}", directory.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".json"))
        .collect();
    unclaimed.sort();
    let mut claimed: Vec<String> = CLAIMED.iter().map(|(file, _)| (*file).to_string()).collect();
    claimed.sort();
    assert_eq!(
        unclaimed, claimed,
        "fixture set must exactly match the claimed type-named set"
    );
}
