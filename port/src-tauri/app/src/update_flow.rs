//! Update presentation and installation (`update-presentation.ts` semantics,
//! main-process-owned confirmation: product documents cannot choose artifacts
//! or authorise installation).
//!
//! The feed is an https manifest configured at `updates.feed-url`:
//! `{"version": "0.1.8", "url": "https://…/DeepSeek-Harness-Setup.exe", "sha256": "…"}`.
//! Only a strictly greater version is accepted (upstream "clients only accept a
//! greater version"). Failures are classified in-band (`DesktopUpdateFailureKind`),
//! never as raw updater diagnostics.

use std::path::PathBuf;

use dsh_core::error::DshError;
use dsh_core::protocol::{
    DesktopUpdateOperation, DesktopUpdatePhase, DesktopUpdatePreparationFailureKind,
    DesktopUpdatePresentation, DesktopUpdateState,
};
use dsh_runtime::control::UpdateTasksAction;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::state::{
    format_message, AppState, UPDATE_CHANNEL_KEY, UPDATE_FEED_BETA_KEY, UPDATE_FEED_KEY,
};

/// Stable reuses the original feed key; beta has an isolated feed key.
/// Missing or invalid channel preferences safely default to stable.
fn channel_feed_key(value: Option<&dsh_core::protocol::SettingValue>) -> &'static str {
    match value {
        Some(dsh_core::protocol::SettingValue::String(channel)) if channel == "beta" => {
            UPDATE_FEED_BETA_KEY
        }
        _ => UPDATE_FEED_KEY,
    }
}

fn no_feed_message(channel: Option<&dsh_core::protocol::SettingValue>) -> String {
    format!(
        "no update feed is configured (settings key `{}`)",
        channel_feed_key(channel)
    )
}

fn configured_feed(
    channel: Option<&dsh_core::protocol::SettingValue>,
    stable: Option<&dsh_core::protocol::SettingValue>,
    beta: Option<&dsh_core::protocol::SettingValue>,
) -> Option<String> {
    let value = match channel_feed_key(channel) {
        UPDATE_FEED_BETA_KEY => beta,
        _ => stable,
    }?;
    match value {
        dsh_core::protocol::SettingValue::String(url) if !url.trim().is_empty() => {
            Some(url.clone())
        }
        _ => None,
    }
}

#[derive(serde::Deserialize, Debug)]
struct UpdateManifest {
    version: String,
    url: String,
    #[serde(default)]
    sha256: Option<String>,
}

fn publish(app: &tauri::AppHandle, state: &DesktopUpdateState) -> DesktopUpdatePresentation {
    let presentation = crate::commands::present_update(state);
    app.emit("dsh://update/state", &presentation).ok();
    presentation
}

async fn with_state<F, T>(app: &tauri::AppHandle, f: F) -> T
where
    F: FnOnce(&mut crate::state::UpdateService) -> T,
{
    let state = app.state::<std::sync::Arc<AppState>>();
    let mut update = state.update.lock().await;
    f(&mut update)
}

/// `update_check`: consult the feed and present the result. Idempotent.
pub async fn check(app: &tauri::AppHandle) -> Result<DesktopUpdatePresentation, DshError> {
    let state = app.state::<std::sync::Arc<AppState>>();
    let feed_url = {
        let settings = state.settings.lock().await;
        let channel = settings.get(UPDATE_CHANNEL_KEY)?;
        let stable = settings.get(UPDATE_FEED_KEY)?;
        let beta = settings.get(UPDATE_FEED_BETA_KEY)?;
        match configured_feed(channel, stable, beta) {
            Some(url) => url,
            None => {
                let presentation = fail(
                    app,
                    DesktopUpdateOperation::Check,
                    &no_feed_message(channel),
                )
                .await;
                return Ok(presentation);
            }
        }
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| DshError::other("update_client", e.to_string()))?;
    with_state(app, |update| {
        update.state.phase = DesktopUpdatePhase::Checking;
        update.state.failed_operation = None;
        update.state.message = None;
    })
    .await;
    publish(app, &current(app).await);
    let response = client.get(&feed_url).send().await;
    let manifest = match response {
        Ok(response) => parse_feed_response(response).await,
        Err(error) => Err(format!("update feed request failed: {error}")),
    };
    match manifest {
        Ok(manifest) if parse_semver(&manifest.version).is_none() => {
            let presentation = fail(
                app,
                DesktopUpdateOperation::Check,
                "invalid update feed response: version is not valid SemVer",
            )
            .await;
            Ok(presentation)
        }
        Ok(manifest) if greater_version(&manifest.version, env!("CARGO_PKG_VERSION")) => {
            with_state(app, |update| {
                update.state.phase = DesktopUpdatePhase::Available;
                update.state.version = Some(manifest.version.clone());
                update.downloaded_version = Some(manifest.version);
                update.state.technical_details = Some(manifest.url.clone());
                update.state.message = Some(manifest.sha256.clone().unwrap_or_default());
            })
            .await;
            let presentation = publish(app, &current(app).await);
            open_confirmation(app).await?;
            Ok(presentation)
        }
        Ok(_) => {
            with_state(app, |update| {
                update.state.phase = DesktopUpdatePhase::Idle;
                update.state.version = Some(env!("CARGO_PKG_VERSION").to_string());
            })
            .await;
            let state_now = current(app).await;
            let presentation = publish(app, &state_now);
            let messages = crate::state::messages(state.locale.lock().await.snapshot().effective);
            app.dialog()
                .message(format_message(
                    messages.update_current,
                    &[("version", env!("CARGO_PKG_VERSION"))],
                ))
                .title(messages.update_title)
                .buttons(tauri_plugin_dialog::MessageDialogButtons::Ok)
                .blocking_show();
            Ok(presentation)
        }
        Err(error) => {
            let presentation = fail(app, DesktopUpdateOperation::Check, &error.to_string()).await;
            Ok(presentation)
        }
    }
}

async fn current(app: &tauri::AppHandle) -> DesktopUpdateState {
    with_state(app, |update| update.state.clone()).await
}

async fn fail(
    app: &tauri::AppHandle,
    operation: DesktopUpdateOperation,
    message: &str,
) -> DesktopUpdatePresentation {
    with_state(app, |update| {
        update.state.phase = DesktopUpdatePhase::Error;
        update.state.failed_operation = Some(operation);
        update.state.message = Some(message.to_string());
    })
    .await;
    publish(app, &current(app).await)
}

/// `update_open`: the main-process-owned confirmation. With a downloaded
/// update it is the Install-and-Restart confirmation; otherwise it opens the
/// check-and-download flow.
pub async fn open_confirmation(app: &tauri::AppHandle) -> Result<(), DshError> {
    let state = app.state::<std::sync::Arc<AppState>>();
    let (phase, version) = {
        let update = state.update.lock().await;
        (update.state.phase, update.state.version.clone())
    };
    match phase {
        DesktopUpdatePhase::Ready => confirm_install(app, version.unwrap_or_default()).await,
        DesktopUpdatePhase::Available | DesktopUpdatePhase::Error | DesktopUpdatePhase::Idle => {
            if phase == DesktopUpdatePhase::Available {
                let messages =
                    crate::state::messages(state.locale.lock().await.snapshot().effective);
                let install = messages.update_download.to_string();
                let later = messages.later.to_string();
                let proceed = app
                    .dialog()
                    .message(format_message(
                        &format!(
                            "{}\n\n{}",
                            messages.update_available, messages.update_detail
                        ),
                        &[("version", version.as_deref().unwrap_or_default())],
                    ))
                    .title(messages.update_title)
                    .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                        install, later,
                    ))
                    .blocking_show();
                if proceed {
                    download(app).await?;
                }
            } else {
                // Boxed: `check` → `open_confirmation` → `check` is mutual
                // recursion across async fns.
                Box::pin(check(app)).await?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

async fn download(app: &tauri::AppHandle) -> Result<(), DshError> {
    let state = app.state::<std::sync::Arc<AppState>>();
    let (url, expected_sha) = {
        let update = state.update.lock().await;
        (
            update.state.technical_details.clone().unwrap_or_default(),
            update.state.message.clone().unwrap_or_default(),
        )
    };
    with_state(app, |update| {
        update.state.phase = DesktopUpdatePhase::Downloading;
        update.state.percent = Some(0.0);
    })
    .await;
    publish(app, &current(app).await);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| DshError::other("update_client", e.to_string()))?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            let _ = e;
            DshError::other("update_download", "download failed")
        })?
        .error_for_status()
        .map_err(|e| DshError::other("update_download", e.to_string()))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| DshError::other("update_download", e.to_string()))?;
    with_state(app, |update| {
        update.state.phase = DesktopUpdatePhase::Verifying;
    })
    .await;
    publish(app, &current(app).await);
    if !expected_sha.is_empty() {
        use sha2::Digest;
        let digest = sha2::Sha256::digest(&bytes);
        let actual = digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if !actual.eq_ignore_ascii_case(&expected_sha) {
            let presentation = fail(
                app,
                DesktopUpdateOperation::Download,
                "the downloaded update failed SHA-256 verification",
            )
            .await;
            let _ = presentation;
            return Err(DshError::other("update_verify", "sha256 mismatch"));
        }
    }
    let cache = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("dsh-desktop-updater");
    std::fs::create_dir_all(&cache).map_err(|e| {
        DshError::io(
            "create updater cache",
            Some(cache.display().to_string()),
            &e,
        )
    })?;
    let target = cache.join(format!("update-{}.bin", std::process::id()));
    std::fs::write(&target, &bytes)
        .map_err(|e| DshError::io("write update", Some(target.display().to_string()), &e))?;
    let version = with_state(app, |update| {
        update.downloaded = Some(target.clone());
        update.downloaded_version.clone()
    })
    .await;
    with_state(app, |update| {
        update.state.phase = DesktopUpdatePhase::Ready;
        update.state.percent = Some(100.0);
    })
    .await;
    publish(app, &current(app).await);
    confirm_install(app, version.unwrap_or_default()).await
}

/// The Windows Install-and-Restart confirmation (upstream `desktopUpdateReadyConfirmation`).
async fn confirm_install(app: &tauri::AppHandle, version: String) -> Result<(), DshError> {
    let state = app.state::<std::sync::Arc<AppState>>();
    let messages = {
        let model = state.locale.lock().await;
        crate::state::messages(model.snapshot().effective)
    };
    let install_label = messages.install_and_restart.to_string();
    let later = messages.later.to_string();
    let proceed = app
        .dialog()
        .message(format_message(
            &format!(
                "{}\n\n{}",
                if cfg!(windows) {
                    messages.update_downloaded_title_windows
                } else {
                    messages.update_available
                },
                if cfg!(windows) {
                    messages.update_downloaded_detail_windows
                } else {
                    messages.update_detail
                }
            ),
            &[("version", &version)],
        ))
        .title(messages.update_title)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
            install_label,
            later,
        ))
        .blocking_show();
    if !proceed {
        return Ok(());
    }
    install(app).await
}

/// Installation admission (lifecycle protocol `update-tasks`): `lock` refuses
/// new API requests and drains admitted ones, then re-checks tasks. Unknown
/// task state refuses installation.
async fn install(app: &tauri::AppHandle) -> Result<(), DshError> {
    let state = app.state::<std::sync::Arc<AppState>>();
    let active = state
        .supervisor
        .update_tasks(UpdateTasksAction::Lock)
        .await
        .map_err(|_| DshError::other("update_tasks_unavailable", "task status is unavailable"))?;
    if active {
        let messages = crate::state::messages(state.locale.lock().await.snapshot().effective);
        let stop = messages.update_stop_tasks.to_string();
        let cancel = messages.cancel.to_string();
        let proceed = app
            .dialog()
            .message(format!(
                "{}\n\n{}",
                messages.update_active_tasks, messages.update_active_tasks_detail
            ))
            .title(messages.update_title)
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                stop, cancel,
            ))
            .blocking_show();
        if !proceed {
            let _ = state
                .supervisor
                .update_tasks(UpdateTasksAction::Unlock)
                .await;
            return Ok(());
        }
    }
    // The handoff refuses after a forced kill, non-zero exit, or missing
    // `shutdown-complete` (upstream `requireGraceful`).
    with_state(app, |update| {
        update.state.phase = DesktopUpdatePhase::Installing;
    })
    .await;
    publish(app, &current(app).await);
    if let Err(error) = state.supervisor.stop(true).await {
        with_state(app, |update| {
            update.state.phase = DesktopUpdatePhase::Error;
            update.state.failed_operation = Some(DesktopUpdateOperation::Install);
            update.state.preparation_failure =
                Some(DesktopUpdatePreparationFailureKind::StopFailed);
            update.state.message = Some(error.to_string());
        })
        .await;
        publish(app, &current(app).await);
        return Err(error);
    }
    let artifact: Option<PathBuf> = with_state(app, |update| update.downloaded.clone()).await;
    let Some(artifact) = artifact else {
        return Err(DshError::other(
            "update_artifact_missing",
            "no downloaded artifact",
        ));
    };
    // Launch the installer and leave the exit to the update reason.
    #[cfg(windows)]
    std::process::Command::new(&artifact)
        .arg("/S")
        .spawn()
        .map_err(|e| DshError::io("launch installer", Some(artifact.display().to_string()), &e))?;
    #[cfg(not(windows))]
    std::process::Command::new(&artifact)
        .spawn()
        .map_err(|e| DshError::io("launch installer", Some(artifact.display().to_string()), &e))?;
    crate::quit_flow::arm_skip(dsh_core::quit::QuitSkip::InstallerRestart);
    crate::quit_flow::confirm_exit(app, dsh_core::protocol::QuitReason::Update).await;
}

/// Parse the update feed response without assuming any status class is an error.
/// Redirects are deliberately not followed: feed redirects are a classified check
/// failure, avoiding an implicit trust-boundary change for manifest and artifact URLs.
async fn parse_feed_response(response: reqwest::Response) -> Result<UpdateManifest, String> {
    let status = response.status();
    match status.as_u16() {
        200..=299 => response
            .json::<UpdateManifest>()
            .await
            .map_err(|error| format!("invalid update feed response: {error}")),
        300..=399 => Err(format!("update feed redirect is not followed ({status})")),
        400..=499 => Err(format!("update feed rejected the request ({status})")),
        500..=599 => Err(format!("update feed server failure ({status})")),
        _ => Err(format!("unexpected update feed status ({status})")),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum PreReleaseId<'a> {
    Numeric(&'a str),
    Text(&'a str),
}

#[derive(Debug)]
struct SemVer<'a> {
    major: &'a str,
    minor: &'a str,
    patch: &'a str,
    prerelease: Option<Vec<PreReleaseId<'a>>>,
}

fn valid_numeric(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn parse_semver(value: &str) -> Option<SemVer<'_>> {
    let (without_build, build) = match value.split_once('+') {
        Some((version, metadata)) if !metadata.contains('+') => (version, Some(metadata)),
        Some(_) => return None,
        None => (value, None),
    };
    if let Some(metadata) = build {
        if !metadata.split('.').all(valid_identifier) {
            return None;
        }
    }
    let (core, prerelease_text) = match without_build.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (without_build, None),
    };
    let mut core_parts = core.split('.');
    let major = core_parts.next()?;
    let minor = core_parts.next()?;
    let patch = core_parts.next()?;
    if core_parts.next().is_some()
        || !valid_numeric(major)
        || !valid_numeric(minor)
        || !valid_numeric(patch)
    {
        return None;
    }
    let prerelease = match prerelease_text {
        Some(value) => {
            let identifiers = value
                .split('.')
                .map(|id| {
                    if !valid_identifier(id) {
                        return None;
                    }
                    if id.bytes().all(|byte| byte.is_ascii_digit()) {
                        if id.len() > 1 && id.starts_with('0') {
                            return None;
                        }
                        Some(PreReleaseId::Numeric(id))
                    } else {
                        Some(PreReleaseId::Text(id))
                    }
                })
                .collect::<Option<Vec<_>>>()?;
            Some(identifiers)
        }
        None => None,
    };
    Some(SemVer {
        major,
        minor,
        patch,
        prerelease,
    })
}

fn compare_numeric(left: &str, right: &str) -> std::cmp::Ordering {
    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}

fn compare_semver(left: &SemVer<'_>, right: &SemVer<'_>) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    for ordering in [
        compare_numeric(left.major, right.major),
        compare_numeric(left.minor, right.minor),
        compare_numeric(left.patch, right.patch),
    ] {
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    match (&left.prerelease, &right.prerelease) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left), Some(right)) => {
            for (left_id, right_id) in left.iter().zip(right) {
                let ordering = match (left_id, right_id) {
                    (PreReleaseId::Numeric(a), PreReleaseId::Numeric(b)) => compare_numeric(a, b),
                    (PreReleaseId::Numeric(_), PreReleaseId::Text(_)) => Ordering::Less,
                    (PreReleaseId::Text(_), PreReleaseId::Numeric(_)) => Ordering::Greater,
                    (PreReleaseId::Text(a), PreReleaseId::Text(b)) => a.cmp(b),
                };
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            left.len().cmp(&right.len())
        }
    }
}

/// SemVer 2.0.0 precedence comparison. Invalid versions are never accepted.
pub fn greater_version(candidate: &str, current: &str) -> bool {
    match (parse_semver(candidate), parse_semver(current)) {
        (Some(candidate), Some(current)) => compare_semver(&candidate, &current).is_gt(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use dsh_core::protocol::SettingValue;

    use super::{
        channel_feed_key, configured_feed, greater_version, no_feed_message, parse_feed_response,
    };
    use crate::state::{UPDATE_FEED_BETA_KEY, UPDATE_FEED_KEY};

    fn text(value: &str) -> SettingValue {
        SettingValue::String(value.to_string())
    }

    #[test]
    fn semver_comparison_uses_semver_precedence_and_rejects_invalid_input() {
        let cases = [
            ("0.1.7", "0.1.7-rc.2", true),
            ("0.1.7-rc.2", "0.1.7", false),
            ("1.0.0", "2.0.0-rc.1", false),
            ("1.0.0-alpha.2", "1.0.0-alpha.10", false),
            ("1.0.0-alpha.10", "1.0.0-alpha.2", true),
            ("1.0.0-alpha", "1.0.0-beta", false),
            ("1.0.0-beta", "1.0.0-alpha", true),
            ("1.0.0+build.2", "1.0.0+build.1", false),
            ("1.0.0+build.1", "1.0.0+build.2", false),
            ("1.0.1", "1.0.0+meta", true),
            ("1.0", "1.0.0", false),
            ("01.0.0", "1.0.0", false),
            ("1.0.0-01", "1.0.0-alpha", false),
            ("1.0.0+", "1.0.0", false),
        ];
        for (candidate, current, expected) in cases {
            let actual = greater_version(candidate, current);
            println!("greater_version({candidate:?}, {current:?}) = {actual}");
            assert_eq!(actual, expected, "{candidate} vs {current}");
        }
    }

    async fn local_response(status: &str) -> reqwest::Response {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local fixture");
        let address = listener.local_addr().expect("local fixture address");
        let status = status.to_string();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept local request");
            // Drain the request before answering. Closing a socket that still has
            // unread data queued makes Windows answer with RST rather than a
            // graceful FIN, and the client then reports WSAECONNABORTED (10053)
            // instead of reading the response that was just written.
            let mut request = Vec::new();
            let mut chunk = [0u8; 512];
            loop {
                match stream.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(read) => {
                        request.extend_from_slice(&chunk[..read]);
                        if request.windows(4).any(|window| window == b"\r\n\r\n") {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let response =
                format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            stream
                .write_all(response.as_bytes())
                .await
                .expect("write fixture response");
            let _ = stream.shutdown().await;
        });
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("build test client")
            .get(format!("http://{address}/feed"))
            .send()
            .await
            .expect("receive local fixture response")
    }

    #[tokio::test]
    async fn feed_redirect_is_a_classified_failure_without_panicking() {
        let response = local_response("303 See Other").await;
        let error = parse_feed_response(response)
            .await
            .expect_err("redirect fails check");
        println!("303 feed response: {error}");
        assert!(error.contains("redirect is not followed (303 See Other)"));
    }

    #[tokio::test]
    async fn feed_client_and_server_errors_are_classified() {
        for (status, class) in [
            ("404 Not Found", "rejected the request"),
            ("503 Service Unavailable", "server failure"),
        ] {
            let response = local_response(status).await;
            let error = parse_feed_response(response)
                .await
                .expect_err("error status fails check");
            assert!(error.contains(class), "{error}");
        }
    }

    #[test]
    fn channel_selects_only_its_own_manifest_feed() {
        let stable = text("stable-feed-value");
        let beta = text("beta-feed-value");
        assert_eq!(channel_feed_key(Some(&text("beta"))), UPDATE_FEED_BETA_KEY);
        assert_eq!(channel_feed_key(Some(&text("stable"))), UPDATE_FEED_KEY);
        assert_eq!(channel_feed_key(None), UPDATE_FEED_KEY);
        assert_eq!(
            configured_feed(Some(&text("beta")), Some(&stable), Some(&beta)),
            Some("beta-feed-value".to_string())
        );
        assert_eq!(
            configured_feed(Some(&text("stable")), Some(&stable), Some(&beta)),
            Some("stable-feed-value".to_string())
        );
    }

    #[test]
    fn missing_selected_feed_is_honest_and_does_not_fall_back_to_other_channel() {
        let stable = text("stable-feed-value");
        assert_eq!(
            configured_feed(Some(&text("beta")), Some(&stable), None),
            None
        );
        assert_eq!(configured_feed(None, None, None), None);
        assert_eq!(
            no_feed_message(Some(&text("beta"))),
            "no update feed is configured (settings key `updates.feed-url-beta`)"
        );
        assert_eq!(
            no_feed_message(None),
            "no update feed is configured (settings key `updates.feed-url`)"
        );
        assert_eq!(
            configured_feed(Some(&text("unknown")), Some(&stable), None),
            Some("stable-feed-value".to_string())
        );
    }
}
