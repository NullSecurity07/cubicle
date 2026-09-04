//! `--smoke`: the headless self-check `scripts/acceptance-all.sh` greps for. Start the daemon on
//! `CUBICLE_VAULT`, give it four seconds, prove it is up and reachable, then checkpoint it and
//! prove that took less than five seconds. No tray and no window, so it also runs without a display.

use crate::{config, daemon};
use std::time::Duration;

/// How long the daemon gets to boot before we look for its daemon.json.
const SETTLE: Duration = Duration::from_secs(4);
/// The checkpoint budget the smoke asserts.
const STOP_BUDGET_MS: u128 = 5000;

pub fn run() -> i32 {
    let cfg = config::load();
    let Some(vault) = cfg.vault_path() else {
        println!("SMOKE FAIL: no vault configured (set CUBICLE_VAULT)");
        return 1;
    };
    let root = daemon::repo_root();
    let entry = match daemon::resolve_daemon_entry(&root) {
        Ok(entry) => entry,
        Err(msg) => {
            println!("SMOKE FAIL: {msg}");
            return 1;
        }
    };
    let mut child = match daemon::start(&root, &entry, &vault) {
        Ok(child) => Some(child),
        Err(err) => {
            println!("SMOKE FAIL: daemon did not start ({err})");
            return 1;
        }
    };
    std::thread::sleep(SETTLE);
    let up = daemon::running(&vault);
    let office = daemon::daemon_info(&vault)
        .and_then(|info| daemon::office_url(&vault, &info))
        .is_some();
    let ms = daemon::stop(&vault, &mut child);
    // No `ms > 0`: a daemon that exits inside the first poll is a success, not a failure.
    let ok = up && office && ms < STOP_BUDGET_MS && !daemon::running(&vault);
    println!(
        "SMOKE {}: daemon up={up} office={office} stop={ms}ms",
        if ok { "PASS" } else { "FAIL" }
    );
    i32::from(!ok)
}
