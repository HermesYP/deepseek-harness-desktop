//! `dsh-runtime` — the runtime supervisor for the DeepSeek Harness desktop port.
//!
//! Owns the dsh Host process tree end to end: the spawn contract transcribed
//! from upstream `host-process.ts`, the Desktop-Host lifecycle control channel
//! (protocol generation 4 over a local NDJSON socket — the documented transport
//! substitution for Node `process.send`), process-tree containment (Windows Job
//! Object / Unix process group — a deliberate improvement over upstream, which
//! can orphan grandchildren), and the `quit-inspection` / `update-tasks`
//! request/response plumbing with their 2 s / 10 s deadlines.

pub mod control;
pub mod proc_tree;
pub mod quit_inspection;
pub mod supervisor;
pub mod update_tasks;

pub use control::{
    ControlEndpoint, ControlError, ControlLink, ControlServer, HostEvent, PlatformSession,
    ShellMessage, UpdateTasksAction, PROTOCOL_GENERATION,
};
pub use proc_tree::{process_alive, stop_tree, StopOutcome, TreeContainment};
pub use supervisor::{HostFatal, HostReady, PackageManager, SpawnPlan, Supervisor};
