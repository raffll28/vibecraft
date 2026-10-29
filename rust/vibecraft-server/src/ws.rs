//! WebSocket (RFC 6455): handshake and framing, server side.

use std::io::{self, Read, Write};

use crate::http::{Request, Response};
use crate::sha1::{base64, sha1};

const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/// Largest message accepted from a client (they only send small JSON)
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

pub fn is_upgrade(req: &Request) -> bool {
    req.method == "GET"
        && req
            .header("upgrade")
            .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
        && req.header("sec-websocket-key").is_some()
}

/// The 101 response that completes the handshake
pub fn handshake_response(req: &Request) -> Response {
    let key = req.header("sec-websocket-key").unwrap_or_default();
    let accept = base64(&sha1(format!("{key}{GUID}").as_bytes()));
    let mut res = Response::empty(101);
    res.headers.push(("Upgrade", "websocket".to_string()));
    res.headers.push(("Sec-WebSocket-Accept", accept));
    res
}

/// Write the 101 response (no Content-Length, Connection: Upgrade)
pub fn write_handshake(stream: &mut impl Write, res: &Response) -> io::Result<()> {
    let mut head = String::from("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n");
    for (name, value) in &res.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.flush()
}

pub enum Message {
    Text(String),
    /// Binary payloads: no client sends them, so they're dropped
    Binary(()),
    Close,
}

const OP_CONTINUATION: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BINARY: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;

/// Read the next data message, answering pings along the way.
/// `writer` is used for pongs and must serialize with other writes.
pub fn read_message(reader: &mut impl Read, mut pong: impl FnMut(Vec<u8>)) -> io::Result<Message> {
    let mut message: Vec<u8> = Vec::new();
    let mut message_op: Option<u8> = None;
    loop {
        let mut head = [0u8; 2];
        reader.read_exact(&mut head)?;
        let fin = head[0] & 0x80 != 0;
        let opcode = head[0] & 0x0F;
        let masked = head[1] & 0x80 != 0;
        let len = match head[1] & 0x7F {
            126 => {
                let mut b = [0u8; 2];
                reader.read_exact(&mut b)?;
                u64::from(u16::from_be_bytes(b))
            }
            127 => {
                let mut b = [0u8; 8];
                reader.read_exact(&mut b)?;
                u64::from_be_bytes(b)
            }
            n => u64::from(n),
        };
        if len as usize > MAX_MESSAGE_BYTES || message.len() + len as usize > MAX_MESSAGE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "message too large",
            ));
        }
        let mut mask = [0u8; 4];
        if masked {
            reader.read_exact(&mut mask)?;
        }
        let mut payload = vec![0u8; len as usize];
        reader.read_exact(&mut payload)?;
        if masked {
            for (i, b) in payload.iter_mut().enumerate() {
                *b ^= mask[i % 4];
            }
        }

        match opcode {
            OP_PING => pong(payload),
            OP_PONG => {}
            OP_CLOSE => return Ok(Message::Close),
            OP_TEXT | OP_BINARY | OP_CONTINUATION => {
                if opcode != OP_CONTINUATION {
                    message_op = Some(opcode);
                    message.clear();
                }
                message.extend_from_slice(&payload);
                if fin {
                    return match message_op {
                        Some(OP_TEXT) => {
                            String::from_utf8(message).map(Message::Text).map_err(|_| {
                                io::Error::new(io::ErrorKind::InvalidData, "invalid UTF-8")
                            })
                        }
                        Some(_) => Ok(Message::Binary(())),
                        None => Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "stray continuation",
                        )),
                    };
                }
            }
            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "unknown opcode")),
        }
    }
}

/// Encode an unmasked server frame
pub fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 10);
    out.push(0x80 | opcode);
    match payload.len() {
        n if n < 126 => out.push(n as u8),
        n if n <= 0xFFFF => {
            out.push(126);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            out.push(127);
            out.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    out.extend_from_slice(payload);
    out
}

pub fn text_frame(text: &str) -> Vec<u8> {
    frame(OP_TEXT, text.as_bytes())
}

pub fn pong_frame(payload: &[u8]) -> Vec<u8> {
    frame(OP_PONG, payload)
}

pub fn close_frame(code: u16, reason: &str) -> Vec<u8> {
    let mut payload = code.to_be_bytes().to_vec();
    payload.extend_from_slice(reason.as_bytes());
    frame(OP_CLOSE, &payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked(opcode: u8, fin: bool, payload: &[u8]) -> Vec<u8> {
        let mask = [1u8, 2, 3, 4];
        let mut out = vec![
            if fin { 0x80 } else { 0 } | opcode,
            0x80 | payload.len() as u8,
        ];
        out.extend_from_slice(&mask);
        out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        out
    }

    #[test]
    fn reads_fragmented_text_and_answers_pings() {
        let mut input = masked(OP_TEXT, false, b"hel");
        input.extend(masked(OP_PING, true, b"p"));
        input.extend(masked(OP_CONTINUATION, true, b"lo"));
        let mut pongs = Vec::new();
        let msg = read_message(&mut input.as_slice(), |p| pongs.push(p)).unwrap();
        assert!(matches!(msg, Message::Text(t) if t == "hello"));
        assert_eq!(pongs, vec![b"p".to_vec()]);
    }

    #[test]
    fn frame_lengths() {
        assert_eq!(frame(OP_TEXT, &[0; 125])[1], 125);
        assert_eq!(&frame(OP_TEXT, &[0; 126])[1..4], &[126, 0, 126]);
        assert_eq!(
            &frame(OP_TEXT, &[0; 70000])[1..10],
            &[127, 0, 0, 0, 0, 0, 1, 17, 112]
        );
    }
}
