//! `vibecraft-server setup` / `uninstall`: install the hook binary and
//! register it in Claude Code's settings.
//!
//! The settings file is rewritten with its keys in their original order
//! (serde_json's preserve_order), after a byte-for-byte backup.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::routes::now_ms;
use crate::state::save_json;

/// Claude Code hook events vibecraft listens to
const HOOK_EVENTS: [&str; 9] = [
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SubagentStop",
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "Notification",
    "PreCompact",
];
/// Tool events take a matcher
const TOOL_EVENTS: [&str; 2] = ["PreToolUse", "PostToolUse"];

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn settings_path() -> PathBuf {
    home().join(".claude/settings.json")
}

fn installed_hook_path() -> PathBuf {
    home().join(".vibecraft/hooks/vibecraft-hook")
}

/// Is this hook entry (`{ matcher?, hooks: [{ command }] }`) one of ours?
fn is_vibecraft_entry(entry: &Value) -> bool {
    entry["hooks"].as_array().is_some_and(|hooks| {
        hooks.iter().any(|h| {
            h["command"]
                .as_str()
                .is_some_and(|c| c.contains("vibecraft-hook"))
        })
    })
}

/// Remove vibecraft entries from every event; drop events left empty
fn remove_vibecraft_hooks(settings: &mut Value) -> usize {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return 0;
    };
    let mut removed = 0;
    for entries in hooks.values_mut() {
        if let Some(list) = entries.as_array_mut() {
            let before = list.len();
            list.retain(|e| !is_vibecraft_entry(e));
            removed += before - list.len();
        }
    }
    hooks.retain(|_, entries| entries.as_array().is_none_or(|l| !l.is_empty()));
    removed
}

/// Register the hook for every event, replacing earlier vibecraft entries
pub fn add_vibecraft_hooks(settings: &mut Value, command: &str) {
    remove_vibecraft_hooks(settings);
    if !settings.is_object() {
        *settings = json!({});
    }
    let root = settings.as_object_mut().expect("object");
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    if !hooks.is_object() {
        *hooks = Value::Object(Map::new());
    }
    let hooks = hooks.as_object_mut().expect("object");
    for event in HOOK_EVENTS {
        let mut entry = Map::new();
        if TOOL_EVENTS.contains(&event) {
            entry.insert("matcher".into(), json!("*"));
        }
        entry.insert(
            "hooks".into(),
            json!([{ "type": "command", "command": command, "timeout": 5 }]),
        );
        let list = hooks.entry(event).or_insert_with(|| json!([]));
        if let Some(list) = list.as_array_mut() {
            list.push(Value::Object(entry));
        }
    }
}

fn load_settings(path: &Path) -> Result<Option<Value>, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| {
            format!(
                "{} is not valid JSON ({e}); fix it and try again",
                path.display()
            )
        }),
        Err(_) => Ok(None),
    }
}

fn backup(path: &Path) -> Result<PathBuf, String> {
    let backup = PathBuf::from(format!("{}.backup-{}", path.display(), now_ms()));
    fs::copy(path, &backup).map_err(|e| format!("Failed to back up {}: {e}", path.display()))?;
    Ok(backup)
}

pub fn setup() -> Result<(), String> {
    // The hook binary is built next to this one (rust/target/release/)
    let source = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("vibecraft-hook")))
        .filter(|p| p.exists())
        .ok_or("vibecraft-hook not found next to vibecraft-server; run `cargo build --release` in rust/")?;

    // Copy then rename: overwriting a binary in place fails while a hook runs it
    let target = installed_hook_path();
    let dir = target.parent().expect("has parent");
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    let temp = dir.join(format!("vibecraft-hook.tmp-{}", std::process::id()));
    fs::copy(&source, &temp).map_err(|e| format!("Failed to copy the hook: {e}"))?;
    fs::rename(&temp, &target).map_err(|e| format!("Failed to install the hook: {e}"))?;
    println!("Installed hook: {}", target.display());

    let _ = fs::create_dir_all(home().join(".vibecraft/data"));

    let path = settings_path();
    let mut settings = load_settings(&path)?.unwrap_or_else(|| json!({}));
    if path.exists() {
        println!("Backed up settings: {}", backup(&path)?.display());
    } else if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    add_vibecraft_hooks(&mut settings, &target.to_string_lossy());
    save_json(&path, &settings);
    println!("Updated settings: {}", path.display());
    println!("\nRestart Claude Code sessions for the hooks to take effect.");
    Ok(())
}

pub fn uninstall() -> Result<(), String> {
    let path = settings_path();
    if let Some(mut settings) = load_settings(&path)? {
        let removed = remove_vibecraft_hooks(&mut settings);
        if removed > 0 {
            println!("Backed up settings: {}", backup(&path)?.display());
            if settings["hooks"].as_object().is_some_and(Map::is_empty)
                && let Some(root) = settings.as_object_mut()
            {
                root.remove("hooks");
            }
            save_json(&path, &settings);
            println!("Removed {removed} hook(s) from {}", path.display());
        } else {
            println!("No vibecraft hooks in {}", path.display());
        }
    }
    let hook = installed_hook_path();
    if fs::remove_file(&hook).is_ok() {
        println!("Removed: {}", hook.display());
    }
    println!("Your data in ~/.vibecraft/data was kept.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_old_entries_and_keeps_everything_else_in_order() {
        let mut settings: Value = serde_json::from_str(
            r#"{
                "zeta": 1,
                "hooks": {
                    "PreToolUse": [
                        { "matcher": "Bash", "hooks": [{ "type": "command", "command": "my-linter" }] },
                        { "matcher": "*", "hooks": [{ "type": "command", "command": "/old/vibecraft-hook.sh" }] }
                    ],
                    "Stop": [{ "hooks": [{ "type": "command", "command": "/old/vibecraft-hook.sh" }] }]
                },
                "alpha": 2
            }"#,
        )
        .unwrap();
        add_vibecraft_hooks(&mut settings, "/h/vibecraft-hook");

        let keys: Vec<&String> = settings.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["zeta", "hooks", "alpha"]);
        let pre = settings["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 2);
        assert_eq!(pre[0]["hooks"][0]["command"], "my-linter");
        assert_eq!(pre[1]["matcher"], "*");
        assert_eq!(pre[1]["hooks"][0]["command"], "/h/vibecraft-hook");
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(settings["hooks"]["Stop"][0].get("matcher").is_none());
        assert_eq!(
            settings["hooks"].as_object().unwrap().len(),
            HOOK_EVENTS.len()
        );
    }

    #[test]
    fn removal_keeps_other_hooks_and_drops_empty_events() {
        let mut settings = json!({});
        add_vibecraft_hooks(&mut settings, "/h/vibecraft-hook");
        settings["hooks"]["PreToolUse"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "matcher": "Bash", "hooks": [{ "command": "mine" }] }));
        assert_eq!(remove_vibecraft_hooks(&mut settings), HOOK_EVENTS.len());
        let hooks = settings["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks["PreToolUse"][0]["hooks"][0]["command"], "mine");
    }
}
