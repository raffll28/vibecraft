//! Known project directories and path autocomplete. Port of
//! server/ProjectsManager.ts, including Node's path.join/dirname/basename
//! semantics the autocomplete results depend on.

use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use vibecraft_core::validation::resolve;

use crate::routes::now_ms;
use crate::state::{State, save_json};

const AUTOCOMPLETE_LIMIT: usize = 15;

fn str_field<'a>(project: &'a Value, key: &str) -> &'a str {
    project.get(key).and_then(Value::as_str).unwrap_or("")
}

impl State {
    /// Known projects, most recently used first
    pub fn projects_sorted(&self) -> Vec<Value> {
        let mut projects = self.projects.clone();
        let last_used = |p: &Value| p.get("lastUsed").and_then(Value::as_f64).unwrap_or(0.0);
        projects.sort_by(|a, b| last_used(b).total_cmp(&last_used(a)));
        projects
    }

    pub fn add_project(&mut self, path: &str, name: &str) {
        let abs = resolve(path).to_string_lossy().into_owned();
        if let Some(existing) = self
            .projects
            .iter_mut()
            .find(|p| str_field(p, "path") == abs)
        {
            existing["lastUsed"] = json!(now_ms());
            let count = existing
                .get("useCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            existing["useCount"] = json!(count + 1);
            if !name.is_empty() {
                existing["name"] = json!(name);
            }
        } else {
            let name = if name.is_empty() {
                basename(&abs)
            } else {
                name
            };
            self.projects.push(json!({
                "path": abs,
                "name": name,
                "lastUsed": now_ms(),
                "useCount": 1,
            }));
        }
        self.save_projects();
    }

    pub fn remove_project(&mut self, path: &str) {
        let abs = resolve(path).to_string_lossy().into_owned();
        self.projects.retain(|p| str_field(p, "path") != abs);
        self.save_projects();
    }

    fn save_projects(&self) {
        if let Some(dir) = self.config.projects_file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        save_json(
            &self.config.projects_file,
            &json!({ "projects": self.projects }),
        );
    }

    /// Directories matching a partial path: filesystem entries and known projects
    pub fn autocomplete(&self, partial: &str) -> Vec<String> {
        let home = std::env::var("HOME").unwrap_or_default();
        // Concatenate rather than resolve(): resolve(home, '/foo') would drop
        // home, and a trailing / or /. (list hidden entries) must survive
        let normalized = if partial == "~" || partial.starts_with("~/") {
            format!("{home}{}", &partial[1..])
        } else if let Some(rest) = partial.strip_prefix('~') {
            resolve(&format!("{home}/{rest}"))
                .to_string_lossy()
                .into_owned()
        } else {
            partial.to_string()
        };

        let is_browsing = partial.ends_with('/') || partial == "~";
        let is_path_like = partial.starts_with(['/', '~', '.']);

        let mut results: Vec<String> = Vec::new();
        if is_path_like {
            for path in filesystem_autocomplete(&normalized) {
                if !results.contains(&path) {
                    results.push(path);
                }
            }
        }

        let lower = partial.to_lowercase();
        let mut matching: Vec<String> = Vec::new();
        for project in &self.projects {
            let path = str_field(project, "path");
            let hit = path.to_lowercase().contains(&lower)
                || str_field(project, "name").to_lowercase().contains(&lower);
            if hit && !results.iter().chain(&matching).any(|p| p == path) {
                matching.push(path.to_string());
            }
        }

        if is_browsing {
            results.extend(matching);
        } else {
            // Not browsing: known projects first, then filesystem-only results
            results.retain(|r| !self.projects.iter().any(|p| str_field(p, "path") == r));
            matching.extend(results);
            results = matching;
        }
        results.truncate(AUTOCOMPLETE_LIMIT);
        results
    }
}

fn is_dir(path: &str) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_dir())
}

fn entries(dir: &str) -> Vec<String> {
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn filesystem_autocomplete(partial: &str) -> Vec<String> {
    if Path::new(partial).exists() && is_dir(partial) {
        // An existing directory: list its subdirectories (hidden ones only after "/.")
        entries(partial)
            .into_iter()
            .filter(|e| !e.starts_with('.') || partial.ends_with("/."))
            .map(|e| join(partial, &e))
            .filter(|p| is_dir(p))
            .collect()
    } else {
        // Complete the last segment
        let dir = dirname(partial);
        let prefix = basename(partial).to_lowercase();
        if !is_dir(&dir) {
            return Vec::new();
        }
        entries(&dir)
            .into_iter()
            .filter(|e| e.to_lowercase().starts_with(&prefix))
            .map(|e| join(&dir, &e))
            .filter(|p| is_dir(p))
            .collect()
    }
}

/// Node's path.normalize (POSIX)
fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            p => parts.push(p),
        }
    }
    let mut out = parts.join("/");
    if out.is_empty() && !absolute {
        out = ".".to_string();
    }
    if trailing && !out.is_empty() {
        out.push('/');
    }
    if absolute { format!("/{out}") } else { out }
}

/// Node's path.join (POSIX)
fn join(a: &str, b: &str) -> String {
    normalize(&format!("{a}/{b}"))
}

/// Node's path.basename (POSIX)
fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "";
    }
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// Node's path.dirname (POSIX)
fn dirname(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".to_string();
    }
    match trimmed.rfind('/') {
        None => ".".to_string(),
        Some(i) => {
            let dir = trimmed[..i].trim_end_matches('/');
            if dir.is_empty() {
                "/".to_string()
            } else {
                dir.to_string()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_path_semantics() {
        assert_eq!(join("/x/code/.", "alpha"), "/x/code/alpha");
        assert_eq!(join("./", "a"), "a");
        assert_eq!(join("/a/b/", "../c"), "/a/c");
        assert_eq!(normalize("a/../.."), "..");
        assert_eq!(normalize("/../a"), "/a");
        assert_eq!(dirname("/a/b/"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("a"), ".");
        assert_eq!(dirname("/"), "/");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename("/"), "");
    }
}
