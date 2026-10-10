//! Credential-backend selection for isolated, owned native qualification runs.
//!
//! The OS credential store is per **user account**, not per Harness home:
//! redirecting `DSH_HOME`/`DSH_DESKTOP_USER_DATA_DIR` relocates indexes, logs
//! and markers but still targets the shared `dsh-desktop:*` OS identities. An
//! owned qualification run therefore opts in explicitly to one namespace
//! through [`DesktopSecretBackend::select`], and this module proves — before a
//! single OS credential call — that the run really is fenced:
//!
//! 1. Owned namespaces require a **debug build** (`cfg!(debug_assertions)`);
//!    a release build can never be pointed at a qualification namespace.
//! 2. The namespace must be a **canonical, non-nil, lowercase hyphenated UUID**
//!    supplied by the caller. This module never reads an environment variable:
//!    the launcher's decision is passed in as an argument.
//! 3. The owned root is `<CARGO_MANIFEST_DIR>/../../../.scratch/native-{UUID}`
//!    and must exist. Both `desktop_home` and `user_data` are canonicalized
//!    (following symlinks, junctions and reparse points) and must lie
//!    **strictly beneath** the canonicalized root, so a mistyped
//!    `..`, a stray junction, or the real user profile cannot pass.
//! 4. With no namespace, [`DesktopSecretBackend::Default`] is returned and
//!    production behaviour is byte-identical to before: the same
//!    `dsh-desktop:{provider}` services, the same accounts, no path validation.
//!
//! This module performs no OS credential access, writes no file, and deletes
//! nothing. Cleanup of an owned namespace stays the harness's job: it persists
//! the namespace in its own owned manifest and cleans only validated,
//! index-tracked `dsh-desktop:{UUID}:{provider}` / account coordinates afterwards.
//! No wildcard sweep or default/legacy credential enumeration is performed.
//!
//! # No path-derived (or ambient) namespace, no migration
//!
//! The namespace is a **caller argument**, never a function of the resolved
//! home, user-data directory, environment or process path: redirecting
//! `DSH_HOME`/`DSH_DESKTOP_USER_DATA_DIR` can never switch stores, and an owned
//! root that moved (a copied checkout, a renamed scratch directory) can never
//! select a namespace derived from its new location. There is likewise no
//! migration step here: a rejected namespace is rejected outright, and no
//! credential is read, written, renamed, or re-pointed on its behalf.
//!
//! # Shell-owned identities at the renderer boundary
//!
//! [`SHELL_RESERVED_CREDENTIALS`] / [`is_shell_reserved_credential`] publish the
//! credential identities the shell itself owns. They exist so the renderer
//! bridge can refuse to observe or mutate them; the shell's own internal use of
//! the same store (the gateway's session-signing secret) is unaffected because
//! it never goes through the renderer commands.

use std::fmt;
use std::path::{Path, PathBuf};

use dsh_core::credentials::{
    CredentialNamespace, KeyringBackend, ScopedKeyringBackend, SecretBackend,
};
use dsh_core::error::DshError;

/// Environment variable the **launcher** reads to request an owned namespace.
///
/// Declared here as the documented contract; this module never reads it, so no
/// hidden global can silently retarget production credentials.
pub const OWNED_NAMESPACE_ENV: &str = "DSH_DESKTOP_OWNED_CREDENTIAL_NAMESPACE";

/// Credential identities the desktop shell owns end to end.
///
/// The names come from the gateway's own constants, so a reservation can never
/// drift away from the identity that actually holds the secret. Only the
/// renderer-originated commands consult this table; the gateway's internal
/// `load_or_create_secret` path is deliberately untouched.
///
/// The reservation is exactly the demonstrated identity, not a guessed provider
/// namespace: every other `(provider, reference)` pair keeps full credential
/// CRUD through the renderer bridge.
pub const SHELL_RESERVED_CREDENTIALS: &[(&str, &str)] = &[(
    dsh_gateway::auth::AUTH_PROVIDER,
    dsh_gateway::auth::AUTH_REFERENCE,
)];

/// Whether `(provider, reference)` is a shell-owned credential identity.
///
/// Match the platform's credential identity semantics. Windows generic target
/// names are case-insensitive, so casing either ASCII segment still addresses
/// the shell's existing key. Other backends retain exact segment comparisons.
pub fn is_shell_reserved_credential(provider: &str, reference: &str) -> bool {
    SHELL_RESERVED_CREDENTIALS
        .iter()
        .any(|(reserved_provider, reserved_reference)| {
            #[cfg(windows)]
            {
                reserved_provider.eq_ignore_ascii_case(provider)
                    && reserved_reference.eq_ignore_ascii_case(reference)
            }
            #[cfg(not(windows))]
            {
                *reserved_provider == provider && *reserved_reference == reference
            }
        })
}

/// Repository-relative scratch directory holding owned qualification roots.
pub const OWNED_SCRATCH_DIR: &str = ".scratch";

/// Hyphen positions of a canonical 8-4-4-4-12 UUID.
const UUID_HYPHEN_POSITIONS: [usize; 4] = [8, 13, 18, 23];

/// The credential backend the desktop shell will run on.
///
/// `Default` is the shipped production layout. `Owned` is an opt-in
/// qualification namespace that is provably disjoint from it.
///
/// The variants are compared by kind (and, for `Owned`, by namespace); the
/// inner keyring backends deliberately carry no state and expose no
/// `PartialEq`, so equality is defined here rather than derived.
pub enum DesktopSecretBackend {
    /// Production: service `dsh-desktop:{provider}`, account `{reference}`.
    Default(KeyringBackend),
    /// Owned qualification: service `dsh-desktop:{namespace}:{provider}`.
    Owned(ScopedKeyringBackend),
}

impl fmt::Debug for DesktopSecretBackend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Default(_) => f.write_str("DesktopSecretBackend::Default"),
            Self::Owned(backend) => {
                write!(f, "DesktopSecretBackend::Owned({})", backend.namespace())
            }
        }
    }
}

impl PartialEq for DesktopSecretBackend {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Default(_), Self::Default(_)) => true,
            (Self::Owned(left), Self::Owned(right)) => left.namespace() == right.namespace(),
            _ => false,
        }
    }
}

impl DesktopSecretBackend {
    /// Select the backend for this run.
    ///
    /// `namespace` is `None` for a normal run (production backend, untouched).
    /// `Some(uuid)` requests an owned qualification namespace and is validated
    /// against the compile-time owned root derived from that UUID.
    pub fn select(
        namespace: Option<&str>,
        desktop_home: &Path,
        user_data: &Path,
    ) -> Result<Self, DshError> {
        match namespace {
            None => Ok(Self::Default(KeyringBackend)),
            Some(raw) => {
                if !cfg!(debug_assertions) {
                    return Err(DshError::runtime_unavailable(
                        "debug build",
                        "owned credential namespaces require a debug desktop build",
                    ));
                }
                let namespace = parse_owned_namespace(raw)?;
                let root = owned_root(&namespace);
                let repository = canonical_dir(
                    &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."),
                    "repositoryRoot",
                )?;
                let scratch = canonical_dir(&repository.join(OWNED_SCRATCH_DIR), "scratchRoot")?;
                let actual_root = canonical_dir(&root, "ownedRoot")?;
                if !scratch.starts_with(&repository)
                    || scratch == repository
                    || actual_root != scratch.join(format!("native-{namespace}"))
                {
                    return Err(DshError::invalid_argument(
                        "ownedRoot",
                        "qualification root must not redirect outside its owned scratch directory",
                    ));
                }
                Self::owned(namespace, desktop_home, user_data, &root)
            }
        }
    }

    /// [`Self::select`] against an explicit owned root (used by tests and by
    /// harnesses that pin their own scratch root).
    #[cfg(test)]
    pub fn select_under_root(
        namespace: Option<&str>,
        desktop_home: &Path,
        user_data: &Path,
        root: &Path,
    ) -> Result<Self, DshError> {
        match namespace {
            None => Ok(Self::Default(KeyringBackend)),
            Some(raw) => Self::owned(parse_owned_namespace(raw)?, desktop_home, user_data, root),
        }
    }

    fn owned(
        namespace: CredentialNamespace,
        desktop_home: &Path,
        user_data: &Path,
        root: &Path,
    ) -> Result<Self, DshError> {
        // Release builds can never be pointed at a qualification namespace.
        if !cfg!(debug_assertions) {
            return Err(DshError::runtime_unavailable(
                "debug build",
                "owned credential namespaces require a debug desktop build",
            ));
        }
        // Fence first: every path check happens before any OS credential call.
        let canonical_root = canonical_dir(root, "ownedRoot")?;
        validate_owned_path(&canonical_root, desktop_home, "desktopHome")?;
        validate_owned_path(&canonical_root, user_data, "userData")?;
        Ok(Self::Owned(ScopedKeyringBackend::new(namespace)))
    }

    /// Whether this run is fenced in an owned qualification namespace.
    #[cfg(test)]
    pub fn is_owned(&self) -> bool {
        matches!(self, Self::Owned(_))
    }

    /// The owned namespace, when this run is fenced.
    pub fn namespace(&self) -> Option<&CredentialNamespace> {
        match self {
            Self::Default(_) => None,
            Self::Owned(backend) => Some(backend.namespace()),
        }
    }

    /// The exact OS service name this backend uses for `provider`.
    #[cfg(test)]
    pub fn service_target(&self, provider: &str) -> Result<String, DshError> {
        match self {
            Self::Default(_) => KeyringBackend::service_target(provider),
            Self::Owned(backend) => backend.service_target(provider),
        }
    }
}

impl SecretBackend for DesktopSecretBackend {
    fn set_secret(&self, provider: &str, reference: &str, secret: &str) -> Result<(), DshError> {
        match self {
            Self::Default(backend) => backend.set_secret(provider, reference, secret),
            Self::Owned(backend) => backend.set_secret(provider, reference, secret),
        }
    }

    fn get_secret(&self, provider: &str, reference: &str) -> Result<Option<String>, DshError> {
        match self {
            Self::Default(backend) => backend.get_secret(provider, reference),
            Self::Owned(backend) => backend.get_secret(provider, reference),
        }
    }

    fn delete_secret(&self, provider: &str, reference: &str) -> Result<(), DshError> {
        match self {
            Self::Default(backend) => backend.delete_secret(provider, reference),
            Self::Owned(backend) => backend.delete_secret(provider, reference),
        }
    }

    fn has_secret(&self, provider: &str, reference: &str) -> Result<bool, DshError> {
        match self {
            Self::Default(backend) => backend.has_secret(provider, reference),
            Self::Owned(backend) => backend.has_secret(provider, reference),
        }
    }
}

/// The metadata-only credential index inside the (owned) user-data directory.
pub fn credential_index_path(user_data: &Path) -> PathBuf {
    user_data.join("credentials-index.json")
}

/// The compile-time owned root for a namespace:
/// `<CARGO_MANIFEST_DIR>/../../../.scratch/native-{UUID}`.
pub fn owned_root(namespace: &CredentialNamespace) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join(OWNED_SCRATCH_DIR)
        .join(format!("native-{namespace}"))
}

/// Validate a caller-supplied owned namespace: canonical, non-nil UUID only.
fn parse_owned_namespace(raw: &str) -> Result<CredentialNamespace, DshError> {
    if !is_canonical_uuid(raw) {
        return Err(DshError::invalid_argument(
            "ownedNamespace",
            "must be a canonical lowercase hyphenated UUID (8-4-4-4-12)",
        ));
    }
    // `parse` re-validates, normalizes, and rejects the nil UUID.
    let namespace = CredentialNamespace::parse(raw)?;
    if namespace.as_str() != raw {
        return Err(DshError::invalid_argument(
            "ownedNamespace",
            "must already be in canonical lowercase hyphenated form",
        ));
    }
    Ok(namespace)
}

fn is_canonical_uuid(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    bytes.len() == 36
        && UUID_HYPHEN_POSITIONS
            .iter()
            .all(|index| bytes[*index] == b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            UUID_HYPHEN_POSITIONS.contains(&index)
                || byte.is_ascii_digit()
                || (b'a'..=b'f').contains(byte)
        })
}

/// Canonicalize a directory that must exist, mapping failures to a labelled
/// contract error instead of an opaque I/O message.
fn canonical_dir(path: &Path, field: &str) -> Result<PathBuf, DshError> {
    let canonical = std::fs::canonicalize(path).map_err(|e| {
        DshError::invalid_argument(field, format!("must be an existing directory: {e}"))
    })?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|e| DshError::invalid_argument(field, format!("must be readable: {e}")))?;
    if !metadata.is_dir() {
        return Err(DshError::invalid_argument(
            field,
            "must be a directory, not a file",
        ));
    }
    Ok(canonical)
}

/// Reject any path that is not **strictly beneath** the canonical owned root.
fn validate_owned_path(
    canonical_root: &Path,
    candidate: &Path,
    field: &str,
) -> Result<PathBuf, DshError> {
    let canonical = canonical_dir(candidate, field)?;
    if !is_strictly_beneath(canonical_root, &canonical) {
        return Err(DshError::invalid_argument(
            field,
            format!(
                "must resolve strictly beneath the owned root {} (got {})",
                canonical_root.display(),
                canonical.display()
            ),
        ));
    }
    Ok(canonical)
}

/// Component-wise strict containment; a shared name prefix is not containment.
fn is_strictly_beneath(root: &Path, candidate: &Path) -> bool {
    match candidate.strip_prefix(root) {
        Ok(rest) => !rest.as_os_str().is_empty(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAMESPACE: &str = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

    fn namespace() -> CredentialNamespace {
        CredentialNamespace::parse(NAMESPACE).expect("namespace")
    }

    fn owned_namespace_value() -> Result<CredentialNamespace, DshError> {
        parse_owned_namespace(NAMESPACE)
    }

    /// Unique scratch directory for one test; never the live harness home.
    fn temp_root(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!(
            "dsh-owned-backend-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap_or_else(|e| {
            panic!("create temp root {}: {e}", path.display());
        });
        path
    }

    fn mkdir(root: &Path, relative: &str) -> PathBuf {
        let path = root.join(relative);
        std::fs::create_dir_all(&path).expect("create dir");
        path
    }

    #[test]
    fn no_namespace_selects_production_and_ignores_paths() {
        // Paths that do not exist and are not owned must not matter for a
        // normal run: production behaviour is unchanged.
        let missing = Path::new("Z:/does-not-exist/dsh-owned").to_path_buf();
        let backend = DesktopSecretBackend::select(None, &missing, &missing).expect("production");
        assert_eq!(backend, DesktopSecretBackend::Default(KeyringBackend));
        assert!(!backend.is_owned());
        assert!(backend.namespace().is_none());
        assert_eq!(
            backend
                .service_target("client-connection")
                .expect("service"),
            "dsh-desktop:client-connection"
        );
        assert_eq!(
            DesktopSecretBackend::select_under_root(None, &missing, &missing, &missing)
                .expect("production"),
            DesktopSecretBackend::Default(KeyringBackend)
        );
    }

    #[test]
    fn owned_namespace_requires_a_canonical_non_nil_uuid() {
        assert_eq!(
            owned_namespace_value().expect("namespace").as_str(),
            NAMESPACE
        );
        for rejected in [
            "",
            "native",
            "qual-1",
            "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0", // uppercase
            "0f1e2d3c4b5a69788796a5b4c3d2e1f0",     // unhyphenated
            "{0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0}",
            "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0 ", // trailing space
            "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f",   // short
            "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0g", // long
            "0f1e2d3c-4b5a-6978-8796-agb4c3d2e1f0",  // non-hex
            "00000000-0000-0000-0000-000000000000",  // nil
        ] {
            assert!(
                matches!(
                    parse_owned_namespace(rejected),
                    Err(DshError::InvalidArgument { .. })
                ),
                "namespace {rejected:?} must be rejected"
            );
        }
    }

    #[test]
    fn owned_root_is_the_compile_time_scratch_directory() {
        let expected = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join(OWNED_SCRATCH_DIR)
            .join(format!("native-{NAMESPACE}"));
        assert_eq!(owned_root(&namespace()), expected);
        assert!(
            owned_root(&namespace()).ends_with(format!("{OWNED_SCRATCH_DIR}/native-{NAMESPACE}"))
        );
    }

    #[test]
    fn strict_containment_is_component_wise() {
        let root = Path::new("/tmp/owned");
        assert!(is_strictly_beneath(root, Path::new("/tmp/owned/home")));
        assert!(is_strictly_beneath(root, Path::new("/tmp/owned/a/b/c")));
        assert!(!is_strictly_beneath(root, root));
        assert!(!is_strictly_beneath(root, Path::new("/tmp")));
        assert!(!is_strictly_beneath(root, Path::new("/tmp/other")));
        assert!(!is_strictly_beneath(root, Path::new("/")));
        // Shared name prefix is not containment.
        assert!(!is_strictly_beneath(
            Path::new("/tmp/owned"),
            Path::new("/tmp/owned-sibling")
        ));
    }

    #[test]
    fn owned_select_fences_paths_before_any_os_credential_call() {
        let root = temp_root("fence");
        let home = mkdir(&root, "home");
        let user_data = mkdir(&root, "user-data");

        let backend =
            DesktopSecretBackend::select_under_root(Some(NAMESPACE), &home, &user_data, &root)
                .expect("owned");
        assert!(backend.is_owned());
        assert_eq!(
            backend.namespace().map(CredentialNamespace::as_str),
            Some(NAMESPACE)
        );
        assert_eq!(
            backend
                .service_target("client-connection")
                .expect("service"),
            format!("dsh-desktop:{NAMESPACE}:client-connection")
        );
        // Never collides with the production target.
        assert_ne!(
            backend
                .service_target("client-connection")
                .expect("service"),
            KeyringBackend::service_target("client-connection").expect("service")
        );
        assert_eq!(
            credential_index_path(&user_data),
            user_data.join("credentials-index.json")
        );

        // Missing root.
        assert!(matches!(
            DesktopSecretBackend::select_under_root(
                Some(NAMESPACE),
                &home,
                &user_data,
                &root.join("absent-root")
            ),
            Err(DshError::InvalidArgument { .. })
        ));
        // A path outside the owned root (the real user profile shape).
        assert!(matches!(
            DesktopSecretBackend::select_under_root(
                Some(NAMESPACE),
                &std::env::temp_dir(),
                &user_data,
                &root
            ),
            Err(DshError::InvalidArgument { .. })
        ));
        // The root itself is not strictly beneath itself.
        assert!(matches!(
            DesktopSecretBackend::select_under_root(Some(NAMESPACE), &root, &user_data, &root),
            Err(DshError::InvalidArgument { .. })
        ));
        // A non-existent descendant.
        assert!(matches!(
            DesktopSecretBackend::select_under_root(
                Some(NAMESPACE),
                &home,
                &root.join("absent/user-data"),
                &root
            ),
            Err(DshError::InvalidArgument { .. })
        ));
        // A `..` escape that starts beneath the root still canonicalizes out.
        assert!(matches!(
            DesktopSecretBackend::select_under_root(
                Some(NAMESPACE),
                &home.join("..").join("..").join("sneaky"),
                &user_data,
                &root
            ),
            Err(DshError::InvalidArgument { .. })
        ));
        // A file instead of a directory.
        let file = root.join("not-a-dir");
        std::fs::write(&file, b"x").expect("write file");
        assert!(matches!(
            DesktopSecretBackend::select_under_root(Some(NAMESPACE), &file, &user_data, &root),
            Err(DshError::InvalidArgument { .. })
        ));

        std::fs::remove_dir_all(&root).expect("cleanup");
    }

    /// The renderer boundary reserves exactly the identity the gateway really
    /// owns — a stale copy of the name here would silently stop protecting it.
    #[test]
    fn reserved_identities_are_exactly_the_shell_owned_secret() {
        assert_eq!(
            SHELL_RESERVED_CREDENTIALS,
            &[(
                dsh_gateway::auth::AUTH_PROVIDER,
                dsh_gateway::auth::AUTH_REFERENCE
            )]
        );
        assert!(is_shell_reserved_credential(
            dsh_gateway::auth::AUTH_PROVIDER,
            dsh_gateway::auth::AUTH_REFERENCE
        ));
        // A near-miss provider or reference is a different OS entry and stays
        // available to the general provider CRUD surface.
        for (provider, reference) in [
            ("client-connection", "browser-sessions"),
            ("client-connections", "browser-session"),
            ("client-connection", ""),
            ("", "browser-session"),
            ("openai", "browser-session"),
        ] {
            assert!(
                !is_shell_reserved_credential(provider, reference),
                "{provider}/{reference} must not be reserved"
            );
        }
    }

    #[test]
    fn reserved_identity_case_variants_follow_the_platform_backend() {
        for (provider, reference) in [
            ("Client-Connection", "browser-session"),
            ("client-connection", "Browser-Session"),
            ("CLIENT-CONNECTION", "BROWSER-SESSION"),
        ] {
            assert_eq!(
                is_shell_reserved_credential(provider, reference),
                cfg!(windows),
                "case aliases must follow the OS target semantics: {provider}/{reference}"
            );
        }
    }

    /// No ambient namespace: setting the launcher's variable cannot retarget a
    /// run whose caller passed `None`, which is what makes "the namespace is a
    /// decision, never a path or environment side effect" true.
    #[test]
    fn the_owned_namespace_is_never_read_from_the_environment() {
        let previous = std::env::var_os(OWNED_NAMESPACE_ENV);
        std::env::set_var(OWNED_NAMESPACE_ENV, NAMESPACE);
        let missing = Path::new("Z:/dsh-owned-absent");
        let backend = DesktopSecretBackend::select(None, missing, missing).expect("production");
        assert_eq!(backend, DesktopSecretBackend::Default(KeyringBackend));
        assert!(!backend.is_owned());
        assert!(backend.namespace().is_none());
        match previous {
            Some(value) => std::env::set_var(OWNED_NAMESPACE_ENV, value),
            None => std::env::remove_var(OWNED_NAMESPACE_ENV),
        }
    }

    /// A rejected namespace must reject *before* it can create the owned root:
    /// there is no migration and no repair-on-refusal.
    #[test]
    fn a_rejected_namespace_performs_no_filesystem_write() {
        let missing_home = Path::new("Z:/dsh-owned-absent/home");
        let missing_user_data = Path::new("Z:/dsh-owned-absent/user-data");

        // Shape rejection: not a canonical UUID.
        assert!(matches!(
            DesktopSecretBackend::select(Some("native-qual"), missing_home, missing_user_data),
            Err(DshError::InvalidArgument { .. })
        ));

        // Containment rejection: a canonical UUID whose compile-time owned root
        // does not exist is refused, never created.
        let namespace = uuid::Uuid::new_v4().hyphenated().to_string();
        let root = owned_root(&CredentialNamespace::parse(&namespace).expect("namespace"));
        assert!(!root.exists(), "{} must not exist yet", root.display());
        assert!(matches!(
            DesktopSecretBackend::select(Some(&namespace), missing_home, missing_user_data),
            Err(DshError::InvalidArgument { .. })
        ));
        assert!(
            !root.exists(),
            "a rejected namespace must not create {}",
            root.display()
        );
    }
}
