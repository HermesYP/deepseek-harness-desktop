//! Bounded HTTP transport for mandatory desktop policy checks.
//!
//! This transport is independent of the optional release feed. It uses the
//! protocol validators in `mandatory_update` and retains prior verdicts on all
//! transport and parsing failures. Feishu cookie transport is deliberately
//! refused until a dedicated native session can safely enforce origin scope.

use crate::mandatory_update::{
    parse_policy, policy_request_url, policy_requires_authentication, DesktopPolicyConfig,
    DesktopPolicyIdentity, MandatoryDecision, PolicyAuthentication, PolicyError,
    PolicyRequestHeaders, PolicyScenario,
};
use reqwest::{header, redirect::Policy, Client};
use std::time::Duration;

/// Maximum decoded JSON payload accepted from the policy service.
pub const MAX_POLICY_RESPONSE_BYTES: usize = 1024 * 1024;

/// Outcome failures preserve the previously confirmed mandatory verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyTransportError {
    Unavailable(String),
    AuthenticationRequired,
    UnsupportedAuthentication,
}

impl PolicyTransportError {
    /// Apply this failed attempt without clearing a known mandatory verdict.
    pub fn retain(self, previous: &MandatoryDecision) -> MandatoryDecision {
        previous.with_error(match self {
            Self::AuthenticationRequired | Self::UnsupportedAuthentication => {
                PolicyError::AuthenticationRequired
            }
            Self::Unavailable(_) => PolicyError::Unavailable,
        })
    }
}

/// Client metadata sampled by the shell for each request, not by a guest page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyClientMetadata {
    pub version: String,
    pub locale: dsh_core::protocol::LocaleId,
    /// Whole seconds east of UTC, matching Platform's wire protocol.
    pub timezone_offset_seconds: i32,
}

impl PolicyClientMetadata {
    fn wire_locale(&self) -> &'static str {
        match self.locale {
            dsh_core::protocol::LocaleId::En => "en_US",
            dsh_core::protocol::LocaleId::Zh => "zh_CN",
        }
    }
}

/// Execute one anonymous mandatory-policy check.
///
/// `FeishuTest` is rejected explicitly: reqwest's ordinary client cannot safely
/// reuse the isolated authenticated WebView session required by that mode.
pub async fn check_policy(
    config: &DesktopPolicyConfig,
    identity: &DesktopPolicyIdentity,
    metadata: &PolicyClientMetadata,
    scenario: PolicyScenario,
) -> Result<MandatoryDecision, PolicyTransportError> {
    identity
        .validate()
        .map_err(PolicyTransportError::Unavailable)?;
    if !crate::update_security::is_valid_semver(&metadata.version) {
        return Err(PolicyTransportError::Unavailable(
            "desktop policy: invalid client build version".into(),
        ));
    }
    if config.authentication != PolicyAuthentication::Anonymous {
        return Err(PolicyTransportError::UnsupportedAuthentication);
    }
    let url = policy_request_url(config, scenario).map_err(PolicyTransportError::Unavailable)?;
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_millis(config.timeout_ms))
        .build()
        .map_err(|error| PolicyTransportError::Unavailable(error.to_string()))?;
    let headers = PolicyRequestHeaders::for_identity(identity);
    let response = client
        .get(url)
        .header(header::ACCEPT, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-client-bundle-id", "")
        .header("x-client-version", &metadata.version)
        .header("x-client-locale", metadata.wire_locale())
        .header(
            "x-client-timezone-offset",
            metadata.timezone_offset_seconds.to_string(),
        )
        .header("x-client-platform", headers.platform)
        .header("x-client-arch", headers.arch)
        .header("x-client-update-channel", headers.channel)
        .header("x-client-bundled-dsh-version", headers.bundled_dsh_version)
        .send()
        .await
        .map_err(|error| PolicyTransportError::Unavailable(error.to_string()))?;

    if response.status().is_redirection() {
        return Err(PolicyTransportError::Unavailable(
            "desktop policy: redirects are refused".to_string(),
        ));
    }
    let status = response.status();
    let body = read_bounded(response).await?;
    let value: serde_json::Value = serde_json::from_slice(&body).map_err(|error| {
        PolicyTransportError::Unavailable(format!("desktop policy: invalid JSON: {error}"))
    })?;
    if policy_requires_authentication(config, status.as_u16(), &value) {
        return Err(PolicyTransportError::AuthenticationRequired);
    }
    parse_policy(&value, status.is_success(), config).map_err(PolicyTransportError::Unavailable)
}

async fn read_bounded(mut response: reqwest::Response) -> Result<Vec<u8>, PolicyTransportError> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_POLICY_RESPONSE_BYTES as u64)
    {
        return Err(PolicyTransportError::Unavailable(
            "desktop policy: response exceeds size limit".to_string(),
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| PolicyTransportError::Unavailable(error.to_string()))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_POLICY_RESPONSE_BYTES {
            return Err(PolicyTransportError::Unavailable(
                "desktop policy: response exceeds size limit".to_string(),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Apply a transport result to current state while preserving confirmed blocks.
///
/// This is the single place a check outcome becomes the current verdict, so the
/// runner and the transport tests cannot drift apart on retention.
pub fn retain_result(
    previous: &MandatoryDecision,
    result: Result<MandatoryDecision, PolicyTransportError>,
) -> MandatoryDecision {
    match result {
        Ok(decision) => decision,
        Err(error) => error.retain(previous),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocking() -> MandatoryDecision {
        MandatoryDecision {
            blocking: true,
            title: Some("Upgrade".into()),
            ..Default::default()
        }
    }

    fn identity() -> DesktopPolicyIdentity {
        DesktopPolicyIdentity {
            platform: crate::mandatory_update::PolicyPlatform::Win32,
            arch: crate::mandatory_update::PolicyArch::X64,
            bundled_dsh_version: "1.2.3".into(),
        }
    }

    fn metadata() -> PolicyClientMetadata {
        PolicyClientMetadata {
            version: "1.2.4".into(),
            locale: dsh_core::protocol::LocaleId::Zh,
            timezone_offset_seconds: 28_800,
        }
    }

    // Each fixture owns an ephemeral loopback port and a bounded server task.
    async fn fixture(response: Vec<u8>) -> (DesktopPolicyConfig, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let config = crate::mandatory_update::resolve_policy_config(
            Some(&serde_json::json!({
                "origin": origin,
                "allowedPageOrigins": ["https://download.example.com"],
                "timeoutMs": 1000
            })),
            true,
        )
        .unwrap()
        .unwrap();
        let task = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(5), async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut chunk = [0u8; 2048];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0, "request headers must complete");
                    request.extend_from_slice(&chunk[..count]);
                    assert!(request.len() <= 16_384, "fixture request is bounded");
                }
                // Oversized/redirect fixtures may be refused before the server
                // finishes writing; a broken pipe is expected in those cases.
                let _write_result = socket.write_all(&response).await;
                String::from_utf8(request).unwrap()
            })
            .await
            .expect("loopback fixture must settle")
        });
        (config, task)
    }

    fn response(status: &str, body: &str) -> Vec<u8> {
        format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes()
    }

    #[tokio::test]
    async fn anonymous_http_sends_exact_platform_headers_and_parses_a_block() {
        let (config, server) = fixture(response(
            "200 OK",
            r#"{"code":40005,"data":{"show_content":{"title":"Upgrade"}}}"#,
        ))
        .await;
        let decision = check_policy(&config, &identity(), &metadata(), PolicyScenario::Manual)
            .await
            .unwrap();
        assert!(decision.blocking);
        assert_eq!(decision.title.as_deref(), Some("Upgrade"));
        let request = server.await.unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /api/v0/check_client_update?scenario=manual http/1.1\r\n"));
        for expected in [
            "x-client-platform: desktop-win\r\n",
            "x-client-arch: x64\r\n",
            "x-client-update-channel: nightly\r\n",
            "x-client-bundled-dsh-version: 1.2.3\r\n",
            "x-client-version: 1.2.4\r\n",
            "x-client-locale: zh_cn\r\n",
            "x-client-timezone-offset: 28800\r\n",
            "x-client-bundle-id: \r\n",
            "cache-control: no-store\r\n",
            "accept: application/json\r\n",
        ] {
            assert!(request.contains(expected), "missing header: {expected}");
        }
        assert!(!request.contains("\r\nauthorization:"));
        assert!(!request.contains("\r\ncookie:"));
    }

    #[tokio::test]
    async fn only_a_fresh_no_force_success_clears_a_confirmed_block() {
        let (config, server) = fixture(response(
            "200 OK",
            r#"{"code":0,"data":{"biz_code":0,"biz_data":null}}"#,
        ))
        .await;
        let result = check_policy(&config, &identity(), &metadata(), PolicyScenario::Launch).await;
        assert!(!retain_result(&blocking(), result).blocking);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn invalid_json_and_protocol_failures_retain_the_block() {
        for body in ["not json", r#"{"code":0,"data":{"biz_code":0}}"#] {
            let (config, server) = fixture(response("200 OK", body)).await;
            let result =
                check_policy(&config, &identity(), &metadata(), PolicyScenario::Launch).await;
            let retained = retain_result(&blocking(), result);
            assert!(retained.blocking);
            assert_eq!(retained.error, Some(PolicyError::Unavailable));
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn redirect_is_refused_instead_of_contacting_its_destination() {
        let (config, server) = fixture(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/redirect-target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()).await;
        let result = check_policy(&config, &identity(), &metadata(), PolicyScenario::Launch).await;
        assert_eq!(
            result,
            Err(PolicyTransportError::Unavailable(
                "desktop policy: redirects are refused".into()
            ))
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn declared_and_chunked_oversized_bodies_are_refused() {
        let large = "x".repeat(MAX_POLICY_RESPONSE_BYTES + 1);
        let chunked = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{large}\r\n0\r\n\r\n", large.len()).into_bytes();
        for raw in [response("200 OK", &large), chunked] {
            let (config, server) = fixture(raw).await;
            let result =
                check_policy(&config, &identity(), &metadata(), PolicyScenario::Periodic).await;
            assert_eq!(
                result,
                Err(PolicyTransportError::Unavailable(
                    "desktop policy: response exceeds size limit".into()
                ))
            );
            assert!(retain_result(&blocking(), result).blocking);
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn exact_body_limit_is_accepted_without_truncating_json() {
        let mut document = serde_json::json!({
            "code": 0, "data": {"biz_code": 0, "biz_data": null}, "padding": ""
        });
        let overhead = document.to_string().len();
        document["padding"] =
            serde_json::Value::String("x".repeat(MAX_POLICY_RESPONSE_BYTES - overhead));
        let body = document.to_string();
        assert_eq!(body.len(), MAX_POLICY_RESPONSE_BYTES);
        let (config, server) = fixture(response("200 OK", &body)).await;
        let result = check_policy(&config, &identity(), &metadata(), PolicyScenario::Periodic)
            .await
            .unwrap();
        assert!(!result.blocking);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn failed_http_success_envelope_and_truncated_body_cannot_clear_a_block() {
        let no_force = r#"{"code":0,"data":{"biz_code":0,"biz_data":null}}"#;
        let truncated = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{no_force}",
            no_force.len() + 10
        )
        .into_bytes();
        for raw in [response("403 Forbidden", no_force), truncated] {
            let (config, server) = fixture(raw).await;
            let result =
                check_policy(&config, &identity(), &metadata(), PolicyScenario::Launch).await;
            assert!(result.is_err());
            assert!(retain_result(&blocking(), result).blocking);
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn a_stalled_body_obeys_the_total_request_deadline_and_retains_the_block() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = crate::mandatory_update::resolve_policy_config(
            Some(&serde_json::json!({
                "origin": format!("http://{}", listener.local_addr().unwrap()),
                "allowedPageOrigins": ["https://download.example.com"], "timeoutMs": 1000
            })),
            true,
        )
        .unwrap()
        .unwrap();
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(5), async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{",
                    )
                    .await
                    .unwrap();
                let _ = released.await;
            })
            .await
            .expect("stalled fixture must be released");
        });
        let started = std::time::Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            check_policy(&config, &identity(), &metadata(), PolicyScenario::Periodic),
        )
        .await
        .expect("the configured total deadline must bound a stalled body");
        assert!(started.elapsed() >= Duration::from_millis(900));
        assert!(result.is_err());
        assert!(retain_result(&blocking(), result).blocking);
        let _ = release.send(());
        server.await.unwrap();
    }

    #[test]
    fn every_error_preserves_a_confirmed_block() {
        for error in [
            PolicyTransportError::Unavailable("offline".into()),
            PolicyTransportError::AuthenticationRequired,
            PolicyTransportError::UnsupportedAuthentication,
        ] {
            let retained = error.retain(&blocking());
            assert!(retained.blocking);
            assert_eq!(retained.title.as_deref(), Some("Upgrade"));
            assert!(retained.error.is_some());
        }
    }

    #[test]
    fn authenticated_mode_is_not_silently_sent_anonymously() {
        let config = crate::mandatory_update::resolve_policy_config(
            Some(&serde_json::json!({
                "origin":"https://policy.example.com",
                "allowedPageOrigins":["https://download.example.com"],
                "authentication":"feishu-test",
                "allowedAuthOrigins":["https://login.example.com"]
            })),
            false,
        )
        .unwrap()
        .unwrap();
        let identity = DesktopPolicyIdentity {
            platform: crate::mandatory_update::PolicyPlatform::Win32,
            arch: crate::mandatory_update::PolicyArch::X64,
            bundled_dsh_version: "1.2.3".into(),
        };
        // The mode check is before client/network creation; exercise it through
        // the async API without making a network call.
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(check_policy(
                &config,
                &identity,
                &metadata(),
                PolicyScenario::Launch,
            ));
        assert_eq!(result, Err(PolicyTransportError::UnsupportedAuthentication));
    }
}
