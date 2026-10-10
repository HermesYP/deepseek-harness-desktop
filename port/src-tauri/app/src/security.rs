//! Privileged desktop authority belongs only to the main view of this launch's
//! loopback gateway. Native guest views never inherit the main window's powers.

use dsh_core::error::DshError;
use tauri::{ipc::CapabilityBuilder, Manager};
use url::{Origin, Url};

const MAIN_VIEW: &str = "main";
const BRIDGE_PERMISSIONS: &[&str] = &[
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "bridge",
];

/// Immutable per-launch origin; deliberately stores neither a launch token nor
/// a path/query. The gateway keeps the same port for Host restarts.
#[derive(Clone, Debug)]
pub struct OwnedAppOrigin {
    origin: Origin,
}

impl OwnedAppOrigin {
    pub fn from_gateway_url(url: &Url) -> Result<Self, DshError> {
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || !url.username().is_empty()
            || url.password().is_some()
            || !matches!(url.port_or_known_default(), Some(1..=65535))
        {
            return Err(DshError::other(
                "desktop_origin",
                "The desktop gateway must have an owned HTTP IPv4 loopback origin.",
            ));
        }
        Ok(Self {
            origin: url.origin(),
        })
    }

    pub fn allows_navigation(&self, url: &Url) -> bool {
        url.username().is_empty() && url.password().is_none() && url.origin() == self.origin
    }

    pub fn allows_sender(&self, window: &str, webview: &str, url: &Url) -> bool {
        window == MAIN_VIEW && webview == MAIN_VIEW && self.allows_navigation(url)
    }

    /// Bind permissions to the view, NOT the window: Tauri combines its window
    /// and view selectors with OR, so a window selector would privilege guests.
    pub fn install<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>) -> tauri::Result<()> {
        let mut capability = CapabilityBuilder::new("owned-desktop-gateway")
            .local(false)
            .webview(MAIN_VIEW)
            .remote(format!("{}/*", self.origin.ascii_serialization()));
        for permission in BRIDGE_PERMISSIONS {
            capability = capability.permission(*permission);
        }
        app.add_capability(capability)
    }
}

/// Defense in depth in addition to Tauri's exact-origin capability checks.
/// The framework checks the originating IPC URL; we also reject guest labels,
/// missing ACL decisions and a main view that has navigated off the gateway.
pub fn authorized_invoke<R: tauri::Runtime>(invoke: &tauri::ipc::Invoke<R>) -> bool {
    if invoke.acl.is_none() {
        return false;
    }
    let webview = invoke.message.webview_ref();
    let Some(origin) = webview.try_state::<OwnedAppOrigin>() else {
        return false;
    };
    let Ok(url) = webview.url() else {
        return false;
    };
    origin.allows_sender(webview.window().label(), webview.label(), &url)
}

pub fn install_policy_capability(app: &tauri::AppHandle) -> tauri::Result<()> {
    app.add_capability(
        CapabilityBuilder::new("isolated-mandatory-policy")
            .local(true)
            .webview("mandatory-policy")
            .permission("policy-surface"),
    )
}

pub fn authorized_policy_invoke<R: tauri::Runtime>(invoke: &tauri::ipc::Invoke<R>) -> bool {
    if invoke.acl.is_none()
        || !matches!(
            invoke.message.command(),
            "policy_presented" | "policy_retry" | "policy_update" | "policy_quit"
        )
    {
        return false;
    }
    let webview = invoke.message.webview_ref();
    webview.label() == "mandatory-policy"
        && webview.window().label() == "mandatory-policy"
        && webview
            .url()
            .is_ok_and(|url| crate::native_policy_surface::is_policy_origin(&url))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned() -> OwnedAppOrigin {
        OwnedAppOrigin::from_gateway_url(
            &Url::parse("http://127.0.0.1:31991/?token=secret").unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn accepts_only_the_launched_origin() {
        let origin = owned();
        for url in [
            "http://127.0.0.1:31991/",
            "http://127.0.0.1:31991/session?a=1#part",
        ] {
            assert!(origin.allows_navigation(&Url::parse(url).unwrap()));
        }
        for url in [
            "http://127.0.0.1:31992/",
            "http://127.0.0.1/",
            "https://127.0.0.1:31991/",
            "http://localhost:31991/",
            "http://[::1]:31991/",
            "https://example.com/",
            "file:///C:/tmp/test.html",
            "data:text/html,test",
            "about:blank",
            "http://user@127.0.0.1:31991/",
            "http://user:pass@127.0.0.1:31991/",
        ] {
            assert!(
                !origin.allows_navigation(&Url::parse(url).unwrap()),
                "{url}"
            );
        }
    }

    #[test]
    fn denies_guest_views_even_on_the_owned_origin() {
        let origin = owned();
        let url = Url::parse("http://127.0.0.1:31991/").unwrap();
        assert!(origin.allows_sender("main", "main", &url));
        assert!(!origin.allows_sender("main", "browser-guest", &url));
        assert!(!origin.allows_sender("platform", "main", &url));
        assert!(!origin.allows_sender(
            "main",
            "main",
            &Url::parse("http://127.0.0.1:31992/").unwrap()
        ));
    }

    #[test]
    fn rejects_invalid_gateway_authority() {
        for url in [
            "https://127.0.0.1:31991/",
            "http://localhost:31991/",
            "http://127.0.0.1:0/",
            "http://user:pass@127.0.0.1:31991/",
            "https://example.com/",
        ] {
            assert!(OwnedAppOrigin::from_gateway_url(&Url::parse(url).unwrap()).is_err());
        }
    }

    #[test]
    fn debug_output_does_not_retain_launch_secrets() {
        let debug = format!("{:?}", owned());
        assert!(!debug.contains("secret"));
        assert!(!debug.contains("token="));
    }

    #[test]
    fn static_capability_never_grants_arbitrary_loopback_authority() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(capability.get("remote").is_none());
        assert_eq!(capability["local"], false);
        assert!(capability.get("windows").is_none());
        assert_eq!(capability["webviews"], serde_json::json!(["main"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!(BRIDGE_PERMISSIONS)
        );
        assert!(
            BRIDGE_PERMISSIONS
                .iter()
                .all(|permission| !permission.starts_with("core:window:")
                    && !permission.starts_with("core:webview:")),
            "native effects must use the freshly guarded owned commands"
        );
    }

    #[test]
    fn isolated_policy_inventory_grants_only_the_four_owned_commands() {
        let inventory = include_str!("../permissions/bridge.toml");
        let (_, policy) = inventory
            .split_once("identifier = \"policy-surface\"")
            .unwrap();
        let declaration = policy
            .lines()
            .find(|line| line.starts_with("commands.allow = "))
            .unwrap();
        let commands: Vec<String> =
            serde_json::from_str(declaration.split_once('=').unwrap().1.trim()).unwrap();
        assert_eq!(
            commands,
            [
                "policy_presented",
                "policy_retry",
                "policy_update",
                "policy_quit"
            ]
        );
        let (bridge, _) = inventory
            .split_once("[[permission]]\nidentifier = \"policy-surface\"")
            .unwrap();
        assert!(bridge.contains("\"shell_window_chrome_action\""));
        assert!(bridge.contains("\"shell_window_resize_dragging\""));
        for command in &commands {
            assert!(!bridge.contains(&format!("\"{command}\"")));
        }
    }
}
