//! Loopback-only API for the Chrome extension and tools (design 4.10): REST, WebSocket audio
//! ingest, SSE events. Every request needs the per-launch token; browser origins must be
//! `chrome-extension://…` (web pages are rejected).

mod ws;
pub mod pairing;
pub mod runtime;

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::Stream;
use mc_core::{EngineEvent, SourceSpec, SummaryMode};
use mc_engine::{Engine, ExportFormat};
use serde::Deserialize;
use serde_json::json;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

pub const PROTOCOL: u32 = 1;

#[derive(Clone)]
pub struct ApiState {
    pub engine: Arc<Engine>,
    pub token: Arc<String>,
    tickets: Arc<Mutex<HashMap<String, Instant>>>,
}

pub fn new_token() -> String {
    let bytes: [u8; 32] = rand::random();
    hex::encode(bytes)
}

pub struct Running {
    pub addr: SocketAddr,
    pub token: String,
    pub task: tokio::task::JoinHandle<()>,
}

/// Binds 127.0.0.1:`port` (0 = random) and serves until the task is dropped.
pub async fn serve(engine: Arc<Engine>, token: String, port: u16) -> anyhow::Result<Running> {
    let state = ApiState { engine, token: Arc::new(token.clone()), tickets: Default::default() };
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let addr = listener.local_addr()?;
    let task = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!(error = %e, "local api stopped");
        }
    });
    tracing::info!(%addr, "local api listening");
    Ok(Running { addr, token, task })
}

pub fn router(state: ApiState) -> Router {
    let api = Router::new()
        .route("/v1/status", get(status))
        .route("/v1/apps", get(apps))
        .route("/v1/sse-ticket", post(sse_ticket))
        .route("/v1/sessions", get(list_sessions).post(create_session))
        .route("/v1/sessions/{id}", get(get_session).patch(patch_session).delete(delete_session))
        .route("/v1/sessions/{id}/stop", post(stop_session))
        .route("/v1/sessions/{id}/transcript", get(transcript))
        .route("/v1/sessions/{id}/insights", get(insights))
        .route("/v1/sessions/{id}/report", get(report))
        .route("/v1/sessions/{id}/missed", get(missed))
        .route("/v1/sessions/{id}/export", get(export))
        .route("/v1/sessions/{id}/markers", get(markers).post(add_marker))
        .route("/v1/search", get(search))
        .route("/v1/events", get(events))
        .route("/v1/ingest/{id}", get(ws::ingest))
        .layer(middleware::from_fn_with_state(state.clone(), auth));
    Router::new()
        .route("/v1/health", get(health))
        .merge(api)
        .layer(middleware::from_fn_with_state(state.clone(), cors))
        .with_state(state)
}

fn origin_allowed(state: &ApiState, origin: Option<&str>) -> bool {
    match origin {
        None => true, // CLI tools and the native host
        Some(o) => {
            let Some(id) = o.strip_prefix("chrome-extension://") else { return false };
            let allowed = state.engine.config().allowed_extension_ids;
            allowed.is_empty() || allowed.iter().any(|a| a == id.trim_end_matches('/'))
        }
    }
}

async fn cors(State(state): State<ApiState>, req: Request, next: Next) -> Response {
    let origin = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()).map(str::to_string);
    if let Some(o) = &origin {
        if !origin_allowed(&state, Some(o)) {
            return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
        }
    }
    let mut resp = if req.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };
    if let Some(o) = origin {
        let h = resp.headers_mut();
        if let Ok(v) = HeaderValue::from_str(&o) {
            h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
        }
        h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("authorization, content-type"));
        h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, PATCH, DELETE, OPTIONS"));
        h.insert(header::VARY, HeaderValue::from_static("Origin"));
    }
    resp
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).map(str::to_string)
}

fn ws_protocol_token(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(header::SEC_WEBSOCKET_PROTOCOL)?.to_str().ok()?;
    let mut parts = v.split(',').map(str::trim);
    (parts.next()? == "mc.v1").then(|| parts.next().map(str::to_string)).flatten()
}

async fn auth(State(state): State<ApiState>, req: Request, next: Next) -> Response {
    let token = bearer(req.headers()).or_else(|| ws_protocol_token(req.headers()));
    let ok = match token {
        Some(t) => constant_eq(&t, &state.token),
        None => {
            // SSE cannot set headers: a one-time ticket in the query (`t=`) is accepted for /v1/events.
            let ticket = req.uri().query().and_then(|q| q.split('&').find_map(|p| p.strip_prefix("t="))).map(str::to_string);
            req.uri().path() == "/v1/events" && ticket.is_some_and(|t| take_ticket(&state, &t))
        }
    };
    if !ok {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "missing or bad token"}))).into_response();
    }
    next.run(req).await
}

fn constant_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn take_ticket(state: &ApiState, t: &str) -> bool {
    let mut tickets = state.tickets.lock().unwrap();
    tickets.retain(|_, at| at.elapsed() < Duration::from_secs(60));
    tickets.remove(t).is_some()
}

struct ApiError(anyhow::Error);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let msg = self.0.to_string();
        let code = if msg.contains("not active") || msg.starts_with("no session") { StatusCode::NOT_FOUND } else { StatusCode::BAD_REQUEST };
        (code, Json(json!({"error": msg}))).into_response()
    }
}
impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}
type ApiResult<T> = Result<T, ApiError>;

async fn health() -> Json<serde_json::Value> {
    Json(json!({"ok": true, "app": "multicorder", "version": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL}))
}

async fn status(State(s): State<ApiState>) -> Json<mc_engine::Status> {
    Json(s.engine.status())
}

async fn apps(State(s): State<ApiState>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(json!(s.engine.list_apps()?)))
}

async fn sse_ticket(State(s): State<ApiState>) -> Json<serde_json::Value> {
    let t = new_token();
    s.tickets.lock().unwrap().insert(t.clone(), Instant::now());
    Json(json!({"ticket": t}))
}

#[derive(Deserialize)]
struct CreateSession {
    source: SourceSpec,
    #[serde(default)]
    summary_mode: Option<SummaryMode>,
    #[serde(default)]
    title: Option<String>,
}

async fn create_session(State(s): State<ApiState>, Json(body): Json<CreateSession>) -> ApiResult<Json<serde_json::Value>> {
    let row = s.engine.start_session(body.source, body.summary_mode.unwrap_or_default(), body.title)?;
    Ok(Json(json!({"session": row, "ingest_path": format!("/v1/ingest/{}", row.id)})))
}

#[derive(Deserialize)]
struct ListQ {
    status: Option<String>,
}

async fn list_sessions(State(s): State<ApiState>, Query(q): Query<ListQ>) -> ApiResult<Json<serde_json::Value>> {
    let rows = s.engine.sessions(q.status.as_deref() == Some("active"))?;
    Ok(Json(json!(rows)))
}

async fn get_session(State(s): State<ApiState>, Path(id): Path<String>) -> ApiResult<Json<serde_json::Value>> {
    let row = s.engine.store.session(&id)?.ok_or_else(|| anyhow::anyhow!("no session {id}"))?;
    Ok(Json(json!({
        "session": row,
        "active": s.engine.is_active(&id),
        "backlog": s.engine.backlog(&id),
        "gaps": s.engine.store.gaps(&id)?,
        "has_report": s.engine.store.report(&id)?.is_some(),
    })))
}

#[derive(Deserialize)]
struct Patch {
    summary_mode: Option<SummaryMode>,
    title: Option<String>,
}

async fn patch_session(State(s): State<ApiState>, Path(id): Path<String>, Json(p): Json<Patch>) -> ApiResult<Json<serde_json::Value>> {
    if let Some(m) = p.summary_mode {
        s.engine.set_mode(&id, m)?;
    }
    if let Some(t) = p.title {
        s.engine.store.set_title(&id, &t)?;
    }
    Ok(Json(json!({"ok": true})))
}

async fn stop_session(State(s): State<ApiState>, Path(id): Path<String>) -> ApiResult<Json<serde_json::Value>> {
    s.engine.stop_session(&id, "user")?;
    Ok(Json(json!({"ok": true})))
}

async fn delete_session(State(s): State<ApiState>, Path(id): Path<String>) -> ApiResult<Json<serde_json::Value>> {
    s.engine.delete_session(&id)?;
    Ok(Json(json!({"ok": true})))
}

async fn transcript(State(s): State<ApiState>, Path(id): Path<String>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(json!(s.engine.transcript(&id)?)))
}

async fn insights(State(s): State<ApiState>, Path(id): Path<String>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(json!(s.engine.insights(&id)?)))
}

async fn report(State(s): State<ApiState>, Path(id): Path<String>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(json!(s.engine.store.report(&id)?)))
}

#[derive(Deserialize)]
struct MissedQ {
    minutes: Option<i64>,
}

async fn missed(State(s): State<ApiState>, Path(id): Path<String>, Query(q): Query<MissedQ>) -> ApiResult<Json<serde_json::Value>> {
    let m = s.engine.missed(&id, q.minutes.unwrap_or(5).clamp(1, 120)).await?;
    Ok(Json(json!(m)))
}

#[derive(Deserialize)]
struct ExportQ {
    format: Option<String>,
}

async fn export(State(s): State<ApiState>, Path(id): Path<String>, Query(q): Query<ExportQ>) -> ApiResult<Response> {
    let fmt = q.format.as_deref().unwrap_or("md");
    let f = ExportFormat::parse(fmt).ok_or_else(|| anyhow::anyhow!("unknown format {fmt}"))?;
    let (ctype, bytes) = s.engine.export(&id, f)?;
    let ext = match f {
        ExportFormat::Markdown => "md",
        ExportFormat::Srt => "srt",
        ExportFormat::Vtt => "vtt",
        ExportFormat::Json => "json",
    };
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, ctype)
        .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"multicorder-{id}.{ext}\""))
        .body(Body::from(bytes))
        .unwrap())
}

#[derive(Deserialize)]
struct MarkerBody {
    label: Option<String>,
}

async fn add_marker(State(s): State<ApiState>, Path(id): Path<String>, body: Option<Json<MarkerBody>>) -> ApiResult<Json<serde_json::Value>> {
    let label = body.and_then(|b| b.0.label);
    Ok(Json(json!({"id": s.engine.add_marker(&id, label.as_deref())?})))
}

async fn markers(State(s): State<ApiState>, Path(id): Path<String>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(json!(s.engine.store.markers(&id)?)))
}

#[derive(Deserialize)]
struct SearchQ {
    q: String,
    session: Option<String>,
}

async fn search(State(s): State<ApiState>, Query(q): Query<SearchQ>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(json!(s.engine.store.search(&q.q, q.session.as_deref(), 200)?)))
}

#[derive(Deserialize)]
struct EventsQ {
    sessions: Option<String>,
}

async fn events(State(s): State<ApiState>, Query(q): Query<EventsQ>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let filter: Option<Vec<String>> = q.sessions.filter(|v| !v.is_empty()).map(|v| v.split(',').map(str::to_string).collect());
    let stream = BroadcastStream::new(s.engine.subscribe()).filter_map(move |e: Result<EngineEvent, _>| {
        let e = e.ok()?;
        if let Some(f) = &filter {
            if !f.iter().any(|id| id == e.session_id()) {
                return None;
            }
        }
        Some(Ok(Event::default().json_data(&e).unwrap_or_default()))
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

#[cfg(test)]
mod tests;
