//! The one thing the tray remembers between runs: which vault it drives.
//! `{ "vault": "…" }` in the XDG config dir, seeded from `CUBICLE_VAULT`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Config {
    #[serde(default)]
    pub vault: String,
}

impl Config {
    pub fn vault_path(&self) -> Option<PathBuf> {
        if self.vault.is_empty() {
            None
        } else {
            Some(PathBuf::from(&self.vault))
        }
    }

    /// The vault's folder name, which is also the Obsidian vault name.
    pub fn vault_name(&self) -> String {
        self.vault_path()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_default()
    }
}

/// `$XDG_CONFIG_HOME/cubicle/config.json`, or the platform config dir when the variable is unset.
pub fn config_path() -> PathBuf {
    let xdg = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    config_path_in(xdg, dirs::config_dir())
}

/// The path rule on its own, so tests can exercise it without touching the process environment.
pub fn config_path_in(xdg: Option<PathBuf>, platform: Option<PathBuf>) -> PathBuf {
    xdg.or(platform)
        .unwrap_or_else(|| PathBuf::from(".config"))
        .join("cubicle")
        .join("config.json")
}

/// The stored config, with `CUBICLE_VAULT` overriding it when set: an exported vault is a
/// deliberate override (the smoke run depends on it), a stored one is only the last choice made.
pub fn load() -> Config {
    load_from(&config_path(), std::env::var("CUBICLE_VAULT").ok())
}

pub fn load_from(path: &Path, vault_env: Option<String>) -> Config {
    let mut cfg: Config = fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if let Some(v) = vault_env.filter(|v| !v.is_empty()) {
        cfg.vault = v;
    }
    cfg
}

pub fn save(cfg: &Config) -> std::io::Result<()> {
    save_to(&config_path(), cfg)
}

pub fn save_to(path: &Path, cfg: &Config) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, serde_json::to_string_pretty(cfg).unwrap_or_default() + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "cubicle-cfg-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn xdg_config_home_wins_over_the_platform_dir() {
        let p = config_path_in(
            Some(PathBuf::from("/xdg")),
            Some(PathBuf::from("/home/u/.config")),
        );
        assert_eq!(p, PathBuf::from("/xdg/cubicle/config.json"));
    }

    #[test]
    fn without_xdg_it_falls_back_to_the_platform_config_dir() {
        let p = config_path_in(None, Some(PathBuf::from("/home/u/.config")));
        assert_eq!(p, PathBuf::from("/home/u/.config/cubicle/config.json"));
    }

    #[test]
    fn save_then_load_round_trips_and_creates_the_directory() {
        let dir = tmpdir("roundtrip");
        let path = dir.join("nested").join("config.json");
        let cfg = Config { vault: "/tmp/my vault".into() };
        save_to(&path, &cfg).unwrap();
        assert_eq!(load_from(&path, None), cfg);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_or_broken_file_is_an_empty_config_not_a_crash() {
        let dir = tmpdir("broken");
        let missing = dir.join("nope.json");
        assert_eq!(load_from(&missing, None), Config::default());
        let broken = dir.join("broken.json");
        fs::write(&broken, "{ not json").unwrap();
        assert_eq!(load_from(&broken, None), Config::default());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cubicle_vault_seeds_an_empty_config_and_overrides_a_stored_one() {
        let dir = tmpdir("seed");
        let path = dir.join("config.json");
        assert_eq!(
            load_from(&path, Some("/tmp/seeded".into())).vault,
            "/tmp/seeded"
        );
        save_to(&path, &Config { vault: "/tmp/stored".into() }).unwrap();
        assert_eq!(load_from(&path, None).vault, "/tmp/stored");
        assert_eq!(load_from(&path, Some("/tmp/env".into())).vault, "/tmp/env");
        assert_eq!(load_from(&path, Some(String::new())).vault, "/tmp/stored");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_vault_name_is_the_folder_name() {
        assert_eq!(Config { vault: "/tmp/my vault".into() }.vault_name(), "my vault");
        assert_eq!(Config::default().vault_name(), "");
        assert_eq!(Config::default().vault_path(), None);
    }
}
