//! HTTP load generator for bench/server.bench.ts: N threads, each with one
//! keep-alive connection, POSTing distinct events for a fixed time.
//! Usage: load <port> <threads> <seconds>  → prints requests per second

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let port: u16 = args[1].parse().unwrap();
    let threads: usize = args[2].parse().unwrap();
    let seconds: u64 = args[3].parse().unwrap();

    let total = Arc::new(AtomicU64::new(0));
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let handles: Vec<_> = (0..threads)
        .map(|t| {
            let total = total.clone();
            std::thread::spawn(move || {
                let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
                stream.set_nodelay(true).unwrap();
                let mut writer = stream.try_clone().unwrap();
                let mut reader = BufReader::new(stream);
                let mut i = 0u64;
                while Instant::now() < deadline {
                    let body = format!(
                        r#"{{"id":"load-{t}-{i}","timestamp":{i},"type":"user_prompt_submit","sessionId":"load","cwd":"/tmp","prompt":"{}"}}"#,
                        "p".repeat(500)
                    );
                    write!(
                        writer,
                        "POST /event HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    )
                    .unwrap();
                    // Read the response head, then exactly Content-Length bytes
                    let mut length = 0;
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line == "\r\n" {
                            break;
                        }
                        if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                            length = v.trim().parse().unwrap();
                        }
                    }
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).unwrap();
                    i += 1;
                }
                total.fetch_add(i, Ordering::Relaxed);
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    println!("{}", total.load(Ordering::Relaxed) / seconds);
}
