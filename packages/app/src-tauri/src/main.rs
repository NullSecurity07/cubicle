//! CUBICLE tray shell (Tauri). The daemon is a separate process (`packages/daemon`); this app only
//! starts/stops it, opens the office and the vault, and forwards suspend/quit as SIGTERM so the
//! daemon checkpoints. There is no default window: the tray is the whole UI.

mod config;
mod daemon;
mod icon;

use config::Config;
use icon::TrayState;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

/// Refresh cadence of the tray while nothing else is happening.
const REFRESH_EVERY: Duration = Duration::from_secs(5);

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
    let _ = tray.set_tooltip(Some(tooltip(&shell.cfg.lock().unwrap(), on, pending)));
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let cfg = config::load();
            log(&format!(
                "vault: {}",
                if cfg.vault.is_empty() { "none chosen" } else { &cfg.vault }
            ));
            app.manage(Shell {
                cfg: Mutex::new(cfg),
                child: Mutex::new(None),
                root: daemon::repo_root(),
                shown: Mutex::new(None),
            });
            TrayIconBuilder::with_id("cubicle")
                .icon(icon::tray_image(TrayState::Stopped))
                .build(app)?;
            refresh(app.handle());

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
        .run(|_app, _event| {});
}
