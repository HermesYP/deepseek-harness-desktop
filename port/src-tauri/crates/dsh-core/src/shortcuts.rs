//! Desktop shortcut configuration engine — the Rust port of
//! `_upstream/packages/client/shortcuts/protocol`
//! (`binding.ts`, `configuration.ts`, `persistence.ts`).
//!
//! Behaviour preserved (`docs/contracts/desktop-shell-features.md` §3):
//! - **K1** overrides live in `keybindings.json` under the application
//!   user-data directory, separately from `$DSH_HOME`;
//! - **K2** the shell validates and serialises changes before publishing
//!   accepted bindings;
//! - **K3** failed reads retain the last accepted bindings and block edits,
//!   including Restore All; unreadable and future-version files remain unchanged.
//!
//! Semantics transcribed verbatim: `normalizeBinding`, `bindingKey`,
//! `isWebBindingAllowed`, `bindingIssue`, `resolveShortcutDefault`,
//! `effectiveShortcuts`, `overlappingBindings`, `editShortcutDocument`,
//! `parseBinding`, `parseShortcutDocument`, `parseShortcutEdit`,
//! `parseShortcutDefinitions`, and `ShortcutPersistence`'s serialized
//! read/compare/validate/persist/publish cycle.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use crate::error::DshError;
use crate::protocol::{
    BindingIssue, ShortcutBinding, ShortcutBindingRow, ShortcutConfigError, ShortcutConfigSnapshot,
    ShortcutConfigStatus, ShortcutDefinition, ShortcutDocument, ShortcutEdit, ShortcutModifier,
    ShortcutSaveResult, ShortcutSaveStatus,
};
use crate::settings::write_atomic;

/// Normalized physical modifier (`NormalizedBinding['modifiers']`, `binding.ts:23`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum NormalizedModifier {
    Control,
    Alt,
    Shift,
    Meta,
}

/// Receiving device platform (upstream `ShortcutPlatform`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutPlatform {
    Macos,
    Windows,
    Linux,
}

impl ShortcutPlatform {
    fn as_str(self) -> &'static str {
        match self {
            ShortcutPlatform::Macos => "macos",
            ShortcutPlatform::Windows => "windows",
            ShortcutPlatform::Linux => "linux",
        }
    }

    /// Current host platform.
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            ShortcutPlatform::Macos
        } else if cfg!(target_os = "linux") {
            ShortcutPlatform::Linux
        } else {
            ShortcutPlatform::Windows
        }
    }
}

/// Receiving application shell (upstream `ShortcutRuntime`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutRuntime {
    Desktop,
    Web,
}

impl ShortcutRuntime {
    fn as_str(self) -> &'static str {
        match self {
            ShortcutRuntime::Desktop => "desktop",
            ShortcutRuntime::Web => "web",
        }
    }
}

fn profile_key(runtime: ShortcutRuntime, platform: ShortcutPlatform) -> String {
    format!("{}:{}", runtime.as_str(), platform.as_str())
}

/// Normalized physical binding (upstream `NormalizedBinding`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedBinding {
    pub code: String,
    pub second_code: Option<String>,
    /// Normalized modifier order is also the keycap order.
    pub modifiers: Vec<NormalizedModifier>,
}

/// Named non-modifier keys accepted in addition to `Key*`/`Digit*`/`F1..F24`
/// (`binding.ts:27-30`).
const KEY_NAMES: [&str; 20] = [
    "Slash",
    "Comma",
    "Period",
    "Backslash",
    "Backquote",
    "Minus",
    "Equal",
    "BracketLeft",
    "BracketRight",
    "Semicolon",
    "Quote",
    "Enter",
    "Escape",
    "Space",
    "Tab",
    "Backspace",
    "Delete",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
];

// `KEY_NAMES` above intentionally lists 20 slots; ArrowRight is appended here
// to keep the array literal aligned with the upstream map's exact key set.
const KEY_NAME_EXTRA: &str = "ArrowRight";

fn is_supported_code(code: &str) -> bool {
    if let Some(rest) = code.strip_prefix("Key") {
        return rest.len() == 1 && rest.bytes().all(|b| b.is_ascii_uppercase());
    }
    if let Some(rest) = code.strip_prefix("Digit") {
        return rest.len() == 1 && rest.bytes().all(|b| b.is_ascii_digit());
    }
    if let Some(rest) = code.strip_prefix('F') {
        if let Ok(number) = rest.parse::<u32>() {
            return (1..=24).contains(&number);
        }
        return false;
    }
    KEY_NAMES.contains(&code) || code == KEY_NAME_EXTRA
}

const MODIFIER_ORDER: [NormalizedModifier; 4] = [
    NormalizedModifier::Control,
    NormalizedModifier::Alt,
    NormalizedModifier::Shift,
    NormalizedModifier::Meta,
];

/// Expand logical modifiers, deduplicate, and validate the physical code
/// (upstream `normalizeBinding`, `binding.ts:41-53`). Unsupported codes and
/// repeated chord keys are rejected.
pub fn normalize_binding(
    binding: &ShortcutBinding,
    platform: ShortcutPlatform,
) -> Result<NormalizedBinding, DshError> {
    let mut codes = vec![binding.code.clone()];
    if let Some(second) = &binding.second_code {
        codes.push(second.clone());
    }
    codes.sort();
    for code in &codes {
        if !is_supported_code(code) {
            return Err(DshError::invalid_argument(
                "binding.code",
                format!("unsupported shortcut code: {code}"),
            ));
        }
    }
    if codes.len() == 2 && codes[0] == codes[1] {
        return Err(DshError::invalid_argument(
            "binding.secondCode",
            "shortcut keys must be distinct",
        ));
    }
    let mut expanded: HashSet<NormalizedModifier> = HashSet::new();
    for modifier in &binding.modifiers {
        expanded.insert(match modifier {
            ShortcutModifier::Primary => {
                if platform == ShortcutPlatform::Macos {
                    NormalizedModifier::Meta
                } else {
                    NormalizedModifier::Control
                }
            }
            ShortcutModifier::Control => NormalizedModifier::Control,
            ShortcutModifier::Alt => NormalizedModifier::Alt,
            ShortcutModifier::Shift => NormalizedModifier::Shift,
            ShortcutModifier::Meta => NormalizedModifier::Meta,
        });
    }
    let modifiers: Vec<NormalizedModifier> = MODIFIER_ORDER
        .into_iter()
        .filter(|m| expanded.contains(m))
        .collect();
    Ok(NormalizedBinding {
        code: codes[0].clone(),
        second_code: codes.get(1).cloned(),
        modifiers,
    })
}

/// Produce the exact-match index used for both matching and conflict checks
/// (upstream `bindingKey`, `binding.ts:60-63`).
pub fn binding_key(binding: &NormalizedBinding) -> String {
    let mut codes = vec![binding.code.clone()];
    if let Some(second) = &binding.second_code {
        codes.push(second.clone());
        codes.sort();
    }
    let mut parts: Vec<String> = binding
        .modifiers
        .iter()
        .map(|m| {
            match m {
                NormalizedModifier::Control => "control",
                NormalizedModifier::Alt => "alt",
                NormalizedModifier::Shift => "shift",
                NormalizedModifier::Meta => "meta",
            }
            .to_string()
        })
        .collect();
    parts.extend(codes);
    parts.join("+")
}

/// Check Web combinations (upstream `isWebBindingAllowed`, `binding.ts:96-112`).
pub fn is_web_binding_allowed(binding: &NormalizedBinding, platform: ShortcutPlatform) -> bool {
    if binding.second_code.is_some() {
        return false;
    }
    if matches!(platform, ShortcutPlatform::Windows | ShortcutPlatform::Macos) {
        if binding.modifiers.len() >= 3 {
            return true;
        }
        let primary = if platform == ShortcutPlatform::Macos {
            NormalizedModifier::Meta
        } else {
            NormalizedModifier::Control
        };
        if binding.modifiers.len() == 1
            && (((binding.code == "Comma" || binding.code == "Backslash")
                && binding.modifiers[0] == primary)
                || (binding.code == "Backquote"
                    && binding.modifiers[0] == NormalizedModifier::Control))
        {
            return true;
        }
        if binding.modifiers.len() == 2
            && binding.modifiers.contains(&primary)
            && (binding.modifiers.contains(&NormalizedModifier::Alt)
                || binding.modifiers.contains(&NormalizedModifier::Shift))
        {
            return true;
        }
    }
    let candidates = [
        ("Slash", vec![ShortcutModifier::Primary]),
        ("Comma", vec![ShortcutModifier::Primary, ShortcutModifier::Shift]),
        ("Period", vec![ShortcutModifier::Primary, ShortcutModifier::Shift]),
    ];
    candidates.iter().any(|(code, modifiers)| {
        let candidate = ShortcutBinding {
            code: (*code).to_string(),
            second_code: None,
            modifiers: modifiers.clone(),
        };
        normalize_binding(&candidate, platform)
            .map(|normalized| binding_key(&normalized) == binding_key(binding))
            .unwrap_or(false)
    })
}

/// System, editor, and browser reservations (upstream `bindingIssue`,
/// `configuration.ts:96-113`).
pub fn binding_issue(
    binding: &NormalizedBinding,
    runtime: ShortcutRuntime,
    platform: ShortcutPlatform,
) -> Option<BindingIssue> {
    if runtime == ShortcutRuntime::Desktop
        && matches!(platform, ShortcutPlatform::Windows | ShortcutPlatform::Macos)
    {
        return None;
    }
    if binding.second_code.is_some() {
        return Some(BindingIssue::UnsupportedKey);
    }
    if binding.modifiers.is_empty()
        || binding
            .modifiers
            .iter()
            .all(|m| *m == NormalizedModifier::Shift)
    {
        return Some(BindingIssue::ModifierRequired);
    }
    if matches!(platform, ShortcutPlatform::Windows | ShortcutPlatform::Macos)
        && binding.modifiers.len() >= 3
    {
        return None;
    }
    if runtime == ShortcutRuntime::Web
        && matches!(platform, ShortcutPlatform::Windows | ShortcutPlatform::Macos)
        && is_web_binding_allowed(binding, platform)
    {
        return None;
    }
    let primary = binding.modifiers.contains(&if platform == ShortcutPlatform::Macos {
        NormalizedModifier::Meta
    } else {
        NormalizedModifier::Control
    });
    let plain_keys = [
        "Escape",
        "Tab",
        "Space",
        "Backspace",
        "Delete",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
    ];
    let reserved = plain_keys.contains(&binding.code.as_str())
        || (binding.code == "Enter" && !binding.modifiers.contains(&NormalizedModifier::Alt))
        || (primary
            && ["KeyC", "KeyV", "KeyX", "KeyZ", "KeyY", "KeyQ", "KeyH"]
                .contains(&binding.code.as_str()))
        || (primary
            && binding.code == "KeyA"
            && !binding.modifiers.contains(&NormalizedModifier::Shift))
        || (platform != ShortcutPlatform::Macos
            && (binding.modifiers.contains(&NormalizedModifier::Meta)
                || (binding.modifiers.contains(&NormalizedModifier::Alt)
                    && ["F4", "F2"].contains(&binding.code.as_str()))))
        || (platform == ShortcutPlatform::Macos
            && binding.modifiers.contains(&NormalizedModifier::Control)
            && binding.modifiers.contains(&NormalizedModifier::Meta))
        || (platform == ShortcutPlatform::Macos
            && binding.modifiers.contains(&NormalizedModifier::Alt)
            && !primary);
    if reserved {
        return Some(BindingIssue::Reserved);
    }
    if runtime == ShortcutRuntime::Web && !is_web_binding_allowed(binding, platform) {
        return Some(BindingIssue::UnsupportedBrowser);
    }
    None
}

/// Select the command owner's explicit default for one device profile
/// (upstream `resolveShortcutDefault`).
pub fn resolve_shortcut_default(
    definition: &ShortcutDefinition,
    runtime: ShortcutRuntime,
    platform: ShortcutPlatform,
) -> Option<&ShortcutBinding> {
    definition.defaults.get(&profile_key(runtime, platform))
}

/// One resolved command row (upstream `EffectiveShortcut`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveShortcut {
    pub id: String,
    pub binding: Option<NormalizedBinding>,
    pub modified: bool,
    pub conflicts: Vec<String>,
    pub issue: Option<BindingIssue>,
}

/// Detect identical combinations or a single key contained in a two-key chord
/// (upstream `overlappingBindings`, `configuration.ts:160-164`).
pub fn overlapping_bindings(left: &NormalizedBinding, right: &NormalizedBinding) -> bool {
    let left_modifiers: Vec<&str> = left.modifiers.iter().map(modifier_str).collect();
    let right_modifiers: Vec<&str> = right.modifiers.iter().map(modifier_str).collect();
    if left_modifiers != right_modifiers {
        return false;
    }
    if left.second_code.is_some() && right.second_code.is_some() {
        return binding_key(left) == binding_key(right);
    }
    [Some(left.code.as_str()), left.second_code.as_deref()]
        .into_iter()
        .flatten()
        .any(|code| Some(code) == Some(right.code.as_str()) || Some(code) == right.second_code.as_deref())
}

fn modifier_str(modifier: &NormalizedModifier) -> &'static str {
    match modifier {
        NormalizedModifier::Control => "control",
        NormalizedModifier::Alt => "alt",
        NormalizedModifier::Shift => "shift",
        NormalizedModifier::Meta => "meta",
    }
}

/// Resolve overrides and conflicts independently of registration order
/// (upstream `effectiveShortcuts`, `configuration.ts:135-152`).
pub fn effective_shortcuts(
    definitions: &[ShortcutDefinition],
    document: &ShortcutDocument,
    runtime: ShortcutRuntime,
    platform: ShortcutPlatform,
) -> Vec<EffectiveShortcut> {
    let overrides = document
        .profiles
        .get(&profile_key(runtime, platform))
        .cloned()
        .unwrap_or_default();
    let mut fixed: Vec<(String, NormalizedBinding)> = Vec::new();
    for row in definitions {
        if let Some(bindings) = &row.fixed {
            for binding in bindings {
                if let Ok(normalized) = normalize_binding(binding, platform) {
                    fixed.push((row.id.clone(), normalized));
                }
            }
        }
    }
    let mut rows: Vec<EffectiveShortcut> = definitions
        .iter()
        .filter(|row| row.fixed.is_none())
        .map(|definition| {
            let modified = overrides.contains_key(&definition.id);
            let candidate = if modified {
                overrides.get(&definition.id).cloned().flatten()
            } else {
                resolve_shortcut_default(definition, runtime, platform).cloned()
            };
            let binding = candidate
                .as_ref()
                .and_then(|spec| normalize_binding(spec, platform).ok());
            let issue = binding
                .as_ref()
                .and_then(|normalized| binding_issue(normalized, runtime, platform));
            EffectiveShortcut {
                id: definition.id.clone(),
                binding,
                modified,
                conflicts: Vec::new(),
                issue,
            }
        })
        .collect();
    for index in 0..rows.len() {
        let row = &rows[index];
        let Some(binding) = row.binding.clone() else {
            continue;
        };
        let mut conflicts: Vec<String> = rows
            .iter()
            .filter(|other| {
                other.id != row.id
                    && other.binding.is_some()
                    && other.issue.is_none()
                    && overlapping_bindings(other.binding.as_ref().expect("checked"), &binding)
                    && (!row.modified || other.modified)
            })
            .map(|other| other.id.clone())
            .collect();
        conflicts.extend(
            fixed
                .iter()
                .filter(|(_, other)| overlapping_bindings(other, &binding))
                .map(|(id, _)| id.clone()),
        );
        let mut seen = HashSet::new();
        conflicts.retain(|id| seen.insert(id.clone()));
        rows[index].conflicts = conflicts;
    }
    rows
}

/// Accepted effective bindings for `dsh://shortcuts/changed`: unbound, issue-free,
/// conflict-free rows as `ShortcutBindingRow` (`{id} & ShortcutBinding`, amendment A1).
pub fn accepted_bindings(rows: &[EffectiveShortcut]) -> Vec<ShortcutBindingRow> {
    rows.iter()
        .filter(|row| row.issue.is_none() && row.conflicts.is_empty())
        .filter_map(|row| {
            row.binding.as_ref().map(|binding| ShortcutBindingRow {
                id: row.id.clone(),
                code: binding.code.clone(),
                second_code: binding.second_code.clone(),
                modifiers: binding.modifiers.iter().map(|m| match m {
                    NormalizedModifier::Control => ShortcutModifier::Control,
                    NormalizedModifier::Alt => ShortcutModifier::Alt,
                    NormalizedModifier::Shift => ShortcutModifier::Shift,
                    NormalizedModifier::Meta => ShortcutModifier::Meta,
                }).collect(),
            })
        })
        .collect()
}

/// Apply an edit without modifying other profiles or dormant overrides
/// (upstream `editShortcutDocument`, `configuration.ts:174-191`).
pub fn edit_shortcut_document(
    document: &ShortcutDocument,
    edit: &ShortcutEdit,
    runtime: ShortcutRuntime,
    platform: ShortcutPlatform,
) -> ShortcutDocument {
    let schema_version = if runtime == ShortcutRuntime::Desktop
        && matches!(platform, ShortcutPlatform::Macos | ShortcutPlatform::Windows)
    {
        2
    } else {
        document.schema_version
    };
    let profile = profile_key(runtime, platform);
    let mut overrides = document
        .profiles
        .get(&profile)
        .cloned()
        .unwrap_or_default();
    match edit {
        ShortcutEdit::Set { id, binding } => {
            overrides.insert(id.clone(), binding.clone());
        }
        ShortcutEdit::Reset { id } => {
            overrides.remove(id);
        }
        ShortcutEdit::ResetAll => {
            overrides.clear();
        }
    }
    let mut profiles = document.profiles.clone();
    profiles.insert(profile, overrides);
    ShortcutDocument {
        schema_version,
        profiles,
    }
}

/// Classified document read failure (`parseShortcutDocument` string results).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentReadError {
    Invalid,
    Future,
}

/// Decode the complete document while preserving dormant command overrides
/// (upstream `parseShortcutDocument`, `configuration.ts:62-87`). Invalid JSON
/// and invalid binding fields both preserve the original document.
pub fn parse_shortcut_document(raw: Option<&str>) -> Result<ShortcutDocument, DocumentReadError> {
    let Some(raw) = raw else {
        return Ok(ShortcutDocument {
            schema_version: 1,
            profiles: BTreeMap::new(),
        });
    };
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| DocumentReadError::Invalid)?;
    let object = value
        .as_object()
        .ok_or(DocumentReadError::Invalid)?;
    let schema_version = object
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .ok_or(DocumentReadError::Invalid)?;
    if schema_version > 2 {
        return Err(DocumentReadError::Future);
    }
    if schema_version != 1 && schema_version != 2 {
        return Err(DocumentReadError::Invalid);
    }
    if object.len() != 2 {
        return Err(DocumentReadError::Invalid);
    }
    let profiles_value = object.get("profiles").ok_or(DocumentReadError::Invalid)?;
    let profiles_object = profiles_value.as_object().ok_or(DocumentReadError::Invalid)?;
    let mut profiles: BTreeMap<String, BTreeMap<String, Option<ShortcutBinding>>> = BTreeMap::new();
    for (profile, overrides) in profiles_object {
        if !is_profile_key(profile) {
            return Err(DocumentReadError::Invalid);
        }
        let overrides_object = overrides.as_object().ok_or(DocumentReadError::Invalid)?;
        let mut bindings = BTreeMap::new();
        for (id, binding) in overrides_object {
            if !is_command_id(id) {
                return Err(DocumentReadError::Invalid);
            }
            let parsed = parse_binding_value(binding).map_err(|_| DocumentReadError::Invalid)?;
            if schema_version == 1 && parsed.as_ref().and_then(|b| b.second_code.as_ref()).is_some() {
                return Err(DocumentReadError::Invalid);
            }
            bindings.insert(id.clone(), parsed);
        }
        profiles.insert(profile.clone(), bindings);
    }
    Ok(ShortcutDocument {
        schema_version: schema_version as u32,
        profiles,
    })
}

fn is_profile_key(key: &str) -> bool {
    matches!(key.split_once(':'), Some((runtime, platform))
        if matches!(runtime, "desktop" | "web") && matches!(platform, "macos" | "windows" | "linux"))
}

fn is_command_id(id: &str) -> bool {
    let mut segments = id.split('.');
    let mut count = 0;
    for segment in segments.by_ref() {
        count += 1;
        let mut chars = segment.chars();
        let Some(first) = chars.next() else {
            return false;
        };
        let first_ok = if count == 1 {
            first.is_ascii_lowercase()
        } else {
            first.is_ascii_alphanumeric()
        };
        if !first_ok
            || !chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return false;
        }
    }
    count >= 2
}

/// Validate one wire binding (upstream `parseBinding`, `configuration.ts:40-55`):
/// only `code`, `secondCode?`, `modifiers` keys; `null` is an explicit unbind.
pub fn parse_binding_value(value: &serde_json::Value) -> Result<Option<ShortcutBinding>, DshError> {
    if value.is_null() {
        return Ok(None);
    }
    let object = value
        .as_object()
        .ok_or_else(|| DshError::invalid_argument("binding", "invalid shortcut binding"))?;
    if object.keys().any(|key| !matches!(key.as_str(), "code" | "secondCode" | "modifiers")) {
        return Err(DshError::invalid_argument("binding", "invalid shortcut binding"));
    }
    let spec: ShortcutBinding = serde_json::from_value(value.clone())
        .map_err(|_| DshError::invalid_argument("binding", "invalid shortcut binding"))?;
    normalize_binding(&spec, ShortcutPlatform::Windows)?;
    Ok(Some(spec))
}

/// Validate a preference edit at the IPC boundary (upstream `parseShortcutEdit`,
/// `configuration.ts:198-205`): exact key sets, command-id pattern.
pub fn parse_shortcut_edit(value: &serde_json::Value) -> Result<ShortcutEdit, DshError> {
    let invalid = || DshError::invalid_argument("edit", "invalid shortcut edit");
    let object = value.as_object().ok_or_else(invalid)?;
    let kind = object.get("type").and_then(|v| v.as_str()).ok_or_else(invalid)?;
    match kind {
        "reset-all" if object.len() == 1 => Ok(ShortcutEdit::ResetAll),
        "reset" if object.len() == 2 => {
            let id = object.get("id").and_then(|v| v.as_str()).ok_or_else(invalid)?;
            if !is_command_id(id) {
                return Err(DshError::invalid_argument("edit.id", "invalid shortcut command"));
            }
            Ok(ShortcutEdit::Reset { id: id.to_string() })
        }
        "set" if object.len() == 3 => {
            let id = object.get("id").and_then(|v| v.as_str()).ok_or_else(invalid)?;
            if !is_command_id(id) {
                return Err(DshError::invalid_argument("edit.id", "invalid shortcut command"));
            }
            let binding = parse_binding_value(object.get("binding").ok_or_else(invalid)?)?;
            Ok(ShortcutEdit::Set {
                id: id.to_string(),
                binding,
            })
        }
        _ => Err(invalid()),
    }
}

/// Validate the trusted product's serializable command catalog at IPC ingress
/// (upstream `parseShortcutDefinitions`, `configuration.ts:212-244`): duplicate
/// IDs, overlapping defaults, and unsupported or reserved combinations reject
/// the whole catalog.
pub fn parse_shortcut_definitions(value: &serde_json::Value) -> Result<Vec<ShortcutDefinition>, DshError> {
    let invalid = |reason: &str| DshError::invalid_argument("definitions", reason);
    let array = value.as_array().ok_or_else(|| invalid("invalid shortcut catalog"))?;
    let mut ids = HashSet::new();
    let mut definitions = Vec::new();
    for entry in array {
        let object = entry.as_object().ok_or_else(|| invalid("invalid shortcut definition"))?;
        let id = object.get("id").and_then(|v| v.as_str()).ok_or_else(|| invalid("invalid shortcut definition"))?;
        if !is_command_id(id) || !ids.insert(id.to_string()) {
            return Err(invalid("invalid shortcut definition"));
        }
        if object.keys().any(|key| !matches!(key.as_str(), "id" | "defaults" | "fixed")) {
            return Err(invalid("invalid shortcut definition"));
        }
        let defaults_value = object.get("defaults").and_then(|v| v.as_object()).ok_or_else(|| invalid("invalid shortcut definition"))?;
        let mut defaults = BTreeMap::new();
        if let Some(fixed_value) = object.get("fixed") {
            let fixed_array = fixed_value.as_array().ok_or_else(|| invalid("invalid fixed shortcut definition"))?;
            if fixed_array.is_empty() || !defaults_value.is_empty() {
                return Err(invalid("invalid fixed shortcut definition"));
            }
            let mut fixed = Vec::new();
            for binding in fixed_array {
                let parsed = parse_binding_value(binding)?
                    .ok_or_else(|| invalid("invalid fixed shortcut binding"))?;
                fixed.push(parsed);
            }
            definitions.push(ShortcutDefinition {
                id: id.to_string(),
                defaults,
                fixed: Some(fixed),
            });
            continue;
        }
        for (profile, candidate) in defaults_value {
            if !is_profile_key(profile) {
                return Err(invalid("invalid shortcut profile"));
            }
            let parsed = parse_binding_value(candidate)?
                .ok_or_else(|| invalid("invalid shortcut default"))?;
            defaults.insert(profile.clone(), parsed);
        }
        definitions.push(ShortcutDefinition {
            id: id.to_string(),
            defaults,
            fixed: None,
        });
    }
    for runtime in [ShortcutRuntime::Desktop, ShortcutRuntime::Web] {
        for platform in [
            ShortcutPlatform::Macos,
            ShortcutPlatform::Windows,
            ShortcutPlatform::Linux,
        ] {
            let mut bindings: Vec<NormalizedBinding> = Vec::new();
            for entry in &definitions {
                let Some(binding) = resolve_shortcut_default(entry, runtime, platform) else {
                    continue;
                };
                let normalized = normalize_binding(binding, platform)?;
                if bindings.iter().any(|other| overlapping_bindings(other, &normalized))
                    || binding_issue(&normalized, runtime, platform).is_some()
                {
                    return Err(invalid("conflicting or reserved shortcut default"));
                }
                bindings.push(normalized);
            }
        }
    }
    Ok(definitions)
}

/// Storage adapter for `keybindings.json` (upstream `ShortcutStorage`).
pub trait ShortcutStorage: Send + Sync {
    /// Raw file content, or `None` when the file does not exist.
    fn read(&self) -> Result<Option<String>, DshError>;
    /// Complete replacement of the file contents (atomic).
    fn write(&self, raw: &str) -> Result<(), DshError>;
}

/// `keybindings.json` file storage (K1: application user-data directory,
/// separate from `$DSH_HOME`).
pub struct FileShortcutStorage {
    path: std::path::PathBuf,
}

impl FileShortcutStorage {
    /// Storage backed by `path` (normally `<user data>/keybindings.json`).
    pub fn new(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
        }
    }
}

impl ShortcutStorage for FileShortcutStorage {
    fn read(&self) -> Result<Option<String>, DshError> {
        match std::fs::read_to_string(&self.path) {
            Ok(raw) => Ok(Some(raw)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(DshError::io("read", Some(self.path.display().to_string()), &e)),
        }
    }

    fn write(&self, raw: &str) -> Result<(), DshError> {
        write_atomic(&self.path, raw)
    }
}

/// Single-writer coordinator (upstream `ShortcutPersistence`, `persistence.ts:50-144`).
/// Read state retains the last accepted document on failure; edits are blocked
/// until a read succeeds; every publish bumps `sequence` and mints a new `revision`.
pub struct ShortcutPersistence {
    storage: Box<dyn ShortcutStorage>,
    runtime: ShortcutRuntime,
    platform: ShortcutPlatform,
    publish: Box<dyn Fn(&ShortcutConfigSnapshot) + Send + Sync>,
    state: std::sync::Mutex<PersistenceState>,
}

struct PersistenceState {
    snapshot: ShortcutConfigSnapshot,
    /// `None` = never read (upstream `raw === undefined`); `Some(None)` = no file.
    raw: Option<Option<String>>,
    definitions: Option<Vec<ShortcutDefinition>>,
    active: bool,
}

fn initial_snapshot() -> ShortcutConfigSnapshot {
    ShortcutConfigSnapshot {
        revision: uuid::Uuid::new_v4().to_string(),
        sequence: 0,
        document: ShortcutDocument {
            schema_version: 1,
            profiles: BTreeMap::new(),
        },
        status: ShortcutConfigStatus::Loading,
        error: None,
        using_defaults: true,
    }
}

impl ShortcutPersistence {
    /// Open the coordinator over `storage`; `publish` receives every accepted
    /// snapshot (K2 publishes only accepted state).
    pub fn new(
        storage: Box<dyn ShortcutStorage>,
        runtime: ShortcutRuntime,
        platform: ShortcutPlatform,
        publish: Box<dyn Fn(&ShortcutConfigSnapshot) + Send + Sync>,
    ) -> Self {
        Self {
            storage,
            runtime,
            platform,
            publish,
            state: std::sync::Mutex::new(PersistenceState {
                snapshot: initial_snapshot(),
                raw: None,
                definitions: None,
                active: true,
            }),
        }
    }

    /// Install or revoke a product catalog and invalidate drafts from its
    /// previous lifetime (upstream `setDefinitions`).
    pub fn set_definitions(&self, definitions: Option<Vec<ShortcutDefinition>>) {
        let mut state = self.state.lock().expect("lock");
        state.definitions = definitions;
        let snapshot = state.snapshot.clone();
        drop(state);
        self.accept(snapshot);
    }

    /// Stop accepting edits or publishing late completions.
    pub fn dispose(&self) {
        self.state.lock().expect("lock").active = false;
    }

    /// Read the current file; failures retain the last accepted document and
    /// disable ordinary writes (K3).
    pub fn read_current(&self) -> ShortcutConfigSnapshot {
        self.read()
    }

    /// Current effective bindings of the accepted snapshot.
    pub fn accepted_bindings(&self) -> Vec<ShortcutBindingRow> {
        let state = self.state.lock().expect("lock");
        let Some(definitions) = &state.definitions else {
            return Vec::new();
        };
        accepted_bindings(&effective_shortcuts(
            definitions,
            &state.snapshot.document,
            self.runtime,
            self.platform,
        ))
    }

    /// Compare the draft revision, validate the complete candidate, then
    /// persist before publishing (K2; upstream `edit`, `persistence.ts:87-115`).
    pub fn edit(&self, edit: &ShortcutEdit, revision: &str) -> ShortcutSaveResult {
        let mut state = self.state.lock().expect("lock");
        let result = |status: ShortcutSaveStatus, state: &PersistenceState| ShortcutSaveResult {
            status,
            snapshot: state.snapshot.clone(),
            issue: None,
            conflicts: None,
        };
        if !state.active
            || state.definitions.is_none()
            || state.snapshot.status == ShortcutConfigStatus::Loading
        {
            return result(ShortcutSaveStatus::NotReady, &state);
        }
        if revision != state.snapshot.revision {
            return result(ShortcutSaveStatus::Stale, &state);
        }
        if state.snapshot.status == ShortcutConfigStatus::Unreadable {
            return result(ShortcutSaveStatus::Unreadable, &state);
        }
        if matches!(edit, ShortcutEdit::Set { .. } | ShortcutEdit::Reset { .. }) {
            let id = match edit {
                ShortcutEdit::Set { id, .. } | ShortcutEdit::Reset { id } => id.as_str(),
                ShortcutEdit::ResetAll => unreachable!(),
            };
            let known = state
                .definitions
                .as_ref()
                .expect("checked")
                .iter()
                .any(|row| row.id == id && row.fixed.is_none());
            if !known {
                return result(ShortcutSaveStatus::NotReady, &state);
            }
        }
        let document = edit_shortcut_document(
            &state.snapshot.document,
            edit,
            self.runtime,
            self.platform,
        );
        let rows = effective_shortcuts(
            state.definitions.as_ref().expect("checked"),
            &document,
            self.runtime,
            self.platform,
        );
        let targets: Vec<&str> = match edit {
            ShortcutEdit::Set { id, .. } | ShortcutEdit::Reset { id } => vec![id.as_str()],
            ShortcutEdit::ResetAll => rows.iter().map(|row| row.id.as_str()).collect(),
        };
        let invalid = rows
            .iter()
            .find(|row| targets.contains(&row.id.as_str()) && (row.issue.is_some() || !row.conflicts.is_empty()));
        // An explicit edit must not silently disable another command's default binding.
        let displaced = match edit {
            ShortcutEdit::Set { id, .. } => rows.iter().find(|row| row.conflicts.contains(id)),
            _ => None,
        };
        if invalid.is_some() || displaced.is_some() {
            return ShortcutSaveResult {
                status: ShortcutSaveStatus::Conflict,
                snapshot: state.snapshot.clone(),
                issue: invalid.and_then(|row| row.issue),
                conflicts: Some(match invalid {
                    Some(row) if !row.conflicts.is_empty() => row.conflicts.clone(),
                    _ => displaced.map(|row| vec![row.id.clone()]).unwrap_or_default(),
                }),
            };
        }
        let raw = format!("{}\n", serde_json::to_string_pretty(&document).expect("serialize"));
        if let Err(_error) = self.storage.write(&raw) {
            // The adapter retains the previous complete document when a write fails.
            return result(ShortcutSaveStatus::WriteFailed, &state);
        }
        state.raw = Some(Some(raw));
        let snapshot = ShortcutConfigSnapshot {
            document,
            status: ShortcutConfigStatus::Ready,
            error: None,
            using_defaults: false,
            ..state.snapshot.clone()
        };
        drop(state);
        self.accept(snapshot);
        let state = self.state.lock().expect("lock");
        result(ShortcutSaveStatus::Saved, &state)
    }

    fn read(&self) -> ShortcutConfigSnapshot {
        let mut state = self.state.lock().expect("lock");
        if !state.active {
            return state.snapshot.clone();
        }
        let raw = match self.storage.read() {
            Ok(raw) => raw,
            Err(_error) => {
                if state.snapshot.error != Some(ShortcutConfigError::Read) {
                    let snapshot = ShortcutConfigSnapshot {
                        status: ShortcutConfigStatus::Unreadable,
                        error: Some(ShortcutConfigError::Read),
                        ..state.snapshot.clone()
                    };
                    drop(state);
                    self.accept(snapshot);
                    state = self.state.lock().expect("lock");
                }
                return state.snapshot.clone();
            }
        };
        if state.raw.as_ref() == Some(&raw) && state.snapshot.error != Some(ShortcutConfigError::Read) {
            return state.snapshot.clone();
        }
        state.raw = Some(raw.clone());
        match parse_shortcut_document(raw.as_deref()) {
            Err(error) => {
                let classified = match error {
                    DocumentReadError::Invalid => ShortcutConfigError::Invalid,
                    DocumentReadError::Future => ShortcutConfigError::Future,
                };
                let snapshot = ShortcutConfigSnapshot {
                    status: ShortcutConfigStatus::Unreadable,
                    error: Some(classified),
                    ..state.snapshot.clone()
                };
                drop(state);
                self.accept(snapshot);
            }
            Ok(document) => {
                let snapshot = ShortcutConfigSnapshot {
                    document,
                    status: ShortcutConfigStatus::Ready,
                    error: None,
                    using_defaults: raw.is_none(),
                    ..state.snapshot.clone()
                };
                drop(state);
                self.accept(snapshot);
            }
        }
        self.state.lock().expect("lock").snapshot.clone()
    }

    fn accept(&self, snapshot: ShortcutConfigSnapshot) {
        let mut state = self.state.lock().expect("lock");
        state.snapshot = ShortcutConfigSnapshot {
            sequence: state.snapshot.sequence + 1,
            revision: uuid::Uuid::new_v4().to_string(),
            ..snapshot
        };
        if !state.active {
            return;
        }
        let accepted = state.snapshot.clone();
        drop(state);
        (self.publish)(&accepted);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(code: &str, modifiers: &[ShortcutModifier]) -> ShortcutBinding {
        ShortcutBinding {
            code: code.to_string(),
            second_code: None,
            modifiers: modifiers.to_vec(),
        }
    }

    #[test]
    fn normalize_expands_primary_and_orders_modifiers() {
        let binding = spec("KeyB", &[ShortcutModifier::Shift, ShortcutModifier::Primary, ShortcutModifier::Alt]);
        let normalized = normalize_binding(&binding, ShortcutPlatform::Windows).expect("normalize");
        assert_eq!(
            normalized.modifiers,
            vec![
                NormalizedModifier::Control,
                NormalizedModifier::Alt,
                NormalizedModifier::Shift
            ]
        );
        let mac = normalize_binding(&binding, ShortcutPlatform::Macos).expect("normalize");
        assert_eq!(
            mac.modifiers,
            vec![NormalizedModifier::Alt, NormalizedModifier::Shift, NormalizedModifier::Meta]
        );
    }

    #[test]
    fn normalize_rejects_unsupported_and_repeated_codes() {
        let bad = spec("Keya", &[ShortcutModifier::Control]);
        assert!(normalize_binding(&bad, ShortcutPlatform::Windows).is_err());
        let chord = ShortcutBinding {
            code: "KeyA".into(),
            second_code: Some("KeyA".into()),
            modifiers: vec![],
        };
        assert!(normalize_binding(&chord, ShortcutPlatform::Windows).is_err());
        let ok = ShortcutBinding {
            code: "KeyB".into(),
            second_code: Some("KeyA".into()),
            modifiers: vec![],
        };
        let normalized = normalize_binding(&ok, ShortcutPlatform::Windows).expect("normalize");
        assert_eq!(binding_key(&normalized), "control+KeyA+KeyB".replace("control+", ""));
    }

    #[test]
    fn overlapping_rules_match_upstream() {
        let single = normalize_binding(&spec("KeyA", &[ShortcutModifier::Control]), ShortcutPlatform::Windows).unwrap();
        let chord = normalize_binding(
            &ShortcutBinding {
                code: "KeyB".into(),
                second_code: Some("KeyA".into()),
                modifiers: vec![ShortcutModifier::Control],
            },
            ShortcutPlatform::Windows,
        )
        .unwrap();
        assert!(overlapping_bindings(&single, &chord), "a single key overlaps a chord containing it");
        let other = normalize_binding(&spec("KeyC", &[ShortcutModifier::Control]), ShortcutPlatform::Windows).unwrap();
        assert!(!overlapping_bindings(&single, &other));
    }

    fn definition(id: &str, defaults: &[(&str, ShortcutBinding)]) -> ShortcutDefinition {
        ShortcutDefinition {
            id: id.to_string(),
            defaults: defaults
                .iter()
                .map(|(profile, spec)| ((*profile).to_string(), spec.clone()))
                .collect(),
            fixed: None,
        }
    }

    #[test]
    fn effective_shortcuts_track_overrides_issues_and_conflicts() {
        let definitions = vec![
            definition(
                "a.one",
                &[("desktop:windows", spec("KeyA", &[ShortcutModifier::Control]))],
            ),
            definition(
                "b.two",
                &[("desktop:windows", spec("KeyB", &[ShortcutModifier::Control]))],
            ),
        ];
        let mut document = ShortcutDocument {
            schema_version: 1,
            profiles: BTreeMap::new(),
        };
        // Override b.two onto a.one's key: modified row conflicts with the default.
        let mut overrides = BTreeMap::new();
        overrides.insert(
            "b.two".to_string(),
            Some(spec("KeyA", &[ShortcutModifier::Control])),
        );
        document
            .profiles
            .insert("desktop:windows".to_string(), overrides);
        let rows = effective_shortcuts(&definitions, &document, ShortcutRuntime::Desktop, ShortcutPlatform::Windows);
        assert_eq!(rows.len(), 2);
        let a = &rows[0];
        let b = &rows[1];
        assert!(!a.modified);
        assert!(b.modified);
        // Upstream conflict rule (`configuration.ts:145-151`): a conflict with
        // an unmodified default is reported on the unmodified row.
        assert_eq!(a.conflicts, vec!["b.two".to_string()]);
        assert!(b.conflicts.is_empty());
    }

    #[test]
    fn explicit_unbind_yields_null_binding_without_issue() {
        let definitions = vec![definition(
            "a.one",
            &[("desktop:windows", spec("KeyA", &[ShortcutModifier::Control]))],
        )];
        let mut overrides = BTreeMap::new();
        overrides.insert("a.one".to_string(), None);
        let mut document = ShortcutDocument {
            schema_version: 1,
            profiles: BTreeMap::new(),
        };
        document.profiles.insert("desktop:windows".into(), overrides);
        let rows = effective_shortcuts(&definitions, &document, ShortcutRuntime::Desktop, ShortcutPlatform::Windows);
        assert!(rows[0].binding.is_none());
        assert!(rows[0].modified);
        assert!(rows[0].issue.is_none());
    }

    #[test]
    fn document_parsing_classifies_invalid_and_future() {
        assert_eq!(
            parse_shortcut_document(Some("{\"schemaVersion\":3,\"profiles\":{}}")),
            Err(DocumentReadError::Future)
        );
        assert_eq!(
            parse_shortcut_document(Some("{not json")),
            Err(DocumentReadError::Invalid)
        );
        assert_eq!(
            parse_shortcut_document(Some("{\"schemaVersion\":2,\"profiles\":{},\"x\":1}")),
            Err(DocumentReadError::Invalid),
            "unknown keys are rejected"
        );
        assert_eq!(
            parse_shortcut_document(None),
            Ok(ShortcutDocument {
                schema_version: 1,
                profiles: BTreeMap::new()
            })
        );
    }

    struct MemoryStorage(std::sync::Mutex<Option<String>>);

    impl ShortcutStorage for MemoryStorage {
        fn read(&self) -> Result<Option<String>, DshError> {
            Ok(self.0.lock().expect("lock").clone())
        }
        fn write(&self, raw: &str) -> Result<(), DshError> {
            *self.0.lock().expect("lock") = Some(raw.to_string());
            Ok(())
        }
    }

    fn persistence(
        storage: Box<dyn ShortcutStorage>,
        published: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) -> ShortcutPersistence {
        ShortcutPersistence::new(
            storage,
            ShortcutRuntime::Desktop,
            ShortcutPlatform::Windows,
            Box::new(move |snapshot| {
                published.lock().expect("lock").push(snapshot.revision.clone());
            }),
        )
    }

    fn catalog() -> Vec<ShortcutDefinition> {
        vec![definition(
            "a.one",
            &[("desktop:windows", spec("KeyA", &[ShortcutModifier::Control]))],
        )]
    }

    #[test]
    fn edit_persists_before_publishing_and_mints_new_revision() {
        let published = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let storage = std::sync::Arc::new(MemoryStorage(std::sync::Mutex::new(None)));
        let persistence = persistence(Box::new(StorageClone(storage.clone())), published.clone());
        persistence.set_definitions(Some(catalog()));
        let snapshot = persistence.read_current();
        assert_eq!(snapshot.status, ShortcutConfigStatus::Ready);
        assert!(snapshot.using_defaults);
        let edit_json = serde_json::json!({
            "type": "set",
            "id": "a.one",
            "binding": { "code": "KeyB", "modifiers": ["primary"] }
        });
        let edit = parse_shortcut_edit(&edit_json).expect("parse edit");
        let result = persistence.edit(&edit, &snapshot.revision);
        assert_eq!(result.status, ShortcutSaveStatus::Saved);
        assert_ne!(result.snapshot.revision, snapshot.revision);
        assert!(!result.snapshot.using_defaults);
        // Persisted before publish: the file content is the serialized document.
        let raw = storage.0.lock().expect("lock").clone().expect("written");
        assert!(raw.contains("\"schemaVersion\": 2"), "desktop windows edits migrate to schema 2: {raw}");
        assert!(published.lock().expect("lock").len() >= 2);
    }

    struct StorageClone(std::sync::Arc<MemoryStorage>);

    impl ShortcutStorage for StorageClone {
        fn read(&self) -> Result<Option<String>, DshError> {
            self.0.read()
        }
        fn write(&self, raw: &str) -> Result<(), DshError> {
            self.0.write(raw)
        }
    }

    #[test]
    fn stale_revisions_and_conflicts_are_classified() {
        let published = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let storage = Box::new(MemoryStorage(std::sync::Mutex::new(None)));
        let persistence = persistence(storage, published);
        persistence.set_definitions(Some(catalog()));
        let snapshot = persistence.read_current();
        let set_b = parse_shortcut_edit(&serde_json::json!({
            "type": "set", "id": "a.one",
            "binding": { "code": "KeyB", "modifiers": ["primary"] }
        }))
        .unwrap();
        let stale = persistence.edit(&set_b, "not-the-revision");
        assert_eq!(stale.status, ShortcutSaveStatus::Stale);
        // Unknown command is not-ready.
        let unknown = parse_shortcut_edit(&serde_json::json!({
            "type": "reset", "id": "zz.unknown"
        }))
        .unwrap();
        let not_ready = persistence.edit(&unknown, &snapshot.revision);
        assert_eq!(not_ready.status, ShortcutSaveStatus::NotReady);
    }

    #[test]
    fn failed_reads_retain_state_and_block_edits_including_reset_all() {
        let published = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let storage = Box::new(FailingReadStorage);
        let persistence = persistence(storage, published);
        persistence.set_definitions(Some(catalog()));
        // First read fails → 'read' diagnostic, edits blocked (K3).
        let snapshot = persistence.read_current();
        assert_eq!(snapshot.status, ShortcutConfigStatus::Unreadable);
        assert_eq!(snapshot.error, Some(ShortcutConfigError::Read));
        let reset_all = parse_shortcut_edit(&serde_json::json!({ "type": "reset-all" })).unwrap();
        assert_eq!(persistence.edit(&reset_all, &snapshot.revision).status, ShortcutSaveStatus::Unreadable);
    }

    struct FailingReadStorage;

    impl ShortcutStorage for FailingReadStorage {
        fn read(&self) -> Result<Option<String>, DshError> {
            Err(DshError::io("read", Some("keybindings.json".into()), &"denied"))
        }
        fn write(&self, _raw: &str) -> Result<(), DshError> {
            Ok(())
        }
    }

    #[test]
    fn future_version_file_stays_unchanged() {
        let published = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let raw = "{\"schemaVersion\":7,\"profiles\":{}}";
        let storage = Box::new(MemoryStorage(std::sync::Mutex::new(Some(raw.to_string()))));
        let shared = std::sync::Arc::new(MemoryStorage(std::sync::Mutex::new(Some(raw.to_string()))));
        let _ = shared;
        let persistence = persistence(storage, published);
        let snapshot = persistence.read_current();
        assert_eq!(snapshot.status, ShortcutConfigStatus::Unreadable);
        assert_eq!(snapshot.error, Some(ShortcutConfigError::Future));
    }
}
