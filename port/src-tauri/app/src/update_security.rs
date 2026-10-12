//! Release trust, feed policy, and download admission for the desktop updater.
//!
//! Three separate decisions live here, each independently testable and each
//! failing closed:
//!
//! 1. **Release admission** ([`ReleaseAdmission`]) — which manifest is allowed
//!    to become a candidate at all. Feed authority comes from *packaged*
//!    configuration, never from the renderer-mutable settings store, so a page
//!    document cannot point the updater at an artifact of its choosing.
//! 2. **Feed/artifact policy** ([`ReleasePolicy`]) — HTTPS-only transport plan
//!    with an explicit origin/redirect allow list. There is no implicit
//!    trust-boundary change through a redirect.
//! 3. **Signature verification** ([`verify_release`]) — mandatory Ed25519
//!    verification over a canonical signed message, in addition to (never
//!    instead of) the SHA-256 integrity check.
//!
//! Missing trust configuration disables delivery: [`ReleasePolicy::admit_check`]
//! refuses before any network request, and [`verify_release`] refuses when the
//! projection carries no signature or no trusted key. Nothing here treats an
//! unsigned or hash-only manifest as installable.
//!
//! 4. **The v2 release contract** ([`SignedReleaseV2`], [`verify_release_v2`]) —
//!    the same signature discipline over a message that also binds the product,
//!    platform, architecture, and artifact class the bytes are for, an
//!    authenticated metadata sequence for anti-rollback, and an expiry for
//!    freshness.
//!
//! The v2 contract is additive and is **not authoritative yet**. [`verify_release`]
//! (v1) is unchanged and is still the only verifier any caller uses, including
//! `update_flow.rs`; no packaged build presents a v2 document to anything, and no
//! feed is enabled by its tests. The whole v2 surface is compiled for tests and
//! the headless probe only, so the shipped library carries no unused verification
//! code and "not authoritative" is enforced by the compiler rather than promised
//! in prose. Making v2 the verifier is the next increment, and it must change
//! publishing and verification together. Refusing an unrecognized schema, in
//! either direction, is a refusal rather than a fallback to the weaker contract.

use std::collections::BTreeSet;
// Compiled wherever the v2 contract is; see `signed_release_v2`.
#[cfg(any(test, updater_probe))]
use std::io::Write;

#[cfg(any(test, updater_probe))]
use crate::mandatory_update::{PolicyArch, PolicyPlatform};
use dsh_core::protocol::SettingValue;
use serde::{Deserialize, Serialize};
use url::Url;

/// Feed authority for one release channel, as packaged with the application.
///
/// This mirrors the upstream `app-update.yml` rule
/// (`_upstream/apps/desktop/src/update-coordinator.ts:53`): an application with
/// no packaged update source has no release delivery at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelFeed {
    /// Absolute https manifest URL of this channel.
    pub feed_url: String,
    /// Hosts (with optional port) allowed to serve either the manifest or the
    /// artifact for this channel. Matching is exact against `Url::host_str`
    /// plus the explicit port, so `example.com` never authorizes
    /// `evil-example.com` or `example.com.evil.test`.
    pub allowed_origins: Vec<String>,
    /// Hex-encoded Ed25519 public key (32 bytes) trusted to sign releases of
    /// this channel. An empty list disables delivery for the channel: a
    /// manifest that only carries a SHA-256 digest does not establish release
    /// provenance and must not be installed.
    pub trusted_keys: Vec<String>,
}

/// Packaged release trust configuration (`updates.json` beside the executable).
///
/// Deliberately *not* backed by the settings store: the renderer can write
/// settings, and release authority must not be renderer-mutable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseTrustConfig {
    /// Identity of this packaged configuration, reported in diagnostics.
    pub config_version: u32,
    /// Deployments may pin a release channel; `None` follows the user's
    /// persisted channel preference.
    #[serde(default)]
    pub pinned_channel: Option<String>,
    /// The `stable` channel definition. Required for stable delivery.
    #[serde(default)]
    pub stable: Option<ChannelFeed>,
    /// The `beta` channel definition. Required for beta delivery.
    #[serde(default)]
    pub beta: Option<ChannelFeed>,
}

/// Outcome of reading packaged trust configuration. A missing file and a
/// malformed file are both "no authority", but they are reported differently so
/// a user can tell a portable build from a broken install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustConfigOutcome {
    /// Packaged authority was read and is internally consistent.
    Loaded(ReleaseTrustConfig),
    /// No packaged trust configuration exists (development or unsigned build).
    Absent,
    /// A configuration exists but could not be used; delivery is disabled.
    Invalid(String),
}

/// Renderer-readable projection of packaged delivery authority. It contains no
/// keys and cannot authorize a feed or widen the native transport policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConfiguration {
    pub channel: String,
    pub feed_url: Option<String>,
    pub available_channels: Vec<String>,
    pub pinned_channel: Option<String>,
    pub disabled_reason: Option<&'static str>,
}

/// Select the same effective channel for presentation and execution. A packaged
/// channel pin takes precedence over an old renderer-persisted preference.
pub fn effective_channel(outcome: &TrustConfigOutcome, requested: &str) -> &'static str {
    let selected = match outcome {
        TrustConfigOutcome::Loaded(config) => config.pinned_channel.as_deref().unwrap_or(requested),
        _ => requested,
    };
    if selected == "beta" {
        "beta"
    } else {
        "stable"
    }
}

/// Explain a disabled delivery path before the UI offers a network action.
pub fn present_configuration(outcome: &TrustConfigOutcome, requested: &str) -> UpdateConfiguration {
    let channel = effective_channel(outcome, requested);
    let mut result = UpdateConfiguration {
        channel: channel.into(),
        feed_url: None,
        available_channels: Vec::new(),
        pinned_channel: None,
        disabled_reason: None,
    };
    let config = match outcome {
        TrustConfigOutcome::Absent => {
            result.disabled_reason = Some("missing-source");
            return result;
        }
        TrustConfigOutcome::Invalid(_) => {
            result.disabled_reason = Some("invalid-source");
            return result;
        }
        TrustConfigOutcome::Loaded(config) => config,
    };
    result.pinned_channel.clone_from(&config.pinned_channel);
    for (name, feed) in [("stable", &config.stable), ("beta", &config.beta)] {
        if feed
            .as_ref()
            .is_some_and(|feed| !feed.trusted_keys.is_empty())
            && config
                .pinned_channel
                .as_deref()
                .is_none_or(|pinned| pinned == name)
        {
            result.available_channels.push(name.into());
        }
    }
    match if channel == "beta" {
        &config.beta
    } else {
        &config.stable
    } {
        None => result.disabled_reason = Some("missing-channel"),
        Some(feed) => {
            result.feed_url = Some(feed.feed_url.clone());
            if feed.trusted_keys.is_empty() {
                result.disabled_reason = Some("missing-key");
            }
        }
    }
    result
}

impl TrustConfigOutcome {
    /// The loaded configuration, when this outcome carries packaged authority.
    ///
    /// `Absent` and `Invalid` deliberately expose nothing: a caller that wants
    /// "the config, if any" must not be able to treat a refused document as an
    /// empty-but-usable one.
    ///
    /// Test/diagnostic surface: the updater matches the outcome and reports the
    /// refusal, rather than asking for a configuration that may be absent.
    #[cfg(any(test, updater_probe))]
    pub fn config(&self) -> Option<&ReleaseTrustConfig> {
        match self {
            Self::Loaded(config) => Some(config),
            Self::Absent | Self::Invalid(_) => None,
        }
    }
}

#[cfg(test)]
mod configuration_tests {
    use super::*;

    fn source() -> ReleaseTrustConfig {
        ReleaseTrustConfig {
            config_version: 1,
            pinned_channel: None,
            stable: Some(ChannelFeed {
                feed_url: "https://release.example/stable.json".into(),
                allowed_origins: vec!["release.example".into()],
                trusted_keys: vec!["11".repeat(32)],
            }),
            beta: None,
        }
    }

    #[test]
    fn disabled_configuration_is_classified_without_exposing_invalid_source_details() {
        for (outcome, reason) in [
            (TrustConfigOutcome::Absent, "missing-source"),
            (
                TrustConfigOutcome::Invalid("private path and contents".into()),
                "invalid-source",
            ),
        ] {
            let view = present_configuration(&outcome, "stable");
            assert_eq!(view.disabled_reason, Some(reason));
            assert_eq!(view.feed_url, None);
            assert!(view.available_channels.is_empty());
            assert!(!serde_json::to_string(&view).unwrap().contains("private"));
        }
    }

    #[test]
    fn configured_channels_require_keys_and_never_fall_back_to_another_feed() {
        let mut config = source();
        let view = present_configuration(&TrustConfigOutcome::Loaded(config.clone()), "beta");
        assert_eq!(view.channel, "beta");
        assert_eq!(view.feed_url, None);
        assert_eq!(view.disabled_reason, Some("missing-channel"));
        assert_eq!(view.available_channels, ["stable"]);
        config.stable.as_mut().unwrap().trusted_keys.clear();
        let view = present_configuration(&TrustConfigOutcome::Loaded(config), "stable");
        assert_eq!(
            view.feed_url.as_deref(),
            Some("https://release.example/stable.json")
        );
        assert_eq!(view.disabled_reason, Some("missing-key"));
        assert!(view.available_channels.is_empty());
    }

    #[test]
    fn packaged_pin_overrides_an_old_preference_for_presentation_and_execution() {
        let mut config = source();
        config.pinned_channel = Some("stable".into());
        let outcome = TrustConfigOutcome::Loaded(config);
        let view = present_configuration(&outcome, "beta");
        assert_eq!(effective_channel(&outcome, "beta"), "stable");
        assert_eq!(view.channel, "stable");
        assert_eq!(view.disabled_reason, None);
        assert_eq!(view.available_channels, ["stable"]);
        assert_eq!(
            serde_json::to_value(view).unwrap(),
            serde_json::json!({
                "channel":"stable", "feedUrl":"https://release.example/stable.json", "availableChannels":["stable"], "pinnedChannel":"stable", "disabledReason":null
            })
        );
    }
}

/// Read and validate the packaged trust configuration.
///
/// Validation is fail-closed: an unparseable, empty, or self-contradictory
/// document yields [`TrustConfigOutcome::Invalid`], never a partially applied
/// configuration. Every URL must already be https, every allowed origin must be
/// a bare host or host:port, and every trusted key must be 32 hex-encoded bytes.
pub fn load_trust_config(source: &std::path::Path) -> TrustConfigOutcome {
    // Classify the directory entry itself, not its target. `read_to_string`
    // reports NotFound for a dangling symlink just as it does for a missing
    // entry; treating that as Absent could let a later candidate win.
    match std::fs::symlink_metadata(source) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return TrustConfigOutcome::Absent
        }
        Err(error) => {
            return TrustConfigOutcome::Invalid(format!(
                "release trust configuration at {} could not be inspected: {error}",
                source.display()
            ))
        }
    }
    // If the entry disappears or becomes unreadable after inspection, fail
    // closed. This narrows (but cannot eliminate) the metadata/read race; it
    // does not defend against privileged replacement of the package directory.
    let text = match std::fs::read_to_string(source) {
        Ok(text) => text,
        Err(error) => {
            return TrustConfigOutcome::Invalid(format!(
                "release trust configuration at {} could not be read: {error}",
                source.display()
            ))
        }
    };
    let config: ReleaseTrustConfig = match serde_json::from_str(&text) {
        Ok(config) => config,
        Err(error) => {
            return TrustConfigOutcome::Invalid(format!(
                "release trust configuration at {} is not valid JSON: {error}",
                source.display()
            ))
        }
    };
    match validate_trust_config(&config) {
        Ok(()) => TrustConfigOutcome::Loaded(config),
        Err(reason) => TrustConfigOutcome::Invalid(format!(
            "release trust configuration at {} is invalid: {reason}",
            source.display()
        )),
    }
}

/// Validate one packaged trust configuration in isolation.
pub fn validate_trust_config(config: &ReleaseTrustConfig) -> Result<(), String> {
    if config.config_version == 0 {
        return Err("configVersion must be a positive integer".to_string());
    }
    if let Some(channel) = config.pinned_channel.as_deref() {
        if channel != "stable" && channel != "beta" {
            return Err(format!("pinnedChannel `{channel}` is not a known channel"));
        }
    }
    if config.stable.is_none() && config.beta.is_none() {
        return Err("no release channel is configured".to_string());
    }
    for (name, feed) in [("stable", &config.stable), ("beta", &config.beta)] {
        let Some(feed) = feed else { continue };
        validate_channel_feed(name, feed)?;
    }
    Ok(())
}

fn validate_channel_feed(name: &str, feed: &ChannelFeed) -> Result<(), String> {
    let url = Url::parse(&feed.feed_url)
        .map_err(|error| format!("{name} feed URL is not a URL: {error}"))?;
    if url.scheme() != "https" {
        return Err(format!(
            "{name} feed URL must use https (found `{}`)",
            url.scheme()
        ));
    }
    if url.host_str().is_none() {
        return Err(format!("{name} feed URL has no host"));
    }
    if feed.allowed_origins.is_empty() {
        return Err(format!(
            "{name} feed declares no allowed origins; delivery is indeterminate"
        ));
    }
    let mut seen = BTreeSet::new();
    for origin in &feed.allowed_origins {
        if !is_valid_origin(origin) {
            return Err(format!(
                "{name} allowed origin `{origin}` is not a bare host or host:port"
            ));
        }
        if !seen.insert(origin.to_ascii_lowercase()) {
            return Err(format!("{name} allowed origin `{origin}` is listed twice"));
        }
    }
    if !origin_is_allowed(&feed.allowed_origins, &url) {
        return Err(format!(
            "{name} feed URL host is not in its own allowed-origin list"
        ));
    }
    for key in &feed.trusted_keys {
        let bytes = decode_hex(key)
            .ok_or_else(|| format!("{name} trusted key `{key}` is not hex-encoded"))?;
        if bytes.len() != 32 {
            return Err(format!(
                "{name} trusted key `{key}` must be 32 bytes (64 hex characters), found {}",
                bytes.len()
            ));
        }
    }
    Ok(())
}

/// Whether `origin` is a bare `host` or `host:port` with no scheme, path, user
/// info, or wildcard. Wildcards are rejected deliberately: an allow list that
/// can be widened by a single character is not an allow list.
fn is_valid_origin(origin: &str) -> bool {
    let origin = origin.trim();
    if origin.is_empty() || origin != origin.to_ascii_lowercase() {
        return false;
    }
    if origin.contains(['/', '\\', '@', '*', '?', '#', ' ']) {
        return false;
    }
    let (host, port) = match origin.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (origin, None),
    };
    if host.is_empty() {
        return false;
    }
    if let Some(port) = port {
        if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
        match port.parse::<u16>() {
            Ok(0) | Err(_) => return false,
            Ok(_) => {}
        }
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

/// Exact host[:port] membership test against an allow list.
pub fn origin_is_allowed(allowed: &[String], url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let candidate = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
    .to_ascii_lowercase();
    allowed
        .iter()
        .any(|entry| entry.trim().to_ascii_lowercase() == candidate)
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
        return None;
    }
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(value.len() / 2);
    for pair in bytes.chunks(2) {
        let high = hex_digit(pair[0])?;
        let low = hex_digit(pair[1])?;
        out.push((high << 4) | low);
    }
    Some(out)
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Lowercase hex encoding (the wire form of digests and keys).
pub fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// SHA-256 of `bytes` in lowercase hex.
///
/// Test-only fixture construction: production hashes with bounded memory in
/// `update_flow` (streamed while downloading, then re-read at install time) and
/// never needs a whole-buffer digest.
#[cfg(test)]
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    encode_hex(&sha2::Sha256::digest(bytes))
}

/// Whether `value` is exactly a 64-character ASCII hex SHA-256 digest.
///
/// Every place a digest is *used* — the signed release message, the artifact
/// filename, and artifact admission — requires this shape first:
///
/// - the signed message is a `\n`-separated document, so a digest containing a
///   newline could otherwise smuggle a field into it;
/// - the artifact filename embeds a digest prefix, so a non-ASCII or over-long
///   value could otherwise select a path or panic a byte slice;
/// - a digest is only ever a hex encoding of 32 bytes, so any other length is a
///   malformed document rather than a release.
///
/// Deliberately strict about the whole string: no trimming, so surrounding
/// whitespace is a refusal rather than an accepted value with a stray byte.
pub fn is_valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

// ---------------------------------------------------------------------------
// Signature verification (Ed25519, RFC 8032)
// ---------------------------------------------------------------------------

/// The exact bytes a release signature covers.
///
/// Every field that decides *what is installed* is inside the signed message:
/// the version, the release channel, and the SHA-256 of the artifact. A
/// signature therefore cannot be replayed onto different bytes, a different
/// version, or across channels. The artifact URL is deliberately **excluded** so
/// an operator may move mirror hosts without re-signing; the artifact host is
/// still constrained by the allow list, not by the signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedRelease<'a> {
    pub version: &'a str,
    pub channel: &'a str,
    pub sha256: &'a str,
}

impl SignedRelease<'_> {
    /// Newline-free canonical message; the field names and separators are part
    /// of the signature contract and must not drift.
    pub fn message(&self) -> String {
        format!(
            "dsh-desktop-release/v1\nversion={}\nchannel={}\nsha256={}\n",
            self.version,
            self.channel,
            self.sha256.to_ascii_lowercase()
        )
    }
}

/// Why a release was refused. Each arm is a distinct, actionable condition; none
/// of them is "trust the manifest anyway".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyFailure {
    /// The packaged configuration carries no key for this channel.
    NoTrustedKeys,
    /// The manifest carries no `signature` field.
    MissingSignature,
    /// The manifest carries no `sha256` field.
    MissingDigest,
    /// The digest is present but is not exactly 64 ASCII hex characters, so it
    /// cannot be a SHA-256 and must not reach the signed message or a filename.
    MalformedDigest,
    /// The supplied key is not 32 hex-encoded bytes.
    MalformedKey(String),
    /// The supplied signature is not 64 hex-encoded bytes.
    MalformedSignature,
    /// The signature does not verify against the signed message.
    InvalidSignature,
    /// The document's schema marker is not the v2 marker this build reads.
    ///
    /// This is the arm a v1 message produces when it is presented where v2 is
    /// required. It is a refusal on purpose: an unrecognized schema is never
    /// retried with an older, weaker verifier, and an older schema is never
    /// silently accepted because a newer one failed.
    #[cfg(any(test, updater_probe))]
    UnsupportedSchema { found: String },
    /// The document is not the canonical v2 line structure: a wrong, missing,
    /// duplicated, or extra field, a value outside the token alphabet, an
    /// unparseable number, or an expiry that cannot be an instant. `reason` is
    /// bounded and names the offending field.
    #[cfg(any(test, updater_probe))]
    MalformedReleaseDocument { reason: String },
    /// The artifact kind token is not one this contract defines.
    #[cfg(any(test, updater_probe))]
    UnsupportedArtifactKind { found: String },
    /// The signed document authorizes a different product.
    #[cfg(any(test, updater_probe))]
    WrongProduct { expected: String, found: String },
    /// The signed document authorizes a different platform.
    #[cfg(any(test, updater_probe))]
    WrongPlatform { expected: String, found: String },
    /// The signed document authorizes a different CPU architecture.
    #[cfg(any(test, updater_probe))]
    WrongArchitecture { expected: String, found: String },
    /// The signed document authorizes a different class of artifact.
    #[cfg(any(test, updater_probe))]
    WrongArtifactKind {
        expected: ReleaseArtifactKind,
        found: ReleaseArtifactKind,
    },
    /// The metadata's expiry has passed beyond the bounded clock tolerance.
    ///
    /// Stale metadata is reported as stale. It says nothing about installation
    /// having succeeded, and expiry cannot force a blocked network to deliver
    /// anything.
    #[cfg(any(test, updater_probe))]
    MetadataExpired {
        expiry_unix_ms: i64,
        now_unix_ms: i64,
    },
    /// The metadata sequence is at or below the highest already admitted.
    #[cfg(any(test, updater_probe))]
    MetadataSequenceTooLow {
        floor_sequence: u64,
        found_sequence: u64,
    },
    /// The caller could not supply a plausible wall-clock instant.
    ///
    /// Refusing is the only safe answer: an unavailable clock must not read as
    /// "nothing has expired".
    #[cfg(any(test, updater_probe))]
    ClockUnavailable { now_unix_ms: i64 },
}

impl std::fmt::Display for VerifyFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoTrustedKeys => write!(
                formatter,
                "no trusted release signing key is packaged for this channel, so release provenance cannot be established"
            ),
            Self::MissingSignature => write!(
                formatter,
                "the release manifest carries no signature; a digest alone does not establish provenance"
            ),
            Self::MissingDigest => write!(
                formatter,
                "the release manifest carries no SHA-256 digest to bind the signature to"
            ),
            Self::MalformedDigest => write!(
                formatter,
                "the release SHA-256 digest is not exactly 64 ASCII hex characters"
            ),
            Self::MalformedKey(detail) => write!(formatter, "trusted key is unusable: {detail}"),
            Self::MalformedSignature => write!(
                formatter,
                "the release signature is not a 64-byte hex-encoded Ed25519 signature"
            ),
            Self::InvalidSignature => write!(
                formatter,
                "the release signature does not verify for this version, channel, and artifact digest"
            ),
            #[cfg(any(test, updater_probe))]
            Self::UnsupportedSchema { found } => write!(
                formatter,
                "the release metadata schema `{found}` is not `{RELEASE_V2_SCHEMA_MARKER}`, so it cannot be read; a different schema is never accepted in place of the one this build verifies"
            ),
            #[cfg(any(test, updater_probe))]
            Self::MalformedReleaseDocument { reason } => {
                write!(formatter, "the release metadata is not canonical: {reason}")
            }
            #[cfg(any(test, updater_probe))]
            Self::UnsupportedArtifactKind { found } => write!(
                formatter,
                "artifact kind `{found}` is not one this build can install"
            ),
            #[cfg(any(test, updater_probe))]
            Self::WrongProduct { expected, found } => write!(
                formatter,
                "the release is signed for product `{found}`, not `{expected}`"
            ),
            #[cfg(any(test, updater_probe))]
            Self::WrongPlatform { expected, found } => write!(
                formatter,
                "the release is signed for platform `{found}`, not `{expected}`"
            ),
            #[cfg(any(test, updater_probe))]
            Self::WrongArchitecture { expected, found } => write!(
                formatter,
                "the release is signed for architecture `{found}`, not `{expected}`"
            ),
            #[cfg(any(test, updater_probe))]
            Self::WrongArtifactKind { expected, found } => write!(
                formatter,
                "the release authorizes a `{}` artifact, not a `{}`",
                found.as_str(),
                expected.as_str()
            ),
            #[cfg(any(test, updater_probe))]
            Self::MetadataExpired {
                expiry_unix_ms,
                now_unix_ms,
            } => write!(
                formatter,
                "the release metadata expired at {expiry_unix_ms} (Unix ms) and the clock now reads {now_unix_ms}, beyond the tolerated skew; the manifest is stale and must not be installed"
            ),
            #[cfg(any(test, updater_probe))]
            Self::MetadataSequenceTooLow {
                floor_sequence,
                found_sequence,
            } => write!(
                formatter,
                "the release metadata sequence {found_sequence} is not newer than the {floor_sequence} this installation already admitted, so it is a rollback"
            ),
            #[cfg(any(test, updater_probe))]
            Self::ClockUnavailable { now_unix_ms } => write!(
                formatter,
                "no usable clock is available (the caller reported {now_unix_ms} ms since the Unix epoch), so release freshness cannot be established and the release is refused"
            ),
        }
    }
}

/// Why a candidate's identity cannot be rendered as an artifact filename.
///
/// The filename is derived from the candidate the signature authenticated, so
/// the derivation is a security boundary: a digest that is not 64 ASCII hex
/// characters, or a channel/version carrying a path separator or a non-ASCII
/// byte, must be refused *before* any path is composed rather than panicking a
/// byte slice or selecting a file outside the artifact cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactNameFailure {
    /// The digest is not exactly 64 ASCII hex characters.
    DigestNotSha256Hex,
    /// The channel or version is not a safe single path component.
    UnsafeIdentityComponent,
}

impl std::fmt::Display for ArtifactNameFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DigestNotSha256Hex => write!(
                formatter,
                "the candidate's SHA-256 digest is not exactly 64 ASCII hex characters"
            ),
            Self::UnsafeIdentityComponent => write!(
                formatter,
                "the candidate's channel or version is not a safe path component"
            ),
        }
    }
}

impl std::error::Error for ArtifactNameFailure {}

/// Whether `value` is a safe single path component: non-empty ASCII
/// alphanumerics plus `.`, `-`, `_` and `+`, and neither `.` nor `..`.
///
/// The permitted set covers everything a release channel (`stable`/`beta`) or a
/// SemVer 2.0.0 version can contain. `+` is the build-metadata separator, which
/// [`is_valid_semver`] admits (and ignores for precedence); refusing it here
/// would leave an admitted release unable to name its artifact file at all.
/// Everything excluded is a real path hazard: separators (`/`, `\`), NUL and
/// control characters, Windows-reserved punctuation, and any non-ASCII byte
/// (which would also break the byte-indexed slicing of a candidate identity).
/// The explicit `.`/`..` check is what makes traversal impossible even though
/// `.` is a legal character inside a component.
///
/// Candidate channels are normalized to `stable`/`beta` and versions are
/// validated SemVer before admission, so this is a defense in depth against a
/// future caller constructing an `UpdateCandidate` directly — a value that can
/// traverse out of the artifact cache is refused instead of being joined.
pub fn is_safe_path_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'+'))
}

/// Verify mandatory release provenance.
///
/// The digest match is *not* performed here; callers must already have matched
/// the artifact bytes against `release.sha256`. This function only answers
/// "was this exact `{version, channel, sha256}` triple signed by a packaged
/// trusted key". All three are required, so a hash-only manifest can never be
/// admitted.
pub fn verify_release(
    trusted_keys: &[String],
    release: &SignedRelease<'_>,
    signature_hex: Option<&str>,
) -> Result<(), VerifyFailure> {
    if trusted_keys.is_empty() {
        return Err(VerifyFailure::NoTrustedKeys);
    }
    let signature_hex = signature_hex
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(VerifyFailure::MissingSignature)?;
    if release.sha256.trim().is_empty() {
        return Err(VerifyFailure::MissingDigest);
    }
    // Shape before provenance: the digest is inside the signed message, so a
    // digest that is not 64 hex characters is refused here rather than being
    // signed over, embedded in a filename, or silently compared as bytes.
    if !is_valid_sha256(release.sha256) {
        return Err(VerifyFailure::MalformedDigest);
    }
    let signature = decode_hex(signature_hex).ok_or(VerifyFailure::MalformedSignature)?;
    let signature: [u8; 64] = signature
        .try_into()
        .map_err(|_| VerifyFailure::MalformedSignature)?;
    let message = release.message();
    for key in trusted_keys {
        let bytes = decode_hex(key.trim())
            .ok_or_else(|| VerifyFailure::MalformedKey(format!("`{key}` is not hex")))?;
        let key: [u8; 32] = bytes
            .try_into()
            .map_err(|_| VerifyFailure::MalformedKey(format!("`{key}` is not 32 bytes")))?;
        if ed25519_verify(&key, message.as_bytes(), &signature) {
            return Ok(());
        }
    }
    Err(VerifyFailure::InvalidSignature)
}

/// Verify a release signature with the maintained ring Ed25519 implementation.
pub fn ed25519_verify(public_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, public_key)
        .verify(message, signature)
        .is_ok()
}

// ---------------------------------------------------------------------------
// The v2 signed release contract: target binding, freshness, anti-rollback
// ---------------------------------------------------------------------------
//
// WHY THIS SECTION EXISTS, AND WHY IT IS NOT AUTHORITATIVE YET.
//
// The v1 message ([`SignedRelease`]) binds a version, a channel, and an artifact
// digest. It does not say which product, platform, architecture, or class of
// artifact those bytes are for, when the metadata stops being current, or how one
// manifest orders against the last one this installation admitted. A signature
// over v1 is therefore replayable onto the same digest presented as a different
// target, and a manifest never becomes stale.
//
// [`SignedReleaseV2`] adds exactly those bindings. It is defined and tested here
// and it is deliberately **not authoritative**: [`verify_release`] is unchanged,
// every caller (including `update_flow.rs`) still admits releases through v1, and
// no packaged build presents a v2 document to anything. Making v2 the verifier is
// the next increment, and it must publish and verify together
// (`port-fix-plan-2026-10-10.md` milestone 4, change 6).
//
// Refusing an unknown schema is a refusal, never a downgrade: an unrecognized
// marker is [`VerifyFailure::UnsupportedSchema`], and no path in this module
// retries a v2 document with the weaker v1 message.

/// The v2 signed release contract, compiled for tests and the headless probe.
///
/// WHY THIS IS GATED. The contract is defined and tested here before anything
/// admits a release through it. Verification surface that nothing in the shipped
/// shell consumes would be dead code in the production library, which this
/// workspace denies as a warning, and silencing that with an `allow` would hide
/// the very fact worth stating. The gate instead makes "v2 is not authoritative
/// yet" something the compiler enforces rather than a sentence in a comment. The
/// increment that admits releases through v2 removes the gate and the wiring
/// together, so they cannot drift apart; until then the shipped enum keeps
/// exactly the v1 vocabulary it had.
#[cfg(any(test, updater_probe))]
mod signed_release_v2 {
    use super::*;

    /// The first line of a canonical v2 signed message.
    ///
    /// The marker *is* the schema negotiation. A verifier that does not recognize it
    /// refuses, so a later schema can never be read as v2 by accident, and a v2
    /// document can never be read as the weaker v1.
    pub const RELEASE_V2_SCHEMA_MARKER: &str = "dsh-desktop-release/v2";

    /// The product every release of this application signs as.
    ///
    /// A stable identifier rather than a display name: the shell's binary is
    /// `dsh-desktop` (`port/src-tauri/app/Cargo.toml`), so a signature over this
    /// value cannot be replayed onto a different product that happens to share a
    /// version, a channel, and a digest.
    pub const RELEASE_PRODUCT_ID: &str = "dsh-desktop";

    /// Bounded leeway for a local clock that runs behind the publisher's.
    ///
    /// A device whose clock is a few minutes slow would otherwise refuse metadata
    /// that is still current. The leeway is small and one-sided: metadata is accepted
    /// until `expiry + this` and no further, so it can never turn an expired manifest
    /// into a permanently valid one. It is a tolerance on reading a local clock, not
    /// a claim that the clock is trustworthy.
    pub const RELEASE_METADATA_CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;

    /// The earliest instant this contract treats as a usable clock.
    ///
    /// 2020-09-13T12:26:40Z, which precedes every release this product has published.
    /// A caller that cannot obtain a plausible wall-clock instant - no clock, a
    /// failed read, an unset field - must pass a value below this floor, and the
    /// verifier refuses with [`VerifyFailure::ClockUnavailable`]. "I do not know what
    /// time it is" must never be answered with "then nothing has expired".
    pub const RELEASE_METADATA_CLOCK_FLOOR_UNIX_MS: i64 = 1_600_000_000_000;

    /// The only schema version a [`ReleaseFloor`] document is read or written as.
    pub const RELEASE_FLOOR_SCHEMA_VERSION: u32 = 1;

    /// Largest floor document accepted, so a corrupt or hostile file is never read
    /// into memory without a bound.
    ///
    /// Public within the gated module so the suite exercises the bound itself
    /// rather than a copy of its value.
    pub const RELEASE_FLOOR_MAX_BYTES: u64 = 4096;

    /// Longest fragment of input this module repeats back inside an error.
    ///
    /// Refusals reach logs, dialogs, and evidence summaries, so an error must not
    /// carry a whole attacker-supplied document with it.
    const RELEASE_ERROR_FRAGMENT_CHARS: usize = 64;

    /// A bounded, printable rendering of attacker-supplied input for an error value.
    ///
    /// Control characters are replaced rather than passed through: error text is
    /// written to line-oriented logs, and a document must not be able to forge log
    /// lines through a refusal.
    fn bounded_fragment(value: &str) -> String {
        value
            .chars()
            .take(RELEASE_ERROR_FRAGMENT_CHARS)
            .map(|character| {
                if character.is_ascii_graphic() || character == ' ' {
                    character
                } else {
                    '.'
                }
            })
            .collect()
    }

    /// Whether `value` is a canonical field value: non-empty ASCII alphanumerics plus
    /// `.`, `-`, `_` and `+`.
    ///
    /// The permitted set covers every token this contract names - `dsh-desktop`,
    /// `desktop-win`, `x64`, `installer`, `runtime-payload`, a SemVer version, a
    /// channel, a hex digest, and the two decimal numbers - and excludes every byte
    /// that could disturb the line structure. A value can therefore never contain a
    /// newline, a carriage return, a space, or a second `=`, which is what makes the
    /// signed document unambiguous without an escaping rule.
    ///
    /// Production surface as well as test surface: the suite asserts that every
    /// token [`ReleaseTarget`] can emit is itself canonical, so a token added later
    /// cannot be one the parser would refuse.
    pub fn is_canonical_release_value(value: &str) -> bool {
        !value.is_empty()
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'+')
            })
    }

    /// Which class of artifact a signed release authorizes.
    ///
    /// v1 cannot express this: one digest and one version describe the combined
    /// installer, and nothing stops those same fields from being presented where a
    /// runtime payload is expected. Naming the kind inside the signed message makes
    /// "this signature authorizes this class of artifact" a property of the
    /// signature instead of a convention at the call site.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum ReleaseArtifactKind {
        /// The combined native installer: the shell plus its bundled runtime.
        Installer,
        /// A runtime payload delivered on its own, once that channel exists.
        RuntimePayload,
    }

    impl ReleaseArtifactKind {
        /// The canonical token this kind contributes to the signed message.
        pub fn as_str(self) -> &'static str {
            match self {
                Self::Installer => "installer",
                Self::RuntimePayload => "runtime-payload",
            }
        }

        /// Parse a canonical token; an unknown token is `None`.
        ///
        /// `None` becomes a refusal at the document parser rather than a default, so
        /// a kind this contract does not define is never read as "some v2 kind".
        pub fn parse(value: &str) -> Option<Self> {
            match value {
                "installer" => Some(Self::Installer),
                "runtime-payload" => Some(Self::RuntimePayload),
                _ => None,
            }
        }
    }

    /// The exact bytes a v2 release signature covers.
    ///
    /// Canonical form, with the field names, their order, and the trailing newline
    /// pinned by test:
    ///
    /// ```text
    /// dsh-desktop-release/v2
    /// product=<product>
    /// platform=<platform>
    /// arch=<architecture>
    /// kind=<artifact kind>
    /// version=<release version>
    /// channel=<channel>
    /// sha256=<64 lowercase ASCII hex>
    /// sequence=<metadata sequence, decimal u64>
    /// expiry=<expiry, Unix milliseconds, decimal i64>
    /// ```
    ///
    /// Nothing is trimmed and no field is normalized, so the document a publisher
    /// signs is byte-for-byte the document a verifier reads: a changed byte either
    /// breaks the line structure (a refusal) or changes [`Self::message`] (a
    /// signature failure). The digest is required in lowercase canonical form rather
    /// than case-folded at verification time, for the same reason.
    ///
    /// The artifact URL is deliberately absent, as in v1, so a mirror move needs no
    /// re-signing; the feed's allow list still constrains the host.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct SignedReleaseV2 {
        /// Product identifier; must equal [`RELEASE_PRODUCT_ID`] for this product.
        pub product: String,
        /// Platform token, canonicalized by [`ReleaseTarget::platform_token`].
        pub platform: String,
        /// Architecture token, canonicalized by [`ReleaseTarget::arch_token`].
        pub arch: String,
        /// The class of artifact this signature authorizes.
        pub artifact_kind: ReleaseArtifactKind,
        /// SemVer of the release the signature authorizes.
        pub version: String,
        /// Release channel the signature is bound to.
        pub channel: String,
        /// SHA-256 of the artifact bytes, 64 lowercase ASCII hex characters.
        pub sha256: String,
        /// Authenticated metadata sequence, used for anti-rollback. A later manifest
        /// must carry a strictly greater value than the persisted floor.
        pub metadata_sequence: u64,
        /// Unix milliseconds after which this metadata is stale.
        pub expiry_unix_ms: i64,
    }

    /// The canonical line count of a v2 document: the marker, nine fields, and the
    /// empty element a trailing newline produces when the text is split.
    const RELEASE_V2_LINE_COUNT: usize = 11;

    /// The nine v2 field names, in the order the signature covers them.
    const RELEASE_V2_FIELD_KEYS: [&str; 9] = [
        "product", "platform", "arch", "kind", "version", "channel", "sha256", "sequence", "expiry",
    ];

    impl SignedReleaseV2 {
        /// The canonical message these values sign, and the exact bytes a verifier
        /// must see.
        ///
        /// The v1 doc comment called its message "newline-free" while the format uses
        /// newlines as separators; what that meant, and what holds here, is that no
        /// *field value* can contain a line separator. [`Self::parse`] enforces that
        /// alphabet, so the line structure cannot be forged from a value.
        pub fn message(&self) -> String {
            format!(
            "dsh-desktop-release/v2\nproduct={product}\nplatform={platform}\narch={arch}\nkind={kind}\nversion={version}\nchannel={channel}\nsha256={sha256}\nsequence={sequence}\nexpiry={expiry}\n",
            product = self.product,
            platform = self.platform,
            arch = self.arch,
            kind = self.artifact_kind.as_str(),
            version = self.version,
            channel = self.channel,
            sha256 = self.sha256,
            sequence = self.metadata_sequence,
            expiry = self.expiry_unix_ms,
        )
        }

        /// Parse one canonical v2 document.
        ///
        /// The structure is checked positionally: the marker line, then exactly the
        /// nine [`RELEASE_V2_FIELD_KEYS`] in order, then the empty tail a trailing
        /// newline leaves. A reordered field, an extra or duplicated field, a blank
        /// line, or a final line without a newline is therefore a refusal rather than
        /// a normalization - which is what keeps [`Self::message`] equal to the input
        /// bytes, so the signature check is over exactly what the publisher signed.
        ///
        /// A document whose marker is not [`RELEASE_V2_SCHEMA_MARKER`] - including a
        /// v1 message - is [`VerifyFailure::UnsupportedSchema`]; it is never retried
        /// with an older schema.
        pub fn parse(document: &str) -> Result<Self, VerifyFailure> {
            let lines: Vec<&str> = document.split('\n').collect();
            let marker = lines.first().copied().unwrap_or_default();
            if marker != RELEASE_V2_SCHEMA_MARKER {
                return Err(VerifyFailure::UnsupportedSchema {
                    found: bounded_fragment(marker),
                });
            }
            if lines.len() != RELEASE_V2_LINE_COUNT || !lines[RELEASE_V2_LINE_COUNT - 1].is_empty()
            {
                return Err(VerifyFailure::MalformedReleaseDocument {
                    reason: "the document is not the canonical v2 line structure".to_string(),
                });
            }
            let mut values = [""; 9];
            for (index, key) in RELEASE_V2_FIELD_KEYS.iter().enumerate() {
                let line = lines[index + 1];
                let Some((found_key, value)) = line.split_once('=') else {
                    return Err(VerifyFailure::MalformedReleaseDocument {
                        reason: format!("line {} is not a `key=value` field", index + 2),
                    });
                };
                if found_key != *key {
                    return Err(VerifyFailure::MalformedReleaseDocument {
                        reason: format!(
                            "line {} names `{}` where `{key}` is required",
                            index + 2,
                            bounded_fragment(found_key)
                        ),
                    });
                }
                values[index] = value;
            }
            let [product, platform, arch, kind, version, channel, sha256, sequence, expiry] =
                values;
            for (name, value) in [
                ("product", product),
                ("platform", platform),
                ("arch", arch),
                ("version", version),
                ("channel", channel),
            ] {
                if !is_canonical_release_value(value) {
                    return Err(VerifyFailure::MalformedReleaseDocument {
                        reason: format!("field `{name}` is not a canonical ASCII token"),
                    });
                }
            }
            // A digest is the one field whose absence and malformation are separate,
            // actionable conditions: an installer with no digest to check is a
            // different defect from a digest that is not a SHA-256.
            if sha256.is_empty() {
                return Err(VerifyFailure::MissingDigest);
            }
            if !is_valid_sha256(sha256) || sha256.bytes().any(|byte| byte.is_ascii_uppercase()) {
                return Err(VerifyFailure::MalformedDigest);
            }
            let artifact_kind = ReleaseArtifactKind::parse(kind).ok_or_else(|| {
                VerifyFailure::UnsupportedArtifactKind {
                    found: bounded_fragment(kind),
                }
            })?;
            let metadata_sequence =
                sequence
                    .parse::<u64>()
                    .map_err(|_| VerifyFailure::MalformedReleaseDocument {
                        reason: "field `sequence` is not a decimal u64".to_string(),
                    })?;
            let expiry_unix_ms =
                expiry
                    .parse::<i64>()
                    .map_err(|_| VerifyFailure::MalformedReleaseDocument {
                        reason: "field `expiry` is not a decimal i64".to_string(),
                    })?;
            if expiry_unix_ms <= 0 {
                return Err(VerifyFailure::MalformedReleaseDocument {
                    reason: "field `expiry` is not a plausible instant".to_string(),
                });
            }
            Ok(Self {
                product: product.to_string(),
                platform: platform.to_string(),
                arch: arch.to_string(),
                artifact_kind,
                version: version.to_string(),
                channel: channel.to_string(),
                sha256: sha256.to_string(),
                metadata_sequence,
                expiry_unix_ms,
            })
        }
    }

    /// The build a signed release must name to be installable here.
    ///
    /// Platform and architecture reuse [`PolicyPlatform`] and [`PolicyArch`], the
    /// same types the installed-client policy identity reports, so one running build
    /// presents one platform/architecture vocabulary to both the release feed and the
    /// policy service; the token methods are pinned by test to
    /// `DesktopPolicyIdentity`'s header values. The derivation from
    /// `std::env::consts::OS`/`ARCH` mirrors `policy_bootstrap::native_target`, which
    /// cannot be called from here: this module is compiled on its own by the updater
    /// probe and must not depend on the app shell's module tree.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ReleaseTarget {
        /// Product identifier the document must carry ([`RELEASE_PRODUCT_ID`]).
        pub product: &'static str,
        /// Platform this build was produced for.
        pub platform: PolicyPlatform,
        /// CPU architecture this build was produced for.
        pub arch: PolicyArch,
    }

    impl ReleaseTarget {
        /// The target of the build this process is running.
        ///
        /// `None` when this product does not ship for the host: an unrecognized
        /// platform or architecture must produce a refusal at the caller, never a
        /// guessed target that another platform's signed manifest could satisfy. The
        /// `Win32`/`Arm64` combination is refused here as well, because it is the one
        /// combination the installer never produces and `DesktopPolicyIdentity`
        /// already rejects (`mandatory_update.rs`). Linux is absent for the same
        /// reason [`PolicyPlatform`] has no Linux variant: the runtime payload names
        /// a linux target, but a `linux` string cannot be formed from these types.
        pub fn for_running_build() -> Option<Self> {
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
            if platform == PolicyPlatform::Win32 && arch != PolicyArch::X64 {
                return None;
            }
            Some(Self {
                product: RELEASE_PRODUCT_ID,
                platform,
                arch,
            })
        }

        /// The canonical platform token a signed message must carry.
        pub fn platform_token(self) -> &'static str {
            match self.platform {
                PolicyPlatform::Win32 => "desktop-win",
                PolicyPlatform::Darwin => "desktop-mac",
            }
        }

        /// The canonical architecture token a signed message must carry.
        pub fn arch_token(self) -> &'static str {
            match self.arch {
                PolicyArch::X64 => "x64",
                PolicyArch::Arm64 => "arm64",
            }
        }
    }

    /// Everything one v2 admission decision depends on.
    ///
    /// The clock and the persisted floor are parameters rather than ambient reads, so
    /// [`verify_release_v2`] touches neither the filesystem nor the system clock: an
    /// admission is reproducible in a test, and a caller cannot silently skip the
    /// floor it persisted.
    #[derive(Debug, Clone, Copy)]
    pub struct ReleaseAdmissionV2<'a> {
        /// Target the running build requires the document to name.
        pub target: &'a ReleaseTarget,
        /// Artifact class this admission is for.
        pub artifact_kind: ReleaseArtifactKind,
        /// The caller's wall-clock instant in Unix milliseconds. A value below
        /// [`RELEASE_METADATA_CLOCK_FLOOR_UNIX_MS`] means "no usable clock" and
        /// refuses.
        pub now_unix_ms: i64,
        /// Highest metadata sequence already admitted, when one is persisted.
        pub floor: Option<&'a ReleaseFloor>,
    }

    /// The values a v2 signature authenticated, on the `Ok` path only.
    ///
    /// Deliberately a different type from [`SignedReleaseV2`]: a caller that has a
    /// `VerifiedReleaseV2` cannot pair "this document verified" with fields read from
    /// somewhere else, which is the property the module's "one immutable candidate
    /// per operation" rule depends on.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct VerifiedReleaseV2 {
        /// Authenticated product identifier.
        pub product: String,
        /// Authenticated platform token.
        pub platform: String,
        /// Authenticated architecture token.
        pub arch: String,
        /// Authenticated artifact class.
        pub artifact_kind: ReleaseArtifactKind,
        /// Authenticated release version.
        pub version: String,
        /// Authenticated release channel.
        pub channel: String,
        /// Authenticated SHA-256 of the artifact bytes.
        pub sha256: String,
        /// Authenticated metadata sequence.
        pub metadata_sequence: u64,
        /// Authenticated expiry, Unix milliseconds.
        pub expiry_unix_ms: i64,
    }

    /// Verify one v2 release document and bind it to this build.
    ///
    /// The order of the checks is part of the contract, because it decides which
    /// refusal a caller sees and, more importantly, that no *policy* decision is made
    /// about an unauthenticated document:
    ///
    /// 1. no packaged key for the channel refuses with
    ///    [`VerifyFailure::NoTrustedKeys`], before the document is even read;
    /// 2. the document must parse as canonical v2, which covers the schema, the
    ///    field structure, the artifact kind token, and the digest shape;
    /// 3. the signature must be present, well formed, and verify over the exact
    ///    document bytes;
    /// 4. only then are the target bindings compared;
    /// 5. then the clock floor, the expiry, and the persisted sequence floor.
    ///
    /// `now_unix_ms` is supplied by the caller and never read here: see
    /// [`RELEASE_METADATA_CLOCK_SKEW_MS`] for the bounded tolerance and
    /// [`RELEASE_METADATA_CLOCK_FLOOR_UNIX_MS`] for what an unusable clock does.
    /// Expiry reports stale metadata; it cannot make a blocked network deliver an
    /// update, and a refusal here never claims that anything was installed.
    ///
    /// The channel is bound inside the signature but is not compared against a
    /// selected channel here: choosing which channel's document to admit remains the
    /// caller's existing selection logic, which this increment does not change.
    pub fn verify_release_v2(
        trusted_keys: &[String],
        document: &str,
        signature_hex: Option<&str>,
        admission: &ReleaseAdmissionV2<'_>,
    ) -> Result<VerifiedReleaseV2, VerifyFailure> {
        if trusted_keys.is_empty() {
            return Err(VerifyFailure::NoTrustedKeys);
        }
        let release = SignedReleaseV2::parse(document)?;
        let signature_hex = signature_hex
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(VerifyFailure::MissingSignature)?;
        let signature = decode_hex(signature_hex).ok_or(VerifyFailure::MalformedSignature)?;
        let signature: [u8; 64] = signature
            .try_into()
            .map_err(|_| VerifyFailure::MalformedSignature)?;
        let message = release.message();
        let mut authenticated = false;
        for key in trusted_keys {
            let bytes = decode_hex(key.trim())
                .ok_or_else(|| VerifyFailure::MalformedKey(format!("`{key}` is not hex")))?;
            let key: [u8; 32] = bytes
                .try_into()
                .map_err(|_| VerifyFailure::MalformedKey(format!("`{key}` is not 32 bytes")))?;
            if ed25519_verify(&key, message.as_bytes(), &signature) {
                authenticated = true;
                break;
            }
        }
        if !authenticated {
            return Err(VerifyFailure::InvalidSignature);
        }
        // Past this point every field below was covered by the signature, so a
        // mismatch is a statement about an authentic document rather than about
        // attacker-chosen bytes.
        if release.product != admission.target.product {
            return Err(VerifyFailure::WrongProduct {
                expected: admission.target.product.to_string(),
                found: bounded_fragment(&release.product),
            });
        }
        if release.platform != admission.target.platform_token() {
            return Err(VerifyFailure::WrongPlatform {
                expected: admission.target.platform_token().to_string(),
                found: bounded_fragment(&release.platform),
            });
        }
        if release.arch != admission.target.arch_token() {
            return Err(VerifyFailure::WrongArchitecture {
                expected: admission.target.arch_token().to_string(),
                found: bounded_fragment(&release.arch),
            });
        }
        if release.artifact_kind != admission.artifact_kind {
            return Err(VerifyFailure::WrongArtifactKind {
                expected: admission.artifact_kind,
                found: release.artifact_kind,
            });
        }
        if admission.now_unix_ms < RELEASE_METADATA_CLOCK_FLOOR_UNIX_MS {
            return Err(VerifyFailure::ClockUnavailable {
                now_unix_ms: admission.now_unix_ms,
            });
        }
        // Saturating rather than wrapping: an absurd expiry must not panic a debug
        // build, and a signed far-future expiry simply never expires.
        let latest = release
            .expiry_unix_ms
            .saturating_add(RELEASE_METADATA_CLOCK_SKEW_MS);
        if admission.now_unix_ms > latest {
            return Err(VerifyFailure::MetadataExpired {
                expiry_unix_ms: release.expiry_unix_ms,
                now_unix_ms: admission.now_unix_ms,
            });
        }
        if let Some(floor) = admission.floor {
            if release.metadata_sequence <= floor.metadata_sequence {
                return Err(VerifyFailure::MetadataSequenceTooLow {
                    floor_sequence: floor.metadata_sequence,
                    found_sequence: release.metadata_sequence,
                });
            }
        }
        Ok(VerifiedReleaseV2 {
            product: release.product,
            platform: release.platform,
            arch: release.arch,
            artifact_kind: release.artifact_kind,
            version: release.version,
            channel: release.channel,
            sha256: release.sha256,
            metadata_sequence: release.metadata_sequence,
            expiry_unix_ms: release.expiry_unix_ms,
        })
    }

    // ---------------------------------------------------------------------------
    // Persisted anti-rollback floor
    // ---------------------------------------------------------------------------

    /// The highest metadata sequence, and the release it admitted, that this
    /// installation has already accepted.
    ///
    /// Rollback protection needs one durable fact that only ever moves forward. The
    /// floor is that fact: a candidate whose authenticated sequence is at or below it
    /// is refused, so an operator who can serve an older but correctly signed
    /// manifest cannot walk an installation backwards.
    ///
    /// WHAT THIS DOES NOT DEFEND AGAINST, STATED PLAINLY. The floor lives in a
    /// user-writable location, and the same user's malware can rewrite it. It
    /// protects the update protocol against replay of genuine older metadata; it is
    /// not a defence against an attacker who already executes as this user. The plan
    /// says the same about the application and the trust store generally
    /// (`port-fix-plan-2026-10-10.md` milestone 4, change 7).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ReleaseFloor {
        /// Highest metadata sequence already admitted.
        pub metadata_sequence: u64,
        /// The release version that sequence admitted, recorded for diagnostics so a
        /// reader can tell which release the floor belongs to.
        pub release_version: String,
    }

    /// The on-disk floor document. Private: callers read and write [`ReleaseFloor`],
    /// never this shape, so the file format can gain a field without changing the
    /// public type.
    #[derive(Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ReleaseFloorDocument {
        schema_version: u32,
        metadata_sequence: u64,
        release_version: String,
    }

    /// Why persisted anti-rollback state could not be read or written.
    ///
    /// Separate from [`VerifyFailure`] because these are I/O and format conditions
    /// rather than statements about a release document, and because every caller of
    /// the floor must treat all of them as "refuse to admit anything new": an
    /// unreadable floor is not an absent floor.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum FloorFailure {
        /// The floor file exists but could not be read.
        ReadFailed { path: String, reason: String },
        /// The floor file exists but is not the canonical floor document: not a
        /// regular file, larger than the contract allows, or not valid JSON of the
        /// expected schema. A refused floor is never reinterpreted as "no floor".
        Unusable { path: String, reason: String },
        /// The floor file could not be created. [`ReleaseFloor::save_to`] creates
        /// exclusively, so an existing file is reported here rather than replaced.
        WriteFailed { path: String, reason: String },
    }

    impl std::fmt::Display for FloorFailure {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::ReadFailed { path, reason } => write!(
                    formatter,
                    "the persisted anti-rollback floor at {path} could not be read: {reason}"
                ),
                Self::Unusable { path, reason } => write!(
                    formatter,
                    "the persisted anti-rollback floor at {path} is unusable: {reason}"
                ),
                Self::WriteFailed { path, reason } => write!(
                    formatter,
                    "the persisted anti-rollback floor at {path} could not be created: {reason}"
                ),
            }
        }
    }

    impl std::error::Error for FloorFailure {}

    /// Create a new private file, exclusively and owner-only where the platform
    /// expresses that through the standard library.
    ///
    /// `create_new` is `O_CREAT|O_EXCL`: it never truncates and never follows an
    /// existing name, so a floor can never be silently lowered by writing over one,
    /// and a pre-planted symlink is a refusal rather than a redirection. On Unix the
    /// creation mode is `0o600`, mirroring how this repository already writes private
    /// state (`dev_handoff.rs`).
    ///
    /// On Windows the standard library exposes no way to attach a DACL to a newly
    /// created file, so the file inherits its parent directory's ACL. The
    /// creation-time owner-only DACL this tree uses elsewhere needs the `windows`
    /// crate, which this module cannot depend on because the updater probe compiles
    /// it standalone without the app shell's dependencies. The Windows per-file ACL
    /// is therefore an explicit gap for the increment that wires the floor, and the
    /// floor must be written into a directory whose ACL already excludes other users.
    fn create_owner_only_new(path: &std::path::Path) -> std::io::Result<std::fs::File> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path)
    }

    impl ReleaseFloor {
        /// Record a sequence and the release version it admitted.
        pub fn new(metadata_sequence: u64, release_version: impl Into<String>) -> Self {
            Self {
                metadata_sequence,
                release_version: release_version.into(),
            }
        }

        /// Whether a candidate sequence must be refused against this floor.
        ///
        /// "At or below" rather than "below": replaying the exact manifest this
        /// installation already admitted is a rollback too, and it is the cheapest
        /// replay an attacker can mount.
        pub fn refuses(&self, metadata_sequence: u64) -> bool {
            metadata_sequence <= self.metadata_sequence
        }

        /// Read the floor from `path`, or report that none is persisted.
        ///
        /// `Ok(None)` means the file does not exist. Every other condition -
        /// unreadable, a directory or other non-regular entry, oversized, malformed,
        /// or carrying a schema version this build does not know - is a
        /// [`FloorFailure`], never an absent floor: a caller that cannot read the
        /// floor must refuse to admit anything new rather than start from zero.
        pub fn load_from(path: &std::path::Path) -> Result<Option<Self>, FloorFailure> {
            let path_text = path.display().to_string();
            // Classify the directory entry itself rather than its target, mirroring
            // `load_trust_config`: a dangling symlink is not an absent file.
            match std::fs::symlink_metadata(path) {
                Ok(metadata) => {
                    if !metadata.file_type().is_file() {
                        return Err(FloorFailure::Unusable {
                            path: path_text,
                            reason: "the entry is not a regular file".to_string(),
                        });
                    }
                    if metadata.len() > RELEASE_FLOOR_MAX_BYTES {
                        return Err(FloorFailure::Unusable {
                        path: path_text,
                        reason: format!(
                            "the document is {} bytes, above the {RELEASE_FLOOR_MAX_BYTES}-byte contract",
                            metadata.len()
                        ),
                    });
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => {
                    return Err(FloorFailure::ReadFailed {
                        path: path_text,
                        reason: error.to_string(),
                    })
                }
            }
            let text = std::fs::read_to_string(path).map_err(|error| FloorFailure::ReadFailed {
                path: path_text.clone(),
                reason: error.to_string(),
            })?;
            let document: ReleaseFloorDocument =
                serde_json::from_str(&text).map_err(|error| FloorFailure::Unusable {
                    path: path_text.clone(),
                    reason: error.to_string(),
                })?;
            if document.schema_version != RELEASE_FLOOR_SCHEMA_VERSION {
                return Err(FloorFailure::Unusable {
                    path: path_text,
                    reason: format!(
                        "schemaVersion {} is not the supported {RELEASE_FLOOR_SCHEMA_VERSION}",
                        document.schema_version
                    ),
                });
            }
            if document.release_version.is_empty() {
                return Err(FloorFailure::Unusable {
                    path: path_text,
                    reason: "releaseVersion is empty".to_string(),
                });
            }
            Ok(Some(Self {
                metadata_sequence: document.metadata_sequence,
                release_version: document.release_version,
            }))
        }

        /// Write this floor to `path`, creating it exclusively.
        ///
        /// Advancing an existing floor is deliberately **not** performed here. The
        /// exclusive creation is what guarantees this call can never lower a floor
        /// that is already on disk: an existing file is a [`FloorFailure::WriteFailed`]
        /// rather than a replacement. A correct replacement needs an atomic
        /// create-then-swap strategy (`std::fs::rename` does not replace an existing
        /// file on Windows), which is a reviewed decision for the increment that
        /// actually advances the floor, not something to invent here untested.
        pub fn save_to(&self, path: &std::path::Path) -> Result<(), FloorFailure> {
            let path_text = path.display().to_string();
            let document = ReleaseFloorDocument {
                schema_version: RELEASE_FLOOR_SCHEMA_VERSION,
                metadata_sequence: self.metadata_sequence,
                release_version: self.release_version.clone(),
            };
            let bytes =
                serde_json::to_vec(&document).map_err(|error| FloorFailure::WriteFailed {
                    path: path_text.clone(),
                    reason: error.to_string(),
                })?;
            let mut file =
                create_owner_only_new(path).map_err(|error| FloorFailure::WriteFailed {
                    path: path_text.clone(),
                    reason: error.to_string(),
                })?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|error| FloorFailure::WriteFailed {
                    path: path_text,
                    reason: error.to_string(),
                })
        }
    }
}

/// The v2 contract's public surface, re-exported beside the v1 items.
///
/// The re-export is what keeps the probe's and the app's test builds resolving
/// the same names, `update_security::SignedReleaseV2` and
/// `update_security::verify_release_v2`, that the wiring increment will call.
#[cfg(any(test, updater_probe))]
pub use signed_release_v2::*;

// ---------------------------------------------------------------------------
// Release policy: HTTPS transport plan with explicit origin/redirect rules
// ---------------------------------------------------------------------------

/// One validated https request plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestPlan {
    pub url: Url,
    /// Hosts the response may be served from. A redirect is followed only to a
    /// host in this list, and only within the scheme limit below.
    pub allowed_origins: Vec<String>,
}

/// Why a request plan was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyFailure {
    /// No packaged trust configuration, or the channel has no feed.
    NoPackagedTrust(String),
    /// The URL is not absolute and parseable.
    MalformedUrl(String),
    /// Plain http (or any non-https scheme) is refused for both feed and
    /// artifact transport.
    InsecureScheme(String),
    /// The URL carries credentials, which would leak them to the host.
    UrlCredentials,
    /// The host is not in the packaged allow list.
    OriginNotAllowed(String),
    /// A redirect left the allow list.
    RedirectNotAllowed(String),
}

impl std::fmt::Display for PolicyFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoPackagedTrust(detail) => write!(
                formatter,
                "release delivery is disabled: {detail}"
            ),
            Self::MalformedUrl(url) => write!(formatter, "`{url}` is not an absolute URL"),
            Self::InsecureScheme(url) => {
                write!(formatter, "`{url}` does not use https, so it is refused")
            }
            Self::UrlCredentials => {
                write!(formatter, "the release URL embeds credentials, so it is refused")
            }
            Self::OriginNotAllowed(origin) => write!(
                formatter,
                "`{origin}` is not a packaged release origin for this channel"
            ),
            Self::RedirectNotAllowed(location) => write!(
                formatter,
                "the release server redirected to `{location}`, which is outside the packaged allow list"
            ),
        }
    }
}

/// Release delivery policy derived from one packaged channel definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleasePolicy {
    channel: String,
    feed_url: Url,
    allowed_origins: Vec<String>,
    trusted_keys: Vec<String>,
}

impl ReleasePolicy {
    /// Select the packaged definition for `channel`.
    ///
    /// `channel` is the *requested* channel. When the packaged configuration
    /// pins a channel (`pinnedChannel`), that pin wins and the request is
    /// refused; a deployment must not silently check a different channel than
    /// the one the user selected.
    pub fn select(config: &ReleaseTrustConfig, channel: &str) -> Result<Self, PolicyFailure> {
        if let Some(pinned) = config.pinned_channel.as_deref() {
            if pinned != channel {
                return Err(PolicyFailure::NoPackagedTrust(format!(
                    "this build is pinned to the `{pinned}` channel"
                )));
            }
        }
        let feed = match channel {
            "beta" => config.beta.as_ref(),
            _ => config.stable.as_ref(),
        }
        .ok_or_else(|| {
            PolicyFailure::NoPackagedTrust(format!("no packaged release source for `{channel}`"))
        })?;
        let feed_url = Url::parse(&feed.feed_url)
            .map_err(|error| PolicyFailure::MalformedUrl(format!("{}: {error}", feed.feed_url)))?;
        let policy = Self {
            channel: channel.to_string(),
            feed_url,
            allowed_origins: feed.allowed_origins.clone(),
            trusted_keys: feed.trusted_keys.clone(),
        };
        // The feed URL itself must be admissible. A missing trust anchor is not
        // checked here: it is reported at admission time by `admit_check`, so
        // the UI can show *why* delivery is disabled rather than a generic
        // "no update source" message.
        policy.admit_url(&policy.feed_url.clone())?;
        Ok(policy)
    }

    pub fn trusted_keys(&self) -> &[String] {
        &self.trusted_keys
    }

    /// Whether any trusted key is packaged. Delivery is disabled without one.
    pub fn has_trust_anchor(&self) -> bool {
        !self.trusted_keys.is_empty()
    }

    /// Admit the manifest request. Refuses before any network activity.
    pub fn admit_check(&self) -> Result<RequestPlan, PolicyFailure> {
        if !self.has_trust_anchor() {
            return Err(PolicyFailure::NoPackagedTrust(format!(
                "the `{}` channel declares no trusted release signing key",
                self.channel
            )));
        }
        self.admit_url(&self.feed_url)
    }

    /// Admit one artifact URL taken from the manifest. The URL is checked
    /// against the same allow list as the feed; a manifest cannot widen it.
    pub fn admit_artifact(&self, url: &str) -> Result<RequestPlan, PolicyFailure> {
        if !self.has_trust_anchor() {
            return Err(PolicyFailure::NoPackagedTrust(format!(
                "the `{}` channel declares no trusted release signing key",
                self.channel
            )));
        }
        let parsed = Url::parse(url)
            .map_err(|error| PolicyFailure::MalformedUrl(format!("{url}: {error}")))?;
        self.admit_url(&parsed)
    }

    fn admit_url(&self, url: &Url) -> Result<RequestPlan, PolicyFailure> {
        if url.scheme() != "https" {
            return Err(PolicyFailure::InsecureScheme(url.to_string()));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(PolicyFailure::UrlCredentials);
        }
        if url.host_str().is_none() {
            return Err(PolicyFailure::MalformedUrl(url.to_string()));
        }
        if !origin_is_allowed(&self.allowed_origins, url) {
            return Err(PolicyFailure::OriginNotAllowed(url.to_string()));
        }
        Ok(RequestPlan {
            url: url.clone(),
            allowed_origins: self.allowed_origins.clone(),
        })
    }

    /// Admit one redirect target observed while executing `plan`.
    ///
    /// Redirects stay inside the packaged allow list and must remain https, so
    /// a compromised or misconfigured feed cannot move the transfer to an
    /// arbitrary host.
    pub fn admit_redirect(&self, plan: &RequestPlan, location: &str) -> Result<Url, PolicyFailure> {
        let resolved = plan
            .url
            .join(location)
            .map_err(|error| PolicyFailure::MalformedUrl(format!("{location}: {error}")))?;
        if resolved.scheme() != "https" {
            return Err(PolicyFailure::RedirectNotAllowed(resolved.to_string()));
        }
        if !origin_is_allowed(&plan.allowed_origins, &resolved) {
            return Err(PolicyFailure::RedirectNotAllowed(resolved.to_string()));
        }
        Ok(resolved)
    }
}

/// Channel identity as persisted, normalized to the two known channels.
pub fn normalize_channel(value: Option<&SettingValue>) -> &'static str {
    match value {
        Some(SettingValue::String(channel)) if channel == "beta" => "beta",
        _ => "stable",
    }
}

/// Whether `value` is a valid SemVer 2.0.0 version. An unparseable version is
/// never a candidate, so a malformed feed cannot become an installable release.
pub fn is_valid_semver(value: &str) -> bool {
    parse_semver(value).is_some()
}

// --- SemVer 2.0.0 parsing and precedence --------------------------------

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

// ---------------------------------------------------------------------------
// Check scheduling (upstream `update-schedule.ts`)
// ---------------------------------------------------------------------------

/// Validated polling delays (`DesktopUpdateScheduleConfig` upstream).
///
/// All three values are validated at construction, so an out-of-range
/// environment override fails loud at startup instead of producing a schedule
/// that never fires or fires continuously.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UpdateScheduleConfig {
    /// Delay after a successful check.
    pub interval_ms: u64,
    /// Cap on the exponential backoff after consecutive failures.
    pub max_backoff_ms: u64,
    /// Fractional jitter in `[0, 1]` applied symmetrically to each delay.
    pub jitter: f64,
}

/// Bounds mirrors upstream `duration()`: 1 s through `i32::MAX` ms.
const MIN_DURATION_MS: u64 = 1_000;
const MAX_DURATION_MS: u64 = 2_147_483_647;
const DEFAULT_INTERVAL_MS: u64 = 600_000;
const DEFAULT_MAX_BACKOFF_MS: u64 = 3_600_000;
const DEFAULT_JITTER: f64 = 0.2;

/// Resolve polling settings from the process environment.
///
/// Upstream reads `DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS`,
/// `DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS`, and
/// `DSH_DESKTOP_UPDATE_CHECK_JITTER`. Invalid values are an error, never a
/// silent fallback.
pub fn resolve_schedule_config(
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<UpdateScheduleConfig, String> {
    fn duration(
        lookup: &impl Fn(&str) -> Option<String>,
        name: &str,
        fallback: u64,
    ) -> Result<u64, String> {
        let Some(raw) = lookup(name) else {
            return Ok(fallback);
        };
        let value: u64 = raw
            .trim()
            .parse()
            .map_err(|_| format!("{name} must be an integer from 1000 through 2147483647"))?;
        if !(MIN_DURATION_MS..=MAX_DURATION_MS).contains(&value) {
            return Err(format!(
                "{name} must be an integer from 1000 through 2147483647"
            ));
        }
        Ok(value)
    }
    let interval_ms = duration(
        &lookup,
        "DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS",
        DEFAULT_INTERVAL_MS,
    )?;
    let default_backoff = interval_ms.max(DEFAULT_MAX_BACKOFF_MS);
    let max_backoff_ms = duration(
        &lookup,
        "DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS",
        default_backoff,
    )?;
    let jitter = match lookup("DSH_DESKTOP_UPDATE_CHECK_JITTER") {
        Some(raw) => raw
            .trim()
            .parse::<f64>()
            .map_err(|_| "desktop update: check jitter must be in [0, 1]".to_string())?,
        None => DEFAULT_JITTER,
    };
    if !jitter.is_finite() || !(0.0..=1.0).contains(&jitter) {
        return Err("desktop update: check jitter must be in [0, 1]".to_string());
    }
    if max_backoff_ms < interval_ms {
        return Err("desktop update: max backoff must cover the check interval".to_string());
    }
    Ok(UpdateScheduleConfig {
        interval_ms,
        max_backoff_ms,
        jitter,
    })
}

/// Completion-based check schedule.
///
/// Mirrors upstream `DesktopUpdateSchedule`: the delay is armed only when the
/// last *joined* check completes, a failure doubles the delay up to the cap,
/// and the jittered delay is drawn from the validated range. Time is supplied
/// by the caller so the schedule is testable without a clock.
#[derive(Debug, Clone, PartialEq)]
pub struct UpdateSchedule {
    config: UpdateScheduleConfig,
    /// Current backoff delay before jitter.
    delay_ms: u64,
    /// Monotonic deadline of the next automatic check.
    next_check_ms: Option<u64>,
    /// Number of callers currently joined on the in-flight check.
    active_checks: u32,
    /// Whether polling has been stopped.
    disposed: bool,
}

impl UpdateSchedule {
    pub fn new(config: UpdateScheduleConfig) -> Self {
        Self {
            delay_ms: config.interval_ms,
            config,
            next_check_ms: None,
            active_checks: 0,
            disposed: false,
        }
    }

    pub fn config(&self) -> UpdateScheduleConfig {
        self.config
    }

    /// Test-only read of the disposed flag; the observable effects of disposal
    /// are otherwise what the other methods return.
    #[cfg(test)]
    pub fn is_disposed(&self) -> bool {
        self.disposed
    }

    /// Whether an automatic check is due at `now_ms`. A disposed schedule is
    /// never due, so a late timer callback cannot restart polling.
    pub fn is_due(&self, now_ms: u64) -> bool {
        if self.disposed {
            return false;
        }
        match self.next_check_ms {
            Some(deadline) => now_ms >= deadline,
            None => true,
        }
    }

    /// Join the in-flight check, recording one more active caller.
    ///
    /// An automatic check that is not yet due is refused so the caller keeps its
    /// current state. There is no manual caller: a user-initiated check runs
    /// through [`crate::update_flow::check`] and never consults this schedule
    /// (see [`crate::update_schedule::CheckTrigger`]).
    pub fn begin_check(&mut self, now_ms: u64) -> bool {
        if self.disposed {
            return false;
        }
        if !self.is_due(now_ms) {
            return false;
        }
        self.next_check_ms = None;
        self.active_checks += 1;
        true
    }

    /// Record the completion of one joined check.
    ///
    /// The retry delay advances exactly once, when the last joined caller
    /// completes, so several callers that joined one request do not
    /// multiply the backoff.
    pub fn complete_check(&mut self, failed: bool, now_ms: u64, random: f64) -> Option<u64> {
        self.active_checks = self.active_checks.saturating_sub(1);
        if self.active_checks != 0 || self.disposed {
            return None;
        }
        self.schedule_next(failed, now_ms, random)
    }

    /// Record that a joined caller finished without a check having completed.
    ///
    /// The coordinator had other work in flight, so this caller's join is
    /// released but the retry delay is deliberately unchanged: nothing was
    /// attempted, and treating a skip as a failure would make an unrelated
    /// download back off the polling interval. The deadline is re-armed at the
    /// current delay so polling continues.
    pub fn complete_skipped(&mut self, now_ms: u64) -> Option<u64> {
        self.active_checks = self.active_checks.saturating_sub(1);
        if self.active_checks != 0 || self.disposed {
            return None;
        }
        let delay = self.delay_ms;
        self.next_check_ms = Some(now_ms.saturating_add(delay));
        Some(delay)
    }

    /// Arm the next automatic check and return its delay.
    fn schedule_next(&mut self, failed: bool, now_ms: u64, random: f64) -> Option<u64> {
        let UpdateScheduleConfig {
            interval_ms,
            max_backoff_ms,
            jitter,
        } = self.config;
        self.delay_ms = if failed {
            self.delay_ms.saturating_mul(2).min(max_backoff_ms)
        } else {
            interval_ms
        };
        let lower = ((self.delay_ms as f64) * (1.0 - jitter)).max(MIN_DURATION_MS as f64);
        let upper = ((self.delay_ms as f64) * (1.0 + jitter)).min(max_backoff_ms as f64);
        let sample = random.clamp(0.0, 1.0);
        let delay = (lower + (upper - lower) * sample).round() as u64;
        self.next_check_ms = Some(now_ms.saturating_add(delay));
        Some(delay)
    }

    /// Stop polling; a late completion can no longer rearm the timer.
    pub fn dispose(&mut self) {
        self.disposed = true;
        self.next_check_ms = None;
    }

    /// Delay that would be used for the next failure, exposed for tests and for
    /// reporting the current backoff.
    pub fn backoff_ms(&self) -> u64 {
        self.delay_ms
    }

    /// Make the next automatic check due at `now_ms` without advancing the
    /// backoff.
    ///
    /// The runner calls this when an external trigger (a foreground/resume
    /// wake, or the arrival of a mandatory decision) requires a check before
    /// the armed deadline. Unlike [`Self::complete_check`] no check completed,
    /// so the retry delay is deliberately left alone.
    pub fn due_now(&mut self, now_ms: u64) {
        if self.disposed {
            return;
        }
        self.next_check_ms = Some(now_ms);
    }

    /// The armed deadline, if any, as monotonic milliseconds.
    pub fn next_check_ms(&self) -> Option<u64> {
        self.next_check_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- canonical message -------------------------------------------------

    #[test]
    fn signed_message_covers_version_channel_and_digest_but_not_url() {
        let release = SignedRelease {
            version: "0.1.8",
            channel: "stable",
            sha256: "AABB",
        };
        assert_eq!(
            release.message(),
            "dsh-desktop-release/v1\nversion=0.1.8\nchannel=stable\nsha256=aabb\n"
        );
        // The artifact URL is intentionally absent, so a mirror move needs no
        // re-signing; the allow list still constrains its host.
        assert!(!release.message().contains("http"));
    }

    #[test]
    fn signature_cannot_be_replayed_across_channel_or_version_or_digest() {
        let base = SignedRelease {
            version: "0.1.8",
            channel: "stable",
            sha256: "aa",
        };
        for other in [
            SignedRelease {
                version: "0.1.9",
                ..base.clone()
            },
            SignedRelease {
                channel: "beta",
                ..base.clone()
            },
            SignedRelease {
                sha256: "ab",
                ..base.clone()
            },
        ] {
            assert_ne!(base.message(), other.message(), "{other:?}");
        }
    }

    // --- RFC 8032 §7.1 vectors --------------------------------------------

    fn hex(value: &str) -> Vec<u8> {
        decode_hex(value).expect("test hex decodes")
    }

    /// RFC 8032 §7.1 TEST 1.
    #[test]
    fn rfc8032_test_1_verifies() {
        let key: [u8; 32] = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
            .try_into()
            .unwrap();
        let signature: [u8; 64] = hex(concat!(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155",
            "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        ))
        .try_into()
        .unwrap();
        assert!(ed25519_verify(&key, b"", &signature));
    }

    /// RFC 8032 §7.1 TEST 2.
    #[test]
    fn rfc8032_test_2_verifies() {
        let key: [u8; 32] = hex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c")
            .try_into()
            .unwrap();
        let signature: [u8; 64] = hex(concat!(
            "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da",
            "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"
        ))
        .try_into()
        .unwrap();
        assert!(ed25519_verify(&key, &[0x72], &signature));
    }

    /// RFC 8032 §7.1 TEST 3 (two-byte message).
    #[test]
    fn rfc8032_test_3_verifies() {
        let key: [u8; 32] = hex("fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025")
            .try_into()
            .unwrap();
        let signature: [u8; 64] = hex(concat!(
            "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac",
            "18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"
        ))
        .try_into()
        .unwrap();
        assert!(ed25519_verify(&key, &[0xaf, 0x82], &signature));
    }

    #[test]
    fn rfc8032_vectors_reject_a_flipped_bit_and_a_wrong_key() {
        let key: [u8; 32] = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
            .try_into()
            .unwrap();
        let mut signature: [u8; 64] = hex(concat!(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155",
            "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        ))
        .try_into()
        .unwrap();
        signature[0] ^= 0x01;
        assert!(!ed25519_verify(&key, b"", &signature));
        let mut other_key = key;
        other_key[0] ^= 0x01;
        let good: [u8; 64] = hex(concat!(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155",
            "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        ))
        .try_into()
        .unwrap();
        assert!(!ed25519_verify(&other_key, b"", &good));
    }

    #[test]
    fn non_canonical_scalar_is_rejected() {
        let key: [u8; 32] = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
            .try_into()
            .unwrap();
        // S = L is not a canonical scalar encoding.
        let mut signature = [0u8; 64];
        signature[32..].copy_from_slice(&hex(
            "edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010",
        ));
        assert!(!ed25519_verify(&key, b"", &signature));
    }

    // --- verify_release admission -----------------------------------------

    /// Fixture signed by the independent `openssl`/RFC 8032 vector path: the
    /// private key below is the RFC 8032 §7.1 TEST 2 secret, and the signature
    /// was produced with the same toolchain that generated the vectors, so this
    /// exercises the canonical message binding rather than the field arithmetic.
    const TEST_PUBLIC_KEY: &str =
        "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
    const TEST_SIGNATURE: &str = concat!(
        "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da",
        "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"
    );

    /// The RFC 8032 TEST 2 message is the single byte `0x72`, while our
    /// canonical message is different bytes. The same signature must therefore
    /// be refused for a release, which is the property that matters: a
    /// signature is bound to the exact signed bytes.
    #[test]
    fn a_signature_over_different_bytes_is_refused_for_a_release() {
        let release = SignedRelease {
            version: "0.1.8",
            channel: "stable",
            sha256: &sha256_hex(b"payload"),
        };
        let outcome = verify_release(
            &[TEST_PUBLIC_KEY.to_string()],
            &release,
            Some(TEST_SIGNATURE),
        );
        assert_eq!(outcome, Err(VerifyFailure::InvalidSignature));
    }

    /// One fixture case recorded by the independent Python `cryptography`
    /// signer (`app/tests/fixtures/update-signatures.json`).
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SignatureCase {
        label: String,
        channel: String,
        trusted_key: String,
        version: String,
        message_channel: String,
        message_sha256: String,
        signature: String,
        expected: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SignatureFixtures {
        payload_sha256: String,
        cases: Vec<SignatureCase>,
    }

    fn signature_fixtures() -> SignatureFixtures {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("update-signatures.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        serde_json::from_str(&text).expect("signature fixtures parse")
    }

    /// Every fixture recorded by the independent signer must satisfy the
    /// verifier in the way the fixture declares.
    ///
    /// A signature is cryptographically valid for exactly the bytes that were
    /// signed, so a fixture signed over a *different* version, channel, or
    /// digest still verifies when it is presented with those same signed
    /// values. What must never happen is that such a signature is accepted for
    /// the release actually being installed. That binding is asserted by the
    /// three `a_signature_is_*` tests below, which present each signature with
    /// the attacker-chosen release and require refusal.
    #[test]
    fn independently_signed_fixtures_verify_and_tampered_cases_are_refused() {
        let fixtures = signature_fixtures();
        assert!(!fixtures.cases.is_empty());
        for case in &fixtures.cases {
            let release = SignedRelease {
                version: &case.version,
                channel: &case.message_channel,
                sha256: &case.message_sha256,
            };
            let outcome = verify_release(
                std::slice::from_ref(&case.trusted_key),
                &release,
                Some(&case.signature),
            );
            let label = format!("{} ({})", case.label, case.channel);
            match case.expected.as_str() {
                // The signature is over exactly these values, so it verifies.
                "ok" | "valid-over-signed-values" => {
                    assert_eq!(outcome, Ok(()), "{label} must verify");
                }
                "invalid-signature" => {
                    assert_eq!(
                        outcome,
                        Err(VerifyFailure::InvalidSignature),
                        "{label} must be refused"
                    );
                }
                other => panic!("unknown fixture expectation `{other}`"),
            }
        }
    }

    /// A signature made for one version must not be accepted when the release
    /// claims a different version.
    #[test]
    fn a_signature_is_bound_to_the_version() {
        let fixtures = signature_fixtures();
        let other_version = fixtures
            .cases
            .iter()
            .find(|case| case.label == "other-version")
            .expect("an other-version fixture");
        // Present the other-version signature with the *valid* version, which
        // is not what it signed.
        let release = SignedRelease {
            version: "0.1.8",
            channel: &other_version.channel,
            sha256: &other_version.message_sha256,
        };
        assert_ne!(release.version, other_version.version);
        assert_eq!(
            verify_release(
                std::slice::from_ref(&other_version.trusted_key),
                &release,
                Some(&other_version.signature)
            ),
            Err(VerifyFailure::InvalidSignature)
        );
    }

    /// A signature made for one channel must not be accepted on another: the
    /// stable and beta fixtures sign the same version and digest, so only the
    /// channel field can distinguish them.
    #[test]
    fn a_signature_is_not_transferable_across_channels() {
        let fixtures = signature_fixtures();
        let stable_valid = fixtures
            .cases
            .iter()
            .find(|case| case.channel == "stable" && case.expected == "ok")
            .expect("a stable fixture");
        let release = SignedRelease {
            version: &stable_valid.version,
            channel: "beta",
            sha256: &stable_valid.message_sha256,
        };
        assert_eq!(
            verify_release(
                std::slice::from_ref(&stable_valid.trusted_key),
                &release,
                Some(&stable_valid.signature)
            ),
            Err(VerifyFailure::InvalidSignature)
        );
    }

    /// A signature made for one artifact digest must not be accepted for
    /// different bytes, even at the same version and channel.
    #[test]
    fn a_signature_is_bound_to_the_artifact_digest() {
        let fixtures = signature_fixtures();
        let valid = fixtures
            .cases
            .iter()
            .find(|case| case.expected == "ok")
            .expect("a valid fixture");
        let other_digest = sha256_hex(b"a different artifact");
        assert_ne!(other_digest, fixtures.payload_sha256);
        let release = SignedRelease {
            version: &valid.version,
            channel: &valid.message_channel,
            sha256: &other_digest,
        };
        assert_eq!(
            verify_release(
                std::slice::from_ref(&valid.trusted_key),
                &release,
                Some(&valid.signature)
            ),
            Err(VerifyFailure::InvalidSignature)
        );
    }

    /// Only the packaged key for the channel is trusted: the beta key must not
    /// accept a stable release.
    #[test]
    fn a_foreign_trusted_key_does_not_accept_another_channels_release() {
        let fixtures = signature_fixtures();
        let stable = fixtures
            .cases
            .iter()
            .find(|case| case.channel == "stable" && case.expected == "ok")
            .expect("a stable fixture");
        let beta = fixtures
            .cases
            .iter()
            .find(|case| case.channel == "beta" && case.expected == "ok")
            .expect("a beta fixture");
        assert_ne!(stable.trusted_key, beta.trusted_key);
        let release = SignedRelease {
            version: &stable.version,
            channel: &stable.message_channel,
            sha256: &stable.message_sha256,
        };
        assert_eq!(
            verify_release(
                std::slice::from_ref(&beta.trusted_key),
                &release,
                Some(&stable.signature)
            ),
            Err(VerifyFailure::InvalidSignature)
        );
    }

    #[test]
    fn missing_trust_anchor_disables_delivery_even_with_a_digest() {
        let release = SignedRelease {
            version: "0.1.8",
            channel: "stable",
            sha256: &sha256_hex(b"payload"),
        };
        assert_eq!(
            verify_release(&[], &release, Some(TEST_SIGNATURE)),
            Err(VerifyFailure::NoTrustedKeys)
        );
    }

    #[test]
    fn unsigned_manifest_is_refused_even_when_the_digest_is_present() {
        let release = SignedRelease {
            version: "0.1.8",
            channel: "stable",
            sha256: &sha256_hex(b"payload"),
        };
        for signature in [None, Some(""), Some("   ")] {
            assert_eq!(
                verify_release(&[TEST_PUBLIC_KEY.to_string()], &release, signature),
                Err(VerifyFailure::MissingSignature),
                "{signature:?}"
            );
        }
    }

    #[test]
    fn manifest_without_a_digest_is_refused() {
        let release = SignedRelease {
            version: "0.1.8",
            channel: "stable",
            sha256: "",
        };
        assert_eq!(
            verify_release(
                &[TEST_PUBLIC_KEY.to_string()],
                &release,
                Some(TEST_SIGNATURE)
            ),
            Err(VerifyFailure::MissingDigest)
        );
    }

    #[test]
    fn malformed_keys_and_signatures_are_classified_not_accepted() {
        // The digest is well formed so the key/signature classification below is
        // the reason for refusal, not a digest-shape refusal.
        let digest = sha256_hex(b"payload");
        let release = SignedRelease {
            version: "0.1.8",
            channel: "stable",
            sha256: &digest,
        };
        assert_eq!(
            verify_release(&["zz".to_string()], &release, Some(TEST_SIGNATURE)),
            Err(VerifyFailure::MalformedKey("`zz` is not hex".to_string()))
        );
        assert!(matches!(
            verify_release(&["aabb".to_string()], &release, Some(TEST_SIGNATURE)),
            Err(VerifyFailure::MalformedKey(_))
        ));
        assert_eq!(
            verify_release(&[TEST_PUBLIC_KEY.to_string()], &release, Some("aabb")),
            Err(VerifyFailure::MalformedSignature)
        );
    }

    #[test]
    fn a_digest_that_is_not_64_ascii_hex_is_refused_before_the_signed_message() {
        let keys = [TEST_PUBLIC_KEY.to_string()];
        // A genuinely signed fixture digest is accepted, so the refusals below
        // are attributable to the shape alone.
        let valid = sha256_hex(b"payload");
        assert!(is_valid_sha256(&valid));
        assert_eq!(
            verify_release(
                &keys,
                &SignedRelease {
                    version: "0.1.8",
                    channel: "stable",
                    sha256: &valid,
                },
                Some(TEST_SIGNATURE),
            ),
            Err(VerifyFailure::InvalidSignature),
            "a valid-shaped digest reaches signature verification"
        );
        // A digest field whose *content* is blank is absent, not malformed.
        // `verify_release` applies the module-wide convention (the one
        // `MissingSignature` follows for the signature) before the shape rule,
        // so `""` and whitespace-only values are `MissingDigest`. Either way the
        // release is refused before the signed message exists.
        for blank in [
            String::new(),
            " ".to_string(),
            " ".repeat(64),
            "\t".repeat(64),
            "\r\n".to_string(),
            "   \t  ".to_string(),
        ] {
            assert_eq!(
                verify_release(
                    &keys,
                    &SignedRelease {
                        version: "0.1.8",
                        channel: "stable",
                        sha256: blank.as_str(),
                    },
                    Some(TEST_SIGNATURE),
                ),
                Err(VerifyFailure::MissingDigest),
                "{blank:?} is a blank digest, so it is missing rather than malformed"
            );
        }
        for malformed in [
            "a".repeat(63),
            "a".repeat(65),
            "g".repeat(64),
            format!("{}a", " ".repeat(63)),
            format!("{valid} "),
            format!(" {valid}"),
            format!("{}\n", &valid[..63]),
            // A multibyte character makes byte slicing a potential panic; the
            // shape rule refuses it before any slice or filename is built.
            "é".repeat(32),
            // Upper case is valid hex, so a mixed-case digest is accepted; this
            // entry pins the *acceptance* rather than a refusal.
            valid.to_ascii_uppercase(),
        ] {
            let outcome = verify_release(
                &keys,
                &SignedRelease {
                    version: "0.1.8",
                    channel: "stable",
                    sha256: malformed.as_str(),
                },
                Some(TEST_SIGNATURE),
            );
            if malformed == valid.to_ascii_uppercase() {
                assert_eq!(
                    outcome,
                    Err(VerifyFailure::InvalidSignature),
                    "upper-case hex is a well-formed digest"
                );
            } else {
                assert_eq!(
                    outcome,
                    Err(VerifyFailure::MalformedDigest),
                    "`{malformed}` must be refused on shape"
                );
            }
        }
    }

    #[test]
    fn sha256_shape_is_exactly_64_ascii_hex_characters() {
        assert!(is_valid_sha256(&"a".repeat(64)));
        assert!(is_valid_sha256(&"0123456789ABCDEFabcdef".repeat(3)[..64]));
        assert!(!is_valid_sha256(""));
        assert!(!is_valid_sha256(&"a".repeat(63)));
        assert!(!is_valid_sha256(&"a".repeat(65)));
        assert!(!is_valid_sha256(&"z".repeat(64)));
        assert!(!is_valid_sha256(&format!("{}\n", "a".repeat(63))));
        assert!(!is_valid_sha256(&format!(" {}", "a".repeat(63))));
        assert!(!is_valid_sha256(&"é".repeat(64)));
    }

    #[test]
    fn path_components_refuse_traversal_and_non_ascii() {
        // A *path* rule, not a SemVer grammar: it accepts the whole
        // version/channel alphabet — including SemVer build metadata (`+`) and
        // the `_` a channel or identifier may carry — and nothing else.
        for safe in [
            "stable",
            "beta",
            "0.1.8",
            "0.1.8-rc.2",
            "0.1.8-rc.2+build_1",
            "1.0.0+build.1",
            "a",
            "A0._-+",
        ] {
            assert!(is_safe_path_component(safe), "{safe}");
        }
        for unsafe_value in [
            "", ".", "..", "../evil", "..\\evil", "a/..", "a/b", "a\\b", "a\0b", "stäble", "a:b",
            "C:", "a b", "a\tb", "a\nb", "a*", "a?", "a\"b", "a<b", "a>b", "a|b",
        ] {
            assert!(!is_safe_path_component(unsafe_value), "{unsafe_value}");
        }
    }

    /// The two predicates in this module must not drift apart: a version the
    /// grammar admits must always be usable as the filename component that
    /// carries it, or an admitted release could never name its artifact file.
    #[test]
    fn every_admitted_version_is_also_a_safe_path_component() {
        for version in [
            "0.1.8",
            "0.1.7-rc.2",
            "1.0.0+build.1",
            "1.0.0-alpha.1+build.5",
            "10.20.30",
            "0.0.0-0",
        ] {
            assert!(is_valid_semver(version), "{version} must be admitted");
            assert!(
                is_safe_path_component(version),
                "{version} is admitted, so it must be able to name an artifact file"
            );
        }
    }

    #[test]
    fn a_trust_outcome_only_exposes_a_loaded_configuration() {
        let config = config_with(
            Some(feed(
                "https://updates.example.com/stable.json",
                &["updates.example.com"],
                &[TEST_PUBLIC_KEY],
            )),
            None,
        );
        let loaded = TrustConfigOutcome::Loaded(config.clone());
        assert_eq!(loaded.config(), Some(&config));
        assert_eq!(TrustConfigOutcome::Absent.config(), None);
        assert_eq!(
            TrustConfigOutcome::Invalid("malformed".to_string()).config(),
            None
        );
    }

    // --- trust configuration ----------------------------------------------

    fn config_with(feed: Option<ChannelFeed>, beta: Option<ChannelFeed>) -> ReleaseTrustConfig {
        ReleaseTrustConfig {
            config_version: 1,
            pinned_channel: None,
            stable: feed,
            beta,
        }
    }

    fn feed(url: &str, origins: &[&str], keys: &[&str]) -> ChannelFeed {
        ChannelFeed {
            feed_url: url.to_string(),
            allowed_origins: origins.iter().map(|value| value.to_string()).collect(),
            trusted_keys: keys.iter().map(|value| value.to_string()).collect(),
        }
    }

    const KEY: &str = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";

    #[test]
    fn http_feed_and_artifact_urls_are_refused() {
        let config = config_with(
            Some(feed(
                "https://updates.example.com/stable.json",
                &["updates.example.com"],
                &[KEY],
            )),
            None,
        );
        let policy = ReleasePolicy::select(&config, "stable").expect("https policy builds");
        let failure = policy
            .admit_artifact("http://updates.example.com/Setup.exe")
            .expect_err("plain http is refused");
        assert!(
            matches!(failure, PolicyFailure::InsecureScheme(_)),
            "{failure}"
        );
        // A downgrade redirect is refused too.
        let plan = policy.admit_check().expect("feed admitted");
        assert!(matches!(
            policy.admit_redirect(&plan, "http://updates.example.com/other.json"),
            Err(PolicyFailure::RedirectNotAllowed(_))
        ));
    }

    #[test]
    fn non_allowlisted_artifact_host_and_redirect_are_refused() {
        let config = config_with(
            Some(feed(
                "https://updates.example.com/stable.json",
                &["updates.example.com"],
                &[KEY],
            )),
            None,
        );
        let policy = ReleasePolicy::select(&config, "stable").expect("policy builds");
        assert!(matches!(
            policy.admit_artifact("https://evil.test/Setup.exe"),
            Err(PolicyFailure::OriginNotAllowed(_))
        ));
        // A look-alike suffix must not match either.
        assert!(matches!(
            policy.admit_artifact("https://evil-updates.example.com/Setup.exe"),
            Err(PolicyFailure::OriginNotAllowed(_))
        ));
        assert!(matches!(
            policy.admit_artifact("https://updates.example.com.evil.test/Setup.exe"),
            Err(PolicyFailure::OriginNotAllowed(_))
        ));
        let plan = policy.admit_check().expect("feed admitted");
        assert!(matches!(
            policy.admit_redirect(&plan, "https://evil.test/x.json"),
            Err(PolicyFailure::RedirectNotAllowed(_))
        ));
        assert!(policy
            .admit_redirect(&plan, "https://updates.example.com/x.json")
            .is_ok());
    }

    #[test]
    fn url_embedded_credentials_are_refused() {
        let config = config_with(
            Some(feed(
                "https://updates.example.com/stable.json",
                &["updates.example.com"],
                &[KEY],
            )),
            None,
        );
        let policy = ReleasePolicy::select(&config, "stable").expect("policy builds");
        assert_eq!(
            policy.admit_artifact("https://user:pass@updates.example.com/Setup.exe"),
            Err(PolicyFailure::UrlCredentials)
        );
    }

    #[test]
    fn a_channel_without_a_trusted_key_disables_delivery_before_any_request() {
        // A channel definition with an empty key list is a valid packaged shape
        // ("this channel is not delivered here"), so it must load and then
        // refuse delivery rather than being rejected by validation.
        let config = config_with(
            Some(feed(
                "https://updates.example.com/stable.json",
                &["updates.example.com"],
                &[],
            )),
            None,
        );
        validate_trust_config(&config).expect("an unkeyed channel is a valid packaged shape");
        let policy = ReleasePolicy::select(&config, "stable").expect("policy builds");
        assert!(!policy.has_trust_anchor());
        assert!(matches!(
            policy.admit_check(),
            Err(PolicyFailure::NoPackagedTrust(_))
        ));
        assert!(matches!(
            policy.admit_artifact("https://updates.example.com/Setup.exe"),
            Err(PolicyFailure::NoPackagedTrust(_))
        ));
    }

    #[test]
    fn selecting_a_channel_without_a_packaged_source_is_refused() {
        let config = config_with(
            Some(feed(
                "https://updates.example.com/stable.json",
                &["updates.example.com"],
                &[KEY],
            )),
            None,
        );
        assert!(matches!(
            ReleasePolicy::select(&config, "beta"),
            Err(PolicyFailure::NoPackagedTrust(_))
        ));
    }

    #[test]
    fn a_pinned_channel_refuses_the_other_channel() {
        let mut config = config_with(
            Some(feed(
                "https://updates.example.com/stable.json",
                &["updates.example.com"],
                &[KEY],
            )),
            Some(feed(
                "https://beta.example.com/beta.json",
                &["beta.example.com"],
                &[KEY],
            )),
        );
        config.pinned_channel = Some("beta".to_string());
        assert!(matches!(
            ReleasePolicy::select(&config, "stable"),
            Err(PolicyFailure::NoPackagedTrust(_))
        ));
        assert!(ReleasePolicy::select(&config, "beta").is_ok());
    }

    #[test]
    fn configuration_validation_rejects_each_unsafe_shape() {
        assert!(validate_trust_config(&ReleaseTrustConfig {
            config_version: 0,
            pinned_channel: None,
            stable: None,
            beta: None,
        })
        .is_err());
        assert!(validate_trust_config(&ReleaseTrustConfig {
            config_version: 1,
            pinned_channel: None,
            stable: None,
            beta: None,
        })
        .is_err());
        for (label, feed) in [
            (
                "http",
                feed(
                    "http://updates.example.com/stable.json",
                    &["updates.example.com"],
                    &[KEY],
                ),
            ),
            (
                "no origins",
                feed("https://updates.example.com/stable.json", &[], &[KEY]),
            ),
            (
                "wildcard origin",
                feed(
                    "https://updates.example.com/stable.json",
                    &["*.example.com"],
                    &[KEY],
                ),
            ),
            (
                "origin with scheme",
                feed(
                    "https://updates.example.com/stable.json",
                    &["https://updates.example.com"],
                    &[KEY],
                ),
            ),
            (
                "feed host not allowlisted",
                feed(
                    "https://updates.example.com/stable.json",
                    &["other.example.com"],
                    &[KEY],
                ),
            ),
            (
                "short key",
                feed(
                    "https://updates.example.com/stable.json",
                    &["updates.example.com"],
                    &["aabb"],
                ),
            ),
            (
                "non-hex key",
                feed(
                    "https://updates.example.com/stable.json",
                    &["updates.example.com"],
                    &["zz".repeat(32).as_str()],
                ),
            ),
            (
                "duplicate origin",
                feed(
                    "https://updates.example.com/stable.json",
                    &["updates.example.com", "updates.example.com"],
                    &[KEY],
                ),
            ),
        ] {
            let config = config_with(Some(feed), None);
            assert!(
                validate_trust_config(&config).is_err(),
                "{label} must not validate"
            );
        }
        assert!(validate_trust_config(&ReleaseTrustConfig {
            config_version: 1,
            pinned_channel: Some("nightly".to_string()),
            stable: Some(feed(
                "https://updates.example.com/stable.json",
                &["updates.example.com"],
                &[KEY]
            )),
            beta: None,
        })
        .is_err());
    }

    #[test]
    fn an_absent_packaged_configuration_reports_absent_not_loaded() {
        let directory =
            std::env::temp_dir().join(format!("dsh-update-trust-absent-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create temp directory");
        let outcome = load_trust_config(&directory.join("updates.json"));
        assert_eq!(outcome, TrustConfigOutcome::Absent);
        // A missing parent is also a true missing directory entry.
        assert_eq!(
            load_trust_config(&directory.join("missing-parent").join("updates.json")),
            TrustConfigOutcome::Absent
        );
        std::fs::remove_dir_all(&directory).expect("remove owned temp directory");
    }

    #[test]
    fn an_existing_directory_at_the_configuration_path_is_invalid() {
        let directory =
            std::env::temp_dir().join(format!("dsh-update-trust-directory-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create temp directory");
        let source = directory.join("updates.json");
        std::fs::create_dir(&source).expect("create directory configuration entry");
        let outcome = load_trust_config(&source);
        assert!(
            matches!(outcome, TrustConfigOutcome::Invalid(_)),
            "{outcome:?}"
        );
        std::fs::remove_dir_all(&directory).expect("remove owned temp directory");
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_is_invalid_not_absent() {
        use std::os::unix::fs::symlink;

        let directory =
            std::env::temp_dir().join(format!("dsh-update-trust-dangling-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create temp directory");
        let source = directory.join("updates.json");
        symlink(directory.join("nonexistent-target"), &source).expect("create dangling symlink");
        let outcome = load_trust_config(&source);
        assert!(
            matches!(outcome, TrustConfigOutcome::Invalid(_)),
            "{outcome:?}"
        );
        std::fs::remove_dir_all(&directory).expect("remove owned temp directory");
    }

    #[test]
    fn a_malformed_packaged_configuration_disables_delivery() {
        let directory =
            std::env::temp_dir().join(format!("dsh-update-trust-invalid-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create temp directory");
        let path = directory.join("updates.json");
        for (label, contents) in [
            ("not json", "{not json"),
            (
                "unknown field",
                r#"{"configVersion":1,"stable":null,"beta":null,"extra":1}"#,
            ),
            (
                "insecure feed",
                r#"{"configVersion":1,"stable":{"feedUrl":"http://x.test/a.json","allowedOrigins":["x.test"],"trustedKeys":["3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"]}}"#,
            ),
        ] {
            std::fs::write(&path, contents).expect("write fixture");
            let outcome = load_trust_config(&path);
            assert!(
                matches!(outcome, TrustConfigOutcome::Invalid(_)),
                "{label} must be invalid, got {outcome:?}"
            );
        }
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn a_valid_packaged_configuration_loads_and_selects_its_channel() {
        let directory =
            std::env::temp_dir().join(format!("dsh-update-trust-valid-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create temp directory");
        let path = directory.join("updates.json");
        std::fs::write(
            &path,
            format!(
                r#"{{"configVersion":1,"stable":{{"feedUrl":"https://updates.example.com/stable.json","allowedOrigins":["updates.example.com:443","updates.example.com"],"trustedKeys":["{KEY}"]}}}}"#
            ),
        )
        .expect("write fixture");
        let outcome = load_trust_config(&path);
        let TrustConfigOutcome::Loaded(config) = outcome else {
            panic!("configuration loads");
        };
        assert_eq!(config.config_version, 1);
        let policy = ReleasePolicy::select(&config, "stable").expect("stable policy");
        // The selected channel is proven by the plan it admits, not by a
        // round-trip through a name: only the stable feed is packaged.
        assert_eq!(
            policy
                .admit_check()
                .expect("the stable feed is admitted")
                .url,
            "https://updates.example.com/stable.json"
                .parse::<Url>()
                .unwrap()
        );
        assert!(policy.has_trust_anchor());
        assert!(
            ReleasePolicy::select(&config, "beta").is_err(),
            "an unpackaged channel has no feed"
        );
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn origin_matching_is_exact_including_an_explicit_port() {
        let allowed = vec!["updates.example.com:8443".to_string()];
        let with_port = Url::parse("https://updates.example.com:8443/a").unwrap();
        let default_port = Url::parse("https://updates.example.com/a").unwrap();
        assert!(origin_is_allowed(&allowed, &with_port));
        assert!(!origin_is_allowed(&allowed, &default_port));
        let allowed = vec!["updates.example.com".to_string()];
        assert!(origin_is_allowed(&allowed, &default_port));
        assert!(!origin_is_allowed(&allowed, &with_port));
    }

    #[test]
    fn channel_normalization_defaults_to_stable() {
        assert_eq!(normalize_channel(None), "stable");
        assert_eq!(
            normalize_channel(Some(&SettingValue::String("beta".to_string()))),
            "beta"
        );
        assert_eq!(
            normalize_channel(Some(&SettingValue::String("nightly".to_string()))),
            "stable"
        );
        assert_eq!(
            normalize_channel(Some(&SettingValue::String(String::new()))),
            "stable"
        );
    }

    #[test]
    fn sha256_hex_matches_a_known_digest() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    // --- SemVer ------------------------------------------------------------

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
            assert_eq!(actual, expected, "{candidate} vs {current}");
        }
    }

    #[test]
    fn version_validity_gates_what_can_become_a_candidate() {
        for valid in ["0.1.7", "0.1.7-rc.2", "1.0.0+build.1", "10.20.30"] {
            assert!(is_valid_semver(valid), "{valid} must be valid");
        }
        for invalid in ["", "1.0", "1.0.0.0", "v1.0.0", "01.0.0", "not-a-version"] {
            assert!(!is_valid_semver(invalid), "{invalid} must be invalid");
            // An invalid version is never greater, so it can never be installed.
            assert!(!greater_version(invalid, "0.1.7"), "{invalid}");
        }
    }

    // --- scheduling --------------------------------------------------------

    fn env_from<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn schedule_defaults_match_upstream_and_validate_overrides() {
        let config = resolve_schedule_config(env_from(&[])).expect("defaults resolve");
        assert_eq!(config.interval_ms, 600_000);
        assert_eq!(config.max_backoff_ms, 3_600_000);
        assert_eq!(config.jitter, 0.2);

        let config = resolve_schedule_config(env_from(&[
            ("DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS", "5000"),
            ("DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS", "60000"),
            ("DSH_DESKTOP_UPDATE_CHECK_JITTER", "0"),
        ]))
        .expect("overrides resolve");
        assert_eq!(config.interval_ms, 5000);
        assert_eq!(config.max_backoff_ms, 60_000);
        assert_eq!(config.jitter, 0.0);
    }

    #[test]
    fn invalid_schedule_overrides_fail_loud_instead_of_defaulting() {
        for (label, pairs) in [
            (
                "below minimum",
                vec![("DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS", "999")],
            ),
            (
                "above maximum",
                vec![("DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS", "2147483648")],
            ),
            (
                "not a number",
                vec![("DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS", "soon")],
            ),
            (
                "backoff below interval",
                vec![
                    ("DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS", "60000"),
                    ("DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS", "1000"),
                ],
            ),
            (
                "jitter above one",
                vec![("DSH_DESKTOP_UPDATE_CHECK_JITTER", "1.5")],
            ),
            (
                "jitter negative",
                vec![("DSH_DESKTOP_UPDATE_CHECK_JITTER", "-0.1")],
            ),
            (
                "jitter not a number",
                vec![("DSH_DESKTOP_UPDATE_CHECK_JITTER", "lots")],
            ),
        ] {
            assert!(
                resolve_schedule_config(env_from(&pairs)).is_err(),
                "{label} must be an error"
            );
        }
    }

    #[test]
    fn automatic_checks_wait_for_the_deadline_until_due_now_moves_it() {
        let config = UpdateScheduleConfig {
            interval_ms: 600_000,
            max_backoff_ms: 3_600_000,
            jitter: 0.0,
        };
        let mut schedule = UpdateSchedule::new(config);
        assert!(schedule.is_due(0), "a fresh schedule is due immediately");
        assert!(schedule.begin_check(0));
        let delay = schedule
            .complete_check(false, 0, 0.0)
            .expect("the last caller reschedules");
        assert_eq!(delay, 600_000);
        assert!(!schedule.is_due(599_999));
        assert!(schedule.is_due(600_000));
        // A check before the deadline is refused and changes nothing.
        assert!(!schedule.begin_check(599_999));
        // An external intent that needs the feed consulted now moves the
        // deadline without completing a check, so the backoff is untouched.
        schedule.due_now(599_999);
        assert!(schedule.is_due(599_999));
        assert!(schedule.begin_check(599_999));
        assert_eq!(schedule.complete_check(false, 599_999, 0.0), Some(600_000));
    }

    #[test]
    fn consecutive_failures_double_the_delay_up_to_the_cap() {
        let config = UpdateScheduleConfig {
            interval_ms: 10_000,
            max_backoff_ms: 40_000,
            jitter: 0.0,
        };
        let mut schedule = UpdateSchedule::new(config);
        schedule.begin_check(0);
        assert_eq!(schedule.complete_check(true, 0, 0.0), Some(20_000));
        schedule.begin_check(20_000);
        assert_eq!(schedule.complete_check(true, 20_000, 0.0), Some(40_000));
        schedule.begin_check(40_000);
        assert_eq!(
            schedule.complete_check(true, 40_000, 0.0),
            Some(40_000),
            "the cap holds"
        );
        // A success returns to the base interval.
        schedule.begin_check(80_000);
        assert_eq!(schedule.complete_check(false, 80_000, 0.0), Some(10_000));
    }

    #[test]
    fn joined_callers_advance_the_backoff_only_once() {
        let config = UpdateScheduleConfig {
            interval_ms: 10_000,
            max_backoff_ms: 40_000,
            jitter: 0.0,
        };
        let mut schedule = UpdateSchedule::new(config);
        assert!(schedule.begin_check(0));
        // A concurrent caller joins the same in-flight request: the first join
        // cleared the armed deadline, so the request is still due.
        assert!(schedule.begin_check(0), "a concurrent caller joins");
        assert_eq!(schedule.complete_check(true, 0, 0.0), None, "not the last");
        assert_eq!(
            schedule.complete_check(true, 0, 0.0),
            Some(20_000),
            "the last caller schedules once"
        );
    }

    #[test]
    fn jitter_stays_inside_the_validated_range() {
        let config = UpdateScheduleConfig {
            interval_ms: 10_000,
            max_backoff_ms: 40_000,
            jitter: 0.2,
        };
        let mut low = UpdateSchedule::new(config);
        low.begin_check(0);
        assert_eq!(low.complete_check(false, 0, 0.0), Some(8_000));
        let mut high = UpdateSchedule::new(config);
        high.begin_check(0);
        assert_eq!(high.complete_check(false, 0, 1.0), Some(12_000));
        // An out-of-range sample is clamped rather than extrapolated.
        let mut clamped = UpdateSchedule::new(config);
        clamped.begin_check(0);
        assert_eq!(clamped.complete_check(false, 0, 99.0), Some(12_000));
    }

    #[test]
    fn disposal_prevents_new_checks_and_late_rearming() {
        let config = UpdateScheduleConfig {
            interval_ms: 10_000,
            max_backoff_ms: 40_000,
            jitter: 0.0,
        };
        let mut schedule = UpdateSchedule::new(config);
        schedule.begin_check(0);
        schedule.dispose();
        assert!(schedule.is_disposed());
        assert!(!schedule.begin_check(999_999));
        assert_eq!(
            schedule.complete_check(false, 0, 0.0),
            None,
            "a completion after disposal must not rearm the timer"
        );
        assert!(!schedule.is_due(u64::MAX));
    }

    #[test]
    fn artifact_file_name_is_derived_from_candidate_identity() {
        use crate::state::{artifact_file_name, UpdateCandidate};

        let candidate = |version: &str, channel: &str, sha: &str| UpdateCandidate {
            version: version.to_string(),
            channel: channel.to_string(),
            url: "https://updates.example.com/Setup.exe".to_string(),
            sha256: sha.to_string(),
            signature: "00".repeat(64),
            artifact_path: None,
        };
        let digest = "a".repeat(64);
        let stable = candidate("0.1.8", "stable", &digest);
        let name = artifact_file_name(&stable).expect("a well-formed candidate names a file");
        assert!(name.starts_with("dsh-update-stable-0.1.8-"), "{name}");
        assert!(name.ends_with(".bin"), "{name}");
        // A retry of the same release reuses one target.
        assert_eq!(
            name,
            artifact_file_name(&candidate("0.1.8", "stable", &digest)).expect("names a file")
        );
        // A different version, channel, or digest never collides.
        assert_ne!(
            name,
            artifact_file_name(&candidate("0.1.9", "stable", &digest)).expect("names a file")
        );
        assert_ne!(
            name,
            artifact_file_name(&candidate("0.1.8", "beta", &digest)).expect("names a file")
        );
        assert_ne!(
            name,
            artifact_file_name(&candidate("0.1.8", "stable", &"b".repeat(64)))
                .expect("names a file")
        );
        // A digest that is not a SHA-256 names nothing at all: the derivation is
        // a security boundary, not a formatting convenience.
        assert_eq!(
            artifact_file_name(&candidate("0.1.8", "stable", "aa")),
            Err(ArtifactNameFailure::DigestNotSha256Hex)
        );
    }

    // --- the v2 signed target/freshness contract ---------------------------

    /// The fixed qualification key pair.
    ///
    /// The RFC 8032 §7.1 TEST 2 vector, already pinned by the signature tests
    /// above. A published test vector, never product trust: nothing here mints,
    /// stores, ships, or enables release authority.
    fn v2_key_pair() -> (ring::signature::Ed25519KeyPair, String) {
        let seed = hex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
        let key_pair =
            ring::signature::Ed25519KeyPair::from_seed_and_public_key(&seed, &hex(TEST_PUBLIC_KEY))
                .expect("the RFC 8032 TEST 2 key pair is consistent");
        (key_pair, TEST_PUBLIC_KEY.to_string())
    }

    fn v2_signature(key_pair: &ring::signature::Ed25519KeyPair, document: &str) -> String {
        encode_hex(key_pair.sign(document.as_bytes()).as_ref())
    }

    /// The target these cases verify against, fixed so the suite does not depend
    /// on which platform it happens to run on.
    fn v2_target() -> ReleaseTarget {
        ReleaseTarget {
            product: RELEASE_PRODUCT_ID,
            platform: PolicyPlatform::Win32,
            arch: PolicyArch::X64,
        }
    }

    fn v2_document(sequence: u64, expiry_unix_ms: i64) -> SignedReleaseV2 {
        SignedReleaseV2 {
            product: RELEASE_PRODUCT_ID.to_string(),
            platform: v2_target().platform_token().to_string(),
            arch: v2_target().arch_token().to_string(),
            artifact_kind: ReleaseArtifactKind::Installer,
            version: "0.1.8".to_string(),
            channel: "stable".to_string(),
            sha256: sha256_hex(b"v2 payload"),
            metadata_sequence: sequence,
            expiry_unix_ms,
        }
    }

    /// A clock instant well clear of both the clock floor and the expiries used
    /// by these cases.
    const V2_NOW: i64 = 1_700_000_000_000;
    const V2_EXPIRY: i64 = V2_NOW + 60 * 60 * 1000;

    fn v2_admission<'a>(
        target: &'a ReleaseTarget,
        floor: Option<&'a ReleaseFloor>,
    ) -> ReleaseAdmissionV2<'a> {
        ReleaseAdmissionV2 {
            target,
            artifact_kind: ReleaseArtifactKind::Installer,
            now_unix_ms: V2_NOW,
            floor,
        }
    }

    /// Verify `release` with a genuine signature over its own canonical message.
    ///
    /// Re-signing is what makes the *policy* arms testable: a mutated document is
    /// still authentic, so a refusal can only come from the binding under test
    /// rather than from a broken signature.
    fn v2_verify_signed(
        release: &SignedReleaseV2,
        target: &ReleaseTarget,
        floor: Option<&ReleaseFloor>,
    ) -> Result<VerifiedReleaseV2, VerifyFailure> {
        let (key_pair, public) = v2_key_pair();
        let document = release.message();
        let signature = v2_signature(&key_pair, &document);
        verify_release_v2(
            &[public],
            &document,
            Some(&signature),
            &v2_admission(target, floor),
        )
    }

    #[test]
    fn the_v2_canonical_message_is_pinned_field_by_field() {
        let document = v2_document(7, 1_700_000_000_000);
        let digest = sha256_hex(b"v2 payload");
        let expected = format!(
            "dsh-desktop-release/v2\nproduct=dsh-desktop\nplatform=desktop-win\narch=x64\nkind=installer\nversion=0.1.8\nchannel=stable\nsha256={digest}\nsequence=7\nexpiry=1700000000000\n"
        );
        assert_eq!(document.message(), expected);
        // One marker, nine fields, and the empty tail a trailing newline leaves.
        assert_eq!(document.message().split('\n').count(), 11);
        // The digest is the canonical lowercase form, so the bytes a publisher
        // signs are the bytes a verifier reads.
        assert!(digest
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()));
    }

    #[test]
    fn a_canonical_v2_document_parses_back_to_its_fields() {
        let document = v2_document(11, 1_700_000_000_000);
        let parsed =
            SignedReleaseV2::parse(&document.message()).expect("the canonical document parses");
        assert_eq!(parsed, document);
        assert_eq!(parsed.metadata_sequence, 11);
        assert_eq!(parsed.artifact_kind, ReleaseArtifactKind::Installer);
    }

    #[test]
    fn a_changed_byte_in_any_v2_field_breaks_the_signature() {
        let target = v2_target();
        let (key_pair, public) = v2_key_pair();
        let signed = v2_document(7, V2_EXPIRY);
        let document = signed.message();
        let signature = v2_signature(&key_pair, &document);
        assert!(
            verify_release_v2(
                std::slice::from_ref(&public),
                &document,
                Some(&signature),
                &v2_admission(&target, None)
            )
            .is_ok(),
            "the unmutated document verifies"
        );
        for (label, mutated) in [
            (
                "version",
                SignedReleaseV2 {
                    version: "0.1.9".to_string(),
                    ..signed.clone()
                },
            ),
            (
                "sequence",
                SignedReleaseV2 {
                    metadata_sequence: 8,
                    ..signed.clone()
                },
            ),
            (
                "expiry",
                SignedReleaseV2 {
                    expiry_unix_ms: V2_EXPIRY + 1,
                    ..signed.clone()
                },
            ),
            (
                "product",
                SignedReleaseV2 {
                    product: "other-product".to_string(),
                    ..signed.clone()
                },
            ),
            (
                "platform",
                SignedReleaseV2 {
                    platform: "desktop-mac".to_string(),
                    ..signed.clone()
                },
            ),
            (
                "arch",
                SignedReleaseV2 {
                    arch: "arm64".to_string(),
                    ..signed.clone()
                },
            ),
            (
                "kind",
                SignedReleaseV2 {
                    artifact_kind: ReleaseArtifactKind::RuntimePayload,
                    ..signed.clone()
                },
            ),
            (
                "channel",
                SignedReleaseV2 {
                    channel: "beta".to_string(),
                    ..signed.clone()
                },
            ),
            (
                "digest",
                SignedReleaseV2 {
                    sha256: "b".repeat(64),
                    ..signed.clone()
                },
            ),
        ] {
            // Every mutation is still a canonical document, so the refusal below
            // is the signature binding and not the parser.
            assert!(
                SignedReleaseV2::parse(&mutated.message()).is_ok(),
                "{label} must stay canonical"
            );
            assert_eq!(
                verify_release_v2(
                    std::slice::from_ref(&public),
                    &mutated.message(),
                    Some(&signature),
                    &v2_admission(&target, None)
                ),
                Err(VerifyFailure::InvalidSignature),
                "{label}"
            );
        }
    }

    #[test]
    fn a_v1_document_is_refused_by_v2_and_a_v2_signature_by_v1() {
        let digest = sha256_hex(b"v2 payload");
        let v1 = SignedRelease {
            version: "0.1.8",
            channel: "stable",
            sha256: &digest,
        };
        assert_eq!(
            SignedReleaseV2::parse(&v1.message()),
            Err(VerifyFailure::UnsupportedSchema {
                found: "dsh-desktop-release/v1".to_string()
            })
        );
        // The other direction: a signature over the v2 message is not a signature
        // over the v1 message, so the v1 verifier refuses it instead of accepting
        // a document it never read.
        let (key_pair, public) = v2_key_pair();
        let document = v2_document(7, V2_EXPIRY).message();
        let signature = v2_signature(&key_pair, &document);
        assert_eq!(
            verify_release(&[public], &v1, Some(&signature)),
            Err(VerifyFailure::InvalidSignature)
        );
    }

    #[test]
    fn an_unknown_schema_marker_is_refused_without_a_fallback() {
        for document in [
            "",
            "dsh-desktop-release/v3\nproduct=dsh-desktop\n",
            "not a release document",
        ] {
            let outcome = SignedReleaseV2::parse(document);
            assert!(
                matches!(outcome, Err(VerifyFailure::UnsupportedSchema { .. })),
                "{document:?} -> {outcome:?}"
            );
        }
        // The verifier refuses the schema before it would consult a key or a
        // clock: neither can rescue an unreadable document.
        let target = v2_target();
        let (_, public) = v2_key_pair();
        let outcome = verify_release_v2(
            &[public],
            "dsh-desktop-release/v1\nversion=0.1.8\nchannel=stable\nsha256=aa\n",
            Some("00"),
            &v2_admission(&target, None),
        );
        assert!(matches!(
            outcome,
            Err(VerifyFailure::UnsupportedSchema { .. })
        ));
    }

    #[test]
    fn the_v2_document_format_refuses_every_non_canonical_shape() {
        let canonical = v2_document(7, 1_700_000_000_000).message();
        let digest = sha256_hex(b"v2 payload");
        let cases: [(&str, String); 8] = [
            (
                "no trailing newline",
                canonical.trim_end_matches('\n').to_string(),
            ),
            (
                "blank line",
                canonical.replace("channel=stable\n", "channel=stable\n\n"),
            ),
            (
                "reordered fields",
                canonical.replace(
                    "platform=desktop-win\narch=x64\n",
                    "arch=x64\nplatform=desktop-win\n",
                ),
            ),
            (
                "extra field",
                canonical.replace("channel=stable\n", "channel=stable\nextra=1\n"),
            ),
            (
                "unknown key",
                canonical.replace("channel=stable", "route=stable"),
            ),
            (
                "uppercase digest",
                canonical.replace(&digest, &digest.to_ascii_uppercase()),
            ),
            (
                "empty value",
                canonical.replace("channel=stable", "channel="),
            ),
            (
                "carriage return",
                canonical.replace("channel=stable", "channel=stable\r"),
            ),
        ];
        for (label, document) in cases {
            let outcome = SignedReleaseV2::parse(&document);
            assert!(outcome.is_err(), "{label} must be refused: {outcome:?}");
        }
        // The unmodified document still parses, so the cases above are the only
        // difference.
        assert!(SignedReleaseV2::parse(&canonical).is_ok());
    }

    #[test]
    fn a_v2_document_needs_a_well_formed_digest() {
        let canonical = v2_document(7, 1_700_000_000_000).message();
        let digest = sha256_hex(b"v2 payload");
        assert_eq!(
            SignedReleaseV2::parse(&canonical.replace(&digest, "")),
            Err(VerifyFailure::MissingDigest)
        );
        assert_eq!(
            SignedReleaseV2::parse(&canonical.replace(&digest, &"a".repeat(63))),
            Err(VerifyFailure::MalformedDigest)
        );
        assert_eq!(
            SignedReleaseV2::parse(&canonical.replace(&digest, &"z".repeat(64))),
            Err(VerifyFailure::MalformedDigest)
        );
    }

    #[test]
    fn an_unknown_artifact_kind_token_is_refused() {
        let document = v2_document(7, 1_700_000_000_000)
            .message()
            .replace("kind=installer", "kind=snapshot");
        assert_eq!(
            SignedReleaseV2::parse(&document),
            Err(VerifyFailure::UnsupportedArtifactKind {
                found: "snapshot".to_string()
            })
        );
    }

    #[test]
    fn v2_signature_and_key_refusals_are_distinct() {
        let target = v2_target();
        let (key_pair, public) = v2_key_pair();
        let document = v2_document(7, V2_EXPIRY).message();
        let signature = v2_signature(&key_pair, &document);
        let admission = v2_admission(&target, None);
        assert_eq!(
            verify_release_v2(&[], &document, Some(&signature), &admission),
            Err(VerifyFailure::NoTrustedKeys)
        );
        assert_eq!(
            verify_release_v2(std::slice::from_ref(&public), &document, None, &admission),
            Err(VerifyFailure::MissingSignature)
        );
        assert_eq!(
            verify_release_v2(
                std::slice::from_ref(&public),
                &document,
                Some("   "),
                &admission
            ),
            Err(VerifyFailure::MissingSignature)
        );
        assert_eq!(
            verify_release_v2(
                std::slice::from_ref(&public),
                &document,
                Some("aabb"),
                &admission
            ),
            Err(VerifyFailure::MalformedSignature)
        );
        // A well-formed signature over a different document, and a signature from
        // a key that is not the trusted one, are both simply not this release.
        let other = v2_document(8, V2_EXPIRY).message();
        let other_signature = v2_signature(&key_pair, &other);
        assert_eq!(
            verify_release_v2(
                std::slice::from_ref(&public),
                &document,
                Some(&other_signature),
                &admission
            ),
            Err(VerifyFailure::InvalidSignature)
        );
        // A key that is not the trusted one cannot authenticate this document,
        // even though its signature is well formed. The RFC 8032 §7.1 TEST 1
        // vector supplies the second pair.
        let untrusted_seed =
            hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
        let untrusted_public =
            hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        let untrusted = ring::signature::Ed25519KeyPair::from_seed_and_public_key(
            &untrusted_seed,
            &untrusted_public,
        )
        .expect("the RFC 8032 TEST 1 key pair is consistent");
        let untrusted_signature = v2_signature(&untrusted, &document);
        assert_eq!(
            verify_release_v2(
                std::slice::from_ref(&public),
                &document,
                Some(&untrusted_signature),
                &admission
            ),
            Err(VerifyFailure::InvalidSignature)
        );
        // A key that cannot be a key is a different condition from a key that did
        // not sign this document.
        for unusable in ["zz", "aabb"] {
            assert!(
                matches!(
                    verify_release_v2(
                        &[unusable.to_string()],
                        &document,
                        Some(&signature),
                        &admission
                    ),
                    Err(VerifyFailure::MalformedKey(_))
                ),
                "{unusable}"
            );
        }
        assert!(verify_release_v2(&[public], &document, Some(&signature), &admission).is_ok());
    }

    #[test]
    fn v2_target_bindings_are_each_refused_for_an_authentic_document() {
        let target = v2_target();
        assert_eq!(
            v2_verify_signed(
                &SignedReleaseV2 {
                    product: "other-product".to_string(),
                    ..v2_document(7, V2_EXPIRY)
                },
                &target,
                None
            ),
            Err(VerifyFailure::WrongProduct {
                expected: RELEASE_PRODUCT_ID.to_string(),
                found: "other-product".to_string()
            })
        );
        assert_eq!(
            v2_verify_signed(
                &SignedReleaseV2 {
                    platform: "desktop-mac".to_string(),
                    ..v2_document(7, V2_EXPIRY)
                },
                &target,
                None
            ),
            Err(VerifyFailure::WrongPlatform {
                expected: "desktop-win".to_string(),
                found: "desktop-mac".to_string()
            })
        );
        assert_eq!(
            v2_verify_signed(
                &SignedReleaseV2 {
                    arch: "arm64".to_string(),
                    ..v2_document(7, V2_EXPIRY)
                },
                &target,
                None
            ),
            Err(VerifyFailure::WrongArchitecture {
                expected: "x64".to_string(),
                found: "arm64".to_string()
            })
        );
        assert_eq!(
            v2_verify_signed(
                &SignedReleaseV2 {
                    artifact_kind: ReleaseArtifactKind::RuntimePayload,
                    ..v2_document(7, V2_EXPIRY)
                },
                &target,
                None
            ),
            Err(VerifyFailure::WrongArtifactKind {
                expected: ReleaseArtifactKind::Installer,
                found: ReleaseArtifactKind::RuntimePayload
            })
        );
    }

    #[test]
    fn v2_refuses_expired_metadata_and_an_unusable_clock() {
        let target = v2_target();
        // Expiry plus the tolerated skew is still current; one millisecond later
        // is stale. The boundary is asserted in both directions so the tolerance
        // cannot drift unnoticed.
        let boundary = SignedReleaseV2 {
            expiry_unix_ms: V2_NOW - RELEASE_METADATA_CLOCK_SKEW_MS,
            ..v2_document(7, V2_NOW)
        };
        assert!(
            v2_verify_signed(&boundary, &target, None).is_ok(),
            "metadata at the tolerance boundary is still current"
        );
        let stale_expiry = V2_NOW - RELEASE_METADATA_CLOCK_SKEW_MS - 1;
        assert_eq!(
            v2_verify_signed(
                &SignedReleaseV2 {
                    expiry_unix_ms: stale_expiry,
                    ..v2_document(7, V2_NOW)
                },
                &target,
                None
            ),
            Err(VerifyFailure::MetadataExpired {
                expiry_unix_ms: stale_expiry,
                now_unix_ms: V2_NOW
            })
        );
        // A clock the caller cannot trust refuses a perfectly fresh document: an
        // unusable clock is never read as "nothing has expired".
        let (key_pair, public) = v2_key_pair();
        let document = v2_document(7, V2_EXPIRY).message();
        let signature = v2_signature(&key_pair, &document);
        let untrusted_now = RELEASE_METADATA_CLOCK_FLOOR_UNIX_MS - 1;
        let no_clock = ReleaseAdmissionV2 {
            target: &target,
            artifact_kind: ReleaseArtifactKind::Installer,
            now_unix_ms: untrusted_now,
            floor: None,
        };
        assert_eq!(
            verify_release_v2(&[public], &document, Some(&signature), &no_clock),
            Err(VerifyFailure::ClockUnavailable {
                now_unix_ms: untrusted_now
            })
        );
    }

    #[test]
    fn v2_refuses_a_sequence_at_or_below_the_persisted_floor() {
        let target = v2_target();
        let floor = ReleaseFloor::new(7, "0.1.8");
        assert_eq!(
            v2_verify_signed(&v2_document(7, V2_EXPIRY), &target, Some(&floor)),
            Err(VerifyFailure::MetadataSequenceTooLow {
                floor_sequence: 7,
                found_sequence: 7
            }),
            "replaying the admitted manifest is a rollback too"
        );
        assert_eq!(
            v2_verify_signed(&v2_document(6, V2_EXPIRY), &target, Some(&floor)),
            Err(VerifyFailure::MetadataSequenceTooLow {
                floor_sequence: 7,
                found_sequence: 6
            })
        );
        assert!(
            v2_verify_signed(&v2_document(8, V2_EXPIRY), &target, Some(&floor)).is_ok(),
            "a strictly newer sequence is admitted"
        );
        assert!(
            v2_verify_signed(&v2_document(1, V2_EXPIRY), &target, None).is_ok(),
            "with no persisted floor there is nothing to roll back to"
        );
    }

    #[test]
    fn a_v2_document_that_binds_this_build_verifies() {
        let target = v2_target();
        let verified = v2_verify_signed(&v2_document(7, V2_EXPIRY), &target, None)
            .expect("an authentic document binding this build is admitted");
        assert_eq!(verified.product, RELEASE_PRODUCT_ID);
        assert_eq!(verified.platform, target.platform_token());
        assert_eq!(verified.arch, target.arch_token());
        assert_eq!(verified.artifact_kind, ReleaseArtifactKind::Installer);
        assert_eq!(verified.version, "0.1.8");
        assert_eq!(verified.channel, "stable");
        assert_eq!(verified.sha256, sha256_hex(b"v2 payload"));
        assert_eq!(verified.metadata_sequence, 7);
        assert_eq!(verified.expiry_unix_ms, V2_EXPIRY);
    }

    #[test]
    fn the_release_floor_round_trips_and_keeps_refusing() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let path = directory.path().join("updates-floor.json");
        assert_eq!(
            ReleaseFloor::load_from(&path),
            Ok(None),
            "an absent floor is not an error"
        );
        let floor = ReleaseFloor::new(7, "0.1.8");
        floor.save_to(&path).expect("the floor is written");
        let loaded = ReleaseFloor::load_from(&path)
            .expect("the floor loads")
            .expect("a floor is present");
        assert_eq!(loaded, floor);
        // The refusal survives the round trip: the persisted sequence still
        // refuses itself and anything older, and still admits a newer one.
        assert!(loaded.refuses(7));
        assert!(loaded.refuses(6));
        assert!(!loaded.refuses(8));
        let target = v2_target();
        assert_eq!(
            v2_verify_signed(&v2_document(7, V2_EXPIRY), &target, Some(&loaded)),
            Err(VerifyFailure::MetadataSequenceTooLow {
                floor_sequence: 7,
                found_sequence: 7
            })
        );
        assert!(v2_verify_signed(&v2_document(8, V2_EXPIRY), &target, Some(&loaded)).is_ok());
    }

    #[test]
    fn saving_a_floor_never_replaces_an_existing_one() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let path = directory.path().join("updates-floor.json");
        ReleaseFloor::new(9, "0.1.9")
            .save_to(&path)
            .expect("the first write succeeds");
        // A lower floor cannot overwrite a higher one, because the write is
        // refused outright rather than truncating the file that is there.
        assert!(matches!(
            ReleaseFloor::new(1, "0.1.1").save_to(&path),
            Err(FloorFailure::WriteFailed { .. })
        ));
        assert_eq!(
            ReleaseFloor::load_from(&path).expect("the floor still loads"),
            Some(ReleaseFloor::new(9, "0.1.9"))
        );
    }

    #[test]
    fn an_unusable_floor_file_is_refused_rather_than_read_as_absent() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let cases: [(&str, Vec<u8>); 5] = [
            ("not json", b"{not json".to_vec()),
            (
                "unknown field",
                br#"{"schemaVersion":1,"metadataSequence":7,"releaseVersion":"0.1.8","extra":true}"#
                    .to_vec(),
            ),
            (
                "unsupported schema",
                br#"{"schemaVersion":2,"metadataSequence":7,"releaseVersion":"0.1.8"}"#.to_vec(),
            ),
            (
                "empty version",
                br#"{"schemaVersion":1,"metadataSequence":7,"releaseVersion":""}"#.to_vec(),
            ),
            (
                "oversized",
                vec![b'0'; (RELEASE_FLOOR_MAX_BYTES + 1) as usize],
            ),
        ];
        for (index, (label, bytes)) in cases.iter().enumerate() {
            let path = directory.path().join(format!("floor-{index}.json"));
            std::fs::write(&path, bytes).expect("write the case fixture");
            let outcome = ReleaseFloor::load_from(&path);
            assert!(
                matches!(outcome, Err(FloorFailure::Unusable { .. })),
                "{label}: {outcome:?}"
            );
        }
        // A directory at the path is not a floor either: the entry is classified
        // before it is read, so a wrong kind of entry is never "no floor".
        let path = directory.path().join("floor-directory.json");
        std::fs::create_dir(&path).expect("create the directory case");
        assert!(matches!(
            ReleaseFloor::load_from(&path),
            Err(FloorFailure::Unusable { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn the_floor_file_is_created_owner_only_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("a temporary directory");
        let path = directory.path().join("updates-floor.json");
        ReleaseFloor::new(7, "0.1.8")
            .save_to(&path)
            .expect("the floor is written");
        let mode = std::fs::metadata(&path)
            .expect("floor metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "the floor is owner-only");
    }

    #[test]
    fn release_target_tokens_are_the_installed_client_identity_vocabulary() {
        use crate::mandatory_update::DesktopPolicyIdentity;

        for (platform, expected_platform) in [
            (PolicyPlatform::Win32, "desktop-win"),
            (PolicyPlatform::Darwin, "desktop-mac"),
        ] {
            for (arch, expected_arch) in [(PolicyArch::X64, "x64"), (PolicyArch::Arm64, "arm64")] {
                let target = ReleaseTarget {
                    product: RELEASE_PRODUCT_ID,
                    platform,
                    arch,
                };
                // The policy identity reports the same running build, so the two
                // vocabularies are pinned together: a change on either side fails
                // here rather than silently splitting the product's identity.
                let identity = DesktopPolicyIdentity {
                    platform,
                    arch,
                    bundled_dsh_version: "0.1.8".to_string(),
                };
                assert_eq!(target.platform_token(), identity.platform_header());
                assert_eq!(target.arch_token(), identity.arch_header());
                assert_eq!(target.platform_token(), expected_platform);
                assert_eq!(target.arch_token(), expected_arch);
                assert!(is_canonical_release_value(target.platform_token()));
                assert!(is_canonical_release_value(target.arch_token()));
            }
        }
    }

    #[test]
    fn the_running_build_target_is_derived_from_its_own_constants() {
        let expected = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("windows", "x86_64") => Some((PolicyPlatform::Win32, PolicyArch::X64)),
            ("macos", "x86_64") => Some((PolicyPlatform::Darwin, PolicyArch::X64)),
            ("macos", "aarch64") => Some((PolicyPlatform::Darwin, PolicyArch::Arm64)),
            _ => None,
        };
        match (ReleaseTarget::for_running_build(), expected) {
            (Some(target), Some((platform, arch))) => {
                assert_eq!(target.product, RELEASE_PRODUCT_ID);
                assert_eq!((target.platform, target.arch), (platform, arch));
            }
            (None, None) => {}
            (target, expected) => panic!(
                "the running build target {target:?} disagrees with the host constants {expected:?}"
            ),
        }
    }
}
