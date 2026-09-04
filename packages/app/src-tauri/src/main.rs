//! CUBICLE tray shell (Tauri). The daemon is a separate process (`packages/daemon`); this app only
//! starts/stops it, opens the office and the vault, and forwards suspend/quit as SIGTERM so the
//! daemon checkpoints. There is no default window: the tray is the whole UI.

mod icon;

use icon::TrayState;
use tauri::tray::TrayIconBuilder;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            TrayIconBuilder::with_id("cubicle")
                .icon(icon::tray_image(TrayState::Stopped))
                .tooltip("CUBICLE — stopped")
                .build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the CUBICLE tray")
        .run(|_app, _event| {});
}
