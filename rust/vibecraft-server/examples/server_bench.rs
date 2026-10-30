//! Server benchmarks: startup, memory, event ingestion and fan-out latency.
//!
//! Runs the release server (next to this example in target/release) in a
//! temp HOME.
//!
//!   cargo run --release --example server_bench

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;
use vibecraft_testkit::{
    TestEnv, TestServer, WsClient, elapsed_ms, example_sibling, make_event, print_table, rss_mib,
    summarize,
};

const SEED_EVENTS: usize = 1000;
const CONCURRENCY: usize = 16;
const LOAD_SECONDS: u64 = 3;
const CLIENTS: usize = 5;
const SEQUENTIAL_POSTS: usize = 500;
const FILE_APPENDS: usize = 200;

fn main() {
    let server_bin = example_sibling("vibecraft-server");
    println!("Server: {}\n", server_bin.display());
    let server_bin = server_bin.to_str().unwrap();

    // --- Startup + memory with a full events file ---------------------------
    let env = TestEnv::new();
    let seed: Vec<_> = (0..SEED_EVENTS)
        .map(|i| {
            make_event(json!({
                "type": if i % 2 == 1 { "post_tool_use" } else { "pre_tool_use" },
                "tool": "Read",
                "toolUseId": format!("seed-{}", i >> 1),
                "toolInput": { "file_path": "/x".repeat(50) },
                "toolResponse": { "content": "z".repeat(2000) },
            }))
        })
        .collect();
    env.seed_events(&seed);

    let mut startup = Vec::new();
    let mut server = None;
    for _ in 0..5 {
        let start = Instant::now();
        let s = TestServer::start(server_bin, &env, &[]);
        startup.push(elapsed_ms(start));
        server = Some(s);
    }
    let server = server.unwrap();
    println!("Startup to first healthy response ({SEED_EVENTS} events on disk):");
    print_table(&[("startup", summarize(&startup))], "ms");
    let rss_idle = rss_mib(server.pid());

    // --- Throughput: keep-alive connections, no WebSocket clients ------------
    let throughput = load(server.port, CONCURRENCY, LOAD_SECONDS);
    let rss_after_load = rss_mib(server.pid());

    // --- Clients that receive every broadcast --------------------------------
    let mut clients: Vec<WsClient> = (0..CLIENTS)
        .map(|_| {
            let mut c = server.connect();
            c.next("history");
            c
        })
        .collect();

    // --- POST /event latency, sequential --------------------------------------
    let sequential: Vec<f64> = (0..SEQUENTIAL_POSTS)
        .map(|_| {
            let event = make_event(json!({}));
            let start = Instant::now();
            server.post_event(&event);
            elapsed_ms(start)
        })
        .collect();

    // --- End-to-end: line appended to events.jsonl → WebSocket client -------
    let watcher = &mut clients[0];
    let fanout: Vec<f64> = (0..FILE_APPENDS)
        .map(|i| {
            let id = format!("file-{i}");
            let event = make_event(json!({ "id": id }));
            let start = Instant::now();
            env.append_events_file(format!("{event}\n").as_bytes());
            watcher.next_matching(Duration::from_secs(5), &id, |m| {
                m["payload"]["id"] == id.as_str()
            });
            elapsed_ms(start)
        })
        .collect();
    let rss_end = rss_mib(server.pid());

    println!("\nPOST /event, sequential ({CLIENTS} WebSocket clients connected):");
    print_table(&[("POST /event", summarize(&sequential))], "ms");
    println!(
        "\nPOST /event throughput, {CONCURRENCY} keep-alive connections, no WebSocket clients: {throughput} req/s"
    );
    println!("\nevents.jsonl append → WebSocket client receives it:");
    print_table(&[("file → client", summarize(&fanout))], "ms");
    println!(
        "\nMemory (RSS): {rss_idle:.1} MiB after startup, {rss_after_load:.1} MiB after the load, {rss_end:.1} MiB at the end"
    );
}

/// `threads` keep-alive connections POSTing distinct events for `seconds`;
/// returns requests per second
fn load(port: u16, threads: usize, seconds: u64) -> u64 {
    let total = Arc::new(AtomicU64::new(0));
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let handles: Vec<_> = (0..threads)
        .map(|t| {
            let total = total.clone();
            thread::spawn(move || {
                let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
                stream.set_nodelay(true).unwrap();
                let mut writer = stream.try_clone().unwrap();
                let mut reader = BufReader::new(stream);
                let prompt = "p".repeat(500);
                let mut i = 0u64;
                while Instant::now() < deadline {
                    let body = format!(
                        r#"{{"id":"load-{t}-{i}","timestamp":{i},"type":"user_prompt_submit","sessionId":"load","cwd":"/tmp","prompt":"{prompt}"}}"#
                    );
                    write!(
                        writer,
                        "POST /event HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    )
                    .unwrap();
                    // The response head, then exactly Content-Length bytes
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
    total.load(Ordering::Relaxed) / seconds
}
