//! Suspend and resume, straight from logind: `org.freedesktop.login1.Manager.PrepareForSleep` on
//! the system bus. `true` arrives before the machine suspends, `false` after it wakes.
//!
//! The daemon subscribes to the same signal itself (`packages/daemon/src/signals.ts`) and holds the
//! delay inhibitor, so if the system bus cannot be reached here we say so once and carry on: the
//! checkpoint still happens, we just cannot restart the daemon on wake.

use futures_util::stream::StreamExt;
use zbus::proxy;

#[proxy(
    interface = "org.freedesktop.login1.Manager",
    default_service = "org.freedesktop.login1",
    default_path = "/org/freedesktop/login1"
)]
trait Login1Manager {
    #[zbus(signal)]
    fn prepare_for_sleep(&self, start: bool) -> zbus::Result<()>;
}

/// Call `on_sleep(true)` before suspend and `on_sleep(false)` on resume, for as long as the bus
/// lasts. `Err` means we never connected; `Ok(())` means we did and the stream then ended, which is
/// what a dbus or logind restart looks like — the caller reconnects, because nothing else restarts
/// the daemon on wake.
pub async fn watch<F: Fn(bool)>(on_sleep: F) -> zbus::Result<()> {
    let connection = zbus::Connection::system().await?;
    let manager = Login1ManagerProxy::new(&connection).await?;
    let mut signals = manager.receive_prepare_for_sleep().await?;
    while let Some(signal) = signals.next().await {
        match signal.args() {
            Ok(args) => on_sleep(args.start),
            Err(err) => return Err(err),
        }
    }
    Ok(())
}
