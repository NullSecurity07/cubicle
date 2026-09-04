//! Everything the tray knows about the daemon process: where its entry point is, whether it is up,
//! what the office URL is, how much is waiting for the owner, and how to start and stop it.
//!
//! The daemon always runs on the system Node from its build output — never on a bundled runtime and
//! never through tsx. A checkout that was never built has no `dist/cli.js`, and spawning it would
//! fail silently, so resolving the entry point is a loud step of its own.

use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// What the daemon writes to `<vault>/.cubicle/daemon.json` while it runs.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct DaemonInfo {
    pub pid: i32,
    #[serde(default)]
    pub port: Option<u32>,
    #[serde(default)]
    pub token: Option<String>,
}

/// Told to the owner verbatim when the daemon CLI has not been built.
pub const NOT_BUILT: &str = "daemon not built: run pnpm -r build";

/// How long `stop` waits for the daemon to checkpoint and exit.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(6);
const POLL: Duration = Duration::from_millis(100);

/// The built daemon CLI under `root`, or the message telling the owner how to build it.
pub fn resolve_daemon_entry(root: &Path) -> Result<PathBuf, String> {
    let entry = root.join("packages").join("daemon").join("dist").join("cli.js");
    if entry.is_file() {
        Ok(entry)
    } else {
        Err(NOT_BUILT.to_string())
    }
}

/// The workspace root: the nearest ancestor of `start` that holds `pnpm-workspace.yaml`.
/// The release binary lives at `packages/app/src-tauri/target/release/`, so this walks up out of it.
pub fn find_repo_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|d| d.join("pnpm-workspace.yaml").is_file())
        .map(Path::to_path_buf)
}

/// The repo root for the running binary, falling back to the directory it was built in.
pub fn repo_root() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| find_repo_root(&exe))
        .or_else(|| find_repo_root(Path::new(env!("CARGO_MANIFEST_DIR"))))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// The system Node: `CUBICLE_NODE` if it names a real binary, else `node` on PATH.
pub fn node_binary() -> PathBuf {
    std::env::var("CUBICLE_NODE")
        .ok()
        .filter(|c| !c.is_empty())
        .and_then(|c| which(&c))
        .or_else(|| which("node"))
        .unwrap_or_else(|| PathBuf::from("node"))
}

/// PATH lookup without a shell, so a vault or a Node path with spaces cannot be mis-quoted.
pub fn which(cmd: &str) -> Option<PathBuf> {
    if cmd.contains('/') {
        let p = PathBuf::from(cmd);
        return p.is_file().then_some(p);
    }
    std::env::var_os("PATH")?
        .to_string_lossy()
        .split(':')
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(d).join(cmd))
        .find(|p| p.is_file())
}

pub fn daemon_info_path(vault: &Path) -> PathBuf {
    vault.join(".cubicle").join("daemon.json")
}

pub fn daemon_info(vault: &Path) -> Option<DaemonInfo> {
    let text = std::fs::read_to_string(daemon_info_path(vault)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Linux process liveness. A zombie still has a `/proc` entry but is gone, and our own child stays
/// one until it is reaped, so the state letter is what decides.
pub fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => match stat.rfind(')') {
            Some(i) => !matches!(stat[i + 1..].trim_start().chars().next(), Some('Z') | Some('X')),
            None => true,
        },
        Err(_) => false,
    }
}

/// The daemon is running when it left a `daemon.json` behind and that process is still alive.
pub fn running(vault: &Path) -> bool {
    daemon_info(vault).is_some_and(|i| pid_alive(i.pid))
}

/// The office is served one port above the daemon's websocket port.
pub fn office_url(vault: &Path, info: &DaemonInfo) -> Option<String> {
    let port = info.port?;
    let name = vault.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Some(format!(
        "http://127.0.0.1:{}/?token={}&vault={}",
        port + 1,
        info.token.as_deref().unwrap_or(""),
        encode_component(&name)
    ))
}

/// `encodeURIComponent`, so a vault folder with spaces or `&` still opens the right office.
pub fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*'
            | b'\'' | b'(' | b')' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Proposals in `00 Inbox/` waiting for a yes or no: anything but a plain message, still `approved: null`.
pub fn pending_count(vault: &Path) -> usize {
    let dir = vault.join("00 Inbox");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.ends_with(".md") && name != "README.md"
        })
        .filter(|e| std::fs::read_to_string(e.path()).is_ok_and(|t| awaits_approval(&t)))
        .count()
}

/// A note is waiting when it declares a kind other than `message` and its `approved:` is still null.
pub fn awaits_approval(text: &str) -> bool {
    let mut proposal = false;
    let mut unanswered = false;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("kind:") {
            if !v.trim_start().starts_with("message") {
                proposal = true;
            }
        } else if let Some(v) = line.strip_prefix("approved:") {
            if v.trim() == "null" {
                unanswered = true;
            }
        }
    }
    proposal && unanswered
}

/// Spawn `node <entry> start <vault>` from the repo root, forwarding its output with a `[daemon]` prefix.
pub fn start(root: &Path, entry: &Path, vault: &Path) -> std::io::Result<Child> {
    let mut child = Command::new(node_binary())
        .arg(entry)
        .arg("start")
        .arg(vault)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(out) = child.stdout.take() {
        forward(out, false);
    }
    if let Some(err) = child.stderr.take() {
        forward(err, true);
    }
    Ok(child)
}

fn forward<R: std::io::Read + Send + 'static>(pipe: R, is_err: bool) {
    std::thread::spawn(move || {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            if is_err {
                eprintln!("[daemon] {line}");
            } else {
                println!("[daemon] {line}");
            }
        }
    });
}

/// Run `node <entry> init <vault>` to completion; a fresh folder becomes a vault.
pub fn init(root: &Path, entry: &Path, vault: &Path) -> std::io::Result<std::process::ExitStatus> {
    Command::new(node_binary())
        .arg(entry)
        .arg("init")
        .arg(vault)
        .current_dir(root)
        .status()
}

/// Reap a child that has already exited and empty the slot. `std::process::Child` does not wait on
/// drop, so a child dropped unreaped stays a `<defunct>` entry for the life of the tray.
/// Only call this for a process already known to be gone: `wait` blocks on a live one.
pub fn reap(child: &mut Option<Child>) {
    if let Some(c) = child.as_mut() {
        let _ = c.wait();
    }
    *child = None;
}

/// One poll of the child slot. When the daemon exited on its own this reaps it, empties the slot and
/// returns how it exited; `None` means it is still running, or there was nothing to watch.
pub fn poll_exit(child: &mut Option<Child>) -> Option<std::process::ExitStatus> {
    let status = match child.as_mut()?.try_wait() {
        Ok(Some(status)) => status,
        Ok(None) => return None,
        Err(_) => return None,
    };
    *child = None;
    Some(status)
}

/// How a child exited, the way Electron's `daemon.on('exit', code)` reported it.
pub fn exit_label(status: std::process::ExitStatus) -> String {
    status.code().map_or_else(|| status.to_string(), |code| code.to_string())
}

/// SIGTERM whichever process owns the vault (our child if we have one) and wait for it to checkpoint.
/// Returns the milliseconds it took, or 0 when nothing was running.
pub fn stop(vault: &Path, child: &mut Option<Child>) -> u128 {
    let pid = child
        .as_ref()
        .map(|c| c.id() as i32)
        .or_else(|| daemon_info(vault).map(|i| i.pid));
    let Some(pid) = pid.filter(|p| pid_alive(*p)) else {
        reap(child); // it died on its own; wait for it rather than dropping a zombie
        return 0;
    };
    let started = Instant::now();
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        reap(child);
        return 0;
    }
    loop {
        if let Some(c) = child.as_mut() {
            let _ = c.try_wait(); // reap, or the exited child lingers as a zombie in /proc
        }
        if !pid_alive(pid) || started.elapsed() > STOP_TIMEOUT {
            break;
        }
        std::thread::sleep(POLL);
    }
    if !pid_alive(pid) {
        reap(child);
    }
    started.elapsed().as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "cubicle-daemon-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::remove_dir_all(&d).ok();
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn an_unbuilt_checkout_is_told_to_build_rather_than_silently_doing_nothing() {
        let root = tmpdir("entry");
        assert_eq!(resolve_daemon_entry(&root), Err(NOT_BUILT.to_string()));
        let dist = root.join("packages/daemon/dist");
        fs::create_dir_all(&dist).unwrap();
        fs::write(dist.join("cli.js"), "// built\n").unwrap();
        assert_eq!(resolve_daemon_entry(&root), Ok(dist.join("cli.js")));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_repo_root_is_the_nearest_ancestor_with_a_workspace_file() {
        let root = tmpdir("root");
        let deep = root.join("packages/app/src-tauri/target/release");
        fs::create_dir_all(&deep).unwrap();
        assert_eq!(find_repo_root(&deep.join("cubicle-tray")), None);
        fs::write(root.join("pnpm-workspace.yaml"), "packages:\n").unwrap();
        assert_eq!(find_repo_root(&deep.join("cubicle-tray")), Some(root.clone()));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn daemon_info_parses_what_the_daemon_writes() {
        let vault = tmpdir("info");
        fs::create_dir_all(vault.join(".cubicle")).unwrap();
        assert_eq!(daemon_info(&vault), None);
        fs::write(
            daemon_info_path(&vault),
            r#"{"pid":4242,"port":7411,"started":"2026-09-04T10:00:00.000Z","vault":"/v","token":"abc123"}"#,
        )
        .unwrap();
        let info = daemon_info(&vault).expect("parsed");
        assert_eq!(info.pid, 4242);
        assert_eq!(info.port, Some(7411));
        assert_eq!(info.token.as_deref(), Some("abc123"));
        fs::write(daemon_info_path(&vault), "{ truncated").unwrap();
        assert_eq!(daemon_info(&vault), None);
        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn the_office_url_is_one_port_up_and_carries_the_token_and_vault_name() {
        let info = DaemonInfo { pid: 1, port: Some(7411), token: Some("t0k".into()) };
        assert_eq!(
            office_url(Path::new("/home/u/my vault"), &info).as_deref(),
            Some("http://127.0.0.1:7412/?token=t0k&vault=my%20vault")
        );
        let no_token = DaemonInfo { pid: 1, port: Some(9000), token: None };
        assert_eq!(
            office_url(Path::new("/v/acme"), &no_token).as_deref(),
            Some("http://127.0.0.1:9001/?token=&vault=acme")
        );
        let no_port = DaemonInfo { pid: 1, port: None, token: Some("t".into()) };
        assert_eq!(office_url(Path::new("/v/acme"), &no_port), None);
    }

    #[test]
    fn only_unanswered_non_message_proposals_are_pending() {
        let vault = tmpdir("pending");
        let inbox = vault.join("00 Inbox");
        fs::create_dir_all(&inbox).unwrap();
        assert_eq!(pending_count(&vault), 0);
        fs::write(
            inbox.join("msg_hi.md"),
            "---\nid: msg_hi\nkind: message\nfrom: owner\nanswered: null\n---\nhello\n",
        )
        .unwrap();
        // Every inbox note gets `approved: null` from the schema default, so this is the shape that
        // separates us from the Electron regex: a message is never a proposal awaiting approval.
        fs::write(
            inbox.join("msg_idea.md"),
            "---\nid: msg_idea\nkind: message\nfrom: owner\napproved: null\n---\nan idea\n",
        )
        .unwrap();
        fs::write(
            inbox.join("prop_brand.md"),
            "---\nid: prop_brand\nkind: brand_change\napproved: null\n---\nrename us\n",
        )
        .unwrap();
        fs::write(
            inbox.join("prop_spend.md"),
            "---\nid: prop_spend\nkind: spend\napproved: true\n---\nbuy a domain\n",
        )
        .unwrap();
        fs::write(inbox.join("README.md"), "---\nkind: spend\napproved: null\n---\n").unwrap();
        fs::write(inbox.join("notes.txt"), "---\nkind: spend\napproved: null\n---\n").unwrap();
        assert_eq!(pending_count(&vault), 1);
        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn a_missing_vault_has_nothing_pending_and_is_not_running() {
        let gone = std::env::temp_dir().join("cubicle-daemon-absent-vault");
        fs::remove_dir_all(&gone).ok();
        assert_eq!(pending_count(&gone), 0);
        assert!(!running(&gone));
    }

    #[test]
    fn liveness_follows_real_processes() {
        assert!(pid_alive(std::process::id() as i32));
        assert!(!pid_alive(0));
        assert!(!pid_alive(-1));
        assert!(!pid_alive(4_000_000));
    }

    #[test]
    fn stopping_signals_the_process_that_owns_the_vault_and_reports_how_long_it_took() {
        let vault = tmpdir("stop");
        let mut none: Option<Child> = None;
        assert_eq!(stop(&vault, &mut none), 0, "nothing running");

        let child = Command::new("sleep").arg("30").spawn().expect("spawn sleep");
        let pid = child.id() as i32;
        fs::create_dir_all(vault.join(".cubicle")).unwrap();
        fs::write(daemon_info_path(&vault), format!(r#"{{"pid":{pid},"port":7411}}"#)).unwrap();
        assert!(running(&vault));
        let mut owned = Some(child);
        let ms = stop(&vault, &mut owned);
        assert!(ms < STOP_TIMEOUT.as_millis(), "took {ms} ms");
        assert!(owned.is_none(), "the child is reaped, not left a zombie");
        assert!(!pid_alive(pid));
        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn stopping_a_daemon_the_tray_does_not_own_uses_the_pid_from_daemon_json() {
        // adopt_vault leans on this: after a tray restart the daemon is nobody's child.
        let vault = tmpdir("stop-unowned");
        let mut sleeper = Command::new("sleep").arg("30").spawn().expect("spawn sleep");
        let pid = sleeper.id() as i32;
        fs::create_dir_all(vault.join(".cubicle")).unwrap();
        fs::write(daemon_info_path(&vault), format!(r#"{{"pid":{pid},"port":7411}}"#)).unwrap();
        assert!(running(&vault));

        let mut unowned: Option<Child> = None;
        let ms = stop(&vault, &mut unowned);
        assert!(ms < STOP_TIMEOUT.as_millis(), "took {ms} ms");
        assert!(!running(&vault), "the daemon.json pid was signalled");

        let _ = sleeper.wait(); // this test process is its parent, so this test reaps it
        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn a_daemon_that_exited_on_its_own_is_reaped_rather_than_left_defunct() {
        let vault = tmpdir("reap");
        let child = Command::new("true").spawn().expect("spawn true");
        let pid = child.id() as i32;
        let mut owned = Some(child);
        for _ in 0..200 {
            if !pid_alive(pid) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!pid_alive(pid), "the child exited");
        assert!(Path::new(&format!("/proc/{pid}")).exists(), "and is defunct until reaped");

        assert_eq!(stop(&vault, &mut owned), 0, "nothing to signal");
        assert!(owned.is_none(), "the slot is emptied");
        assert!(!Path::new(&format!("/proc/{pid}")).exists(), "and the zombie is gone");
        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn polling_the_slot_reaps_the_daemon_and_reports_how_it_exited() {
        let child = Command::new("true").spawn().expect("spawn true");
        let pid = child.id() as i32;
        let mut owned = Some(child);
        let mut status = None;
        for _ in 0..200 {
            status = poll_exit(&mut owned);
            if status.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let status = status.expect("the child exited");
        assert!(status.success());
        assert_eq!(exit_label(status), "0");
        assert!(owned.is_none(), "the slot is emptied so the tray can restart");
        assert!(!Path::new(&format!("/proc/{pid}")).exists(), "and nothing is left defunct");
        assert_eq!(poll_exit(&mut owned), None, "an empty slot polls to nothing");
    }

    #[test]
    fn the_url_encoder_matches_encode_uri_component() {
        assert_eq!(encode_component("my vault"), "my%20vault");
        assert_eq!(encode_component("a&b=c"), "a%26b%3Dc");
        assert_eq!(encode_component("ok-_.!~*'()"), "ok-_.!~*'()");
        assert_eq!(encode_component("café"), "caf%C3%A9");
    }

    #[test]
    fn node_is_found_on_the_path() {
        assert!(which("node").is_some(), "the daemon needs the system node");
        assert_eq!(which("definitely-not-a-real-binary-xyz"), None);
        assert_eq!(which("/nonexistent/node"), None);
    }
}
