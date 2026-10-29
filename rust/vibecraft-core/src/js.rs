//! JavaScript string semantics the ported code depends on.

/// JS regex `\s` (and `String.prototype.trim`): WhiteSpace + LineTerminator.
/// Differs from `char::is_whitespace`, which includes U+0085 and excludes U+FEFF.
pub fn is_space(c: char) -> bool {
    const SPACES: [char; 14] = [
        '\t', '\n', '\u{0B}', '\u{0C}', '\r', ' ', '\u{A0}', '\u{1680}', '\u{2028}', '\u{2029}',
        '\u{202F}', '\u{205F}', '\u{3000}', '\u{FEFF}',
    ];
    SPACES.contains(&c) || ('\u{2000}'..='\u{200A}').contains(&c)
}

/// JS regex `.` without the `s` flag matches anything but line terminators
pub fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// JS regex `\w` (ASCII only)
pub fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `String.prototype.trim`
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// Skip leading JS whitespace
pub fn skip_space(s: &str) -> &str {
    s.trim_start_matches(is_space)
}

/// Case-insensitive prefix match as the `/i` flag does it without `u`: only
/// ASCII letters fold (e.g. the Kelvin sign does not match `k`).
pub fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &s[prefix.len()..])
}

/// Case-insensitive (ASCII) suffix check
pub fn ends_with_ci(s: &str, suffix: &str) -> bool {
    s.len() >= suffix.len()
        && s.as_bytes()[s.len() - suffix.len()..].eq_ignore_ascii_case(suffix.as_bytes())
}

/// Case-insensitive (ASCII) substring search, without allocating.
/// Folding bytes is safe in UTF-8: ASCII bytes never occur inside a
/// multibyte character.
pub fn contains_ci(haystack: &str, needle: &str) -> bool {
    let (h, n) = (haystack.as_bytes(), needle.as_bytes());
    let Some((&first, rest)) = n.split_first() else {
        return true;
    };
    if h.len() < n.len() {
        return false;
    }
    let (lower, upper) = (first.to_ascii_lowercase(), first.to_ascii_uppercase());
    (0..=h.len() - n.len()).any(|i| {
        (h[i] == lower || h[i] == upper) && h[i + 1..i + n.len()].eq_ignore_ascii_case(rest)
    })
}
