//! Shared compile-time boundary for development-only handoff callers.
//!
//! Keep the handoff body inside this macro so both the application callers and
//! the standalone Release regression exercise the same `cfg` expansion.
#[macro_export]
macro_rules! dsh_debug_handoff {
    ($($body:tt)*) => {
        #[cfg(debug_assertions)]
        {
            $($body)*
        }
    };
}