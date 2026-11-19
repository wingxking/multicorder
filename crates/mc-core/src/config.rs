//! `config.json` in the data folder. Keys come from the named environment variable first, then the file.
//! The file lives in the user's data folder and is never part of the repository.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub asr: AsrConfig,
    #[serde(default)]
    pub llm: LlmConfig,
    /// Language of insights and reports.
    #[serde(default = "default_output_lang")]
    pub output_lang: String,
    /// Chrome extension IDs allowed to talk to the local API (`chrome-extension://<id>`).
    #[serde(default)]
    pub allowed_extension_ids: Vec<String>,
    /// Shared daily ceiling for model and remote ASR spending. Live mode falls back to "after" above it.
    #[serde(default = "default_cap")]
    pub daily_usd_cap: f64,
}

fn default_output_lang() -> String {
    "zh".into()
}
fn default_cap() -> f64 {
    2.0
}

impl Default for Config {
    fn default() -> Self {
        Self {
            asr: AsrConfig::default(),
            llm: LlmConfig::default(),
            output_lang: default_output_lang(),
            allowed_extension_ids: vec![],
            daily_usd_cap: default_cap(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrConfig {
    pub provider: String,
    /// `moss` or `openai` (OpenAI-compatible: OpenAI, Groq, …). `fake` is for tests.
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key_env: String,
    #[serde(default)]
    pub api_key: String,
    /// `segment` when the provider returns timed segments, `chunk` when it returns one text per request.
    #[serde(default = "default_timestamps")]
    pub timestamps: String,
    #[serde(default)]
    pub usd_per_minute: f64,
    /// Fixed language (e.g. "en", "zh"); empty lets the provider detect it.
    #[serde(default)]
    pub language: String,
    /// Parallel requests across all sessions.
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
}

fn default_timestamps() -> String {
    "segment".into()
}
fn default_concurrency() -> usize {
    3
}

impl Default for AsrConfig {
    fn default() -> Self {
        Self {
            provider: "moss".into(),
            protocol: "moss".into(),
            base_url: "https://api.mosi.cn/v1".into(),
            model: "moss-transcribe-diarize-pro".into(),
            api_key_env: "MOSS_API_KEY".into(),
            api_key: String::new(),
            timestamps: default_timestamps(),
            usd_per_minute: 0.005,
            language: String::new(),
            concurrency: default_concurrency(),
        }
    }
}

impl AsrConfig {
    pub fn key(&self) -> String {
        resolve_key(&self.api_key_env, &self.api_key)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    #[serde(rename = "use")]
    pub use_: String,
    #[serde(default)]
    pub fallback: Vec<String>,
    #[serde(default)]
    pub providers: BTreeMap<String, LlmProvider>,
}

impl Default for LlmConfig {
    fn default() -> Self {
        let mut providers = BTreeMap::new();
        providers.insert(
            "moss".into(),
            LlmProvider {
                base_url: "https://api.mosi.cn/v1".into(),
                api_key_env: "MOSS_API_KEY".into(),
                api_key: String::new(),
                model: "nex-n2.6".into(),
                extra: None,
                prices: [4.0, 4.0, 20.0],
                json_mode: true,
            },
        );
        Self { use_: "moss".into(), fallback: vec![], providers }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProvider {
    pub base_url: String,
    #[serde(default)]
    pub api_key_env: String,
    #[serde(default)]
    pub api_key: String,
    pub model: String,
    /// Extra request fields merged into every Chat Completions body.
    #[serde(default)]
    pub extra: Option<serde_json::Value>,
    /// USD per million tokens: [input, cached input, output].
    #[serde(default)]
    pub prices: [f64; 3],
    /// Send `response_format: {"type":"json_object"}`.
    #[serde(default = "yes")]
    pub json_mode: bool,
}

fn yes() -> bool {
    true
}

impl LlmProvider {
    pub fn key(&self) -> String {
        resolve_key(&self.api_key_env, &self.api_key)
    }
}

fn resolve_key(env: &str, fallback: &str) -> String {
    if !env.is_empty() {
        if let Ok(value) = std::env::var(env) {
            if !value.trim().is_empty() {
                return value.trim().to_string();
            }
        }
    }
    fallback.trim().to_string()
}

impl Config {
    /// Reads `config.json` in `dir`, writing the default file on first run.
    pub fn load_or_init(dir: &Path) -> anyhow::Result<Self> {
        let path = dir.join("config.json");
        if !path.exists() {
            std::fs::create_dir_all(dir)?;
            let config = Self::default();
            std::fs::write(&path, serde_json::to_vec_pretty(&config)?)?;
            set_private(&path);
            return Ok(config);
        }
        Ok(serde_json::from_slice(&std::fs::read(&path)?)?)
    }
}

/// Owner-only permissions: the file may hold API keys.
pub fn set_private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_key_wins_over_file() {
        std::env::set_var("MC_TEST_KEY_X", " from-env ");
        assert_eq!(resolve_key("MC_TEST_KEY_X", "from-file"), "from-env");
        assert_eq!(resolve_key("MC_TEST_KEY_MISSING", "from-file"), "from-file");
    }

    #[test]
    fn default_config_round_trips() {
        let json = serde_json::to_string(&Config::default()).unwrap();
        let back: Config = serde_json::from_str(&json).unwrap();
        assert_eq!(back.llm.use_, "moss");
        assert_eq!(back.asr.protocol, "moss");
    }
}
