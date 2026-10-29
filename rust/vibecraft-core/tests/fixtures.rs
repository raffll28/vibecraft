//! Runs the JSON fixtures in tests/fixtures/ (cases kept as data, readable
//! without Rust).

use std::path::PathBuf;

use serde_json::{Value, json};
use vibecraft_core::event_store::{EventStore, LineSplitter};
use vibecraft_core::validation::{expand_home, is_origin_allowed};

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures")
        .join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap()
}

fn cases<'a>(fixture: &'a Value, key: &str) -> &'a Vec<Value> {
    fixture[key]
        .as_array()
        .unwrap_or_else(|| panic!("missing fixture group {key}"))
}

fn name(case: &Value) -> String {
    case.get("name")
        .map_or_else(|| case["input"].to_string(), |n| n.to_string())
}

#[test]
fn is_origin_allowed_fixtures() {
    let f = fixture("validation.json");
    for case in cases(&f, "isOriginAllowed") {
        let got = is_origin_allowed(case["input"].as_str());
        assert_eq!(json!(got), case["expected"], "{}", name(case));
    }
}

#[test]
fn expand_home_fixtures() {
    let f = fixture("validation.json");
    let home = std::env::var("HOME").unwrap_or_default();
    for case in cases(&f, "expandHome") {
        let expected = case["expected"].as_str().unwrap().replace("$HOME", &home);
        assert_eq!(
            expand_home(case["input"].as_str().unwrap()),
            expected,
            "{}",
            name(case)
        );
    }
}

fn ids<'a>(events: impl IntoIterator<Item = &'a Value>) -> Vec<Value> {
    events.into_iter().map(|e| e["id"].clone()).collect()
}

#[test]
fn event_store_fixtures() {
    let f = fixture("event-store.json");
    for scenario in cases(&f, "eventStore") {
        let mut store = EventStore::new(scenario["maxEvents"].as_u64().unwrap() as usize);
        for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let result = store.add(step["add"].clone()).cloned();
            let label = format!("{} step {i}", name(scenario));
            match &step["expect"] {
                Value::String(s) if s == "duplicate" => assert!(result.is_none(), "{label}"),
                Value::String(_) => assert!(result.is_some(), "{label}"),
                Value::Object(expected) => {
                    let result = result.unwrap_or_else(|| panic!("{label} should be added"));
                    for (key, value) in expected {
                        if value.is_null() {
                            assert!(result.get(key).is_none(), "{label}: {key} should be absent");
                        } else {
                            assert_eq!(&result[key], value, "{label}: {key}");
                        }
                    }
                }
                other => panic!("bad expect {other}"),
            }
        }
        assert_eq!(
            json!(ids(store.events())),
            scenario["expectedIds"],
            "{}",
            name(scenario)
        );
    }
}

#[test]
fn event_store_query_fixtures() {
    let f = fixture("event-store.json");
    let q = &f["queries"];
    let mut store = EventStore::new(100);
    for event in q["events"].as_array().unwrap() {
        store.add(event.clone());
    }
    for case in q["initialHistory"].as_array().unwrap() {
        let got = store.initial_history(
            case["cutoff"].as_f64().unwrap(),
            case["limit"].as_u64().unwrap() as usize,
        );
        assert_eq!(json!(ids(got)), case["expectedIds"], "{}", name(case));
    }
    assert_eq!(json!(store.last_session_id()), q["lastSessionId"]);
    assert_eq!(EventStore::new(10).last_session_id(), "unknown");
}

#[test]
fn line_splitter_fixtures() {
    let f = fixture("event-store.json");
    for case in cases(&f, "lineSplitter") {
        let mut splitter = LineSplitter::new();
        let got: Vec<Vec<String>> = case["chunksHex"]
            .as_array()
            .unwrap()
            .iter()
            .map(|hex| splitter.push(&decode_hex(hex.as_str().unwrap())))
            .collect();
        assert_eq!(json!(got), case["expected"], "{}", name(case));
    }
}

fn decode_hex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}
