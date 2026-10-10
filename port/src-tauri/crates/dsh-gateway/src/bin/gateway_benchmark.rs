//! Static-handler load harness for same-machine reference/port comparison.
//!
//! This binary exists so LANE 9 of `port/scripts/benchmark.ps1` can measure the
//! gateway's static path **without launching the desktop application**. It serves a
//! fixture tree through the same [`dsh_gateway`] code the shell uses and prints the
//! bound port on stdout, then serves until the process is killed.
//!
//! It is gated behind the `benchmark-harness` feature and is not a product entry
//! point. The gateway it starts is deliberately minimal:
//!
//! - It uses [`dsh_gateway::start`] unchanged, so the static handler under
//!   measurement is the production one, not a copy.
//! - It performs the real launch-token exchange on a loopback socket to obtain a
//!   signed browser cookie, then prints a ready-to-use `Cookie:` header value as
//!   `BENCHMARK_COOKIE=<name=value>`. The driver sends that cookie, so the measured
//!   requests traverse the same authenticated route a browser does. Bypassing
//!   authentication inside the harness would measure a code path the product never
//!   serves.
//! - It does **not** bind a Host. A request that falls through the static handler
//!   therefore waits for Host readiness and answers `503`; the harness's fixture
//!   routes all exist, so a measured request never takes that path. A `503` during
//!   measurement is reported as a failure rather than silently recorded as latency.
//!
//! Usage: `gateway-benchmark <fixture-root>`
//!
//! Prints exactly two lines, `BENCHMARK_PORT=<port>` and `BENCHMARK_COOKIE=<cookie>`,
//! then serves.

use std::path::PathBuf;

use dsh_gateway::{start, GatewayConfig};

/// Complete the launch-token → cookie exchange against the harness's own listener
/// and return the `name=value` pair a browser would replay.
async fn mint_browser_cookie(authenticated_url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("http client: {error}"))?;
    let response = client
        .get(authenticated_url)
        .send()
        .await
        .map_err(|error| format!("mint request: {error}"))?;
    if response.status().as_u16() != 303 {
        return Err(format!(
            "expected a 303 mint, got {}",
            response.status().as_u16()
        ));
    }
    let raw = response
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "mint returned no set-cookie".to_string())?;
    let pair = raw
        .split(';')
        .next()
        .ok_or_else(|| "malformed set-cookie".to_string())?
        .trim()
        .to_string();
    if pair.is_empty() {
        return Err("mint returned an empty cookie pair".to_string());
    }
    Ok(pair)
}

#[tokio::main]
async fn main() {
    let root: PathBuf = match std::env::args().nth(1) {
        Some(value) => PathBuf::from(value),
        None => {
            eprintln!("usage: gateway-benchmark <fixture-root>");
            std::process::exit(2);
        }
    };
    if !root.is_dir() {
        eprintln!("fixture root is not a directory: {}", root.display());
        std::process::exit(2);
    }

    // Port 0: an ephemeral loopback port, so concurrent harness runs cannot collide
    // and nothing here can touch the live application port.
    let handle = match start(GatewayConfig::loopback(root), vec![0u8; 32]).await {
        Ok(handle) => handle,
        Err(error) => {
            eprintln!("gateway failed to start: {error}");
            std::process::exit(1);
        }
    };

    let cookie = match mint_browser_cookie(&handle.authenticated_url()).await {
        Ok(cookie) => cookie,
        Err(error) => {
            eprintln!("browser cookie exchange failed: {error}");
            handle.shutdown();
            std::process::exit(1);
        }
    };

    // The two protocol lines the driver reads. Everything else goes to stderr, so a
    // stray log line can never be mistaken for a value.
    println!("BENCHMARK_PORT={}", handle.local_addr().port());
    println!("BENCHMARK_COOKIE={cookie}");
    use std::io::Write as _;
    let _ = std::io::stdout().flush();

    // Serve until killed. The driver owns the lifetime; a self-imposed timeout would
    // truncate a long repetition without telling anyone.
    match tokio::signal::ctrl_c().await {
        Ok(()) => handle.shutdown(),
        Err(error) => eprintln!("signal handler failed: {error}"),
    }
}
