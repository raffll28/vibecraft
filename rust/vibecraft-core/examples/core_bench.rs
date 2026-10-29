//! Per-call timing of the tmux parsers, for bench/core.bench.ts.
//! Usage: core_bench <corpus.json> <iterations>  (corpus: array of pane strings)

use std::hint::black_box;
use std::time::Instant;

use vibecraft_core::tmux_parsing::{detect_permission_prompt, parse_tokens_from_output};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let corpus: Vec<String> =
        serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let iterations: usize = args[2].parse().unwrap();

    let time = |f: &dyn Fn(&str)| {
        let start = Instant::now();
        for _ in 0..iterations {
            for pane in &corpus {
                f(black_box(pane));
            }
        }
        start.elapsed().as_nanos() as f64 / (iterations * corpus.len()) as f64
    };

    let tokens = time(&|p| {
        black_box(parse_tokens_from_output(p));
    });
    let prompt = time(&|p| {
        black_box(detect_permission_prompt(p));
    });
    println!(r#"{{"parseTokensFromOutput":{tokens},"detectPermissionPrompt":{prompt}}}"#);
}
