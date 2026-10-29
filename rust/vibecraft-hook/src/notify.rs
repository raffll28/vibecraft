//! POST the event to the vibecraft server - the curl replacement.
//!
//! Plain HTTP/1.1 over TCP (the server is local, so no TLS). The bash hook
//! backgrounded curl; here the request is synchronous but tightly bounded:
//! on loopback it takes well under a millisecond, a stopped server refuses
//! the connection immediately, and a hung one costs at most the timeouts.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
const IO_TIMEOUT: Duration = Duration::from_millis(500);

pub fn post(url: &str, body: &[u8]) {
    let Some((host, port, path)) = parse_http_url(url) else {
        return;
    };
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return;
    };
    // "localhost" may resolve to ::1 first while the server listens on 127.0.0.1
    for addr in addrs {
        if let Ok(stream) = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            let _ = send(stream, host, port, path, body);
            return;
        }
    }
}

fn send(
    mut stream: TcpStream,
    host: &str,
    port: u16,
    path: &str,
    body: &[u8],
) -> std::io::Result<()> {
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_nodelay(true)?;

    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.shutdown(Shutdown::Write)?;

    // Wait for the response so closing doesn't reset the connection before the
    // server has read the whole request
    let mut response = [0u8; 256];
    let _ = stream.read(&mut response)?;
    Ok(())
}

/// `http://host[:port][/path]` → (host, port, path)
fn parse_http_url(url: &str) -> Option<(&str, u16, &str)> {
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || h.starts_with('[') => (h, p.parse().ok()?),
        _ => (authority, 80),
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return None;
    }
    Some((host, port, path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_urls() {
        assert_eq!(
            parse_http_url("http://localhost:4003/event"),
            Some(("localhost", 4003, "/event"))
        );
        assert_eq!(
            parse_http_url("http://127.0.0.1/x"),
            Some(("127.0.0.1", 80, "/x"))
        );
        assert_eq!(parse_http_url("http://h:1"), Some(("h", 1, "/")));
        assert_eq!(
            parse_http_url("http://[::1]:4003/event"),
            Some(("::1", 4003, "/event"))
        );
        assert_eq!(parse_http_url("https://h/event"), None);
        assert_eq!(parse_http_url("http://:80/"), None);
    }
}
