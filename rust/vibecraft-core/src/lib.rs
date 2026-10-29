//! Pure vibecraft server logic, ported from the TypeScript server:
//!
//! - [`event_store`]: event log with dedupe, tool durations and history
//!   (`server/eventStore.ts`)
//! - [`tmux_parsing`]: parsers for captured tmux panes (`server/tmuxParsing.ts`)
//! - [`validation`]: input validation (`server/validation.ts`)
//!
//! No I/O beyond what validation needs, and no regex engine: the patterns are
//! small enough to match by hand, following JavaScript regex semantics.
//! Behavior is pinned by the JSON fixtures in `tests/fixtures/`, shared with
//! the TypeScript tests.

pub mod event_store;
pub mod js;
pub mod tmux_parsing;
pub mod validation;
