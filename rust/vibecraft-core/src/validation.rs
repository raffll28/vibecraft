//! Input validation and path helpers. Port of `server/validation.ts`.

use std::fmt;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError(pub String);

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ValidationError {}

/// Should a browser `Origin` be allowed (WebSocket and CORS)?
///
/// Allows localhost and 127.0.0.1 on any port and https://vibecraft.sh.
/// The TypeScript version parses with WHATWG `new URL`, which also accepts
/// odd spellings such as `http://127.1` or `http://user@localhost`; this one
/// rejects them. Stricter is the safe direction for an allowlist, and browsers
/// always send origins in canonical form.
pub fn is_origin_allowed(origin: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return false;
    };
    // new URL strips leading/trailing C0 controls and spaces
    let origin = origin.trim_matches(|c: char| c <= ' ');
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    let scheme = scheme.to_ascii_lowercase();
    if scheme.is_empty() || !scheme.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return false;
    }

    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    // Userinfo, percent-encoding, IPv6 and non-ASCII hosts: not a browser origin
    if authority.is_empty()
        || !authority.is_ascii()
        || authority.contains(['@', '%', '[', ']', '\\'])
        || authority.chars().any(|c| c.is_ascii_control() || c == ' ')
    {
        return false;
    }

    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    if let Some(port) = port {
        let valid = port.is_empty()
            || (port.bytes().all(|b| b.is_ascii_digit())
                && port.parse::<u32>().is_ok_and(|p| p <= 65535));
        if !valid {
            return false;
        }
    }
    let host = host.to_ascii_lowercase();

    // file://localhost has an empty hostname in WHATWG URLs
    if (host == "localhost" || host == "127.0.0.1") && scheme != "file" {
        return true;
    }
    host == "vibecraft.sh" && scheme == "https"
}

/// Validate a tmux session name: alphanumerics, underscore and hyphen only
pub fn validate_tmux_session(name: &str) -> Result<&str, ValidationError> {
    if !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        Ok(name)
    } else {
        Err(ValidationError(format!(
            "Invalid tmux session name: {name}"
        )))
    }
}

/// Expand a leading `~` or `~/` to $HOME
pub fn expand_home(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        format!(
            "{}{}",
            std::env::var("HOME").unwrap_or_default(),
            &path[1..]
        )
    } else {
        path.to_string()
    }
}

/// Node's `path.resolve`: absolute and lexically normalized (no symlinks)
pub fn resolve(path: &str) -> PathBuf {
    let base = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let joined = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        base.join(path)
    };
    let mut out = PathBuf::from("/");
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    out
}

/// Validate a directory for use as a tmux session's working directory:
/// it must exist, be a directory, and contain no shell metacharacters.
pub fn validate_directory_path(input: &str) -> Result<PathBuf, ValidationError> {
    let resolved = resolve(&expand_home(input));
    if !resolved.exists() {
        return Err(ValidationError(format!(
            "Directory does not exist: {input}"
        )));
    }
    if !resolved.is_dir() {
        return Err(ValidationError(format!("Path is not a directory: {input}")));
    }
    // JS: /[;&|`$(){}[\]<>\\'"!#*?]/ - even with execFile, tmux hands
    // commands to a shell
    const DANGEROUS: &[char] = &[
        ';', '&', '|', '`', '$', '(', ')', '{', '}', '[', ']', '<', '>', '\\', '\'', '"', '!', '#',
        '*', '?',
    ];
    if resolved.to_string_lossy().contains(DANGEROUS) {
        return Err(ValidationError(format!(
            "Directory path contains invalid characters: {input}"
        )));
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_like_node() {
        assert_eq!(resolve("/a/b/../c/./d/"), PathBuf::from("/a/c/d"));
        assert_eq!(resolve("/.."), PathBuf::from("/"));
        assert_eq!(resolve("/a//b"), PathBuf::from("/a/b"));
    }

    #[test]
    fn stricter_origins_than_whatwg() {
        assert!(!is_origin_allowed(Some("http://127.1")));
        assert!(!is_origin_allowed(Some("http://user@localhost")));
        assert!(!is_origin_allowed(Some("http://local%68ost")));
        assert!(!is_origin_allowed(Some("http://localhost:99999")));
        assert!(!is_origin_allowed(Some("file://localhost")));
        assert!(is_origin_allowed(Some("HTTP://LOCALHOST:4002")));
        assert!(is_origin_allowed(Some("http://localhost:")));
        assert!(is_origin_allowed(Some("https://vibecraft.sh:443/path")));
    }
}
