//! CUBICLE tray shell (Tauri). The daemon is a separate process (`packages/daemon`); this app only
//! starts/stops it, opens the office and the vault, and forwards suspend/quit as SIGTERM so the
//! daemon checkpoints. There is no default window: the tray is the whole UI.

mod config;
mod daemon;
mod icon;
mod sleep;
mod smoke;

use config::Config;
use icon::TrayState;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tokio::signal::unix::{signal, SignalKind};

/// Refresh cadence of the tray while nothing else is happening.
const REFRESH_EVERY: Duration = Duration::from_secs(5);
/// How often the watcher thread looks for a daemon that exited on its own.
const CHILD_POLL: Duration = Duration::from_millis(500);
/// Reconnect backoff for the sleep subscription, from first retry to cap.
const SLEEP_RETRY: Duration = Duration::from_secs(2);
const SLEEP_RETRY_MAX: Duration = Duration::from_secs(60);
/// The office window's label; there is only ever one.
const OFFICE: &str = "office";

/// Everything the tray owns. The daemon child is only ours when we started it; a daemon started
/// from a terminal is found through `daemon.json` instead.
struct Shell {
    cfg: Mutex<Config>,
    child: Mutex<Option<Child>>,
    root: PathBuf,
    shown: Mutex<Option<TrayState>>,
}

impl Shell {
    fn vault(&self) -> Option<PathBuf> {
        self.cfg.lock().unwrap().vault_path()
    }
}

fn log(msg: &str) {
    println!("[cubicle-app] {msg}");
}

/// Run blocking work (start, stop, init) off the GTK main thread, then repaint the tray.
fn in_background<F: FnOnce(&AppHandle) + Send + 'static>(app: &AppHandle, work: F) {
    let handle = app.clone();
    std::thread::spawn(move || {
        work(&handle);
        let h = handle.clone();
        let _ = handle.run_on_main_thread(move || refresh(&h));
    });
}

/// What the tray should be showing right now.
fn snapshot(shell: &Shell) -> (bool, usize, TrayState) {
    let Some(vault) = shell.vault() else {
        return (false, 0, TrayState::Stopped);
    };
    let on = daemon::running(&vault);
    let pending = if on { daemon::pending_count(&vault) } else { 0 };
    let state = match (on, pending) {
        (false, _) => TrayState::Stopped,
        (true, 0) => TrayState::Running,
        (true, _) => TrayState::Attention,
    };
    (on, pending, state)
}

fn tooltip(cfg: &Config, on: bool, pending: usize) -> String {
    let status = match (on, pending) {
        (false, _) => "stopped".to_string(),
        (true, 0) => "running".to_string(),
        (true, n) => format!("running, {n} to approve"),
    };
    if cfg.vault.is_empty() {
        format!("CUBICLE — {status}")
    } else {
        format!("CUBICLE — {status}\n{}", cfg.vault)
    }
}

fn build_menu(
    app: &AppHandle,
    cfg: &Config,
    on: bool,
    pending: usize,
) -> tauri::Result<Menu<tauri::Wry>> {
    let vault_label = if cfg.vault.is_empty() {
        "No vault chosen".to_string()
    } else {
        format!("Vault: {}", cfg.vault_name())
    };
    let pending_label = if pending > 0 {
        format!("{pending} proposal(s) waiting for you")
    } else {
        "Nothing to approve".to_string()
    };
    let item = |id: &str, text: String, enabled: bool| {
        MenuItem::with_id(app, id, text, enabled, None::<&str>)
    };
    Menu::with_items(
        app,
        &[
            &item("vault_label", vault_label, false)?,
            &item("toggle", if on { "Stop daemon" } else { "Start daemon" }.into(), true)?,
            &item("office", "Open Office".into(), on)?,
            &item("vault", "Open Vault in Obsidian".into(), !cfg.vault.is_empty())?,
            &item("pending", pending_label, false)?,
            &PredefinedMenuItem::separator(app)?,
            &item("choose", "Choose vault…".into(), true)?,
            &item("quit", "Quit (checkpoints the daemon)".into(), true)?,
        ],
    )
}

/// Repaint the tray. GTK is main-thread only, so callers off the main thread hop through
/// `run_on_main_thread` rather than touching the tray directly.
fn refresh(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let (on, pending, state) = snapshot(&shell);
    let Some(tray) = app.tray_by_id("cubicle") else { return };
    let mut shown = shell.shown.lock().unwrap();
    if *shown != Some(state) {
        let _ = tray.set_icon(Some(icon::tray_image(state)));
        *shown = Some(state);
    }
    drop(shown);
    let cfg = shell.cfg.lock().unwrap().clone();
    let _ = tray.set_tooltip(Some(tooltip(&cfg, on, pending)));
    match build_menu(app, &cfg, on, pending) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(err) => log(&format!("menu rebuild failed: {err}")),
    }
}

/// The built daemon CLI, or `None` after telling the owner what to run — never a silent no-op.
fn daemon_entry(app: &AppHandle) -> Option<PathBuf> {
    let root = app.state::<Shell>().root.clone();
    match daemon::resolve_daemon_entry(&root) {
        Ok(entry) => Some(entry),
        Err(msg) => {
            log(&msg);
            app.dialog()
                .message(format!(
                    "{msg}\n\nThe tray starts the daemon from packages/daemon/dist, which this checkout does not have yet."
                ))
                .kind(MessageDialogKind::Error)
                .title("CUBICLE")
                .show(|_| {});
            None
        }
    }
}

/// Watch a daemon we spawned. `std::process::Child` never waits on drop, so a daemon that crashes
/// has to be reaped here or it stays `<defunct>`; this also restores Electron's immediate repaint
/// when the daemon goes away by itself. The thread retires as soon as the slot stops being ours.
fn watch_child(app: &AppHandle, pid: u32) {
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(CHILD_POLL);
        let exited = {
            let shell = handle.state::<Shell>();
            let mut slot = shell.child.lock().unwrap();
            match slot.as_ref() {
                Some(c) if c.id() == pid => daemon::poll_exit(&mut slot),
                _ => return, // stopped, or replaced by a newer daemon: not ours any more
            }
        };
        let Some(status) = exited else { continue };
        log(&format!("daemon exited ({})", daemon::exit_label(status)));
        let refreshed = handle.clone();
        let _ = handle.run_on_main_thread(move || refresh(&refreshed));
        return;
    });
}

fn start_daemon(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let Some(vault) = shell.vault() else {
        log("no vault configured");
        return;
    };
    if daemon::running(&vault) {
        log("daemon already running");
        return;
    }
    let Some(entry) = daemon_entry(app) else { return };
    match daemon::start(&shell.root, &entry, &vault) {
        Ok(child) => {
            let pid = child.id();
            log(&format!("daemon started (pid {pid})"));
            let mut slot = shell.child.lock().unwrap();
            daemon::reap(&mut slot); // whatever was here has exited; do not drop it unreaped
            *slot = Some(child);
            drop(slot);
            watch_child(app, pid);
        }
        Err(err) => log(&format!("daemon failed to start: {err}")),
    }
}

/// SIGTERM the daemon and wait for its checkpoint. Returns how long that took, in ms.
fn stop_daemon(app: &AppHandle) -> u128 {
    let shell = app.state::<Shell>();
    let Some(vault) = shell.vault() else { return 0 };
    let mut child = shell.child.lock().unwrap();
    daemon::stop(&vault, &mut child)
}

/// Schemes the office window is allowed to load by itself. Anything else — `obsidian:` above all —
/// WebKitGTK cannot render, and navigating to it blanks the window for good (SP8 §1, ruling P8-4).
const OFFICE_SCHEMES: [&str; 4] = ["http", "https", "ws", "wss"];

/// Schemes never worth handing to the desktop: they mean something only inside the page, and
/// `javascript:` must never reach a shell command.
const IN_PAGE_SCHEMES: [&str; 5] = ["about", "blob", "data", "javascript", "chrome-error"];

/// The one hook the office page gets from the tray. It needs no Tauri API and so no capability
/// grant: assigning `location` raises a navigation the guard below cancels and hands to the
/// desktop, so the page stays exactly where it was. The page falls back to a clipboard toast when
/// `window.__cubicle` is absent (a plain browser tab).
const OPEN_EXTERNAL_SHIM: &str = r#"(function () {
  var c = window.__cubicle || (window.__cubicle = {});
  c.openExternal = function (url) {
    if (typeof url !== 'string' || !url) return false;
    try { window.location.href = url; return true; } catch (e) { return false; }
  };
})();"#;

/// May the office window navigate to `url` itself? True only for the daemon's own origin over
/// http/https/ws/wss; every other scheme, host or port belongs to the desktop. Pure, so the rule is
/// testable without a webview.
fn navigation_allowed(url: &str, office_origin: &str) -> bool {
    let (Ok(target), Ok(origin)) = (url.parse::<tauri::Url>(), office_origin.parse::<tauri::Url>())
    else {
        return false;
    };
    if !OFFICE_SCHEMES.contains(&target.scheme()) {
        return false;
    }
    target.host_str().is_some()
        && target.host_str() == origin.host_str()
        && target.port_or_known_default() == origin.port_or_known_default()
}

/// Is a cancelled navigation worth opening on the desktop? `obsidian:`, `mailto:`, an `https:` link
/// somewhere else: yes. `about:blank`, `blob:`, `data:`, `javascript:`: no — dropped quietly.
fn opens_on_the_desktop(url: &str) -> bool {
    let Ok(parsed) = url.parse::<tauri::Url>() else { return false };
    !IN_PAGE_SCHEMES.contains(&parsed.scheme())
}

/// Hand a URL the office cannot load to the desktop, reusing the tray's `xdg_open`. Off the calling
/// thread: the navigation guard runs on GTK's main thread and `xdg_open` waits for the child.
fn open_external(url: &str) {
    if !opens_on_the_desktop(url) {
        log(&format!("navigation to {url} cancelled"));
        return;
    }
    let target = url.to_string();
    std::thread::spawn(move || {
        log(&format!("opening outside the office: {target}"));
        xdg_open(&target);
    });
}

fn open_office(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let url = shell
        .vault()
        .and_then(|v| daemon::daemon_info(&v).and_then(|i| daemon::office_url(&v, &i)));
    let Some(url) = url else {
        log("office not available: start the daemon first");
        return;
    };
    let Ok(url) = url.parse::<tauri::Url>() else {
        log(&format!("office url is not a url: {url}"));
        return;
    };
    if let Some(win) = app.get_webview_window(OFFICE) {
        let _ = win.navigate(url);
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    // The guard is installed once, on the window that lasts the whole session; the `navigate()`
    // above reuses the same webview, so re-opening the office keeps it.
    let origin = url.origin().ascii_serialization();
    let built = WebviewWindowBuilder::new(app, OFFICE, WebviewUrl::External(url))
        .title("CUBICLE — the office")
        .inner_size(1280.0, 800.0)
        .background_color(tauri::window::Color(0x0f, 0x11, 0x15, 0xff))
        .initialization_script(OPEN_EXTERNAL_SHIM)
        .on_navigation(move |url| {
            let url = url.as_str();
            if navigation_allowed(url, &origin) {
                return true;
            }
            open_external(url);
            false
        })
        // `target="_blank"` links — ui/markdown.ts marks every http link that way — come through
        // WebKit's new-window path, not the navigation one. They belong on the desktop too.
        .on_new_window(|url, _features| {
            open_external(url.as_str());
            tauri::webview::NewWindowResponse::Deny
        })
        .build();
    if let Err(err) = built {
        log(&format!("could not open the office: {err}"));
    }
}

/// Obsidian if it is registered, otherwise the folder in the file manager.
fn open_vault(app: &AppHandle) {
    let cfg = app.state::<Shell>().cfg.lock().unwrap().clone();
    let Some(path) = cfg.vault_path() else { return };
    let uri = format!("obsidian://open?vault={}", daemon::encode_component(&cfg.vault_name()));
    if !xdg_open(&uri) {
        xdg_open(&path.to_string_lossy());
    }
}

fn xdg_open(target: &str) -> bool {
    match std::process::Command::new("xdg-open").arg(target).status() {
        Ok(status) => status.success(),
        Err(err) => {
            log(&format!("xdg-open {target} failed: {err}"));
            false
        }
    }
}

/// Folder picker, then `init` if the folder is not a vault yet.
fn choose_vault(app: &AppHandle) {
    let handle = app.clone();
    app.dialog()
        .file()
        .set_title("Choose your CUBICLE vault (an Obsidian vault folder)")
        .pick_folder(move |picked| {
            let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return };
            in_background(&handle, move |app| adopt_vault(app, &path));
        });
}

fn adopt_vault(app: &AppHandle, path: &Path) {
    let shell = app.state::<Shell>();
    // Our child, if we have one, serves the vault we are leaving; it has to checkpoint first.
    let previous = shell.vault();
    if previous.as_deref() != Some(path) {
        if let Some(previous) = previous {
            let mut child = shell.child.lock().unwrap();
            // A daemon started outside the tray, or before a tray restart, is nobody's child — but
            // it still holds port 7411, so the new vault's daemon could not bind behind it.
            if child.is_some() || daemon::running(&previous) {
                let ms = daemon::stop(&previous, &mut child);
                log(&format!("leaving {}: daemon exited in {ms} ms", previous.display()));
            }
        }
    }
    {
        let mut cfg = shell.cfg.lock().unwrap();
        cfg.vault = path.to_string_lossy().into_owned();
        if let Err(err) = config::save(&cfg) {
            log(&format!("could not save the config: {err}"));
        }
    }
    log(&format!("vault: {}", path.display()));
    if !path.join("Memory").join("constitution.md").is_file() {
        let Some(entry) = daemon_entry(app) else { return };
        log("new vault: running cubicle init");
        match daemon::init(&shell.root, &entry, path) {
            Ok(status) if status.success() => log("vault initialised"),
            Ok(status) => log(&format!("cubicle init exited with {status}")),
            Err(err) => log(&format!("cubicle init failed: {err}")),
        }
    }
    start_daemon(app);
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "toggle" => in_background(app, |app| {
            let running = app.state::<Shell>().vault().is_some_and(|v| daemon::running(&v));
            if running {
                let ms = stop_daemon(app);
                log(&format!("daemon stopped in {ms} ms"));
            } else {
                start_daemon(app);
            }
        }),
        "office" => open_office(app),
        // xdg-open is waited on for its exit status, so it cannot run on the GTK main thread.
        "vault" => in_background(app, open_vault),
        "choose" => choose_vault(app),
        "quit" => in_background(app, |app| {
            let ms = stop_daemon(app);
            log(&format!("quit: daemon checkpointed and exited in {ms} ms"));
            let h = app.clone();
            let _ = app.run_on_main_thread(move || h.exit(0));
        }),
        _ => {}
    }
}

/// A SIGTERM or SIGINT to the tray checkpoints the daemon before we go (spec §8: OS shutdown
/// signals checkpoint and exit). Without this the tray dies instantly and orphans its child.
fn watch_for_signals(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut terminate = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(err) => return log(&format!("cannot listen for SIGTERM: {err}")),
        };
        let mut interrupt = match signal(SignalKind::interrupt()) {
            Ok(s) => s,
            Err(err) => return log(&format!("cannot listen for SIGINT: {err}")),
        };
        let name = tokio::select! {
            _ = terminate.recv() => "SIGTERM",
            _ = interrupt.recv() => "SIGINT",
        };
        // Off the async runtime: the checkpoint blocks for as long as the daemon needs.
        in_background(&handle, move |app| {
            let ms = stop_daemon(app);
            log(&format!("{name}: daemon checkpointed and exited in {ms} ms"));
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || handle.exit(0));
        });
    });
    // SIGUSR2 means "show the office". It is how `scripts/run.sh` reaches a tray that is already
    // running: the office belongs in this window, not in a browser tab. Not SIGUSR1: WebKit's
    // JavaScriptCore takes that one over for its garbage collector once the first webview exists.
    // Windows are GTK, so the open happens on the main thread.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut show = match signal(SignalKind::user_defined2()) {
            Ok(s) => s,
            Err(err) => return log(&format!("cannot listen for SIGUSR2: {err}")),
        };
        while show.recv().await.is_some() {
            log("SIGUSR2: opening the office");
            let h = handle.clone();
            if handle.run_on_main_thread(move || open_office(&h)).is_err() {
                return; // the app is gone
            }
        }
    });
}

/// Checkpoint the daemon before the machine suspends and bring it back on wake (spec §14 test 9).
fn watch_for_sleep(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut backoff = SLEEP_RETRY;
        let mut reported = false;
        loop {
            let app = handle.clone();
            let outcome = sleep::watch(move |suspending| {
                if suspending {
                    in_background(&app, |app| {
                        let ms = stop_daemon(app);
                        log(&format!("suspend: daemon checkpointed and exited in {ms} ms"));
                    });
                } else {
                    log("resume: restarting daemon");
                    in_background(&app, start_daemon);
                }
            })
            .await;
            match outcome {
                // The subscription was live and the bus went away. Nothing else restarts the daemon
                // on wake, so this has to come back rather than end the task silently.
                Ok(()) => {
                    log("sleep watcher: the PrepareForSleep stream ended; reconnecting");
                    backoff = SLEEP_RETRY;
                    reported = false;
                }
                // Never connected. Say so once, then keep retrying quietly: the daemon subscribes to
                // the same signal itself, so a bus that never comes back is not fatal.
                Err(err) => {
                    if !reported {
                        log(&format!(
                            "sleep watcher unavailable ({err}); retrying — the daemon checkpoints on PrepareForSleep by itself"
                        ));
                        reported = true;
                    }
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(SLEEP_RETRY_MAX);
                    continue;
                }
            }
            tokio::time::sleep(backoff).await;
        }
    });
}

fn main() {
    if std::env::args().skip(1).any(|arg| arg == "--smoke") {
        std::process::exit(smoke::run());
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let cfg = config::load();
            let has_vault = !cfg.vault.is_empty();
            log(&format!(
                "vault: {}",
                if has_vault { cfg.vault.as_str() } else { "none chosen" }
            ));
            app.manage(Shell {
                cfg: Mutex::new(cfg),
                child: Mutex::new(None),
                root: daemon::repo_root(),
                shown: Mutex::new(None),
            });
            TrayIconBuilder::with_id("cubicle")
                .icon(icon::tray_image(TrayState::Stopped))
                .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
                .build(app)?;
            refresh(app.handle());

            if has_vault {
                in_background(app.handle(), start_daemon);
            } else {
                choose_vault(app.handle());
            }

            watch_for_signals(app.handle());
            watch_for_sleep(app.handle());

            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(REFRESH_EVERY);
                let h = handle.clone();
                if handle.run_on_main_thread(move || refresh(&h)).is_err() {
                    return; // the app is gone
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the CUBICLE tray")
        .run(|app, event| match event {
            // Closing the office window must not end the app: the tray is the app.
            tauri::RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            // However we are leaving, the daemon gets its SIGTERM so the vault is checkpointed.
            tauri::RunEvent::Exit => {
                let ms = stop_daemon(app);
                if ms > 0 {
                    log(&format!("exit: daemon checkpointed and exited in {ms} ms"));
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    const OFFICE_ORIGIN: &str = "http://127.0.0.1:7412";

    #[test]
    fn the_office_window_never_navigates_to_a_scheme_webkit_cannot_load() {
        // The bug: clicking one of these blanked the window.
        assert!(!navigation_allowed("obsidian://open?vault=Cubicle", OFFICE_ORIGIN));
        assert!(!navigation_allowed(
            "obsidian://open?vault=Cubicle&file=00%20Inbox%2Fnote.md",
            OFFICE_ORIGIN
        ));
        assert!(!navigation_allowed("file:///home/u/Vaults/Cubicle/README.md", OFFICE_ORIGIN));
        assert!(!navigation_allowed("mailto:someone@example.com", OFFICE_ORIGIN));
        assert!(!navigation_allowed("javascript:alert(1)", OFFICE_ORIGIN));
        assert!(!navigation_allowed("about:blank", OFFICE_ORIGIN));
        assert!(!navigation_allowed("not a url at all", OFFICE_ORIGIN));
    }

    #[test]
    fn the_office_navigates_within_the_daemons_own_origin() {
        assert!(navigation_allowed("http://127.0.0.1:7412/?token=t0k&vault=acme", OFFICE_ORIGIN));
        assert!(navigation_allowed("http://127.0.0.1:7412/site/?token=t0k", OFFICE_ORIGIN));
        // The office subscribes to the daemon over a websocket on the same host and port.
        assert!(navigation_allowed("ws://127.0.0.1:7412/events?token=t0k", OFFICE_ORIGIN));
        assert!(navigation_allowed("wss://127.0.0.1:7412/events", OFFICE_ORIGIN));
    }

    #[test]
    fn another_host_or_port_is_outside_the_office_even_over_http() {
        assert!(!navigation_allowed("https://example.com", OFFICE_ORIGIN));
        assert!(!navigation_allowed("http://example.com/docs", OFFICE_ORIGIN));
        // The daemon itself is one port down; only the office port is ours.
        assert!(!navigation_allowed("http://127.0.0.1:7411/op", OFFICE_ORIGIN));
        // Same numbers, different host: localhost is not 127.0.0.1 to the url parser.
        assert!(!navigation_allowed("http://localhost:7412/", OFFICE_ORIGIN));
        // A default port still has to match the office's explicit one.
        assert!(!navigation_allowed("http://127.0.0.1/", OFFICE_ORIGIN));
    }

    #[test]
    fn a_default_port_origin_matches_the_implicit_port() {
        assert!(navigation_allowed("https://cubicle.test/a", "https://cubicle.test"));
        assert!(navigation_allowed("https://cubicle.test:443/a", "https://cubicle.test"));
        assert!(!navigation_allowed("https://cubicle.test:8443/a", "https://cubicle.test"));
        assert!(!navigation_allowed("http://cubicle.test/a", "https://cubicle.test"));
    }

    #[test]
    fn a_broken_office_origin_allows_nothing() {
        assert!(!navigation_allowed("http://127.0.0.1:7412/", "not-an-origin"));
    }

    #[test]
    fn only_cancelled_navigations_that_mean_something_outside_reach_the_desktop() {
        assert!(opens_on_the_desktop("obsidian://open?vault=Cubicle"));
        assert!(opens_on_the_desktop("https://example.com"));
        assert!(opens_on_the_desktop("mailto:someone@example.com"));
        assert!(opens_on_the_desktop("file:///home/u/Vaults/Cubicle"));
        // Never shelled out.
        assert!(!opens_on_the_desktop("javascript:alert(1)"));
        assert!(!opens_on_the_desktop("about:blank"));
        assert!(!opens_on_the_desktop("data:text/html,<b>hi</b>"));
        assert!(!opens_on_the_desktop("blob:http://127.0.0.1:7412/abc"));
        assert!(!opens_on_the_desktop("nonsense"));
    }

    #[test]
    fn the_open_external_shim_needs_no_tauri_api() {
        // If this ever grows a `__TAURI__` call it needs a capability grant the office must not have.
        assert!(!OPEN_EXTERNAL_SHIM.contains("__TAURI"));
        assert!(OPEN_EXTERNAL_SHIM.contains("window.__cubicle"));
        assert!(OPEN_EXTERNAL_SHIM.contains("openExternal"));
    }

    #[test]
    fn the_tooltip_names_the_state_and_the_vault() {
        let none = Config::default();
        assert_eq!(tooltip(&none, false, 0), "CUBICLE — stopped");
        let cfg = Config { vault: "/home/u/acme".into() };
        assert_eq!(tooltip(&cfg, false, 3), "CUBICLE — stopped\n/home/u/acme");
        assert_eq!(tooltip(&cfg, true, 0), "CUBICLE — running\n/home/u/acme");
        assert_eq!(tooltip(&cfg, true, 2), "CUBICLE — running, 2 to approve\n/home/u/acme");
    }
}
