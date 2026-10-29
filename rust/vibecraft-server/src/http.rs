//! Minimal HTTP/1.1: request parsing with limits, keep-alive, and responses.
//!
//! Only what vibecraft's clients send (browsers, Node fetch, the hook):
//! Content-Length or chunked bodies, no pipelining guarantees beyond
//! sequential keep-alive requests.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;

const MAX_HEADER_BYTES: usize = 64 * 1024;
/// Bodies above the limit are read and dropped up to this size, so the 413
/// response reaches the client; beyond it the connection is just closed
const MAX_DRAIN_BYTES: usize = 64 * 1024 * 1024;

pub struct Request {
    pub method: String,
    /// Raw request target (path + query), like Node's `req.url`
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Body,
    pub keep_alive: bool,
}

pub enum Body {
    Bytes(Vec<u8>),
    TooLarge,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

pub enum ReadError {
    /// Connection closed (or idle timeout) before a request started
    Closed,
    Malformed,
    Io,
}

impl From<io::Error> for ReadError {
    fn from(_: io::Error) -> Self {
        ReadError::Io
    }
}

/// Read one request. `max_body` bytes at most are kept; larger bodies are
/// drained and reported as `Body::TooLarge`.
pub fn read_request(
    reader: &mut BufReader<TcpStream>,
    max_body: usize,
) -> Result<Request, ReadError> {
    let mut line = String::new();
    // Tolerate stray CRLFs between requests
    loop {
        line.clear();
        let n = read_line_limited(reader, &mut line)?;
        if n == 0 {
            return Err(ReadError::Closed);
        }
        if !line.trim().is_empty() {
            break;
        }
    }

    let mut parts = line.split_ascii_whitespace();
    let (Some(method), Some(url), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(ReadError::Malformed);
    };
    let method = method.to_string();
    let url = url.to_string();
    let http10 = version == "HTTP/1.0";

    let mut headers = Vec::new();
    let mut header_bytes = line.len();
    loop {
        line.clear();
        let n = read_line_limited(reader, &mut line)?;
        header_bytes += n;
        if n == 0 || header_bytes > MAX_HEADER_BYTES {
            return Err(ReadError::Malformed);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        let Some((name, value)) = trimmed.split_once(':') else {
            return Err(ReadError::Malformed);
        };
        headers.push((name.trim().to_string(), value.trim().to_string()));
    }

    let get = |name: &str| {
        headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    };
    let connection = get("connection").unwrap_or("").to_ascii_lowercase();
    let keep_alive = if http10 {
        connection.contains("keep-alive")
    } else {
        !connection.contains("close")
    };
    let chunked =
        get("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let content_length = match get("content-length") {
        Some(v) => Some(v.parse::<usize>().map_err(|_| ReadError::Malformed)?),
        None => None,
    };

    let body = if chunked {
        read_chunked(reader, max_body)?
    } else if let Some(len) = content_length {
        if len > max_body {
            if len > MAX_DRAIN_BYTES {
                return Err(ReadError::Malformed);
            }
            io::copy(&mut reader.by_ref().take(len as u64), &mut io::sink())?;
            Body::TooLarge
        } else {
            let mut buf = vec![0; len];
            reader.read_exact(&mut buf)?;
            Body::Bytes(buf)
        }
    } else {
        Body::Bytes(Vec::new())
    };

    Ok(Request {
        method,
        url,
        headers,
        body,
        keep_alive,
    })
}

fn read_line_limited(
    reader: &mut BufReader<TcpStream>,
    line: &mut String,
) -> Result<usize, ReadError> {
    let mut bytes = Vec::new();
    let n = reader
        .by_ref()
        .take(MAX_HEADER_BYTES as u64 + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|e| match e.kind() {
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => ReadError::Closed,
            _ => ReadError::Io,
        })?;
    if n > MAX_HEADER_BYTES {
        return Err(ReadError::Malformed);
    }
    line.push_str(&String::from_utf8_lossy(&bytes));
    Ok(n)
}

fn read_chunked(reader: &mut BufReader<TcpStream>, max_body: usize) -> Result<Body, ReadError> {
    let mut body = Vec::new();
    let mut total = 0usize;
    let mut line = String::new();
    loop {
        line.clear();
        read_line_limited(reader, &mut line)?;
        let size_text = line.trim().split(';').next().unwrap_or("");
        let size = usize::from_str_radix(size_text, 16).map_err(|_| ReadError::Malformed)?;
        if size == 0 {
            // Trailers until the empty line
            loop {
                line.clear();
                if read_line_limited(reader, &mut line)? == 0 || line.trim().is_empty() {
                    break;
                }
            }
            break;
        }
        total += size;
        if total > MAX_DRAIN_BYTES {
            return Err(ReadError::Malformed);
        }
        if total > max_body {
            io::copy(&mut reader.by_ref().take(size as u64), &mut io::sink())?;
        } else {
            let start = body.len();
            body.resize(start + size, 0);
            reader.read_exact(&mut body[start..])?;
        }
        line.clear();
        read_line_limited(reader, &mut line)?; // CRLF after the chunk
    }
    Ok(if total > max_body {
        Body::TooLarge
    } else {
        Body::Bytes(body)
    })
}

pub struct Response {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn new(status: u16, content_type: Option<&str>, body: impl Into<Vec<u8>>) -> Self {
        let mut headers = Vec::new();
        if let Some(ct) = content_type {
            headers.push(("Content-Type", ct.to_string()));
        }
        Self {
            status,
            headers,
            body: body.into(),
        }
    }

    pub fn json(status: u16, body: &serde_json::Value) -> Self {
        Self::new(status, Some("application/json"), body.to_string())
    }

    pub fn empty(status: u16) -> Self {
        Self::new(status, None, Vec::new())
    }

    pub fn write_to(&self, stream: &mut impl Write, keep_alive: bool) -> io::Result<()> {
        let mut head = format!("HTTP/1.1 {} {}\r\n", self.status, reason(self.status));
        for (name, value) in &self.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        if self.status != 204 {
            head.push_str(&format!("Content-Length: {}\r\n", self.body.len()));
        }
        head.push_str(if keep_alive {
            "Connection: keep-alive\r\n\r\n"
        } else {
            "Connection: close\r\n\r\n"
        });
        let mut out = head.into_bytes();
        out.extend_from_slice(&self.body);
        stream.write_all(&out)?;
        stream.flush()
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        101 => "Switching Protocols",
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "",
    }
}
