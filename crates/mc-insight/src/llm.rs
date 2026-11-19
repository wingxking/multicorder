//! OpenAI-compatible Chat Completions client with provider fallback (same config shape as
//! Catchup's `llm_config.json`). Returns parsed JSON plus usage for the ledger.

use async_trait::async_trait;
use mc_core::config::{LlmConfig, LlmProvider};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct Usage {
    pub provider: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub usd: f64,
}

#[async_trait]
pub trait Llm: Send + Sync {
    async fn chat_json(&self, system: &str, user: &str, max_tokens: u32) -> anyhow::Result<(Value, Usage)>;
}

pub struct HttpLlm {
    providers: Vec<(String, LlmProvider)>,
    client: reqwest::Client,
}

impl HttpLlm {
    pub fn from_config(cfg: &LlmConfig) -> anyhow::Result<Self> {
        let mut order = vec![cfg.use_.clone()];
        order.extend(cfg.fallback.iter().cloned());
        let providers: Vec<(String, LlmProvider)> = order
            .into_iter()
            .filter_map(|name| cfg.providers.get(&name).map(|p| (name, p.clone())))
            .filter(|(_, p)| !p.key().is_empty())
            .collect();
        if providers.is_empty() {
            anyhow::bail!("no model provider with an API key (llm.use = {})", cfg.use_);
        }
        Ok(Self {
            providers,
            client: reqwest::Client::builder().timeout(std::time::Duration::from_secs(180)).build()?,
        })
    }

    async fn call(&self, name: &str, p: &LlmProvider, system: &str, user: &str, max_tokens: u32) -> anyhow::Result<(Value, Usage)> {
        let mut body = json!({
            "model": p.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "stream": false,
        });
        if p.json_mode {
            body["response_format"] = json!({"type": "json_object"});
        }
        if let Some(Value::Object(extra)) = &p.extra {
            for (k, v) in extra {
                body[k] = v.clone();
            }
        }
        let url = format!("{}/chat/completions", p.base_url.trim_end_matches('/'));
        let mut attempt = 0;
        let resp: Value = loop {
            let r = self.client.post(&url).bearer_auth(p.key()).json(&body).send().await;
            match r {
                Ok(r) if r.status().is_success() => break r.json().await?,
                Ok(r) if (r.status().as_u16() == 429 || r.status().is_server_error()) && attempt < 2 => {
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_secs(2 * attempt)).await;
                }
                Ok(r) => {
                    let status = r.status();
                    let text: String = r.text().await.unwrap_or_default().chars().take(300).collect();
                    anyhow::bail!("{name} HTTP {status}: {text}");
                }
                Err(e) if attempt < 2 => {
                    attempt += 1;
                    tracing::warn!(provider = name, error = %e, "model request failed, retrying");
                    tokio::time::sleep(std::time::Duration::from_secs(2 * attempt)).await;
                }
                Err(e) => return Err(e.into()),
            }
        };
        let choice = &resp["choices"][0];
        let finish = choice["finish_reason"].as_str().unwrap_or("");
        if finish == "content_filter" || finish == "sensitive" {
            anyhow::bail!("{name} refused the request");
        }
        let content = choice["message"]["content"].as_str().unwrap_or("").to_string();
        let parsed = parse_json_loose(&content).ok_or_else(|| anyhow::anyhow!("{name} returned non-JSON output (finish={finish})"))?;
        let input = resp["usage"]["prompt_tokens"].as_u64().unwrap_or(0);
        let output = resp["usage"]["completion_tokens"].as_u64().unwrap_or(0);
        let usd = (input as f64 * p.prices[0] + output as f64 * p.prices[2]) / 1_000_000.0;
        Ok((parsed, Usage { provider: name.to_string(), model: p.model.clone(), input_tokens: input, output_tokens: output, usd }))
    }
}

#[async_trait]
impl Llm for HttpLlm {
    async fn chat_json(&self, system: &str, user: &str, max_tokens: u32) -> anyhow::Result<(Value, Usage)> {
        let mut last_err = None;
        for (name, p) in &self.providers {
            match self.call(name, p, system, user, max_tokens).await {
                Ok(r) => return Ok(r),
                Err(e) => {
                    tracing::warn!(provider = %name, error = %e, "model provider failed, trying next");
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("no provider")))
    }
}

/// Accepts plain JSON, fenced ```json blocks, or text around a single JSON object.
pub fn parse_json_loose(s: &str) -> Option<Value> {
    let t = s.trim();
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return Some(v);
    }
    let start = t.find('{')?;
    let end = t.rfind('}')?;
    serde_json::from_str(&t[start..=end]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loose_json() {
        assert_eq!(parse_json_loose("```json\n{\"a\":1}\n```").unwrap()["a"], 1);
        assert!(parse_json_loose("nope").is_none());
    }
}
