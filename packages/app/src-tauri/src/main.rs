//! CUBICLE tray shell (Tauri). The daemon is a separate process (`packages/daemon`); this app only
//! starts/stops it, opens the office and the vault, and forwards suspend/quit as SIGTERM so the
//! daemon checkpoints. There is no default window: the tray is the whole UI.

mod config;
mod daemon;
mod icon;
mod sleep;

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

/// Refresh cadence of the tray while nothing else is happening.
const REFRESH_EVERY: Duration = Duration::from_secs(5);
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
            log(&format!("daemon started (pid {})", child.id()));
            *shell.child.lock().unwrap() = Some(child);
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
    let built = WebviewWindowBuilder::new(app, OFFICE, WebviewUrl::External(url))
        .title("CUBICLE — the office")
        .inner_size(1280.0, 800.0)
        .background_color(tauri::window::Color(0x0f, 0x11, 0x15, 0xff))
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
    {
        let mut cfg = shell.cfg.lock().unwrap();
        cfg.vault = path.to_string_lossy().into_owned();
        if let Err(err) = config::save(&cfg) {
            log(&format!("could not save the config: {err}"));
        }
    }
    log(&format!("vault: {}", path.display()));
    if path.join("Memory").join("constitution.md").is_file() {
        return;
    }
    let Some(entry) = daemon_entry(app) else { return };
    log("new vault: running cubicle init");
    match daemon::init(&shell.root, &entry, path) {
        Ok(status) if status.success() => log("vault initialised"),
        Ok(status) => log(&format!("cubicle init exited with {status}")),
        Err(err) => log(&format!("cubicle init failed: {err}")),
    }
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
        "vault" => open_vault(app),
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

/// Checkpoint the daemon before the machine suspends and bring it back on wake (spec §14 test 9).
fn watch_for_sleep(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let app = handle.clone();
        let result = sleep::watch(move |suspending| {
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
        if let Err(err) = result {
            log(&format!(
                "sleep watcher unavailable ({err}); the daemon checkpoints on PrepareForSleep by itself"
            ));
        }
    });
}

fn main() {
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
