fn main() {
    // Native library tests now exercise Wry/dialog ownership as well as pure
    // state. They need the same Common Controls v6 activation as the app binary
    // (TaskDialogIndirect is not exported by the unactivated v5 assembly).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
    tauri_build::build()
}
