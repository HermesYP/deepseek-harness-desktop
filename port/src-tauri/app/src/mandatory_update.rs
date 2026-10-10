//! Mandatory-update policy and the release gate it implies.
//!
//! Parity target: `_upstream/apps/desktop/src/mandatory-update-policy.ts` and
//! the confirmation rules of `mandatory-update-window.ts`.
//!
//! ## The distinction this module exists to keep
//!
//! Upstream has **two independent** concepts, and conflating them is the bug
//! this module is written to prevent:
//!
//! 1. **The mandatory decision** ([`MandatoryDecision`]) is a *server* verdict
//!    from the client-update endpoint: this installed version is no longer
//!    supported. It is the only thing that blocks the application.
//! 2. **The ordinary update** ([`crate::update_flow`]) is a feed result: a newer
//!    package exists. It is offered as an optional prompt, and the user may
//!    choose **Later**.
//!
//! A normal update is therefore **never** mandatory, and a mandatory decision
//! does **not** by itself describe a downloadable release — it says "update or
//! stop", and the feed is consulted separately. Upstream expresses this by
//! letting the policy publish a blocked state with *no* release attached
//! (`mandatoryNoRelease`), while the updater keeps its own candidate state.
//! [`MandatoryPolicy::enforcement`] is the single place that combines them.
//!
//! ## Failure behaviour
//!
//! A known block survives transport, parsing, and protocol failures: the last
//! confirmed verdict stands rather than being silently cleared by an error.
//! Only a *fresh, well-formed* no-force answer clears it. Both rules are
//! upstream's (`mandatory-update-policy.ts:112-125`, `:201-204`).
//!
//! ## Scheduling
//!
//! Polling mirrors [`crate::update_security::UpdateSchedule`]'s shape but is
//! independent of it: upstream is explicit that ordinary feed polling and
//! mandatory-policy polling keep separate lifetimes and separate schedules
//! (`mandatory-update-policy.ts:1`, `update-schedule.ts:14`). The mandatory
//! endpoint also has its own timeout, and a failure count that drives the
//! backoff (`2 ** min(failures, 20)`, capped) rather than a simple doubling.

use url::Url;

// ---------------------------------------------------------------------------
// Installed-client identity
// ---------------------------------------------------------------------------

/// Which platform this build was produced for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PolicyPlatform {
    Win32,
    Darwin,
}

/// Which CPU architecture this build was produced for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PolicyArch {
    X64,
    Arm64,
}

/// The installed release identity sent with every policy check.
///
/// No field is supplied by a renderer: `bundledDshVersion` is the Harness
/// runtime bundled into this shell, not the shell's own package version, so a
/// shell-only release does not change what the server is asked about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopPolicyIdentity {
    pub platform: PolicyPlatform,
    pub arch: PolicyArch,
    /// SemVer of the bundled Harness runtime.
    pub bundled_dsh_version: String,
}

impl DesktopPolicyIdentity {
    /// Validate the identity before any request is made.
    ///
    /// Upstream rejects an invalid client version, an invalid bundled version,
    /// and the one platform/arch combination the installer never produces
    /// (`mandatory-update-policy.ts:153-154`).
    pub fn validate(&self) -> Result<(), String> {
        if !crate::update_security::is_valid_semver(&self.bundled_dsh_version) {
            return Err(format!(
                "desktop policy: bundled Harness version `{}` is not valid SemVer",
                self.bundled_dsh_version
            ));
        }
        if self.platform == PolicyPlatform::Win32 && self.arch != PolicyArch::X64 {
            return Err(
                "desktop policy: the installed client identity is not a supported build"
                    .to_string(),
            );
        }
        Ok(())
    }

    /// The `x-client-arch` header value.
    pub fn arch_header(&self) -> &'static str {
        match self.arch {
            PolicyArch::X64 => "x64",
            PolicyArch::Arm64 => "arm64",
        }
    }

    /// The `x-client-platform` header value.
    pub fn platform_header(&self) -> &'static str {
        match self.platform {
            PolicyPlatform::Win32 => "desktop-win",
            PolicyPlatform::Darwin => "desktop-mac",
        }
    }
}

// ---------------------------------------------------------------------------
// Deployment configuration
// ---------------------------------------------------------------------------

/// How the policy request authenticates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyAuthentication {
    /// Anonymous `fetch` with no credentials.
    Anonymous,
    /// Test authentication over a dedicated session that carries cookies.
    ///
    /// This port has no qualified isolated login session, so
    /// [`crate::policy_composition::install`] refuses the whole mode before any
    /// window exists and [`crate::policy_transport::check_policy`] refuses it
    /// before any client is built. The configuration still parses and validates
    /// so a deployment document is never silently downgraded to anonymous.
    ///
    /// Whoever qualifies the mode owns two rules that no production code in this
    /// tree enforces yet, because the surface does not exist:
    ///
    /// 1. a login window may navigate to exactly `allowed_auth_origins` plus
    ///    `origin`, and never to `allowed_page_origins` — opening a download
    ///    page there would hand it the gateway cookies only the login flow may
    ///    carry;
    /// 2. a check issued on return from that window is
    ///    [`PolicyScenario::Manual`], so it bypasses the armed deadline exactly
    ///    as an explicit user retry does, and never reuses a flight started
    ///    before the login.
    FeishuTest,
}

/// Validated deployment choices for policy polling.
///
/// `origin` is the policy service. `allowed_page_origins` bounds the
/// "Open download page" action, which is a *navigation* authority and therefore
/// deliberately separate from the feed/artifact allow list in
/// [`crate::update_security`]: a page origin never authorizes an artifact
/// download, and an artifact origin never authorizes navigation.
///
/// `allowed_auth_origins` is the third, separate authority: see
/// [`PolicyAuthentication::FeishuTest`] for the navigation rule it will govern.
/// It is validated here but has no consumer while that mode is refused.
///
/// Not `Eq`: `jitter` is a fraction. Two configurations with the same effective
/// jitter compare equal through `PartialEq`, which is all callers need.
#[derive(Debug, Clone, PartialEq)]
pub struct DesktopPolicyConfig {
    pub origin: String,
    pub allowed_page_origins: Vec<String>,
    pub allowed_auth_origins: Vec<String>,
    pub interval_ms: u64,
    pub timeout_ms: u64,
    pub max_backoff_ms: u64,
    pub jitter: f64,
    pub authentication: PolicyAuthentication,
}

const POLICY_MIN_DURATION_MS: u64 = 1_000;
const POLICY_MAX_DURATION_MS: u64 = 2_147_483_647;
const DEFAULT_POLICY_INTERVAL_MS: u64 = 600_000;
const DEFAULT_POLICY_TIMEOUT_MS: u64 = 15_000;
const DEFAULT_POLICY_MAX_BACKOFF_MS: u64 = 3_600_000;
const DEFAULT_POLICY_JITTER: f64 = 0.2;

/// Validate one deployment origin.
///
/// An origin must be HTTPS (loopback HTTP is the one explicit, unpackaged
/// exception) with no credentials, path, query, or fragment. Anything else is
/// refused rather than normalized, because normalizing would let a
/// misconfiguration silently point policy traffic somewhere unintended.
fn policy_origin(value: &str, allow_loopback: bool) -> Result<String, String> {
    let url = Url::parse(value)
        .map_err(|error| format!("desktop policy: origin must be a URL: {error}"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("desktop policy: origin must not carry credentials".to_string());
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("desktop policy: origin must not carry a path, query, or fragment".to_string());
    }
    let loopback = url.scheme() == "http" && allow_loopback && url.host_str() == Some("127.0.0.1");
    if url.scheme() != "https" && !loopback {
        return Err(format!(
            "desktop policy: expected an HTTPS origin without credentials, path, query, or fragment (found `{}`)",
            url.scheme()
        ));
    }
    Ok(url.origin().ascii_serialization())
}

/// Resolve the mandatory-policy configuration from a parsed deployment document.
///
/// Returns `Ok(None)` when no configuration is present at all, which disables
/// policy queries: an application that was not packaged with a policy service
/// must not guess one. A present but invalid document is an error, never a
/// silent fallback (upstream `resolveDesktopPolicyConfig`).
pub fn resolve_policy_config(
    input: Option<&serde_json::Value>,
    allow_loopback: bool,
) -> Result<Option<DesktopPolicyConfig>, String> {
    let Some(input) = input else {
        return Ok(None);
    };
    let object = input
        .as_object()
        .ok_or_else(|| "desktop policy: configuration must be an object".to_string())?;
    let allowed_page_origins = object
        .get("allowedPageOrigins")
        .and_then(|value| value.as_array())
        .filter(|values| !values.is_empty())
        .ok_or_else(|| {
            "desktop policy: configure origin and a nonempty allowedPageOrigins list".to_string()
        })?;

    fn duration(
        object: &serde_json::Map<String, serde_json::Value>,
        key: &str,
        fallback: u64,
    ) -> Result<u64, String> {
        let Some(value) = object.get(key) else {
            return Ok(fallback);
        };
        let value = value.as_u64().ok_or_else(|| {
            format!("desktop policy: {key} must be an integer from 1000 through 2147483647")
        })?;
        if !(POLICY_MIN_DURATION_MS..=POLICY_MAX_DURATION_MS).contains(&value) {
            return Err(format!(
                "desktop policy: {key} must be an integer from 1000 through 2147483647"
            ));
        }
        Ok(value)
    }

    let interval_ms = duration(object, "intervalMs", DEFAULT_POLICY_INTERVAL_MS)?;
    let timeout_ms = duration(object, "timeoutMs", DEFAULT_POLICY_TIMEOUT_MS)?;
    let max_backoff_ms = duration(object, "maxBackoffMs", DEFAULT_POLICY_MAX_BACKOFF_MS)?;
    let jitter = match object.get("jitter") {
        Some(value) => value
            .as_f64()
            .ok_or_else(|| "desktop policy: jitter must be in [0, 1]".to_string())?,
        None => DEFAULT_POLICY_JITTER,
    };
    let authentication = match object
        .get("authentication")
        .and_then(|value| value.as_str())
    {
        None | Some("anonymous") => PolicyAuthentication::Anonymous,
        Some("feishu-test") => PolicyAuthentication::FeishuTest,
        Some(other) => {
            return Err(format!(
                "desktop policy: authentication must be anonymous or feishu-test (found `{other}`)"
            ))
        }
    };
    if !jitter.is_finite() || !(0.0..=1.0).contains(&jitter) || max_backoff_ms < interval_ms {
        return Err(
            "desktop policy: jitter must be in [0, 1] and maxBackoffMs must cover intervalMs"
                .to_string(),
        );
    }
    let auth_origins = object.get("allowedAuthOrigins");
    // The two authentication modes have opposite rules, and both are enforced:
    // test authentication *requires* login origins, anonymous *forbids* them,
    // so a test configuration cannot ship as a production one unmodified.
    let allowed_auth_origins = match (authentication, auth_origins) {
        (PolicyAuthentication::FeishuTest, Some(values)) => {
            let values = values
                .as_array()
                .filter(|values| !values.is_empty())
                .ok_or_else(|| {
                    "desktop policy: test authentication requires nonempty allowedAuthOrigins"
                        .to_string()
                })?;
            let mut origins = Vec::with_capacity(values.len());
            for value in values {
                let value = value.as_str().ok_or_else(|| {
                    "desktop policy: allowedAuthOrigins entries must be strings".to_string()
                })?;
                origins.push(policy_origin(value, false)?);
            }
            origins
        }
        (PolicyAuthentication::FeishuTest, None) => {
            return Err(
                "desktop policy: test authentication requires nonempty allowedAuthOrigins"
                    .to_string(),
            )
        }
        (PolicyAuthentication::Anonymous, Some(_)) => {
            return Err(
                "desktop policy: anonymous policy must not configure allowedAuthOrigins"
                    .to_string(),
            )
        }
        (PolicyAuthentication::Anonymous, None) => Vec::new(),
    };
    let origin = object
        .get("origin")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "desktop policy: origin must be a URL".to_string())?;
    // Loopback HTTP is permitted only for an anonymous, unpackaged
    // configuration: carrying cookies over cleartext to a local test service
    // would leak them, and a packaged build must never point at loopback.
    let origin = policy_origin(
        origin,
        allow_loopback && authentication == PolicyAuthentication::Anonymous,
    )?;
    let mut allowed_page_origins_out = Vec::with_capacity(allowed_page_origins.len());
    for value in allowed_page_origins {
        let value = value.as_str().ok_or_else(|| {
            "desktop policy: allowedPageOrigins entries must be strings".to_string()
        })?;
        allowed_page_origins_out.push(policy_origin(value, false)?);
    }
    Ok(Some(DesktopPolicyConfig {
        origin,
        allowed_page_origins: allowed_page_origins_out,
        allowed_auth_origins,
        interval_ms,
        timeout_ms,
        max_backoff_ms,
        jitter,
        authentication,
    }))
}

/// Validate a fallback download page immediately before browser or clipboard
/// use.
///
/// The page comes from the policy response, never from the feed, the renderer,
/// or a shell command. Returns `None` for a missing, oversized, non-https, or
/// unlisted destination (upstream `desktopPolicyPage`).
pub fn policy_page(value: Option<&str>, allowed_origins: &[String]) -> Option<String> {
    let value = value?;
    if value.len() > 2048 {
        return None;
    }
    let url = Url::parse(value).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let origin = url.origin().ascii_serialization();
    allowed_origins
        .iter()
        .any(|allowed| allowed == &origin)
        .then(|| url.to_string())
}

// ---------------------------------------------------------------------------
// The policy decision
// ---------------------------------------------------------------------------

/// Why a policy answer could not be used. Neither arm clears a known block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyError {
    /// Transport, JSON, or protocol failure: the decision is unknown.
    Unavailable,
    /// Test authentication is required before the server will decide.
    AuthenticationRequired,
}

/// The mandatory decision as last confirmed.
///
/// `blocking` is the verdict; the presentation fields are the server's
/// localized copy, which is optional in every case and falls back to client
/// text. `error` records that the *latest* attempt failed without changing the
/// verdict.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MandatoryDecision {
    pub blocking: bool,
    pub checking: bool,
    pub title: Option<String>,
    pub detail: Option<String>,
    /// Validated fallback download page, already checked against the allow list.
    pub page: Option<String>,
    pub error: Option<PolicyError>,
}

impl MandatoryDecision {
    /// The initial, unqueried decision: not blocking.
    pub fn initial() -> Self {
        Self::default()
    }

    /// Retain a known verdict while recording that the newest attempt failed.
    ///
    /// This is the rule that makes a mandatory requirement durable: a network
    /// outage must not be able to lift a block, because the user could
    /// otherwise reconnect, lose one request, and keep using an unsupported
    /// build.
    pub fn with_error(&self, error: PolicyError) -> Self {
        Self {
            checking: false,
            error: Some(error),
            ..self.clone()
        }
    }

    /// Mark a check as started, keeping the current verdict.
    pub fn checking(&self) -> Self {
        Self {
            checking: true,
            error: None,
            ..self.clone()
        }
    }
}

/// Parse one policy response body into a decision.
///
/// The protocol is exact: `code: 40005` is a mandatory block, and only
/// `code: 0` with `biz_code: 0` and `biz_data: null` is a no-force answer.
/// Anything else is an error, so an unrecognized response can never be read as
/// "no update required" (upstream `parsePolicy`).
pub fn parse_policy(
    body: &serde_json::Value,
    http_ok: bool,
    config: &DesktopPolicyConfig,
) -> Result<MandatoryDecision, String> {
    let root = body
        .as_object()
        .ok_or_else(|| "desktop policy: response is not an object".to_string())?;
    let data = root.get("data").and_then(|value| value.as_object());
    if root.get("code").and_then(|value| value.as_i64()) == Some(40005) {
        let content = data
            .and_then(|data| data.get("show_content"))
            .and_then(|value| value.as_object());
        let title = content
            .and_then(|content| content.get("title"))
            .and_then(|value| value.as_str())
            .and_then(|value| policy_text(Some(value), 256));
        let detail = content
            .and_then(|content| content.get("detail"))
            .and_then(|value| value.as_str())
            .and_then(|value| policy_text(Some(value), 16_384));
        let page = data
            .and_then(|data| data.get("desktop_app_link"))
            .and_then(|value| value.as_str())
            .and_then(|value| policy_page(Some(value), &config.allowed_page_origins));
        return Ok(MandatoryDecision {
            blocking: true,
            checking: false,
            title,
            detail,
            page,
            error: None,
        });
    }
    let no_force = http_ok
        && root.get("code").and_then(|value| value.as_i64()) == Some(0)
        && data
            .and_then(|data| data.get("biz_code"))
            .and_then(|value| value.as_i64())
            == Some(0)
        && data
            .and_then(|data| data.get("biz_data"))
            .is_some_and(|value| value.is_null());
    if no_force {
        return Ok(MandatoryDecision {
            blocking: false,
            checking: false,
            ..MandatoryDecision::default()
        });
    }
    Err(
        "desktop policy: response does not contain a valid mandatory or no-force decision"
            .to_string(),
    )
}

/// Plain-text policy copy: trimmed, non-empty, and within `limit`.
fn policy_text(value: Option<&str>, limit: usize) -> Option<String> {
    let value = value?;
    let trimmed = value.trim();
    (!trimmed.is_empty() && value.len() <= limit).then(|| trimmed.to_string())
}

/// Whether a policy response indicates that test authentication is required.
///
/// Only the exact `401` + `UNAUTHENTICATED` pair counts, and only when test
/// authentication is configured. A bare `401` on an anonymous build is an
/// ordinary failure, not an instruction to open a login window.
pub fn policy_requires_authentication(
    config: &DesktopPolicyConfig,
    http_status: u16,
    body: &serde_json::Value,
) -> bool {
    config.authentication == PolicyAuthentication::FeishuTest
        && http_status == 401
        && body
            .get("error")
            .and_then(|value| value.get("code"))
            .and_then(|value| value.as_str())
            == Some("UNAUTHENTICATED")
}

// ---------------------------------------------------------------------------
// Enforcement: combining the mandatory decision with the ordinary update
// ---------------------------------------------------------------------------

/// What the shell must do about the mandatory decision *right now*.
///
/// This is the answer to "is this update mandatory", and it is deliberately not
/// a property of a release. A blocking decision with no usable release still
/// blocks; an available release with no blocking decision is still optional.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MandatoryEnforcement {
    /// No mandatory requirement: ordinary optional update behaviour applies.
    NotRequired,
    /// The policy check is in flight and no prior verdict blocks.
    Checking,
    /// A mandatory update is required, and the feed has a release that
    /// satisfies it. The user must install; `Later` is offered only while
    /// tasks are running.
    Required { version: String },
    /// A mandatory update is required, but no installable release is known.
    ///
    /// The application still blocks. Reached when the verdict arrived before
    /// the feed was consulted, when the feed failed, or when the newest release
    /// is not newer than the installed build (for example a policy pinned to a
    /// version that was withdrawn). Upstream renders this as
    /// `mandatoryNoRelease` with the download page offered when the policy
    /// supplied an approved one.
    RequiredWithoutRelease { page: Option<String> },
}

impl MandatoryEnforcement {
    /// Whether the application is blocked from normal use.
    ///
    /// A check in flight does not block: upstream only blocks on a *confirmed*
    /// verdict, so a slow or failing policy request never locks a user out.
    pub fn is_blocking(&self) -> bool {
        matches!(
            self,
            Self::Required { .. } | Self::RequiredWithoutRelease { .. }
        )
    }
}

/// Combine the mandatory decision with the ordinary update flow.
///
/// `available` is the ordinary updater's current target, if any, and
/// `installed` is the running version. The release satisfies the requirement
/// only when it is strictly newer than the installed build: a policy that names
/// the installed version is satisfied, not blocking, and a target the feed no
/// longer offers cannot authorize an installation.
///
/// Two rules keep this honest:
///
/// - A blocking verdict without a newer release stays blocking. It never
///   degrades into an optional prompt, which is what would happen if the
///   mandatory flag were derived from "an update is available".
/// - A required release is reported by version only. The bytes still come from
///   [`crate::update_flow`]'s admitted candidate, so satisfying a mandatory
///   requirement cannot bypass signature or digest verification.
pub fn enforcement(
    decision: &MandatoryDecision,
    available: Option<&str>,
    installed: &str,
) -> MandatoryEnforcement {
    if !decision.blocking {
        return if decision.checking {
            MandatoryEnforcement::Checking
        } else {
            MandatoryEnforcement::NotRequired
        };
    }
    match available {
        Some(version) if crate::update_security::greater_version(version, installed) => {
            MandatoryEnforcement::Required {
                version: version.to_string(),
            }
        }
        _ => MandatoryEnforcement::RequiredWithoutRelease {
            page: decision.page.clone(),
        },
    }
}

// ---------------------------------------------------------------------------
// Schedule (independent of the ordinary feed schedule)
// ---------------------------------------------------------------------------

/// Which trigger started a policy check. Recorded in the request query, where
/// it is diagnostic only and never matched against by the backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyScenario {
    Launch,
    Periodic,
    Manual,
    ForegroundOrResume,
}

impl PolicyScenario {
    pub fn label(self) -> &'static str {
        match self {
            Self::Launch => "launch",
            Self::Periodic => "periodic",
            Self::Manual => "manual",
            Self::ForegroundOrResume => "foreground-or-resume",
        }
    }
}

/// The mandatory-policy schedule.
///
/// Mirrors upstream `DesktopMandatoryUpdatePolicy`'s timer bookkeeping: a
/// manual check bypasses the deadline without bypassing request coalescing, the
/// backoff is exponential in the *failure count* rather than the previous
/// delay, and disposal prevents a late completion from re-arming.
#[derive(Debug, Clone, PartialEq)]
pub struct PolicySchedule {
    config: DesktopPolicyConfig,
    failures: u32,
    next_check_ms: Option<u64>,
    disposed: bool,
}

impl PolicySchedule {
    pub fn new(config: DesktopPolicyConfig) -> Self {
        Self {
            config,
            failures: 0,
            next_check_ms: None,
            disposed: false,
        }
    }

    /// Test-only read of the private failure counter.
    ///
    /// Production never inspects it: the backoff it drives is already visible
    /// through the delay [`Self::complete`] returns, which is what the schedule
    /// actually arms. These accessors exist so the pure state machine can be
    /// asserted directly and are not compiled into the application.
    #[cfg(test)]
    pub fn failures(&self) -> u32 {
        self.failures
    }

    /// Test-only read of the disposed flag; see [`Self::failures`].
    #[cfg(test)]
    pub fn is_disposed(&self) -> bool {
        self.disposed
    }

    /// Whether a check may start for `scenario`.
    ///
    /// A disposed schedule refuses everything; a manual check bypasses the
    /// deadline; an automatic one waits for it.
    pub fn begin(&mut self, scenario: PolicyScenario, now_ms: u64) -> bool {
        if self.disposed {
            return false;
        }
        if scenario == PolicyScenario::Manual || self.is_due(now_ms) {
            self.next_check_ms = None;
            return true;
        }
        false
    }

    /// Whether an automatic check is due at `now_ms`.
    pub fn is_due(&self, now_ms: u64) -> bool {
        if self.disposed {
            return false;
        }
        match self.next_check_ms {
            Some(deadline) => now_ms >= deadline,
            None => true,
        }
    }

    /// Record a completion and arm the next check.
    ///
    /// Upstream computes the base as `intervalMs * 2 ** min(failures, 20)`
    /// capped at `maxBackoffMs`, then applies a *one-sided* jitter
    /// (`1 + random * jitter`), unlike the ordinary schedule's symmetric
    /// jitter. The exponent is clamped before the multiply, so a long outage
    /// cannot overflow.
    pub fn complete(&mut self, succeeded: bool, now_ms: u64, random: f64) -> u64 {
        if self.disposed {
            return 0;
        }
        if succeeded {
            self.failures = 0;
        } else {
            self.failures = self.failures.saturating_add(1);
        }
        let exponent = self.failures.min(20);
        let base = (self.config.interval_ms as f64) * 2f64.powi(exponent as i32);
        let base = base.min(self.config.max_backoff_ms as f64);
        let jittered = base * (1.0 + random.clamp(0.0, 1.0) * self.config.jitter);
        let delay = (jittered.min(self.config.max_backoff_ms as f64)).round() as u64;
        self.next_check_ms = Some(now_ms.saturating_add(delay));
        delay
    }

    /// Stop polling; a late completion can no longer re-arm the timer.
    pub fn dispose(&mut self) {
        self.disposed = true;
        self.next_check_ms = None;
    }

    /// The armed deadline, if any.
    pub fn next_check_ms(&self) -> Option<u64> {
        self.next_check_ms
    }
}

// ---------------------------------------------------------------------------
// Response admission
// ---------------------------------------------------------------------------

/// Headers a policy request must carry, derived from the fixed build identity.
///
/// Every value comes from the installed build; none is renderer-supplied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyRequestHeaders {
    pub platform: String,
    pub arch: String,
    pub channel: String,
    pub bundled_dsh_version: String,
}

impl PolicyRequestHeaders {
    /// Build the headers for `identity`.
    ///
    /// The channel is fixed at `nightly`, matching upstream's pinned
    /// `x-client-update-channel`: the mandatory decision is about the installed
    /// *build*, which is a Nightly, not about the user's optional feed channel.
    pub fn for_identity(identity: &DesktopPolicyIdentity) -> Self {
        Self {
            platform: identity.platform_header().to_string(),
            arch: identity.arch_header().to_string(),
            channel: "nightly".to_string(),
            bundled_dsh_version: identity.bundled_dsh_version.clone(),
        }
    }
}

/// Build the policy endpoint URL for one scenario.
pub fn policy_request_url(
    config: &DesktopPolicyConfig,
    scenario: PolicyScenario,
) -> Result<Url, String> {
    let base = Url::parse(&config.origin)
        .map_err(|error| format!("desktop policy: origin is not a URL: {error}"))?;
    let mut url = base.join("/api/v0/check_client_update").map_err(|error| {
        format!("desktop policy: could not resolve the decision endpoint: {error}")
    })?;
    url.query_pairs_mut()
        .append_pair("scenario", scenario.label());
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_json() -> serde_json::Value {
        serde_json::json!({
            "origin": "https://policy.example.com",
            "allowedPageOrigins": ["https://download.example.com"],
        })
    }

    fn config() -> DesktopPolicyConfig {
        resolve_policy_config(Some(&config_json()), false)
            .expect("configuration resolves")
            .expect("configuration is present")
    }

    fn identity() -> DesktopPolicyIdentity {
        DesktopPolicyIdentity {
            platform: PolicyPlatform::Win32,
            arch: PolicyArch::X64,
            bundled_dsh_version: "0.1.7".to_string(),
        }
    }

    // --- configuration -----------------------------------------------------

    #[test]
    fn absent_configuration_disables_policy_queries() {
        assert_eq!(resolve_policy_config(None, false), Ok(None));
    }

    #[test]
    fn an_origin_with_a_path_query_credentials_or_cleartext_is_refused() {
        for bad in [
            "https://policy.example.com/api",
            "https://policy.example.com/?a=1",
            "https://policy.example.com/#x",
            "https://user:secret@policy.example.com",
            "http://policy.example.com",
        ] {
            let mut document = config_json();
            document["origin"] = serde_json::Value::String(bad.to_string());
            assert!(
                resolve_policy_config(Some(&document), false).is_err(),
                "`{bad}` must be refused"
            );
        }
    }

    #[test]
    fn loopback_cleartext_is_allowed_only_for_anonymous_unpackaged_use() {
        let mut document = config_json();
        document["origin"] = serde_json::Value::String("http://127.0.0.1:8080".to_string());
        // Packaged (no loopback permission) refuses it.
        assert!(resolve_policy_config(Some(&document), false).is_err());
        // Unpackaged anonymous use accepts it.
        assert!(resolve_policy_config(Some(&document), true).is_ok());
        // Test authentication carrying cookies must not use cleartext.
        document["authentication"] = serde_json::Value::String("feishu-test".to_string());
        document["allowedAuthOrigins"] = serde_json::json!(["https://login.example.com"]);
        assert!(resolve_policy_config(Some(&document), true).is_err());
    }

    #[test]
    fn authentication_modes_enforce_opposite_login_origin_rules() {
        let mut anonymous = config_json();
        anonymous["allowedAuthOrigins"] = serde_json::json!(["https://login.example.com"]);
        assert!(resolve_policy_config(Some(&anonymous), false).is_err());

        let mut test_auth = config_json();
        test_auth["authentication"] = serde_json::Value::String("feishu-test".to_string());
        assert!(
            resolve_policy_config(Some(&test_auth), false).is_err(),
            "test authentication requires allowedAuthOrigins"
        );
        test_auth["allowedAuthOrigins"] = serde_json::json!(["https://login.example.com"]);
        let resolved = resolve_policy_config(Some(&test_auth), false)
            .expect("valid")
            .expect("present");
        assert_eq!(resolved.authentication, PolicyAuthentication::FeishuTest);
        assert_eq!(
            resolved.allowed_auth_origins,
            vec!["https://login.example.com"]
        );
    }

    #[test]
    fn polling_durations_are_validated_rather_than_defaulted() {
        for (key, value) in [
            ("intervalMs", serde_json::json!(999)),
            ("intervalMs", serde_json::json!(2_147_483_648u64)),
            ("timeoutMs", serde_json::json!(0)),
            ("maxBackoffMs", serde_json::json!(5)),
        ] {
            let mut document = config_json();
            document[key] = value;
            assert!(
                resolve_policy_config(Some(&document), false).is_err(),
                "{key} must be validated"
            );
        }
        let mut document = config_json();
        document["intervalMs"] = serde_json::json!(60_000);
        document["maxBackoffMs"] = serde_json::json!(1_000);
        assert!(
            resolve_policy_config(Some(&document), false).is_err(),
            "a cap below the interval is refused"
        );
    }

    #[test]
    fn defaults_match_upstream() {
        let resolved = config();
        assert_eq!(resolved.interval_ms, 600_000);
        assert_eq!(resolved.timeout_ms, 15_000);
        assert_eq!(resolved.max_backoff_ms, 3_600_000);
        assert_eq!(resolved.jitter, 0.2);
        assert_eq!(resolved.authentication, PolicyAuthentication::Anonymous);
    }

    #[test]
    fn the_download_page_is_confined_to_its_own_allow_list() {
        let config = config();
        // An allowed https page is returned normalized.
        let page = policy_page(
            Some("https://download.example.com/x"),
            &config.allowed_page_origins,
        );
        assert_eq!(page.as_deref(), Some("https://download.example.com/x"));
        // A different origin, cleartext, credentials, and an oversized value are all refused.
        for bad in [
            "https://evil.example.com/x",
            "http://download.example.com/x",
            "https://user:pw@download.example.com/x",
        ] {
            assert_eq!(
                policy_page(Some(bad), &config.allowed_page_origins),
                None,
                "`{bad}` must be refused"
            );
        }
        assert_eq!(policy_page(None, &config.allowed_page_origins), None);
        let oversized = format!("https://download.example.com/{}", "a".repeat(2048));
        assert_eq!(
            policy_page(Some(&oversized), &config.allowed_page_origins),
            None
        );
    }

    // --- identity ----------------------------------------------------------

    #[test]
    fn an_unsupported_installed_identity_is_refused() {
        assert!(identity().validate().is_ok());
        let mut bad_version = identity();
        bad_version.bundled_dsh_version = "not-a-version".to_string();
        assert!(bad_version.validate().is_err());
        let mut bad_arch = identity();
        bad_arch.arch = PolicyArch::Arm64;
        assert!(
            bad_arch.validate().is_err(),
            "windows arm64 was never shipped"
        );
        let mut mac = identity();
        mac.platform = PolicyPlatform::Darwin;
        mac.arch = PolicyArch::Arm64;
        assert!(mac.validate().is_ok(), "darwin arm64 is supported");
    }

    #[test]
    fn request_headers_are_derived_from_the_installed_build_only() {
        let headers = PolicyRequestHeaders::for_identity(&identity());
        assert_eq!(headers.platform, "desktop-win");
        assert_eq!(headers.arch, "x64");
        assert_eq!(headers.channel, "nightly");
        assert_eq!(headers.bundled_dsh_version, "0.1.7");
    }

    // --- response parsing --------------------------------------------------

    #[test]
    fn a_40005_response_is_a_mandatory_block() {
        let body = serde_json::json!({
            "code": 40005,
            "data": {
                "show_content": { "title": "Update required", "detail": "Upgrade to continue." },
                "desktop_app_link": "https://download.example.com/latest",
            },
        });
        let decision = parse_policy(&body, true, &config()).expect("block parses");
        assert!(decision.blocking);
        assert!(!decision.checking);
        assert_eq!(decision.title.as_deref(), Some("Update required"));
        assert_eq!(decision.detail.as_deref(), Some("Upgrade to continue."));
        assert_eq!(
            decision.page.as_deref(),
            Some("https://download.example.com/latest")
        );
        assert_eq!(decision.error, None);
    }

    #[test]
    fn an_unapproved_download_page_is_dropped_without_clearing_the_block() {
        let body = serde_json::json!({
            "code": 40005,
            "data": { "desktop_app_link": "https://evil.example.com/latest" },
        });
        let decision = parse_policy(&body, true, &config()).expect("block parses");
        assert!(decision.blocking, "the block survives a bad page");
        assert_eq!(decision.page, None, "the unapproved page is dropped");
    }

    #[test]
    fn optional_policy_copy_is_reported_only_when_usable() {
        let body = serde_json::json!({
            "code": 40005,
            "data": { "show_content": { "title": "   ", "detail": "Real detail" } },
        });
        let decision = parse_policy(&body, true, &config()).expect("block parses");
        assert_eq!(decision.title, None, "whitespace-only copy falls back");
        assert_eq!(decision.detail.as_deref(), Some("Real detail"));
    }

    #[test]
    fn a_fresh_no_force_answer_clears_the_requirement() {
        let body = serde_json::json!({
            "code": 0,
            "data": { "biz_code": 0, "biz_data": null },
        });
        let decision = parse_policy(&body, true, &config()).expect("no-force parses");
        assert!(!decision.blocking);
        assert_eq!(decision.error, None);
    }

    #[test]
    fn an_unrecognized_response_is_an_error_never_a_clearance() {
        for (label, body, ok) in [
            (
                "non-zero code",
                serde_json::json!({ "code": 1, "data": {} }),
                true,
            ),
            (
                "ok code but failing status",
                serde_json::json!({ "code": 0, "data": { "biz_code": 0, "biz_data": null } }),
                false,
            ),
            ("missing data", serde_json::json!({ "code": 0 }), true),
            (
                "non-null biz_data",
                serde_json::json!({ "code": 0, "data": { "biz_code": 0, "biz_data": 7 } }),
                true,
            ),
            ("not an object", serde_json::json!([1, 2, 3]), true),
        ] {
            assert!(
                parse_policy(&body, ok, &config()).is_err(),
                "{label} must be an error"
            );
        }
    }

    #[test]
    fn authentication_is_required_only_for_the_exact_test_pair() {
        let mut document = config_json();
        document["authentication"] = serde_json::Value::String("feishu-test".to_string());
        document["allowedAuthOrigins"] = serde_json::json!(["https://login.example.com"]);
        let test_config = resolve_policy_config(Some(&document), false)
            .unwrap()
            .unwrap();
        let unauthenticated = serde_json::json!({ "error": { "code": "UNAUTHENTICATED" } });
        assert!(policy_requires_authentication(
            &test_config,
            401,
            &unauthenticated
        ));
        // A bare 401, a different code, or an anonymous build are ordinary failures.
        assert!(!policy_requires_authentication(
            &test_config,
            401,
            &serde_json::json!({})
        ));
        assert!(!policy_requires_authentication(
            &test_config,
            401,
            &serde_json::json!({ "error": { "code": "OTHER" } })
        ));
        assert!(!policy_requires_authentication(
            &config(),
            401,
            &unauthenticated
        ));
    }

    // --- enforcement: the mandatory-versus-optional distinction ------------

    #[test]
    fn an_ordinary_available_update_is_never_mandatory() {
        // The feed found a newer release and the server says nothing: this is
        // the optional prompt the user may decline.
        let decision = MandatoryDecision::initial();
        assert_eq!(
            enforcement(&decision, Some("0.1.9"), "0.1.7"),
            MandatoryEnforcement::NotRequired
        );
    }

    #[test]
    fn a_mandatory_decision_with_a_newer_release_requires_that_release() {
        let decision = MandatoryDecision {
            blocking: true,
            ..MandatoryDecision::default()
        };
        assert_eq!(
            enforcement(&decision, Some("0.1.9"), "0.1.7"),
            MandatoryEnforcement::Required {
                version: "0.1.9".to_string()
            }
        );
    }

    #[test]
    fn a_mandatory_decision_without_a_release_still_blocks() {
        // The verdict arrived before the feed was consulted.
        let decision = MandatoryDecision {
            blocking: true,
            page: Some("https://download.example.com/latest".to_string()),
            ..MandatoryDecision::default()
        };
        assert_eq!(
            enforcement(&decision, None, "0.1.7"),
            MandatoryEnforcement::RequiredWithoutRelease {
                page: Some("https://download.example.com/latest".to_string())
            }
        );
        assert!(enforcement(&decision, None, "0.1.7").is_blocking());
    }

    #[test]
    fn a_release_that_is_not_newer_cannot_satisfy_the_requirement() {
        let decision = MandatoryDecision {
            blocking: true,
            ..MandatoryDecision::default()
        };
        // The feed offers the installed version, or an older one.
        for available in ["0.1.7", "0.1.6", "not-a-version"] {
            let outcome = enforcement(&decision, Some(available), "0.1.7");
            assert!(
                matches!(outcome, MandatoryEnforcement::RequiredWithoutRelease { .. }),
                "`{available}` must not satisfy the requirement"
            );
            assert!(outcome.is_blocking());
        }
    }

    #[test]
    fn an_in_flight_check_does_not_block_by_itself() {
        let decision = MandatoryDecision::initial().checking();
        assert_eq!(
            enforcement(&decision, Some("0.1.9"), "0.1.7"),
            MandatoryEnforcement::Checking
        );
        assert!(!enforcement(&decision, Some("0.1.9"), "0.1.7").is_blocking());
    }

    #[test]
    fn a_failed_attempt_never_lifts_a_known_requirement() {
        let blocking = MandatoryDecision {
            blocking: true,
            ..MandatoryDecision::default()
        };
        for error in [
            PolicyError::Unavailable,
            PolicyError::AuthenticationRequired,
        ] {
            let after_failure = blocking.with_error(error);
            assert!(after_failure.blocking, "a known block survives {error:?}");
            assert_eq!(after_failure.error, Some(error));
            assert_eq!(
                enforcement(&after_failure, None, "0.1.7"),
                MandatoryEnforcement::RequiredWithoutRelease { page: None }
            );
        }
    }

    // --- schedule ----------------------------------------------------------

    #[test]
    fn a_manual_policy_check_bypasses_the_deadline() {
        let mut schedule = PolicySchedule::new(config());
        assert!(schedule.begin(PolicyScenario::Launch, 0));
        schedule.complete(true, 0, 0.0);
        let deadline = schedule.next_check_ms().expect("armed");
        assert!(!schedule.begin(PolicyScenario::Periodic, deadline - 1));
        assert!(schedule.begin(PolicyScenario::Manual, deadline - 1));
    }

    #[test]
    fn policy_backoff_is_exponential_in_the_failure_count_and_capped() {
        let mut config = config();
        config.interval_ms = 10_000;
        config.max_backoff_ms = 80_000;
        config.jitter = 0.0;
        let mut schedule = PolicySchedule::new(config);
        schedule.begin(PolicyScenario::Launch, 0);
        assert_eq!(schedule.complete(false, 0, 0.0), 20_000);
        schedule.begin(PolicyScenario::Periodic, 20_000);
        assert_eq!(schedule.complete(false, 20_000, 0.0), 40_000);
        schedule.begin(PolicyScenario::Periodic, 60_000);
        assert_eq!(schedule.complete(false, 60_000, 0.0), 80_000);
        schedule.begin(PolicyScenario::Periodic, 140_000);
        assert_eq!(
            schedule.complete(false, 140_000, 0.0),
            80_000,
            "the cap holds"
        );
        // Success resets the failure count and returns to the base interval.
        schedule.begin(PolicyScenario::Periodic, 300_000);
        assert_eq!(schedule.complete(true, 300_000, 0.0), 10_000);
        assert_eq!(schedule.failures(), 0);
    }

    #[test]
    fn policy_jitter_is_one_sided_and_stays_under_the_cap() {
        let mut config = config();
        config.interval_ms = 10_000;
        config.max_backoff_ms = 20_000;
        config.jitter = 0.5;
        let mut schedule = PolicySchedule::new(config);
        schedule.begin(PolicyScenario::Launch, 0);
        // Base 10_000, one-sided jitter: [10_000, 15_000].
        assert_eq!(schedule.complete(true, 0, 0.0), 10_000);
        schedule.begin(PolicyScenario::Periodic, 0);
        assert_eq!(schedule.complete(true, 0, 1.0), 15_000);
        // An out-of-range sample is clamped, not extrapolated.
        schedule.begin(PolicyScenario::Periodic, 0);
        assert_eq!(schedule.complete(true, 0, 99.0), 15_000);
    }

    #[test]
    fn disposal_prevents_new_policy_checks_and_late_rearming() {
        let mut schedule = PolicySchedule::new(config());
        schedule.begin(PolicyScenario::Launch, 0);
        schedule.dispose();
        assert!(schedule.is_disposed());
        assert!(!schedule.begin(PolicyScenario::Manual, 999_999));
        assert!(!schedule.is_due(u64::MAX));
        assert_eq!(schedule.complete(false, 1_000_000, 1.0), 0);
        assert_eq!(schedule.complete(true, 1_000_001, 0.0), 0);
        assert_eq!(schedule.failures(), 0, "late results cannot change backoff");
        assert_eq!(schedule.next_check_ms(), None);
    }

    // --- request admission -------------------------------------------------

    #[test]
    fn the_decision_endpoint_is_fixed_and_carries_the_scenario() {
        let url = policy_request_url(&config(), PolicyScenario::ForegroundOrResume).unwrap();
        assert_eq!(url.path(), "/api/v0/check_client_update");
        assert_eq!(url.query(), Some("scenario=foreground-or-resume"));
        assert_eq!(url.host_str(), Some("policy.example.com"));
    }
}
