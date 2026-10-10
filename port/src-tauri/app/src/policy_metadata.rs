//! Native request-time metadata for mandatory desktop policy checks.

use std::sync::Arc;

use tauri::Manager;

use crate::policy_runner::{MetadataFuture, PolicyMetadataSource};
use crate::policy_transport::PolicyClientMetadata;
use crate::state::AppState;

/// Trusted build version and Tauri handle used to sample current native metadata.
pub(super) struct NativePolicyMetadata {
    app: tauri::AppHandle,
    client_version: String,
}

impl NativePolicyMetadata {
    /// Create a metadata source only for an explicitly supplied valid build version.
    pub(super) fn new(app: tauri::AppHandle, client_version: String) -> Result<Self, String> {
        validate_client_version(&client_version)?;
        Ok(Self {
            app,
            client_version,
        })
    }
}

impl PolicyMetadataSource for NativePolicyMetadata {
    fn sample(&self) -> MetadataFuture<'_> {
        Box::pin(async move {
            let state = self.app.state::<Arc<AppState>>().inner().clone();
            let locale = sample_locale(&state.locale).await;
            Ok(PolicyClientMetadata {
                version: self.client_version.clone(),
                locale,
                timezone_offset_seconds: native_timezone_offset_seconds(),
            })
        })
    }
}

fn validate_client_version(version: &str) -> Result<(), String> {
    if crate::update_security::is_valid_semver(version) {
        Ok(())
    } else {
        Err("desktop policy: invalid client build version".to_string())
    }
}

async fn sample_locale(
    locale: &tokio::sync::Mutex<crate::state::LocaleModel>,
) -> dsh_core::protocol::LocaleId {
    locale.lock().await.snapshot().effective
}

fn native_timezone_offset_seconds() -> i32 {
    chrono::Local::now().offset().local_minus_utc()
}

#[cfg(test)]
mod tests {
    use super::*;
    use dsh_core::protocol::{LocaleId, LocaleSource};

    #[test]
    fn client_version_requires_explicit_valid_semver() {
        assert!(validate_client_version("1.2.3").is_ok());
        assert!(validate_client_version("").is_err());
        assert!(validate_client_version("not-a-version").is_err());
    }

    #[tokio::test]
    async fn each_sample_uses_the_current_applied_locale() {
        let locale = tokio::sync::Mutex::new(crate::state::LocaleModel {
            preference: Some(LocaleId::En),
            effective: LocaleId::En,
            source: LocaleSource::Preference,
            languages: vec![],
            applied: Some(LocaleId::Zh),
        });
        assert_eq!(sample_locale(&locale).await, LocaleId::Zh);
        locale.lock().await.applied = Some(LocaleId::En);
        assert_eq!(sample_locale(&locale).await, LocaleId::En);
        locale.lock().await.applied = None;
        assert_eq!(sample_locale(&locale).await, LocaleId::En);
    }

    #[test]
    fn native_timezone_offset_is_whole_seconds_east_of_utc() {
        let actual = native_timezone_offset_seconds();
        let expected = chrono::Local::now().offset().local_minus_utc();
        assert_eq!(actual, expected);
        assert!(actual.abs() < 24 * 60 * 60);
    }
}
