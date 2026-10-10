//! Guest geometry: the renderer rectangle (CSS pixels) translated into the
//! physical pixels a child WebView is placed at, plus visibility.
//!
//! `platformBounds` in `_upstream/apps/desktop/src/platform-view.ts` validates
//! the renderer rectangle (finite, `0..=100_000`, rounded) before allocating a
//! native view; the Sidebar Browser guest is positioned by the layout engine
//! instead. Tauri's child webview positioning *is* host-side
//! (`Webview::set_position` / `set_size`, logical units scaled by the window's
//! scale factor), so this module owns the same validation locally and is the
//! first place a malformed rectangle can be rejected.

use dsh_core::error::DshError;

/// Largest accepted coordinate or extent.
///
/// Upstream's ceiling for one Platform bounds value. Keeping the same number
/// matters: the retained `PlatformOverlay.tsx` measures a real element, so a
/// value above it can only be hostile or broken input.
pub const MAX_COORDINATE: f64 = 100_000.0;

/// A guest rectangle in the owning window's content coordinates (CSS pixels).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GuestBounds {
    /// Left edge in CSS pixels.
    pub x: i32,
    /// Top edge in CSS pixels.
    pub y: i32,
    /// Width in CSS pixels; `0` hides nothing by itself — use
    /// [`GuestBounds::visible`] for that decision.
    pub width: i32,
    /// Height in CSS pixels.
    pub height: i32,
}

impl GuestBounds {
    /// Validate one renderer-supplied rectangle (upstream `platformBounds`).
    ///
    /// Rejects a non-finite value, a negative value and a value above
    /// [`MAX_COORDINATE`] with `DshError::InvalidArgument`; the retained UI
    /// renders `field`/`reason` verbatim, so both name the exact coordinate.
    pub fn parse(value: &serde_json::Value) -> Result<Self, DshError> {
        let object = value.as_object().ok_or_else(|| {
            DshError::invalid_argument(
                "bounds",
                "a bounds object with x, y, width and height is required",
            )
        })?;
        let mut parsed = [0i32; 4];
        for (index, field) in ["x", "y", "width", "height"].into_iter().enumerate() {
            let raw = object.get(field).and_then(serde_json::Value::as_f64);
            let Some(raw) = raw else {
                return Err(DshError::invalid_argument(field, "expected a number"));
            };
            if !raw.is_finite() || !(0.0..=MAX_COORDINATE).contains(&raw) {
                return Err(DshError::invalid_argument(
                    field,
                    format!("expected a finite value between 0 and {MAX_COORDINATE}"),
                ));
            }
            parsed[index] = raw.round() as i32;
        }
        Ok(Self {
            x: parsed[0],
            y: parsed[1],
            width: parsed[2],
            height: parsed[3],
        })
    }

    /// Whether a rectangle can show a document at all.
    ///
    /// A zero-extent rectangle is the ordinary hidden state of a retained
    /// guest (the Sidebar collapses, the Platform overlay unmounts), so it
    /// hides the child instead of destroying it — the retained
    /// `ElectronWebViewImpl` keeps its guest across `detach()` and only
    /// re-creates it on the next physical mount.
    pub fn visible(&self) -> bool {
        self.width > 0 && self.height > 0
    }
}

impl From<GuestBounds> for tauri::LogicalPosition<f64> {
    fn from(bounds: GuestBounds) -> Self {
        Self::new(f64::from(bounds.x), f64::from(bounds.y))
    }
}

impl From<GuestBounds> for tauri::LogicalSize<f64> {
    fn from(bounds: GuestBounds) -> Self {
        Self::new(f64::from(bounds.width), f64::from(bounds.height))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Result<GuestBounds, DshError> {
        GuestBounds::parse(&serde_json::from_str(json).expect("json"))
    }

    #[test]
    fn rounds_fractional_css_pixels() {
        assert_eq!(
            parse(r#"{"x":10.4,"y":0.6,"width":300.5,"height":199.5}"#).expect("valid"),
            GuestBounds {
                x: 10,
                y: 1,
                width: 301,
                height: 200
            }
        );
    }

    #[test]
    fn rejects_missing_non_finite_and_oversized_values() {
        assert!(parse(r#"{"x":0,"y":0,"width":1}"#).is_err());
        assert!(parse(r#"{"x":0,"y":0,"width":1,"height":null}"#).is_err());
        assert!(parse(r#"{"x":-1,"y":0,"width":1,"height":1}"#).is_err());
        assert!(parse(r#"{"x":0,"y":0,"width":1,"height":100001}"#).is_err());
        assert!(parse(r#"{"x":"0","y":0,"width":1,"height":1}"#).is_err());
        assert!(GuestBounds::parse(&serde_json::Value::Null).is_err());
    }

    /// The name of the refused coordinate reaches the UI verbatim.
    #[test]
    fn refusal_names_the_offending_field() {
        let error = parse(r#"{"x":0,"y":0,"width":1,"height":-4}"#).expect_err("invalid");
        match error {
            DshError::InvalidArgument { field, .. } => assert_eq!(field, "height"),
            other => panic!("expected invalid_argument, got {other:?}"),
        }
    }

    #[test]
    fn zero_extent_is_hidden_not_invalid() {
        assert!(!parse(r#"{"x":0,"y":0,"width":0,"height":640}"#)
            .expect("valid")
            .visible());
        assert!(parse(r#"{"x":0,"y":0,"width":320,"height":240}"#)
            .expect("valid")
            .visible());
    }

    #[test]
    fn converts_to_logical_child_webview_units() {
        let bounds = GuestBounds {
            x: 12,
            y: 34,
            width: 560,
            height: 780,
        };
        let position: tauri::LogicalPosition<f64> = bounds.into();
        let size: tauri::LogicalSize<f64> = bounds.into();
        assert_eq!((position.x, position.y), (12.0, 34.0));
        assert_eq!((size.width, size.height), (560.0, 780.0));
    }
}
