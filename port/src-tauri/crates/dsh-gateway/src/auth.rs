//! Browser-session authentication — the Rust port of
//! `_upstream/packages/client/connection/src/browser-auth.ts` (flow contract:
//! `docs/contracts/ui-backend-protocol.md` §2.2).
//!
//! Flow preserved exactly: `authenticatedUrl()` appends exactly one `token`
//! query parameter carrying the process launch token; a `GET /` with exactly
//! one matching token (timing-safe compare) mints an HMAC-SHA256-signed,
//! authority-bound session cookie and answers `303` to `./` with `set-cookie`;
//! `GET /` with a valid cookie plus any token answers `303` to `./` without a
//! cookie; a valid cookie without a token serves the index; every other request
//! receives the same minimal `401`
//! (`dsh web authentication required; reopen the URL printed by dsh web.`).
//!
//! The signing secret lives in `dsh-core::credentials` (OS-backed) — never on
//! disk in the frontend and never in any log.

use dsh_core::credentials::{CredentialStore, SecretBackend};
use dsh_core::error::DshError;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// Credential coordinates of the browser-session signing secret
/// (`credentialKey('client-connection', 'browser-session')`).
pub const AUTH_PROVIDER: &str = "client-connection";
/// Credential reference of the browser-session signing secret.
pub const AUTH_REFERENCE: &str = "browser-session";

const SECRET_BYTES: usize = 32;
const TOKEN_QUERY: &str = "token";
const COOKIE_PREFIX: &str = "dsh-auth-";
const COOKIE_PAYLOAD_VERSION: u32 = 1;
const DAY_MILLIS: u64 = 24 * 60 * 60 * 1000;

/// Minimal 401 body (verbatim upstream `browser-auth.ts:309`).
pub const UNAUTHORIZED_BODY: &str =
    "dsh web authentication required; reopen the URL printed by dsh web.\n";

/// Signed cookie payload (`BrowserCookiePayload`, `browser-auth.ts:27-32`).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct BrowserCookiePayload {
    version: u32,
    authority: String,
    #[serde(rename = "issuedAt")]
    issued_at: u64,
    #[serde(rename = "expiresAt")]
    expires_at: u64,
}

/// Outcome of [`BrowserAuth::authorize_index`] (upstream `authorizeIndex`).
#[derive(Debug, Clone)]
pub enum IndexOutcome {
    /// Serve the index document.
    Serve,
    /// `303` to `./`; `set_cookie` is `Some` only for the token mint.
    Redirect { set_cookie: Option<String> },
    /// The minimal `401`.
    Unauthorized,
}

fn encode_base64url(bytes: &[u8]) -> String {
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    if value.len() % 4 == 1
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, value).ok()
}

/// Constant-time byte comparison.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    use subtle::ConstantTimeEq;
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

/// Process launch-token exchange and signed-cookie verification
/// (upstream `BrowserAuth`).
pub struct BrowserAuth {
    launch_token: String,
    secret: Vec<u8>,
    max_age_millis: u64,
}

impl BrowserAuth {
    /// Build authentication from an existing signing secret and a fresh
    /// one-time launch token.
    pub fn new(secret: Vec<u8>, cookie_max_age_days: u32) -> Result<Self, DshError> {
        if secret.len() != SECRET_BYTES {
            return Err(DshError::other(
                "auth_secret_invalid",
                "browser-session signing secret must be 32 bytes",
            ));
        }
        let max_age_millis = u64::from(cookie_max_age_days) * DAY_MILLIS;
        let mut token_bytes = [0u8; SECRET_BYTES];
        getrandom::fill(&mut token_bytes).expect("OS randomness is required for the launch token");
        Ok(Self {
            launch_token: encode_base64url(&token_bytes),
            secret,
            max_age_millis,
        })
    }

    /// Add this process's launch token to the caller's application URL
    /// (`authenticatedUrl`, `browser-auth.ts:223-227`).
    pub fn authenticated_url(&self, base_url: &str) -> String {
        let joiner = if base_url.contains('?') { '&' } else { '?' };
        format!("{base_url}{joiner}{TOKEN_QUERY}={}", self.launch_token)
    }

    /// Authenticate an index request (`authorizeIndex`,
    /// `browser-auth.ts:238-280`). `authority` is the request's `Host` value.
    pub fn authorize_index(
        &self,
        method: &str,
        path: &str,
        query: &str,
        authority: Option<&str>,
        cookie_header: Option<&str>,
    ) -> IndexOutcome {
        let tokens: Vec<&str> = query
            .split('&')
            .filter_map(|pair| {
                let (name, value) = pair.split_once('=')?;
                if name == TOKEN_QUERY {
                    Some(value)
                } else {
                    None
                }
            })
            .collect();
        if !tokens.is_empty() {
            let authenticated = self.is_authenticated(authority, cookie_header);
            if method == "GET"
                && path == "/"
                && tokens.len() == 1
                && authority.is_some()
                && constant_time_eq(tokens[0].as_bytes(), self.launch_token.as_bytes())
            {
                let Some(authority) = authority else {
                    return IndexOutcome::Unauthorized;
                };
                let issued_at = now_millis();
                let expires_at = issued_at + self.max_age_millis;
                let value = self.encode_cookie(&BrowserCookiePayload {
                    version: COOKIE_PAYLOAD_VERSION,
                    authority: authority.to_string(),
                    issued_at,
                    expires_at,
                });
                let max_age_seconds = self.max_age_millis / 1000;
                return IndexOutcome::Redirect {
                    set_cookie: Some(format!(
                        "{}={value}; Max-Age={max_age_seconds}; Path=/; Expires={}; HttpOnly; SameSite=Strict",
                        cookie_name(authority),
                        http_date(expires_at)
                    )),
                };
            }
            if method == "GET" && path == "/" && authenticated {
                return IndexOutcome::Redirect { set_cookie: None };
            }
            return IndexOutcome::Unauthorized;
        }
        if self.is_authenticated(authority, cookie_header) {
            return IndexOutcome::Serve;
        }
        IndexOutcome::Unauthorized
    }

    /// Verify the authority-bound browser cookie (`isAuthenticated`,
    /// `browser-auth.ts:287-300`).
    pub fn is_authenticated(&self, authority: Option<&str>, cookie_header: Option<&str>) -> bool {
        let (Some(authority), Some(raw_cookie)) = (authority, cookie_header) else {
            return false;
        };
        let Some(value) = cookie_value(raw_cookie, &cookie_name(authority)) else {
            return false;
        };
        let Some(payload) = self.decode_cookie(&value) else {
            return false;
        };
        if payload.authority != authority {
            return false;
        }
        let now = now_millis();
        payload.issued_at <= now
            && payload.expires_at > now
            && payload.expires_at > payload.issued_at
            && payload.expires_at - payload.issued_at <= self.max_age_millis
    }

    fn signature(&self, body: &str) -> Vec<u8> {
        let mut mac =
            HmacSha256::new_from_slice(&self.secret).expect("HMAC accepts a key of any length");
        mac.update(body.as_bytes());
        mac.finalize().into_bytes().to_vec()
    }

    fn encode_cookie(&self, payload: &BrowserCookiePayload) -> String {
        let body =
            encode_base64url(&serde_json::to_vec(payload).expect("cookie payload serializes"));
        format!("v1.{body}.{}", encode_base64url(&self.signature(&body)))
    }

    fn decode_cookie(&self, value: &str) -> Option<BrowserCookiePayload> {
        let parts: Vec<&str> = value.split('.').collect();
        if parts.len() != 3 || parts[0] != "v1" {
            return None;
        }
        let (body, encoded_signature) = (parts[1], parts[2]);
        let actual = decode_base64url(encoded_signature)?;
        if !constant_time_eq(&actual, &self.signature(body)) {
            return None;
        }
        let body_bytes = decode_base64url(body)?;
        let payload: BrowserCookiePayload = serde_json::from_slice(&body_bytes).ok()?;
        if payload.version != COOKIE_PAYLOAD_VERSION {
            return None;
        }
        Some(payload)
    }
}

/// Load the durable signing secret from the OS credential store, creating it
/// on first use (upstream `initializeSecret`).
pub fn load_or_create_secret(
    store: &mut CredentialStore<impl SecretBackend>,
) -> Result<Vec<u8>, DshError> {
    if let Some(existing) = store.get(AUTH_PROVIDER, AUTH_REFERENCE)? {
        return decode_base64url(&existing)
            .filter(|bytes| bytes.len() == SECRET_BYTES)
            .ok_or_else(|| {
                DshError::credential_store(
                    "read",
                    "browser-session credential record has an unsupported format",
                )
            });
    }
    let mut secret = vec![0u8; SECRET_BYTES];
    getrandom::fill(&mut secret).expect("OS randomness is required for the signing secret");
    store.store(AUTH_PROVIDER, AUTH_REFERENCE, &encode_base64url(&secret))?;
    Ok(secret)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Cookie name is `dsh-auth-<base64url(sha256(authority))>` (`browser-auth.ts:106-108`).
fn cookie_name(authority: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(authority.as_bytes());
    format!("{COOKIE_PREFIX}{}", encode_base64url(&hasher.finalize()))
}

/// Read the exact generated cookie without general Cookie decoding
/// (`browser-auth.ts:111-118`).
///
/// The reference splits on `;` and **continues** past any segment that carries
/// no `=` at all, so one bare segment (or an empty one from a doubled `;`) never
/// hides a later matching pair. For a segment that does carry `=`, the name is
/// the text before the **first** `=` with surrounding whitespace removed, the
/// value is the text after it trimmed, and the comparison is exact and
/// case-sensitive: a longer or differently cased name does not match. The first
/// matching segment wins, so a duplicated name resolves to its first occurrence
/// rather than the last.
fn cookie_value(header_value: &str, name: &str) -> Option<String> {
    for segment in header_value.split(';') {
        let Some(at) = segment.find('=') else {
            continue;
        };
        if segment[..at].trim() != name {
            continue;
        }
        return Some(segment[at + 1..].trim().to_string());
    }
    None
}

/// `Expires` attribute formatting (`Date#toUTCString`).
fn http_date(expires_at_millis: u64) -> String {
    let seconds = (expires_at_millis / 1000) as i64;
    let dt = chrono::DateTime::from_timestamp(seconds, 0).unwrap_or_default();
    dt.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth() -> BrowserAuth {
        BrowserAuth::new(vec![7u8; SECRET_BYTES], 30).expect("auth")
    }

    fn authority() -> &'static str {
        "127.0.0.1:3080"
    }

    fn mint(auth: &BrowserAuth) -> String {
        match auth.authorize_index(
            "GET",
            "/",
            &format!("token={}", auth.launch_token),
            Some(authority()),
            None,
        ) {
            IndexOutcome::Redirect {
                set_cookie: Some(cookie),
            } => cookie,
            other => panic!("expected a mint, got {other:?}"),
        }
    }

    #[test]
    fn valid_token_mints_signed_cookie_and_redirects() {
        let auth = auth();
        let outcome = auth.authorize_index(
            "GET",
            "/",
            &format!("token={}", auth.launch_token),
            Some(authority()),
            None,
        );
        let IndexOutcome::Redirect {
            set_cookie: Some(cookie),
        } = outcome
        else {
            panic!("expected mint: {outcome:?}");
        };
        assert!(cookie.starts_with("dsh-auth-"));
        assert!(cookie.contains("HttpOnly; SameSite=Strict"));
        assert!(cookie.contains("Path=/"));
        // The minted cookie authenticates.
        let name_value = cookie.split(';').next().expect("pair").to_string();
        assert!(auth.is_authenticated(Some(authority()), Some(&name_value)));
    }

    #[test]
    fn wrong_duplicate_and_missing_tokens_get_the_minimal_401() {
        let auth = auth();
        let wrong = auth.authorize_index("GET", "/", "token=nope", Some(authority()), None);
        assert!(matches!(wrong, IndexOutcome::Unauthorized));
        let duplicate = auth.authorize_index(
            "GET",
            "/",
            &format!("token={}&token={}", auth.launch_token, auth.launch_token),
            Some(authority()),
            None,
        );
        assert!(matches!(duplicate, IndexOutcome::Unauthorized));
        let missing = auth.authorize_index("GET", "/", "", Some(authority()), None);
        assert!(matches!(missing, IndexOutcome::Unauthorized));
        // Wrong method on the exchange path is equally refused.
        let posted = auth.authorize_index(
            "POST",
            "/",
            &format!("token={}", auth.launch_token),
            Some(authority()),
            None,
        );
        assert!(matches!(posted, IndexOutcome::Unauthorized));
    }

    #[test]
    fn cookie_plus_token_follows_the_source_branch_order() {
        let auth = auth();
        let cookie = mint(&auth);
        let name_value = cookie.split(';').next().expect("pair").to_string();
        // Source order (`browser-auth.ts:244-273`): a matching token mints
        // again even when a valid cookie is present.
        let outcome = auth.authorize_index(
            "GET",
            "/",
            &format!("token={}", auth.launch_token),
            Some(authority()),
            Some(&name_value),
        );
        assert!(
            matches!(
                outcome,
                IndexOutcome::Redirect {
                    set_cookie: Some(_)
                }
            ),
            "a matching token always mints (browser-auth.ts:244-264)"
        );
        // A NON-matching token with a valid cookie answers 303 without a cookie
        // (browser-auth.ts:265-273).
        let outcome = auth.authorize_index(
            "GET",
            "/",
            "token=not-the-launch-token",
            Some(authority()),
            Some(&name_value),
        );
        assert!(
            matches!(outcome, IndexOutcome::Redirect { set_cookie: None }),
            "a valid cookie plus a non-matching token must not mint again"
        );
    }

    #[test]
    fn valid_cookie_without_token_serves_and_tampering_fails() {
        let auth = auth();
        let cookie = mint(&auth);
        let name_value = cookie.split(';').next().expect("pair").to_string();
        assert!(matches!(
            auth.authorize_index("GET", "/", "", Some(authority()), Some(&name_value)),
            IndexOutcome::Serve
        ));
        // Authority-bound: another authority's cookie value cannot authenticate.
        assert!(matches!(
            auth.authorize_index("GET", "/", "", Some("127.0.0.1:9999"), Some(&name_value)),
            IndexOutcome::Unauthorized
        ));
        // A tampered body fails the signature.
        let tampered = name_value.replace("v1.", "v1.AA");
        assert!(matches!(
            auth.authorize_index("GET", "/", "", Some(authority()), Some(&tampered)),
            IndexOutcome::Unauthorized
        ));
    }

    #[test]
    fn cookie_parsing_continues_past_bare_segments_and_pins_the_name() {
        let name = cookie_name(authority());
        // A bare segment (no `=`) and an empty segment are skipped, not treated
        // as the end of the header (`browser-auth.ts:112-116`).
        assert_eq!(
            cookie_value(&format!("flag; ; {name}=value; other=1"), &name),
            Some("value".to_string())
        );
        // Duplicate names resolve to the FIRST occurrence, never the last.
        assert_eq!(
            cookie_value(&format!("{name}=first; {name}=second"), &name),
            Some("first".to_string())
        );
        // The name is the text before the first `=` after trimming, and the
        // value is trimmed.
        assert_eq!(
            cookie_value(&format!("{name} =  padded  "), &name),
            Some("padded".to_string())
        );
        // The comparison is exact and case-sensitive: a longer name, an
        // unrelated name, and a case variant are different cookies.
        assert_eq!(cookie_value(&format!("{name}extra=v"), &name), None);
        assert_eq!(cookie_value("dsh-auth=v", &name), None);
        assert_eq!(cookie_value(&name.to_uppercase(), &name), None);
        // An empty value parses as an empty string, which then fails
        // verification exactly as the reference's empty slice does.
        assert_eq!(
            cookie_value(&format!("{name}="), &name),
            Some(String::new())
        );
        assert_eq!(cookie_value("", &name), None);
        assert_eq!(cookie_value("flag; other", &name), None);
    }

    #[test]
    fn a_bare_cookie_segment_does_not_hide_the_session_cookie() {
        let auth = auth();
        let cookie = mint(&auth);
        let name_value = cookie.split(';').next().expect("pair").to_string();
        // The regression this pins: the previous parser used `split_once('=')?`,
        // so one bare segment returned `None` for the whole header and a valid
        // session cookie behind it was treated as absent.
        let header = format!("consent; {name_value}; theme=dark");
        assert!(
            auth.is_authenticated(Some(authority()), Some(&header)),
            "a bare segment must not mask a later exact cookie"
        );
        // A duplicate of the generated name in FRONT of the real pair is the
        // segment that gets verified, so the request is not authenticated. The
        // reference reads the first match rather than the last.
        let name = cookie_name(authority());
        let shadowed = format!("{name}=v1.AA.BB; {name_value}");
        assert!(
            !auth.is_authenticated(Some(authority()), Some(&shadowed)),
            "the first exact-name segment is the one verified"
        );
    }
}
