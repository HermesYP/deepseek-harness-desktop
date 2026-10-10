//! The updater-owned half of `AppState`: candidate identity, flight ownership,
//! download episodes, and the single confirmation reservation.
//!
//! This is a submodule of [`crate::state`] rather than a separate concept, and
//! `state.rs` re-exports every item so existing paths
//! (`crate::state::UpdateCandidate`, …) are unchanged. It is split out because
//! the updater's runtime and policy modules are the only consumers, and because
//! the scratch probe in `port/.scratch/updater-probe/` includes this file
//! verbatim, so the tests that drive the updater exercise the same type the
//! production crate ships rather than a re-declaration of it.
//!
//! Invariants the module owns:
//!
//! - **One immutable candidate.** Every field that decides *what gets
//!   installed* is captured once, when the manifest is admitted, and is never
//!   re-read from a mutable store afterwards. "The version the user confirmed"
//!   and "the bytes that were verified and launched" are therefore the same
//!   object by construction rather than by convention.
//! - **One flight.** Check, download, and install each own the service; a
//!   second request joins or is refused instead of racing. Ownership is settled
//!   by identity ([`UpdateService::settle_flight`]), so a stale settlement can
//!   never clear a newer operation's claim.
//! - **Episodes reject stale completions.** A download publishes only while the
//!   episode it began in is still current, so a channel switch or a superseding
//!   check cannot be overwritten by a late result.
//! - **One confirmation.** A prompt is reserved ([`UpdateService::reserve_confirmation`])
//!   *before* it is shown, and its answer is re-checked against the candidate
//!   identity and episode it was opened for, so a second prompt cannot open for
//!   the same candidate and a late answer cannot install a superseded target.
//! - **Typed exhaustion.** Monotonic identities never wrap, saturate, or panic:
//!   running out of identity space is a returned
//!   [`UpdateIdentityExhausted`], and invalidation still fails closed.

use std::path::PathBuf;

use crate::update_security::{self, ArtifactNameFailure};

/// One immutable update candidate.
///
/// Every field that decides *what gets installed* is captured here once, when
/// the manifest is admitted, and is never re-read from a mutable store
/// afterwards. That makes "the version the user confirmed" and "the bytes that
/// were verified and launched" the same object by construction rather than by
/// convention.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateCandidate {
    /// Exact release version this candidate installs.
    pub version: String,
    /// Release channel the manifest was admitted for. A channel switch
    /// invalidates this candidate.
    pub channel: String,
    /// Artifact URL as admitted against the packaged allow list.
    pub url: String,
    /// Lowercase hex SHA-256 the artifact bytes must match.
    pub sha256: String,
    /// Hex-encoded Ed25519 signature over the canonical signed message.
    pub signature: String,
    /// Artifact path once the bytes have been downloaded, verified, and
    /// atomically published. `None` until publication succeeds.
    pub artifact_path: Option<PathBuf>,
}

impl UpdateCandidate {
    /// The exact values a signature covers for this candidate.
    pub fn signed_release(&self) -> crate::update_security::SignedRelease<'_> {
        crate::update_security::SignedRelease {
            version: &self.version,
            channel: &self.channel,
            sha256: &self.sha256,
        }
    }
}

/// Which user-initiated operation currently owns the update service.
///
/// Exactly one of these may be in flight. A second attempt joins or is refused
/// rather than starting competing network work, which is what prevents two
/// downloads from racing to publish different bytes for the same version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateFlight {
    Check,
    Download,
    Install,
}

impl UpdateFlight {
    /// Stable label of the in-flight operation.
    pub fn label(self) -> &'static str {
        match self {
            Self::Check => "check",
            Self::Download => "download",
            Self::Install => "install",
        }
    }
}

/// One download episode's identity.
///
/// A download completion may only publish while the episode it started in is
/// still current. A channel switch, a new check, or an invalidation starts a
/// new episode, so a late completion is rejected instead of overwriting newer
/// state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct DownloadEpisode(pub u64);

/// Monotonic identity for one update operation's ownership claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpdateOperation(pub u64);

/// Which monotonic identity space ran out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateIdentityKind {
    /// The operation-ownership generation.
    Operation,
    /// The download-episode generation.
    Episode,
}

/// The monotonic update identity space is exhausted.
///
/// This is a **returned** outcome, never a panic, a saturating clamp, or a
/// wrapping reuse: after `u64::MAX` generations the updater cannot distinguish a
/// new operation from an old owner, so it stops claiming new ownership and keeps
/// the presentation it can still account for. A wrapping identity would let a
/// stale settlement or confirmation match a *newer* operation, which is exactly
/// what ownership generations exist to prevent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpdateIdentityExhausted {
    /// Which identity space ran out.
    pub kind: UpdateIdentityKind,
}

impl std::fmt::Display for UpdateIdentityExhausted {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.kind {
            UpdateIdentityKind::Operation => write!(
                formatter,
                "update operation identity exhausted; no further update operation can be admitted in this process"
            ),
            UpdateIdentityKind::Episode => write!(
                formatter,
                "update download episode identity exhausted; no further download episode can begin in this process"
            ),
        }
    }
}

impl std::error::Error for UpdateIdentityExhausted {}

/// The identity a confirmation prompt is bound to.
///
/// Captured when the prompt is *reserved* — before the dialog is shown — so the
/// answer can be checked against the candidate and episode the user actually saw
/// rather than against whatever is admitted when the dialog closes. The
/// operation the prompt would authorize is deliberately not part of this: the
/// caller knows which prompt it opened, and the answer's authority comes from the
/// candidate identity and episode being unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmationReservation {
    /// Candidate version the prompt named.
    pub version: String,
    /// Candidate channel the prompt was opened for.
    pub channel: String,
    /// Candidate digest the prompt was opened for.
    pub sha256: String,
    /// Download episode current when the prompt was reserved.
    pub episode: DownloadEpisode,
}

/// What an answer to a reserved prompt means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmationOutcome {
    /// The prompt was answered and the identity still matched. `proceed` is the
    /// raw answer: `Some(true)` for the primary action, `Some(false)` for the
    /// secondary (`Later`, or consent-based Quit), and `None` when the native
    /// callback was dropped without an answer.
    Answered {
        /// Primary (`true`) or secondary (`false`) action; `None` for a lost
        /// callback, which is never consent.
        proceed: Option<bool>,
    },
    /// The reservation no longer describes the admitted candidate or episode,
    /// so the answer authorizes nothing.
    Superseded,
}

impl ConfirmationOutcome {
    /// Whether the answer was refused because its reservation was superseded.
    ///
    /// Test/diagnostic surface: production call sites ask [`Self::answered`],
    /// because "authorizes nothing" and "no answer" are the same decision for
    /// them.
    #[cfg(any(test, updater_probe))]
    pub fn is_superseded(self) -> bool {
        matches!(self, Self::Superseded)
    }

    /// The raw answer when it was honoured.
    ///
    /// `Some(Some(true))` is the primary action, `Some(Some(false))` the
    /// secondary (`Later`, or consent-based Quit), `Some(None)` a native callback
    /// that was dropped without an answer, and `None` a superseded reservation.
    pub fn answered(self) -> Option<Option<bool>> {
        match self {
            Self::Answered { proceed } => Some(proceed),
            Self::Superseded => None,
        }
    }
}

/// Update-presentation state machine (`apps/desktop/src/ipc.ts` states), plus
/// the candidate identity the presentation deliberately does not carry.
pub struct UpdateService {
    pub state: dsh_core::protocol::DesktopUpdateState,
    /// The one admitted candidate, if any. `Some` with a published artifact is
    /// what authorizes an installation; there is no other artifact authority.
    pub candidate: Option<UpdateCandidate>,
    /// In-flight operation, if any.
    pub flight: Option<UpdateFlight>,
    /// Monotonic ownership generation, independent of download episodes.
    pub operation: UpdateOperation,
    /// Serialize Host Lock/Unlock through handoff, even when invalidation revokes
    /// presentation ownership. The Host protocol has no per-installer lease id.
    pub install_gate: std::sync::Arc<tokio::sync::Mutex<()>>,
    /// Current download episode identity.
    pub episode: DownloadEpisode,
    /// Highest episode that published a verified artifact.
    pub published_episode: DownloadEpisode,
    /// Whether a check has completed since the last invalidation, so the UI can
    /// distinguish "not checked yet" from "checked, up to date".
    pub checked: bool,
    /// The one reserved confirmation prompt, if a prompt is open.
    pub confirmation: Option<ConfirmationReservation>,
    /// Verified artifacts the service has detached from its admitted candidate
    /// and no longer needs.
    ///
    /// Retirement happens *under the service lock*, in the same scope that drops
    /// the candidate, so a path can only be retired once nothing owns it: cleanup
    /// can never clear a path a newer operation still references. The paths are
    /// removed later, by the retained cleanup owner at shutdown
    /// ([`crate::update_flow::drain_artifact_cleanup`]).
    pub retired_artifacts: Vec<PathBuf>,
    /// Whether update admission has been closed for shutdown.
    ///
    /// A closed service refuses every new check, download, and install; it is the
    /// state side of the shutdown barrier, so an operation that arrives while the
    /// process is winding down joins the closed presentation instead of starting
    /// network or Host work the drain is about to run behind. There is no reopen:
    /// a process either admits updates or is closing.
    pub admission_closed: bool,
}

impl UpdateService {
    pub fn idle() -> Self {
        Self {
            state: dsh_core::protocol::DesktopUpdateState {
                phase: dsh_core::protocol::DesktopUpdatePhase::Idle,
                version: None,
                message: None,
                technical_details: None,
                percent: None,
                failed_operation: None,
                preparation_failure: None,
            },
            candidate: None,
            flight: None,
            operation: UpdateOperation(0),
            install_gate: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            episode: DownloadEpisode(0),
            published_episode: DownloadEpisode(0),
            checked: false,
            confirmation: None,
            retired_artifacts: Vec::new(),
            admission_closed: false,
        }
    }

    /// Advance the operation generation, or report exhaustion without mutating.
    fn advance_operation(&mut self) -> Result<UpdateOperation, UpdateIdentityExhausted> {
        let next = self
            .operation
            .0
            .checked_add(1)
            .ok_or(UpdateIdentityExhausted {
                kind: UpdateIdentityKind::Operation,
            })?;
        self.operation = UpdateOperation(next);
        Ok(self.operation)
    }

    /// Advance the episode generation, or report exhaustion without mutating.
    fn advance_episode(&mut self) -> Result<DownloadEpisode, UpdateIdentityExhausted> {
        let next = self
            .episode
            .0
            .checked_add(1)
            .ok_or(UpdateIdentityExhausted {
                kind: UpdateIdentityKind::Episode,
            })?;
        self.episode = DownloadEpisode(next);
        Ok(self.episode)
    }

    /// Claim ownership for a new in-flight operation.
    ///
    /// The flight is set only when a fresh generation was obtained, so an
    /// exhausted identity space leaves the previous ownership exactly as it was
    /// instead of publishing a claim nothing can distinguish.
    pub fn claim_flight(
        &mut self,
        flight: UpdateFlight,
    ) -> Result<UpdateOperation, UpdateIdentityExhausted> {
        let owner = self.advance_operation()?;
        self.flight = Some(flight);
        Ok(owner)
    }

    /// Whether this operation still owns the requested flight.
    pub fn owns_flight(&self, flight: UpdateFlight, operation: UpdateOperation) -> bool {
        self.flight == Some(flight) && self.operation == operation
    }

    /// Release the flight **only** when it is still the one this operation owns.
    ///
    /// Returns whether the claim was released. A stale settlement — the tail of
    /// an operation that was superseded while it ran — returns `false` and leaves
    /// the newer flight untouched.
    pub fn settle_flight(&mut self, flight: UpdateFlight, operation: UpdateOperation) -> bool {
        if self.owns_flight(flight, operation) {
            self.flight = None;
            true
        } else {
            false
        }
    }

    /// Whether a verified artifact is ready to install.
    pub fn has_published_artifact(&self) -> bool {
        self.candidate
            .as_ref()
            .is_some_and(|candidate| candidate.artifact_path.is_some())
            && self.published_episode >= self.episode
    }

    /// Begin a new download episode, invalidating any previous completion.
    ///
    /// Returns the typed exhaustion when the episode space runs out; the previous
    /// episode then remains current, so an in-flight completion can still be
    /// accounted for rather than being mistaken for a newer one.
    pub fn begin_episode(&mut self) -> Result<DownloadEpisode, UpdateIdentityExhausted> {
        let episode = self.advance_episode()?;
        self.state.percent = None;
        Ok(episode)
    }

    /// Whether `episode` is still the current episode.
    pub fn episode_is_current(&self, episode: DownloadEpisode) -> bool {
        episode == self.episode
    }

    /// Publish `path` as the verified artifact of the current download episode.
    ///
    /// Returns whether it was published. Refuses when `episode` is no longer the
    /// current episode (a channel switch, a superseding check, or a new download
    /// began a later one), so a late completion cannot mark a newer target
    /// `Ready`, and refuses when no candidate is admitted, because the bytes
    /// would then belong to no identity.
    pub fn publish_artifact(&mut self, episode: DownloadEpisode, path: PathBuf) -> bool {
        if !self.episode_is_current(episode) {
            return false;
        }
        let Some(version) = self
            .candidate
            .as_ref()
            .map(|candidate| candidate.version.clone())
        else {
            return false;
        };
        if let Some(candidate) = self.candidate.as_mut() {
            candidate.artifact_path = Some(path);
        }
        self.published_episode = episode;
        self.state.phase = dsh_core::protocol::DesktopUpdatePhase::Ready;
        self.state.version = Some(version);
        self.state.percent = Some(100.0);
        self.state.failed_operation = None;
        self.state.message = None;
        self.state.technical_details = None;
        true
    }

    /// Drop the admitted candidate, any published artifact, and any reserved
    /// confirmation.
    ///
    /// Called whenever the release channel changes or a new check supersedes
    /// the current target, so no install can use a candidate that was admitted
    /// under different authority. An open prompt is revoked too: its answer can
    /// no longer be matched to the candidate the user saw.
    ///
    /// Exhaustion is reported rather than hidden. The invalidation itself still
    /// takes effect and additionally revokes presentation ownership, because with
    /// no fresh generation the previous owner can no longer be distinguished from
    /// a current one.
    pub fn invalidate_candidate(&mut self) -> Result<(), UpdateIdentityExhausted> {
        self.candidate = None;
        self.confirmation = None;
        let operation = self.advance_operation();
        let episode = self.advance_episode();
        // The operation identity is reported first: it is the generation that
        // gates ownership, and `and` keeps that error when both fail.
        let outcome = operation.and(episode).map(|_episode| ());
        if outcome.is_err() {
            // Fail closed: revoke ownership outright rather than leaving a stale
            // owner able to publish or install behind an identity that cannot be
            // advanced past its limit.
            self.flight = None;
            self.confirmation = None;
        }
        outcome
    }

    // -----------------------------------------------------------------------
    // Confirmation reservation
    // -----------------------------------------------------------------------

    /// Reserve the one confirmation slot for the admitted candidate.
    ///
    /// Returns the reservation, or `None` when another prompt is already open
    /// for this candidate (the caller joins it instead of opening a second
    /// dialog) or when no candidate is admitted to confirm. Reserving **before**
    /// the dialog is shown is what closes the gap between a check committing a
    /// candidate and the prompt appearing.
    pub fn reserve_confirmation(&mut self) -> Option<ConfirmationReservation> {
        if self.confirmation.is_some() {
            return None;
        }
        let candidate = self.candidate.as_ref()?;
        let reservation = ConfirmationReservation {
            version: candidate.version.clone(),
            channel: candidate.channel.clone(),
            sha256: candidate.sha256.clone(),
            episode: self.episode,
        };
        self.confirmation = Some(reservation.clone());
        Some(reservation)
    }

    /// The currently reserved confirmation, if any.
    ///
    /// Test/diagnostic surface: the updater reserves and answers by slot
    /// ([`Self::answer_reserved_confirmation`]), and never inspects the
    /// reservation it does not hold.
    #[cfg(any(test, updater_probe))]
    pub fn confirmation(&self) -> Option<&ConfirmationReservation> {
        self.confirmation.as_ref()
    }

    /// Whether `reservation` still describes the admitted candidate and episode.
    pub fn confirmation_is_current(&self, reservation: &ConfirmationReservation) -> bool {
        self.episode_is_current(reservation.episode)
            && self.candidate.as_ref().is_some_and(|candidate| {
                candidate.version == reservation.version
                    && candidate.channel == reservation.channel
                    && candidate.sha256 == reservation.sha256
            })
    }

    /// Release the reserved confirmation without acting on it.
    ///
    /// Test/diagnostic surface: production either answers the reservation or
    /// revokes it with the candidate.
    #[cfg(any(test, updater_probe))]
    pub fn release_confirmation(&mut self) -> Option<ConfirmationReservation> {
        self.confirmation.take()
    }

    /// Bind an answer to the reservation it was opened for.
    ///
    /// A superseded or already-consumed reservation yields
    /// [`ConfirmationOutcome::Superseded`] and changes nothing, so a late dialog
    /// cannot install a target the user never saw. On a matching answer the
    /// reservation is released; the *caller* decides what the answer authorizes,
    /// and a declined or lost answer leaves the candidate and its verified
    /// artifact exactly as they were.
    pub fn answer_confirmation(
        &mut self,
        reservation: &ConfirmationReservation,
        proceed: Option<bool>,
    ) -> ConfirmationOutcome {
        if self.confirmation.as_ref() != Some(reservation) {
            return ConfirmationOutcome::Superseded;
        }
        self.confirmation = None;
        if !self.confirmation_is_current(reservation) {
            return ConfirmationOutcome::Superseded;
        }
        ConfirmationOutcome::Answered { proceed }
    }

    /// Answer the currently reserved confirmation.
    ///
    /// There is at most one reservation, and only the caller whose
    /// [`Self::reserve_confirmation`] succeeded proceeds to a dialog, so "the
    /// current reservation" is unambiguous. This is the form the updater's dialog
    /// paths use: nothing borrowed from the service is held across the dialog, so
    /// no state guard can be alive while the user decides, and the answer is
    /// re-checked against the candidate identity and episode that were reserved.
    pub fn answer_reserved_confirmation(&mut self, proceed: Option<bool>) -> ConfirmationOutcome {
        let Some(reservation) = self.confirmation.clone() else {
            return ConfirmationOutcome::Superseded;
        };
        self.answer_confirmation(&reservation, proceed)
    }

    /// Whether update admission is open.
    pub fn admission_is_open(&self) -> bool {
        !self.admission_closed
    }

    /// Close admission. There is deliberately no reopen.
    pub fn close_admission(&mut self) {
        self.admission_closed = true;
    }

    // -----------------------------------------------------------------------
    // Artifact retirement
    // -----------------------------------------------------------------------

    /// Record one detached artifact for removal at the cleanup drain.
    ///
    /// Returns the number of artifacts now retired. Never removes anything: a
    /// removal performed here (or in a `Drop`) could race a fresh publication of
    /// the same filename, and a `Drop` cannot await, so removal belongs to the
    /// joined drain. Callers only retire a path they have *just* detached from
    /// the admitted candidate, under this same lock.
    pub fn retire_artifact(&mut self, path: PathBuf) -> usize {
        self.retired_artifacts.push(path);
        self.retired_artifacts.len()
    }

    /// Whether `path` is the artifact of the currently admitted candidate.
    ///
    /// Test/diagnostic surface: the updater's own retirement guard is
    /// [`crate::update_flow`]'s `superseded_artifact`, which compares the
    /// detaching candidate with its successor; this predicate exists so that rule
    /// can be asserted directly against the service.
    #[cfg(any(test, updater_probe))]
    pub fn references_artifact(&self, path: &std::path::Path) -> bool {
        self.candidate
            .as_ref()
            .and_then(|candidate| candidate.artifact_path.as_deref())
            == Some(path)
    }

    /// Take the retired artifacts, leaving an empty list.
    pub fn take_retired_artifacts(&mut self) -> Vec<PathBuf> {
        std::mem::take(&mut self.retired_artifacts)
    }
}

/// Filename a verified artifact is published under.
///
/// Derived from the candidate identity (channel + version + digest) rather than
/// from the process id, so a retry of the same release reuses one target and
/// two different releases can never collide.
///
/// The digest is shape-checked as exactly 64 ASCII hex characters before it is
/// sliced, and the channel/version are checked as safe single path components
/// before they are joined: a malformed candidate is refused with
/// [`ArtifactNameFailure`] rather than panicking a byte slice or selecting a
/// path outside the artifact cache.
pub fn artifact_file_name(candidate: &UpdateCandidate) -> Result<String, ArtifactNameFailure> {
    if !update_security::is_valid_sha256(&candidate.sha256) {
        return Err(ArtifactNameFailure::DigestNotSha256Hex);
    }
    if !update_security::is_safe_path_component(&candidate.channel)
        || !update_security::is_safe_path_component(&candidate.version)
    {
        return Err(ArtifactNameFailure::UnsafeIdentityComponent);
    }
    // ASCII-verified above, so a 16-byte prefix is a character boundary. Hex
    // case is normalized so the same release always names the same target.
    let digest = candidate.sha256[..16].to_ascii_lowercase();
    Ok(format!(
        "dsh-update-{}-{}-{digest}.bin",
        candidate.channel, candidate.version
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(version: &str, channel: &str, sha: &str) -> UpdateCandidate {
        UpdateCandidate {
            version: version.to_string(),
            channel: channel.to_string(),
            url: "https://updates.example.com/Setup.exe".to_string(),
            sha256: sha.to_string(),
            signature: "ab".repeat(64),
            artifact_path: None,
        }
    }

    #[test]
    fn invalidation_revokes_paused_check_and_install() {
        for flight in [UpdateFlight::Check, UpdateFlight::Install] {
            let mut service = UpdateService::idle();
            let operation = service.claim_flight(flight).expect("identity available");
            service.invalidate_candidate().expect("identity available");
            assert!(!service.owns_flight(flight, operation));
        }
    }

    #[test]
    fn replacement_same_kind_claim_rejects_old_operation() {
        let mut service = UpdateService::idle();
        let candidate = candidate("1.2.3", "stable", &"a".repeat(64));
        service.candidate = Some(candidate.clone());
        let old = service
            .claim_flight(UpdateFlight::Install)
            .expect("identity available");
        let new = service
            .claim_flight(UpdateFlight::Install)
            .expect("identity available");
        assert_ne!(old, new);
        assert_eq!(service.candidate.as_ref(), Some(&candidate));
        assert!(!service.owns_flight(UpdateFlight::Install, old));
        assert!(service.owns_flight(UpdateFlight::Install, new));
    }

    #[test]
    fn clearing_terminal_flight_then_retry_changes_operation() {
        let mut service = UpdateService::idle();
        let first = service
            .claim_flight(UpdateFlight::Check)
            .expect("identity available");
        service.flight = None;
        let retry = service
            .claim_flight(UpdateFlight::Check)
            .expect("identity available");
        assert_ne!(first, retry);
        assert!(!service.owns_flight(UpdateFlight::Check, first));
        assert!(service.owns_flight(UpdateFlight::Check, retry));
    }

    #[test]
    fn ownership_generation_does_not_change_episode_semantics() {
        let mut service = UpdateService::idle();
        let operation = service
            .claim_flight(UpdateFlight::Download)
            .expect("identity available");
        let episode = service.begin_episode().expect("identity available");
        assert!(service.episode_is_current(episode));
        assert!(service.owns_flight(UpdateFlight::Download, operation));
        service.invalidate_candidate().expect("identity available");
        assert!(!service.episode_is_current(episode));
        assert!(!service.has_published_artifact());
        assert!(!service.owns_flight(UpdateFlight::Download, operation));
    }

    // --- settlement --------------------------------------------------------

    #[test]
    fn a_settlement_releases_only_the_claim_it_owns() {
        let mut service = UpdateService::idle();
        let old = service
            .claim_flight(UpdateFlight::Download)
            .expect("identity available");
        let newer = service
            .claim_flight(UpdateFlight::Install)
            .expect("identity available");
        assert!(
            !service.settle_flight(UpdateFlight::Download, old),
            "a stale settlement must not clear a newer flight"
        );
        assert_eq!(service.flight, Some(UpdateFlight::Install));
        assert!(service.owns_flight(UpdateFlight::Install, newer));
        assert!(service.settle_flight(UpdateFlight::Install, newer));
        assert_eq!(service.flight, None);
        assert!(
            !service.settle_flight(UpdateFlight::Install, newer),
            "settling twice is a no-op, not a panic"
        );
    }

    #[test]
    fn a_settlement_for_the_wrong_kind_leaves_the_claim_alone() {
        let mut service = UpdateService::idle();
        let owner = service
            .claim_flight(UpdateFlight::Check)
            .expect("identity available");
        assert!(!service.settle_flight(UpdateFlight::Install, owner));
        assert_eq!(service.flight, Some(UpdateFlight::Check));
    }

    // --- identity exhaustion ----------------------------------------------

    #[test]
    fn exhausted_operation_identity_is_returned_not_wrapped_or_clamped() {
        let mut service = UpdateService::idle();
        service.operation = UpdateOperation(u64::MAX);
        for flight in [
            UpdateFlight::Check,
            UpdateFlight::Download,
            UpdateFlight::Install,
        ] {
            let outcome = service.claim_flight(flight);
            assert_eq!(
                outcome,
                Err(UpdateIdentityExhausted {
                    kind: UpdateIdentityKind::Operation
                })
            );
            assert_eq!(
                service.flight, None,
                "an exhausted claim must not publish ownership"
            );
            assert_eq!(service.operation, UpdateOperation(u64::MAX));
        }
        assert_eq!(
            service.invalidate_candidate(),
            Err(UpdateIdentityExhausted {
                kind: UpdateIdentityKind::Operation
            })
        );
        assert_eq!(service.operation, UpdateOperation(u64::MAX));
        assert_eq!(service.flight, None);
    }

    #[test]
    fn exhausted_episode_identity_is_returned_and_keeps_the_previous_episode() {
        let mut service = UpdateService::idle();
        service.episode = DownloadEpisode(u64::MAX);
        assert_eq!(
            service.begin_episode(),
            Err(UpdateIdentityExhausted {
                kind: UpdateIdentityKind::Episode
            })
        );
        assert!(service.episode_is_current(DownloadEpisode(u64::MAX)));
        service.operation = UpdateOperation(u64::MAX);
        assert_eq!(
            service.invalidate_candidate(),
            Err(UpdateIdentityExhausted {
                kind: UpdateIdentityKind::Operation
            })
        );
    }

    #[test]
    fn exhausted_invalidation_still_revokes_ownership_and_the_candidate() {
        let mut service = UpdateService::idle();
        service.candidate = Some(candidate("1.2.3", "stable", &"a".repeat(64)));
        let owner = service
            .claim_flight(UpdateFlight::Install)
            .expect("identity available");
        service.operation = UpdateOperation(u64::MAX);
        assert!(service.invalidate_candidate().is_err());
        assert_eq!(service.candidate, None);
        assert_eq!(service.flight, None, "ownership is revoked fail-closed");
        assert!(!service.owns_flight(UpdateFlight::Install, owner));
        assert!(!service.has_published_artifact());
    }

    #[test]
    fn an_exhausted_identity_error_explains_itself() {
        let operation = UpdateIdentityExhausted {
            kind: UpdateIdentityKind::Operation,
        };
        let episode = UpdateIdentityExhausted {
            kind: UpdateIdentityKind::Episode,
        };
        assert!(operation
            .to_string()
            .contains("operation identity exhausted"));
        assert!(episode.to_string().contains("episode identity exhausted"));
        assert_ne!(operation, episode);
    }

    // --- publication -------------------------------------------------------

    #[test]
    fn a_stale_episode_cannot_publish_an_artifact() {
        let mut service = UpdateService::idle();
        service.candidate = Some(candidate("1.2.3", "stable", &"a".repeat(64)));
        let episode = service.begin_episode().expect("identity available");
        service.begin_episode().expect("identity available");
        assert!(!service.publish_artifact(episode, PathBuf::from("late.bin")));
        assert!(!service.has_published_artifact());
        assert!(service
            .candidate
            .as_ref()
            .is_some_and(|candidate| candidate.artifact_path.is_none()));
    }

    #[test]
    fn the_current_episode_publishes_the_admitted_candidates_artifact() {
        let mut service = UpdateService::idle();
        service.candidate = Some(candidate("1.2.3", "stable", &"a".repeat(64)));
        let episode = service.begin_episode().expect("identity available");
        assert!(service.publish_artifact(episode, PathBuf::from("verified.bin")));
        assert!(service.has_published_artifact());
        assert_eq!(
            service.state.phase,
            dsh_core::protocol::DesktopUpdatePhase::Ready
        );
        // Republishing the same episode is idempotent.
        assert!(service.publish_artifact(episode, PathBuf::from("verified.bin")));
    }

    #[test]
    fn no_candidate_means_nothing_to_publish() {
        let mut service = UpdateService::idle();
        let episode = service.begin_episode().expect("identity available");
        assert!(!service.publish_artifact(episode, PathBuf::from("orphan.bin")));
        assert!(!service.has_published_artifact());
    }

    // --- confirmation reservation -----------------------------------------

    #[test]
    fn one_confirmation_is_reserved_and_a_second_caller_joins_it() {
        let mut service = UpdateService::idle();
        service.candidate = Some(candidate("1.2.3", "stable", &"a".repeat(64)));
        let first = service
            .reserve_confirmation()
            .expect("the first caller reserves");
        assert_eq!(
            service.reserve_confirmation(),
            None,
            "a concurrent caller must join the open prompt, not open a second"
        );
        assert_eq!(service.confirmation(), Some(&first));
    }

    #[test]
    fn no_reservation_without_an_admitted_candidate() {
        let mut service = UpdateService::idle();
        assert_eq!(service.reserve_confirmation(), None);
    }

    #[test]
    fn a_reservation_survives_a_release_until_it_is_answered() {
        let mut service = UpdateService::idle();
        service.candidate = Some(candidate("1.2.3", "stable", &"a".repeat(64)));
        let reservation = service.reserve_confirmation().expect("reserved");
        service.release_confirmation();
        assert_eq!(service.confirmation(), None);
        assert_eq!(
            service.answer_confirmation(&reservation, Some(true)),
            ConfirmationOutcome::Superseded,
            "a released reservation authorizes nothing"
        );
    }

    #[test]
    fn a_stale_prompt_answer_is_superseded_and_changes_nothing() {
        let mut service = UpdateService::idle();
        service.candidate = Some(candidate("1.2.3", "stable", &"a".repeat(64)));
        let reservation = service.reserve_confirmation().expect("reserved");
        // A new check admits a different release while the prompt is open.
        service.candidate = Some(candidate("1.2.4", "stable", &"b".repeat(64)));
        assert!(!service.confirmation_is_current(&reservation));
        assert_eq!(
            service.answer_confirmation(&reservation, Some(true)),
            ConfirmationOutcome::Superseded
        );
        assert_eq!(
            service.candidate.as_ref().map(|c| c.version.as_str()),
            Some("1.2.4"),
            "the superseding candidate is untouched"
        );
    }

    #[test]
    fn a_prompt_answer_bound_to_the_same_episode_is_honoured() {
        let mut service = UpdateService::idle();
        service.candidate = Some(candidate("1.2.3", "stable", &"a".repeat(64)));
        let reservation = service.reserve_confirmation().expect("reserved");
        assert!(service.confirmation_is_current(&reservation));
        assert_eq!(
            service.answer_confirmation(&reservation, Some(true)),
            ConfirmationOutcome::Answered {
                proceed: Some(true)
            }
        );
        assert_eq!(service.confirmation(), None, "the slot is consumed");
        // Later, and a dropped callback, are non-consent answers.
        let declined = service.reserve_confirmation().expect("reserved");
        assert_eq!(
            service.answer_confirmation(&declined, Some(false)),
            ConfirmationOutcome::Answered {
                proceed: Some(false)
            }
        );
        let lost = service.reserve_confirmation().expect("reserved");
        assert_eq!(
            service.answer_confirmation(&lost, None),
            ConfirmationOutcome::Answered { proceed: None }
        );
    }

    #[test]
    fn an_answer_for_a_superseded_episode_is_refused() {
        let mut service = UpdateService::idle();
        service.candidate = Some(candidate("1.2.3", "stable", &"a".repeat(64)));
        let reservation = service.reserve_confirmation().expect("reserved");
        // A download began a new episode while the prompt was open.
        service.begin_episode().expect("identity available");
        assert_eq!(
            service.answer_confirmation(&reservation, Some(true)),
            ConfirmationOutcome::Superseded
        );
    }

    #[test]
    fn invalidation_revokes_an_open_confirmation() {
        let mut service = UpdateService::idle();
        service.candidate = Some(candidate("1.2.3", "stable", &"a".repeat(64)));
        let reservation = service.reserve_confirmation().expect("reserved");
        service.invalidate_candidate().expect("identity available");
        assert_eq!(service.confirmation(), None);
        assert_eq!(
            service.answer_confirmation(&reservation, Some(true)),
            ConfirmationOutcome::Superseded
        );
    }

    #[test]
    fn answering_the_current_reservation_needs_no_borrowed_state() {
        let mut service = UpdateService::idle();
        service.candidate = Some(candidate("1.2.3", "stable", &"a".repeat(64)));
        assert!(service.reserve_confirmation().is_some());
        assert_eq!(
            service.answer_reserved_confirmation(Some(true)).answered(),
            Some(Some(true))
        );
        // A second answer has nothing to consume.
        assert!(service
            .answer_reserved_confirmation(Some(true))
            .is_superseded());
    }

    #[test]
    fn a_superseded_reservation_is_reported_not_answered() {
        let mut service = UpdateService::idle();
        service.candidate = Some(candidate("1.2.3", "stable", &"a".repeat(64)));
        assert!(service.reserve_confirmation().is_some());
        // The candidate is replaced while the prompt is open.
        service.candidate = Some(candidate("1.2.4", "stable", &"b".repeat(64)));
        let outcome = service.answer_reserved_confirmation(Some(true));
        assert!(outcome.is_superseded());
        assert_eq!(outcome.answered(), None);
    }

    // --- artifact retirement -----------------------------------------------

    #[test]
    fn closing_admission_is_one_way_and_visible_to_the_admission_checks() {
        let mut service = UpdateService::idle();
        assert!(service.admission_is_open());
        service.close_admission();
        assert!(!service.admission_is_open());
        service.close_admission();
        assert!(!service.admission_is_open());
    }

    #[test]
    fn retirement_records_without_removing_and_only_the_current_path_is_referenced() {
        let mut service = UpdateService::idle();
        let live = PathBuf::from("/cache/dsh-update-stable-1.2.3-live.bin");
        service.candidate = Some(UpdateCandidate {
            artifact_path: Some(live.clone()),
            ..candidate("1.2.3", "stable", &"a".repeat(64))
        });
        assert!(service.references_artifact(&live));
        assert!(!service.references_artifact(std::path::Path::new("/cache/other.bin")));

        let retired = PathBuf::from("/cache/dsh-update-stable-1.2.2-old.bin");
        assert_eq!(service.retire_artifact(retired.clone()), 1);
        assert_eq!(service.retired_artifacts, vec![retired.clone()]);
        assert_eq!(service.take_retired_artifacts(), vec![retired]);
        assert!(service.retired_artifacts.is_empty());

        // Once the candidate is gone, it references nothing.
        service.invalidate_candidate().expect("identity available");
        assert!(!service.references_artifact(&live));
    }

    // --- artifact filenames ------------------------------------------------

    #[test]
    fn a_digest_that_is_not_64_hex_characters_names_no_file() {
        for malformed in [
            String::new(),
            "a".repeat(63),
            "a".repeat(65),
            "z".repeat(64),
            "é".repeat(32),
            format!("{} ", "a".repeat(63)),
        ] {
            assert_eq!(
                artifact_file_name(&candidate("1.2.3", "stable", &malformed)),
                Err(ArtifactNameFailure::DigestNotSha256Hex),
                "{malformed}"
            );
        }
    }

    #[test]
    fn identity_components_that_traverse_name_no_file() {
        let digest = "a".repeat(64);
        for (version, channel) in [
            ("../evil", "stable"),
            ("1.2.3/../../etc", "stable"),
            ("1.2.3", "../stable"),
            ("1.2.3", "sta/ble"),
            ("1.2.3", ""),
            ("", "stable"),
        ] {
            assert_eq!(
                artifact_file_name(&candidate(version, channel, &digest)),
                Err(ArtifactNameFailure::UnsafeIdentityComponent),
                "{channel}/{version}"
            );
        }
    }

    #[test]
    fn a_well_formed_candidate_names_one_stable_file() {
        let digest = "AaBb".repeat(16);
        let first = artifact_file_name(&candidate("1.2.3", "stable", &digest))
            .expect("a well-formed candidate names a file");
        let second = artifact_file_name(&candidate("1.2.3", "stable", &digest.to_lowercase()))
            .expect("hex case does not change the target");
        assert_eq!(first, second);
        assert!(first.starts_with("dsh-update-stable-1.2.3-"), "{first}");
        assert!(first.ends_with(".bin"), "{first}");
    }
}
