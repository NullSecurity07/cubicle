//! Files dropped on the window, handed to the page.
//!
//! WebKitGTK does not give a page the files dragged onto it from a file manager: the page's drop event carries only an
//! empty `text/uri-list`, no files, and a drop nobody takes makes the window open the file in place of the stage. So
//! the shell keeps Tauri's own drop handler, which sees the real paths, and replays each drag into the page as the
//! ordinary events a browser would fire: `dragenter`, `dragover` and `dragleave` while it moves (with placeholder
//! files, so a card can light up), then `drop` with the files read from disk. Every handler the page already has —
//! the stage's note, picture and address drop, a card's own drop — takes it as it takes a drop in the browser.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{DragDropEvent, Runtime, WebviewWindow, WindowEvent};

/// Defines `window.__stageShellDrop` in the page. Runs at the start of every page load.
pub const SCRIPT: &str = r#"
(() => {
  if (window.__stageShellDrop) return;
  const bytes = (text) => (Uint8Array.fromBase64 ? Uint8Array.fromBase64(text) : Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
  const carrying = (files) => { const data = new DataTransfer(); for (const file of files) data.items.add(file); return data; };
  const event = (type, x, y, data) => new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: data });
  let target = null;
  let hovering = [];
  let parts = [];
  const leave = (x, y) => { if (target) target.dispatchEvent(event('dragleave', x, y, carrying(hovering))); target = null; };
  window.__stageShellDrop = {
    over(x, y, list) {
      if (list) hovering = list.map(([name, type]) => new File([], name, { type }));
      const at = document.elementFromPoint(x, y) || document.documentElement;
      if (at !== target) { leave(x, y); at.dispatchEvent(event('dragenter', x, y, carrying(hovering))); target = at; }
      at.dispatchEvent(event('dragover', x, y, carrying(hovering)));
    },
    leave() { leave(0, 0); },
    begin() { parts = []; },
    chunk(index, text) { (parts[index] ??= []).push(bytes(text)); },
    drop(x, y, list) {
      const files = list.map(([name, type], index) => new File(parts[index] || [], name, { type }));
      parts = [];
      target = null;
      const at = document.elementFromPoint(x, y) || document.documentElement;
      at.dispatchEvent(event('drop', x, y, carrying(files)));
    },
  };
})();
"#;

/// A drop larger than this in all is not read into the page: it would sit in memory twice.
const MOST: u64 = 1 << 30;
/// Read and sent in pieces, so no single call into the page carries a whole recording.
const PIECE: usize = 768 * 1024;

/// The type the page's handlers look at, from the name: pictures, notes, tables, recordings, films.
pub fn mime(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "webm" => "video/webm",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        _ => "",
    }
}

/// A JavaScript string literal.
pub fn js_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let n = (group[0] as u32) << 16 | (*group.get(1).unwrap_or(&0) as u32) << 8 | *group.get(2).unwrap_or(&0) as u32;
        out.push(ABC[(n >> 18) as usize & 63] as char);
        out.push(ABC[(n >> 12) as usize & 63] as char);
        out.push(if group.len() > 1 { ABC[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if group.len() > 2 { ABC[n as usize & 63] as char } else { '=' });
    }
    out
}

/// `[["name", "type"], …]` for the files among `paths`; folders and anything unreadable are left out.
pub fn listing(paths: &[PathBuf]) -> (Vec<PathBuf>, String) {
    let files: Vec<PathBuf> = paths.iter().filter(|path| path.is_file()).cloned().collect();
    let items: Vec<String> = files
        .iter()
        .map(|path| {
            let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
            format!("[{},{}]", js_string(&name), js_string(mime(path)))
        })
        .collect();
    (files, format!("[{}]", items.join(",")))
}

/// Replays the window's native drags into the page.
pub fn bridge<R: Runtime>(window: &WebviewWindow<R>) {
    let target = window.clone();
    let hovering: Arc<Mutex<String>> = Arc::new(Mutex::new("[]".into()));
    window.on_window_event(move |event| {
        let WindowEvent::DragDrop(drag) = event else { return };
        let scale = target.scale_factor().unwrap_or(1.0);
        match drag {
            DragDropEvent::Enter { paths, position } => {
                let (_, list) = listing(paths);
                *hovering.lock().unwrap() = list.clone();
                let _ = target.eval(format!("window.__stageShellDrop?.over({}, {}, {list})", position.x / scale, position.y / scale));
            }
            DragDropEvent::Over { position } => {
                let _ = target.eval(format!("window.__stageShellDrop?.over({}, {})", position.x / scale, position.y / scale));
            }
            DragDropEvent::Leave => {
                let _ = target.eval("window.__stageShellDrop?.leave()");
            }
            DragDropEvent::Drop { paths, position } => {
                let (x, y) = (position.x / scale, position.y / scale);
                let paths = paths.clone();
                let page = target.clone();
                // Read off the window's thread: a recording can be large.
                std::thread::spawn(move || {
                    let (files, list) = listing(&paths);
                    let total: u64 = files.iter().filter_map(|path| path.metadata().ok()).map(|meta| meta.len()).sum();
                    if total > MOST {
                        eprintln!("stage-shell: a drop of {total} bytes is more than the window takes at once");
                        let _ = page.eval("window.__stageShellDrop?.leave()");
                        return;
                    }
                    let _ = page.eval("window.__stageShellDrop?.begin()");
                    for (index, path) in files.iter().enumerate() {
                        let Ok(bytes) = std::fs::read(path) else { continue };
                        for piece in bytes.chunks(PIECE) {
                            let _ = page.eval(format!("window.__stageShellDrop?.chunk({index}, \"{}\")", base64(piece)));
                        }
                    }
                    let _ = page.eval(format!("window.__stageShellDrop?.drop({x}, {y}, {list})"));
                });
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_base64_like_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
    }

    #[test]
    fn quotes_names_safely_for_the_page() {
        assert_eq!(js_string("a \"b\" \\ c\n</script>\u{2028}"), "\"a \\\"b\\\" \\\\ c\\n</script>\\u2028\"");
        assert_eq!(js_string("\u{1}"), "\"\\u0001\"");
    }

    #[test]
    fn types_what_the_page_takes() {
        assert_eq!(mime(Path::new("/x/Notes.MD")), "text/markdown");
        assert_eq!(mime(Path::new("shot.jpeg")), "image/jpeg");
        assert_eq!(mime(Path::new("call.m4a")), "audio/mp4");
        assert_eq!(mime(Path::new("no-extension")), "");
    }

    #[test]
    fn lists_files_and_leaves_out_folders() {
        let dir = std::env::temp_dir().join(format!("stage-shell-drop-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("folder")).unwrap();
        std::fs::write(dir.join("a \"note\".md"), "# hi").unwrap();
        let (files, list) = listing(&[dir.join("a \"note\".md"), dir.join("folder"), dir.join("missing.png")]);
        assert_eq!(files.len(), 1);
        assert_eq!(list, "[[\"a \\\"note\\\".md\",\"text/markdown\"]]");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
