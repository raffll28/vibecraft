//! Pure vibecraft server logic:
//!
//! - [`event_store`]: event log with dedupe, tool durations and history
//! - [`validation`]: origin check and path helpers
//!
//! Behavior is pinned by the JSON fixtures in `tests/fixtures/`.

pub mod event_store;
pub mod validation;
