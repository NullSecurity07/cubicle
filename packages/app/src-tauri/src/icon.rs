//! The tray icon (a tiny office cubicle), drawn procedurally so the app ships no image assets.
//! Ported from the Electron shell's `tray-icon.cjs`; the geometry is authored on a 22x22 grid and
//! scaled to whatever size the tray asks for.

use tauri::image::Image;

/// What the tray is telling the owner. `stopped` is also the first-run state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayState {
    Stopped,
    Running,
    Attention,
}

impl TrayState {
    /// The status colour: the monitor screen and the corner badge are painted with it.
    pub fn colour(self) -> [u8; 3] {
        match self {
            TrayState::Stopped => [140, 140, 140],
            TrayState::Running => [42, 111, 219],
            TrayState::Attention => [224, 160, 48],
        }
    }
}

/// Side of the icon the tray is given. 32 keeps the cubicle readable on HiDPI panels.
pub const ICON_SIZE: u32 = 32;

const PARTITION: [u8; 3] = [150, 155, 170];
const DESK: [u8; 3] = [165, 109, 54];
const MONITOR: [u8; 3] = [43, 47, 58];

/// Straight RGBA8 pixels, row-major, `size * size * 4` bytes.
pub fn icon_rgba(state: TrayState, size: u32) -> Vec<u8> {
    let mut px = vec![0u8; (size * size * 4) as usize];
    let scale = |v: u32| -> u32 { ((v as f64) * (size as f64) / 22.0).round() as u32 };
    let mut rect = |x0: u32, y0: u32, x1: u32, y1: u32, c: [u8; 3]| {
        for y in scale(y0)..=scale(y1).min(size - 1) {
            for x in scale(x0)..=scale(x1).min(size - 1) {
                let i = ((y * size + x) * 4) as usize;
                px[i] = c[0];
                px[i + 1] = c[1];
                px[i + 2] = c[2];
                px[i + 3] = 255;
            }
        }
    };
    let dot = state.colour();
    rect(3, 4, 18, 5, PARTITION); // partition, top rail
    rect(3, 4, 4, 17, PARTITION); // partition, left wall
    rect(17, 4, 18, 17, PARTITION); // partition, right wall
    rect(6, 11, 15, 14, DESK);
    rect(8, 6, 13, 10, MONITOR);
    rect(9, 7, 12, 9, dot); // the monitor screen glows in the status colour
    rect(15, 15, 20, 20, dot); // status badge, bottom right
    px
}

/// The image handed to `TrayIcon::set_icon`.
pub fn tray_image(state: TrayState) -> Image<'static> {
    Image::new_owned(icon_rgba(state, ICON_SIZE), ICON_SIZE, ICON_SIZE)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Where the status colour lands on the 22x22 authoring grid: the monitor screen and the badge.
    const SCREEN_POINT: (u32, u32) = (10, 8);
    const BADGE_POINT: (u32, u32) = (17, 17);

    fn pixel(px: &[u8], size: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * size + x) * 4) as usize;
        [px[i], px[i + 1], px[i + 2], px[i + 3]]
    }

    fn on_grid(size: u32, v: u32) -> u32 {
        ((v as f64) * (size as f64) / 22.0).round() as u32
    }

    #[test]
    fn every_state_paints_its_colour_on_the_screen_and_the_badge() {
        for size in [22u32, ICON_SIZE] {
            for state in [TrayState::Stopped, TrayState::Running, TrayState::Attention] {
                let px = icon_rgba(state, size);
                assert_eq!(px.len(), (size * size * 4) as usize, "size {size}");
                let want = state.colour();
                for (gx, gy) in [SCREEN_POINT, BADGE_POINT] {
                    let got = pixel(&px, size, on_grid(size, gx), on_grid(size, gy));
                    assert_eq!(
                        got,
                        [want[0], want[1], want[2], 255],
                        "{state:?} at grid ({gx},{gy}) size {size}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_states_are_told_apart_by_colour() {
        let states = [TrayState::Stopped, TrayState::Running, TrayState::Attention];
        for (i, a) in states.iter().enumerate() {
            for b in &states[i + 1..] {
                assert_ne!(a.colour(), b.colour(), "{a:?} vs {b:?}");
            }
        }
    }

    #[test]
    fn the_corners_stay_transparent() {
        let size = ICON_SIZE;
        for state in [TrayState::Stopped, TrayState::Running, TrayState::Attention] {
            let px = icon_rgba(state, size);
            for (x, y) in [(0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)] {
                assert_eq!(pixel(&px, size, x, y), [0, 0, 0, 0], "{state:?} corner ({x},{y})");
            }
        }
    }
}
