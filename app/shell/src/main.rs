//! The desktop window for the stage.
//!
//! Starts the local server (unless one already answers on the port), opens one window on it and stops the
//! server it started when the window closes.
//!
//!   stage-shell                 serve the built client and the api from the node server, open the window
//!   stage-shell --url <url>     open the window on another address (development: the Vite server)
//!   stage-shell --perf          self-test in this webview: drag a frosted card and count frames, send one chat
//!                               message and wait for the streamed reply; print the result, exit

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct Server(Mutex<Option<Child>>);

fn app_dir() -> PathBuf {
    std::env::var_os("STAGE_APP_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."))
}

fn port() -> u16 {
    std::env::var("STAGE_API_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(7421)
}

fn answers(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(250)).is_ok()
}

/// Starts `node server/index.ts` and waits until it answers. Returns None when a server was already there.
fn start_server(port: u16) -> Result<Option<Child>, String> {
    if answers(port) {
        return Ok(None);
    }
    let child = Command::new("node")
        .arg("server/index.ts")
        .current_dir(app_dir())
        .env("STAGE_API_PORT", port.to_string())
        // The server holds the read end of this pipe and exits when it closes — that is, whenever this
        // process ends, however it ends.
        .env("STAGE_EXIT_WITH_PARENT", "1")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start node: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if answers(port) {
            return Ok(Some(child));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut child = child;
    let _ = child.kill();
    Err(format!("the server did not answer on port {port} within 15 s"))
}

/// Drags the first card by its header for two seconds with in-page mouse events, counts frames, then reports by
/// navigating to /__perf?fps=…, which the navigation handler below reads. No desktop input is synthesised.
const PERF_SCRIPT: &str = r#"
(async () => {
  if (location.pathname === '/__perf') return;
  const report = (query) => { location.href = '/__perf?' + query; };
  try {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let i = 0; i < 100 && !document.querySelector('.card__header'); i += 1) await wait(100);
    const header = document.querySelector('.card__header');
    if (!header) return report('error=no-card-after-10s');
    await wait(800);
    const box = header.getBoundingClientRect();
    const at = (x, y) => ({ bubbles: true, cancelable: true, view: window, button: 0, buttons: 1, clientX: x, clientY: y });
    let x = box.x + box.width / 2, y = box.y + box.height / 2;
    header.dispatchEvent(new MouseEvent('mousedown', at(x, y)));
    let frames = 0;
    const start = performance.now();
    let running = true;
    const tick = () => {
      if (!running) return;
      frames += 1;
      const t = performance.now() - start;
      x += Math.cos(t / 250) * 6; y += Math.sin(t / 250) * 4;
      window.dispatchEvent(new MouseEvent('mousemove', at(x, y)));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await wait(2000);
    running = false;
    window.dispatchEvent(new MouseEvent('mouseup', at(x, y)));
    const moved = Math.round(Math.abs(header.getBoundingClientRect().x - box.x) + Math.abs(header.getBoundingClientRect().y - box.y));
    const fps = ((frames * 1000) / (performance.now() - start)).toFixed(1);
    // Then one chat turn, typed the way React expects, to prove streaming replies work in this webview.
    const input = document.querySelector('.ask textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'shell check');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(100);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    let chat = 'no-reply';
    for (let i = 0; i < 100; i += 1) {
      await wait(100);
      const last = [...document.querySelectorAll('.msg--assistant')].pop();
      const problem = document.querySelector('.msg--problem');
      if (problem) { chat = 'problem:' + encodeURIComponent(problem.textContent); break; }
      if (last && last.textContent.includes('shell check') && document.querySelector('.status--idle')) { chat = 'ok'; break; }
    }
    report('chat=' + chat + '&fps=' + fps + '&frames=' + frames + '&moved=' + moved + '&visibility=' + document.visibilityState + '&size=' + innerWidth + 'x' + innerHeight);
  } catch (error) {
    report('error=' + encodeURIComponent(String(error)));
  }
})();
"#;

fn main() {
    // WebKitGTK's DMABUF renderer paints nothing on some Linux GPU drivers (measured here on NVIDIA: zero frames,
    // a blank window). Without it the same window drags a frosted card at about 150 frames a second.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let args: Vec<String> = std::env::args().collect();
    let perf = args.iter().any(|arg| arg == "--perf");
    let custom_url = args.iter().position(|arg| arg == "--url").and_then(|index| args.get(index + 1)).cloned();
    let port = port();

    let server = if custom_url.is_none() {
        match start_server(port) {
            Ok(child) => child,
            Err(error) => {
                eprintln!("stage-shell: {error}");
                std::process::exit(1);
            }
        }
    } else {
        None
    };
    let url = custom_url.unwrap_or_else(|| format!("http://127.0.0.1:{port}"));

    let app = tauri::Builder::default()
        .manage(Server(Mutex::new(server)))
        .setup(move |app| {
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "stage", WebviewUrl::External(url.parse().expect("a valid url")))
                .title("Stage")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .focused(!perf || std::env::var_os("STAGE_PERF_FOCUS").is_some())
                // Runs at the start of every page load, so it is in place before the stage renders.
                .initialization_script(if perf { PERF_SCRIPT } else { "" })
                .on_navigation(move |target| {
                    if target.path() == "/__perf" {
                        println!("webkit perf: {}", target.query().unwrap_or(""));
                        handle.exit(0);
                        return false;
                    }
                    true
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the stage window could not be built");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = handle.state::<Server>().0.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}
