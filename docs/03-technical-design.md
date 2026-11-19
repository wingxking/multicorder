# Multicorder 详细技术设计：Mac App 与 Chrome 插件

> **MVP-1 的实现与本文的差异（2026-11-19，详见 [implementation-plan.md](implementation-plan.md)）：**
> - 存档用 FLAC，不用 Opus（纯 Rust 实现，不需要 libopus 和 cmake）；
> - VAD 用自适应能量检测，块策略不变；
> - 监督树用 tokio 任务实现，没有引入 ractor；
> - 转写只实现了 HTTP 适配器（MOSS 和 OpenAI 兼容），本机引擎放到 MVP-2；
> - 麦克风来源放到 MVP-2；
> - 插件的溢出改为 60 秒重发缓冲（IndexedDB 溢出放到 MVP-2）；
> - 新增无界面的守护进程 `mcd`，用于开发和测试。

日期：2026-11-18　版本：0.1（设计稿，未开发）
依据：[竞品功能调研](01-competitor-features.md)、[源码架构对比](02-architecture-comparison.md)、[产品规划](plan.md)

## 0. 范围

**目标**

- 一个 Mac App 和一个 Chromium 插件，组成一个产品：同时采集**多个浏览器 Tab、多个原生 App 和麦克风**，每一路独立地录音、转写、总结，每条要点都有证据。
- 录音不依赖转写和总结。总结可以实时做、结束后做，或者不做。
- 自愿把公开视频的转写文字共享给 Catchup（[plan.md](plan.md) 第 6 节）。

**非目标（MVP）**

- Windows 和手机；
- 偷偷录音、绕过 DRM；
- 默认跨来源合成观点；
- 上架 Mac App Store。

**运行环境**

| 项目 | 要求 |
|---|---|
| 系统 | macOS 14.4 及以上；macOS 26 以上启用按 bundle ID 采集和进程自动恢复 |
| 芯片 | Apple 芯片（本机转写需要），MVP 不支持 Intel |
| 浏览器 | Chrome、Edge、Brave、Arc，Chromium 116 及以上 |

**不变量（违反就是 P0 级缺陷）**

1. 不同来源之间零串路：每一路有独立的采集、缓冲、存档、转写会话、修订日志和摘要状态。
2. 任何一路的转写或模型卡住，都不会让任何一路丢失原始音频。
3. 不开云端功能时，没有任何出站网络请求。
4. 每条要点至少引用一个存在的转写事件；引用了已撤回事件的要点不能进入报告。

## 1. 总体架构

```
┌────────────────────── Chrome / Edge ──────────────────────────────────────────────┐
│ service worker   入口（图标、快捷键、右键菜单）· getMediaStreamId · 会话路由 · 原生消息 │
│ offscreen 文档   唯一一个（USER_MEDIA）：共用 AudioContext；每个 Tab 一个 Worklet 和一条 WS │
│ 媒体时钟脚本     调用插件时用 scripting 注入：读 <video> 的时间、暂停、是否直播       │
│ 侧边栏           React（packages/ui）：每一路一张卡片；SSE 读字幕和要点               │
└───────┬──────────────────────────────────────────────┬────────────────────────────┘
        │ 原生消息（配对：取端口和令牌）                │ WS：PCM16 帧 + 媒体时间标记；REST；SSE
        ▼                                              ▼
┌─ multicorder-host（Rust 命令行，由 Chrome 启动）─┐   ┌─ Multicorder.app（Tauri 2）──────────────┐
│ stdin/stdout 原生消息帧 ⇄ 本机套接字              │──▶│ local-api（axum，监听 127.0.0.1:随机端口）│
└──────────────────────────────────────────────────┘   │ engine（tokio 加 ractor 的 actor 树）     │
                                                       │  Registry · AppWatcher · AsrScheduler      │
                                                       │  InsightScheduler · ShareActor · Store     │
                                                       │  每一路：SessionSupervisor                 │
                                                       │     ├ Source（AppTap / Mic / Tab）         │
                                                       │     ├ Recorder（1 分钟 Opus 分段）         │
                                                       │     ├ Listener（VAD → 转写）               │
                                                       │     └ Insight（滚动要点）                  │
                                                       │ ui（React，通过 Tauri 命令和事件）        │
                                                       └──────────────┬─────────────────────────────┘
                                                                      │ HTTPS（只在用户开启时）
                                                        云端转写 · 模型接口 · Catchup 共享接口
```

## 2. 仓库与模块

独立仓库 `multicorder`，用 pnpm 工作区加 Cargo 工作区。

```
apps/
  desktop/              Tauri 2：src-tauri（engine 和命令）+ src（React UI）
  extension/            WXT + MV3 + React
  host/                 原生消息宿主（Rust 命令行）
crates/
  mc-core/              类型、ID、时间、错误；Frame、SessionId、SourceKind
  mc-capture-macos/     进程枚举与归组、AppTap、聚合设备、麦克风、设备监听
  mc-audio/             实时安全环形缓冲、重采样、电平、掉线检测
  mc-recorder/          Ogg/Opus 分段、SHA-256、磁盘预留、恢复
  mc-vad/               Silero（ort）、块策略
  mc-asr/               AsrAdapter 接口及其实现
  mc-insight/           要点归并器、模型客户端、数字校验、报告
  mc-store/             SQLite（rusqlite）、迁移、FTS5、数据保留
  mc-engine/            actor 树、调度器、会话生命周期（被 desktop 和 local-api 共用）
  mc-local-api/         axum：REST、WS 接收音频、SSE
  mc-share/             Catchup 客户端和 outbox
packages/
  protocol/             TS 类型：由 Rust 用 specta 生成，再加上 WS 帧的编解码
  ui/                   React 组件（卡片、时间轴、证据播放器）
third_party/            复制来的代码，保留原文件头；THIRD_PARTY_NOTICES.md
```

**主要依赖：**

- 采集与音频：`cidre`（锁定提交）、`cpal`、`rubato`（重采样）、`ringbuf`；
- 编码：`opus`、`ogg`；
- 转写与 VAD：`ort`（ONNX 运行时，启用 CoreML）、`whisper-rs`（Metal）、`sherpa-rs`；
- 结构与接口：`ractor`、`tokio`、`axum`；
- 存储：`rusqlite`（bundled，启用 FTS5）、`sha2`；
- 类型生成：`specta`、`tauri-specta`。

## 3. 数据模型（SQLite，WAL）

### 3.1 文件位置

| 内容 | 位置 |
|---|---|
| 数据库 | `~/Library/Application Support/Multicorder/mc.db` |
| 音频 | `…/audio/<session_id>/<seq:06>.opus` |
| 模型 | `…/models/<engine>/<name>/` |
| 运行时 | `…/run/host.sock` |

### 3.2 表结构

```sql
CREATE TABLE sources (
  id TEXT PRIMARY KEY,                 -- ULID
  kind TEXT NOT NULL CHECK (kind IN ('chromium_tab','mac_app','mic')),
  title TEXT NOT NULL,
  app_bundle_id TEXT,                  -- mac_app：最外层 .app 的 bundle ID
  canonical_url TEXT,                  -- chromium_tab：去掉跟踪参数后的地址
  video_key TEXT,                      -- 只限白名单平台的公开视频，例如 youtube:<id>
  created_at TEXT NOT NULL
);
CREATE TABLE session_groups (          -- 同时录的几路编成一组（会议两轨、“3 个 Tab 加 1 个 App”的一次研究）
  id TEXT PRIMARY KEY, title TEXT NOT NULL, preset_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE presets (                 -- 常用的来源组合（借鉴 aCapture），例如“腾讯会议加麦克风”
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sources TEXT NOT NULL,   -- JSON：[{kind, bundle_id?, url_pattern?, summary_mode}]
  template TEXT                        -- 报告模板：keynote / interview / earnings / lecture / meeting
);
CREATE TABLE markers (                 -- 录音中打的点（借鉴 aCapture）
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at_ms INTEGER NOT NULL, label TEXT, created_at TEXT NOT NULL
);
CREATE TABLE capture_sessions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  group_id TEXT REFERENCES session_groups(id),   -- 可以为空：单独的一路
  track_role TEXT,                     -- 'me' / 'them' / 空值：会议两轨时用
  status TEXT NOT NULL CHECK (status IN ('starting','capturing','reconnecting','stopping','stopped','failed')),
  summary_mode TEXT NOT NULL DEFAULT 'after' CHECK (summary_mode IN ('off','live','after')),
  share_state TEXT NOT NULL DEFAULT 'off' CHECK (share_state IN ('off','on','ended')),
  asr_engine TEXT,                     -- 本路选用的引擎；空值表示按语言自动选
  lang TEXT,                           -- 空值表示自动识别
  started_at TEXT NOT NULL, ended_at TEXT,
  failure TEXT                         -- 机器可读的原因，例如 permission_denied、tab_closed
);
CREATE TABLE audio_segments (
  session_id TEXT NOT NULL REFERENCES capture_sessions(id),
  seq INTEGER NOT NULL,                -- 1 分钟一个
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,   -- 相对会话开始的时间
  path TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE gaps (                    -- 采集中断、帧缺失、掉线
  session_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  cause TEXT NOT NULL, PRIMARY KEY (session_id, start_ms)
);
CREATE TABLE media_marks (             -- Tab 的视频时间映射：共享时对齐和跳转都用它
  session_id TEXT NOT NULL, at_ms INTEGER NOT NULL,     -- 会话时间
  media_ms INTEGER, paused INTEGER NOT NULL, live INTEGER NOT NULL, rate REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, at_ms)
);
CREATE TABLE asr_chunks (              -- 送去转写的块（VAD 切出来的，每块不超过 15 秒）
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  pass TEXT NOT NULL CHECK (pass IN ('live','after','backfill')),
  state TEXT NOT NULL CHECK (state IN ('pending','running','done','failed')),
  engine TEXT, attempts INTEGER NOT NULL DEFAULT 0, enqueued_at TEXT NOT NULL
);
CREATE TABLE transcript_events (       -- 只追加；revision 递增
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, chunk_id TEXT,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, media_start_ms INTEGER,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('partial','final','corrected','retracted')),
  supersedes TEXT,                     -- 被 corrected 或 retracted 替代的事件 ID
  text TEXT NOT NULL, lang TEXT, speaker TEXT,   -- speaker：'me' / 'them' / 'spk_0'，不推断身份
  engine TEXT NOT NULL, confidence REAL
);
CREATE INDEX te_session_time ON transcript_events(session_id, start_ms);
CREATE VIRTUAL TABLE transcript_fts USING fts5(text, event_id UNINDEXED, session_id UNINDEXED, tokenize='trigram');
CREATE TABLE insight_events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, insight_key TEXT NOT NULL,   -- 同一条要点的不同版本共用 key
  revision INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('key_point','claim','number','decision','question','action','quote','topic')),
  state TEXT NOT NULL CHECK (state IN ('tentative','confirmed','retracted')),
  text TEXT NOT NULL, lang TEXT NOT NULL,
  evidence TEXT NOT NULL,              -- JSON：[{event_id, start_ms, end_ms}]，至少一条
  created_at TEXT NOT NULL
);
CREATE TABLE reports (session_id TEXT PRIMARY KEY, body TEXT NOT NULL, is_final INTEGER NOT NULL, model TEXT, created_at TEXT NOT NULL);
CREATE TABLE alert_rules (id TEXT PRIMARY KEY, pattern TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT, quiet_hours TEXT, daily_cap INTEGER);
CREATE TABLE alert_events (id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, session_id TEXT NOT NULL, event_id TEXT NOT NULL, verdict TEXT, created_at TEXT NOT NULL);
CREATE TABLE usage_ledger (id TEXT PRIMARY KEY, session_id TEXT, provider TEXT NOT NULL, unit TEXT NOT NULL, qty REAL NOT NULL, usd REAL NOT NULL, at TEXT NOT NULL);
CREATE TABLE share_outbox (contribution_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT, PRIMARY KEY (contribution_id, seq));
```

### 3.3 规则

- **FTS 只索引现行文字：** 只收 `final` 和 `corrected` 状态的事件；事件被替代时，删掉对应的 FTS 行。
- **查询隔离：** 所有读取要点和转写的函数都要求传入 `session_id`。跨会话的检索只返回各自带来源的结果列表，不合成。
- **删除：** 删除一路数据时，删掉它的音频目录、该会话在所有表里的行，以及 FTS 行，然后执行 `VACUUM`（P1 加入定期执行）。

## 4. Mac App

### 4.1 进程与生命周期

**进程**

| 进程 | 作用 |
|---|---|
| Multicorder.app | 唯一的主进程，包含 Tauri 主线程、tokio 运行时和 actor 树。关闭窗口后常驻菜单栏，继续录 |
| multicorder-host | 由 Chrome 按需启动，只负责转发配对消息；用完即退 |

**生命周期**

- 用 `SMAppService.mainApp` 注册为登录项，用户可以关闭。
- 启动时依次执行：
  1. 打开数据库并迁移；
  2. 恢复上次异常退出的会话：把所有 `capturing` 状态的会话标为 `stopped`，`failure` 记为 `app_restart`；修复最后一个分段；未转写的块重新入队；
  3. **清理残留的聚合设备：** 删除所有名称以 `Multicorder-` 开头的聚合设备（借鉴 FineTune 的 `OrphanedTapCleanup`）。私有聚合设备一般会随进程退出而消失，这一步是保险；
  4. 启动 local-api 和本机套接字；
  5. 启动 AppWatcher。

### 4.2 actor 树（参考 Anarlog `listener-core` 改写）

```
RootActor
 ├─ Registry            会话表：增删会话、查询状态；对外的唯一入口
 ├─ AppWatcher          进程枚举与归组、“正在发声的 App”列表、设备变化
 ├─ AsrScheduler        全局转写调度（第 4.8 节）
 ├─ InsightScheduler    模型调用限速与排队（第 4.9 节）
 ├─ ShareActor          Catchup 共享的 outbox
 └─ SessionSupervisor × N（每一路一个）
      ├─ SourceActor     AppTapSource | MicSource | TabSource
      ├─ RecorderActor   只要 Source 在产出，就必须在运行
      ├─ ListenerActor   summary_mode ≠ off 时才启动；失败只降级
      └─ InsightActor    summary_mode = live 时才启动
```

**消息与背压**（沿用 Anarlog 的参数）

- Source 每 20 ms 产出一帧（16 kHz 单声道 f32，320 个采样）。同一帧分别发给 Recorder 和 Listener。
- **发给 Recorder：** 队列容量 32，背压超时 2 秒。超时后写入内存缓冲（上限 64 MB，约 17 分钟）。缓冲也满了，就把这一路标为 `failed(storage_unavailable)`。录音永远不静默丢帧。
- **发给 Listener：** 队列容量 32，超时 1 秒；超时就丢帧，并记录“字幕积压”。转写之后可以从存档补转（`backfill`），所以这里丢帧是允许的。
- **重启：** Source 和 Recorder 各自有重启计数，60 秒内最多 3 次，超过就把这一路标为 `failed`。Listener 失败不重启 Source；重启 Listener 时，从内存回放最近 5 秒（`REPLAY_HISTORY_SECS`）。
- **掉线检测：** 5 秒窗口里全零的比例超过 15%，就发出 `source_silent` 事件。这只是提示，不会停止录音。

### 4.3 AppWatcher：发现与归组

1. **枚举**（参考 Fader 的 `AudioProcessMonitor`，MIT）：
   - 用 `ca::System` 读进程对象列表（`kAudioHardwarePropertyProcessObjectList`），并注册属性监听；
   - **每 2 秒轮询一次**每个对象的 `is_running_output` 和 `is_running_input`。Fader 在 macOS 26 上观察到这两个属性变化时收不到事件，所以只能轮询；读几十个对象只要几微秒；
   - 监听 `kAudioHardwarePropertyServiceRestarted`：Core Audio 服务重启后，所有监听失效、所有进程对象 ID 都会变，此时重建监听、重新枚举，并让所有正在采集的 AppTapSource 重建 tap（空档记入 `gaps(cause='coreaudio_restart')`）。
2. **身份**（三级退路）：
   1. **负责进程：** 通过 `dlsym` 查找私有函数 `responsibility_get_pid_responsible_for_pid`，取得“负责这个辅助进程的 App”。TCC 和活动监视器用的也是这种归属方式，Fader 和 FineTune 都在用。找不到这个函数或者返回无效值，就进入下一级；
   2. **父进程：** 用 `sysctl` 沿父进程往上找，找到第一个可执行文件在 `*.app` 里的进程。这对 Chrome、Brave、Electron 的辅助进程有效；
   3. **路径：** 用 `proc_pidpath` 往上找最外层的 `*.app`。

   **为什么不能只按路径找：** Safari 和用 WKWebView 的 App 由 WebKit 的 GPU 进程发声，这个进程在系统框架目录里，不在 App 包里，只有“负责进程”能把它归到正确的 App。

   得到的 App 身份包括 bundle 路径和 `CFBundleIdentifier`；同一个 bundle ID 的多个条目合并（参考 SonicFlow 的去重处理）。热路径上**不调用 `NSRunningApplication` 的字符串属性**：Screenpipe 记录过在 Intel Mac 上会崩溃。图标和显示名在后台线程读一次，缓存起来。
3. **列表规则**（参考 Fader）：正常的 App 一直显示；后台代理和辅助进程只在播放或录音时显示。
4. **过滤：**
   - 本进程，以及我们自己建的聚合设备（名称前缀 `Multicorder-`，列设备时同样排除）；
   - 系统常驻进程：`corespeechd`、`coreaudiod`、远程桌面辅助进程等，列表写成代码常量；
   - 不过滤 `avconferenced`（FaceTime 的音频引擎），把它归到 FaceTime。
5. **浏览器：** 如果某个浏览器正在被插件按 Tab 采集，App 列表里把它标为“由插件按 Tab 采集”，默认不允许再整体采集；用户坚持的话要二次确认，因为会重复。
6. **输出：** `AppAudioInfo { app_id, bundle_id, name, icon, pids: Vec<i32>, process_objs: Vec<u32>, is_emitting: bool }`，通过 Tauri 事件推给界面。

### 4.4 AppTapSource：每个 App 一路

**创建（参考 AudioCap 的步骤，Meetily 的聚合设备参数，用 `cidre` 实现）**

```rust
// 1. tap 描述
let mut desc = ca::TapDesc::with_mono_mixdown_of_processes(&ns_array(process_objs));
desc.set_private(true);
desc.set_mute_behavior(if user_muted { TapMuteBehavior::Muted } else { TapMuteBehavior::Unmuted });
if macos >= 26 { desc.set_bundle_ids(&bundle_ids_of_group); desc.set_process_restore_enabled(true); }
let tap = desc.create_process_tap()?;                // TapGuard：被 drop 时自动销毁
// 2. 私有聚合设备：只挂 tap，主子设备 = 默认输出（作为时钟）
let agg = ca::AggregateDevice::with_desc(&dict! {
    is_private: true, is_stacked: false, tap_auto_start: true,
    name: "Multicorder-<session>", uid: Uuid::new(),     // 固定前缀：设备列表据此过滤，启动时据此清理残留
    main_sub_device: clock_uid, clock_device: clock_uid, // 时钟设备：优先内置或有线设备
    tap_list: [{ sub_tap_uid: tap.uid()?, drift_compensation: true }],
})?;
// 3. IOProc：只写环形缓冲（不分配内存、不加锁、不打日志）
let fmt = tap.asbd()?;                                 // 通常是 48 kHz f32 单声道
let proc_id = agg.create_io_proc_id(io_proc, Some(&mut ctx))?;
let started = ca::device_start(agg, Some(proc_id))?;
```

**取数据**

- 实时线程：按 `fmt` 把数据转成 f32，写进 `ringbuf::HeapRb<f32>`，容量 2 秒。缓冲满时只计数（`consecutive_drops`），不阻塞。
- 普通线程：每 10 ms 取一次，用 `rubato` 的 FFT 重采样器转到 16 kHz，切成 20 ms 一帧，盖上会话时间（单调时钟），发出去。

**变化处理**

| 事件 | 处理 |
|---|---|
| 这个 App 新增或退出了发声进程（14.4–25） | **先建后拆**（参考 Fader 的换 tap 做法）：用新的进程列表建一个新的 tap 和聚合设备并启动；收到它的第一帧后，在一帧的边界把写入切到新 tap，再拆掉旧的。切换前后的样本在同一条时间线上衔接，没有空档也没有重复。`tap.set_desc()` 原地更新作为优化，等 V-1 实测确认后再启用 |
| 同上（macOS 26 以上） | 交给 `bundle_ids` 加 `process_restore_enabled` 处理；如果实测仍然漏掉新进程，就退回先建后拆 |
| 默认输出设备或时钟设备变了 | 先建后拆。时钟设备优先选内置或有线设备，因为蓝牙设备的时钟会漂（参考 Fader） |
| tap 建立失败 | 不会再有 HAL 事件触发重试，所以按定时器重试（1、2、4…最多 30 秒）；这段时间记入 gaps |
| tap 没有回调了 | 健康检查（借鉴 FineTune 的思路）：如果这个 App 的 `is_running_output` 为真，但超过 2 秒没有收到回调，就判为 tap 已死，先建后拆 |
| Core Audio 服务重启 | 由 AppWatcher 统一触发重建 |
| tap 的格式变了 | 读到新的 asbd，重建重采样器 |
| App 整个退出 | 14.4–25：这一路进入 `reconnecting`，等 30 秒，App 重新出现就重建；超时则 `stopped`。macOS 26：由系统自动恢复 |

**权限**

- `Info.plist` 写 `NSAudioCaptureUsageDescription`，第一次建 tap 时系统会弹出授权提示。
- 检测：建好 tap 后读 2 秒，如果这个 App 的 `is_running_output` 为真、而采样全是零，就判为“未授权”，引导用户打开“系统设置 → 隐私与安全性 → 屏幕与系统录音 → 仅系统录音”。不调用私有 TCC 接口。

**并发**

- 每个 App 一个 tap 和一个聚合设备。目标是同时 6 路（V-1），上限写成常量 `MAX_APP_TAPS = 8`。
- 开源的按 App 混音器（Fader、FineTune）在生产中给每个正在出声的 App 各建一个 tap，同时运行几十个。这说明多个 tap 并存可行；V-1 主要验证“只录不放（`Unmuted`）”时的 CPU 占用和稳定性。

**省电（P1）：** 参考 Fader 的 `ProcessTap+Idle`。一个 App 连续 60 秒不出声时，暂停这个 tap 的 IO，由 AppWatcher 的 2 秒轮询在它重新出声时恢复。暂停期间按静音记录，并在时间轴上标为“无声”。

### 4.5 MicSource

- 用 `cpal` 打开所选的输入设备（默认是系统默认输入），转成单声道 16 kHz（参考 Anarlog `audio-actual/mic.rs`）。
- 监听设备变化：拔掉耳机时切回默认输入，并记入 `gaps(cause='device_change')`。
- **会议两轨：** 用户选“会议模式”时，麦克风和会议 App 的 tap 作为**同一个会话的两轨**，`speaker` 分别标为 `me` 和 `them`。可以选择对麦克风这一轨做回声消除（Anarlog `aec`，参考信号是会议 App 那一轨；**ONNX 模型的许可证要先核对**）。
- 第一次使用时请求 `NSMicrophoneUsageDescription` 权限。

### 4.6 TabSource

- 由 local-api 的 WS 连接驱动（协议见第 6 节）。收到 PCM16 帧后转成 f32，按 `seq` 检查缺帧：缺失的部分补静音并记入 `gaps(cause='ws_gap')`；重复的 `seq` 丢弃。
- 文字帧里的 `media_mark` 写入 `media_marks` 表。
- 连接断开后进入 `reconnecting`；插件按 `seq` 续传，最多补 60 秒。超过 5 分钟没有重连就 `stopped(cause='extension_gone')`。

### 4.7 RecorderActor：存档

- **编码：** 16 kHz 单声道，Opus VOIP 模式，24 kbps（约 10.8 MB/小时），20 ms 一帧，封装成 Ogg。
- **分段：** 每 60 秒一个文件 `<seq:06>.opus`，一个分段写完后计算 SHA-256，写入 `audio_segments`。
- **写盘**（照搬 Anarlog 的参数）：
  - 每秒写一次并 fsync 文件，新建文件后 fsync 目录；
  - 磁盘剩余空间低于 256 MB 时，停止新的会话，并提醒用户。
- **恢复：** 启动时检查每个会话最后一个分段。Ogg 页不完整就截到最后一个完整的页；无法恢复的移到 `audio-recovery/`。
- **读取：** 播放器和批量转写按时间范围读分段，解码成 16 kHz 的 PCM。

### 4.8 ListenerActor 与 AsrScheduler：转写

**VAD 与切块**

- 参考 Anarlog 的 `audio-chunking` 和 `vad`：用 Silero（ONNX，`ort`，16 kHz，30 ms 一个窗口）。
- 块策略：
  - 至少 200 ms 语音；
  - 间隔 250 ms 以内的短块合并；
  - 静音判定 500 ms；
  - **每块最长 15 秒**，到了就强制切开（避免 Meetily #756 的问题）。
- 切出的块写入 `asr_chunks`（`pass='live'`），对应的音频保存在内存里（≤15 秒 × 64 KB/秒）。

**引擎（`AsrAdapter`）**

```rust
#[async_trait]
pub trait AsrAdapter: Send + Sync {
    fn id(&self) -> &'static str;                       // "parakeet-tdt-0.6b" 等
    fn kind(&self) -> AsrKind;                          // Batch | Streaming
    fn languages(&self) -> &[Lang];
    async fn transcribe(&self, pcm16k: &[f32], hint: &AsrHint) -> Result<Vec<AsrSegment>>; // Batch
    async fn open_stream(&self, hint: &AsrHint) -> Result<Box<dyn AsrStream>>;            // Streaming
}
```

| 实现 | 用途 | 来源 |
|---|---|---|
| `SenseVoiceSmall`（sherpa-onnx） | 中文，实时 | 新写 |
| `ParakeetTdt`（ort，CoreML） | 英文，实时 | 参考 Meetily 的 `parakeet_engine` |
| `WhisperLargeV3Turbo`（whisper-rs，Metal） | 多语言，以及结束后的高精度转写 | 参考 Anarlog 的 `whisper-local` |
| `SpeechAnalyzer` | macOS 26 以上，可选 | 参考 Anarlog 的 `transcribe-speechanalyzer` |
| `Soniox`、`Deepgram` | 流式，用户开启并提供 Key 后才用 | 参考 Anarlog 的 `soniox` |
| `OpenAiCompatible` | 批量，云端备选 | 新写 |

- **语言路由：** 会话设了 `lang` 就按它选引擎；否则用前 30 秒的音频做语言识别（Whisper 的语言检测），然后固定下来。中英混讲选 SenseVoice 或 Whisper。
- **模型：** 第一次使用时下载，校验 SHA-256，放在 `models/` 下（参考 Anarlog 的 `model-downloader`）；界面上显示大小和进度。

**调度**

- 每一路一个队列。调度器按以下优先级取块：
  1. `live` 的块，在实时模式的会话之间轮流取；
  2. `after`，即结束后模式的整段转写；
  3. `backfill`，即中途切到实时模式后补转之前的部分。
- 每个引擎有自己的并发上限：Whisper（Metal）为 1；Parakeet 和 SenseVoice 按 V-3 的实测设为 2–4。
- 某一路的实时积压超过 30 秒时，这一路降级：改用更小的模型，或者暂停实时字幕，结束后再补；同时在界面上提示。

**结果**

- 写入 `transcript_events`，状态为 `final`（本机批量引擎）或 `partial` 加 `final`（流式引擎）。
- 结束后模式的转写结果是 `corrected`：用时间重叠关系找到被替代的实时事件，填入 `supersedes`。
- 每条结果通过 SSE 推给界面和插件。

**模式切换**

| 切换 | 处理 |
|---|---|
| 关 → 实时 | 启动 Listener 和 Insight，从当前时刻开始实时转写；之前的部分作为 `backfill` 从存档读 |
| 实时 → 关 | 停止 Listener 和 Insight，已有的结果保留 |
| 任何模式 → 结束后 | 会话结束时，把整段排进 `after` |

### 4.9 InsightActor：滚动要点、“我错过了什么”、报告

**归并**

- **触发：** 每 45 秒一次，或者新增的 final 文字超过 400 个英文词（或 800 个汉字），取先到者。
- **输入：** 当前要点状态（最近 40 条 confirmed 和 tentative，以及它们的 key），加上新增的事件（带 ID 和时间）。
- **输出：** JSON 格式的一组操作：

  ```json
  {"ops":[{"op":"upsert","key":"k3","type":"number","text":"…","evidence":["ev_…"]},
          {"op":"confirm","key":"k1"},{"op":"retract","key":"k2","reason":"…"}]}
  ```

- **校验**（代码执行，不交给模型）：
  - 证据里的事件 ID 必须存在于本会话、并且没被撤回；
  - 数字必须出现在证据文字里（规则从 Catchup 的 `validators/numbers.py` 移植到 `mc-insight`，包括序数词和英文月份的处理）；
  - 引用的原话不超过 25 个词。

  不通过的操作丢弃，并在下一轮提示词里带上错误原因。
- **转写更正后的联动：** 某个事件被 `corrected` 或 `retracted` 时，引用它的要点降为 `tentative`，在下一轮归并时重新判断。

**“我错过了什么”**

- 1 分钟和 5 分钟：不调用模型，直接列出这段时间里 confirmed 的要点。
- 15 分钟：要点少于 2 条时，调一次模型总结这段转写，结果同样要带证据。

**结束报告**

- 会话结束，并且转写完成（结束后模式要等整段转写完）后，用全文生成报告：要点、数字、决定、问题、行动项，每节都带证据时间码。
- 引用已撤回事件的内容不能写入报告。

**模型调用**

- OpenAI 兼容的 Chat Completions，配置文件写法沿用 Catchup 的 `llm_config.json`（主供应商加备用供应商，模型和单价都写在文件里）。
- 密钥存钥匙串。
- 每一路有自己的限速和费用记录（`usage_ledger`）；所有会话共用一个每日上限，超出时实时模式自动降为结束后。

**提醒（P1）**

- 先用规则匹配（正则或关键词，支持同义词表），命中后再交给模型判断要不要提醒。
- 有每日配额、静默时段和去重。

### 4.10 local-api

**传输与鉴权**

- 监听 `127.0.0.1`，端口随机（不固定）。
- 每次 App 启动生成一个 256 位的令牌，只通过本机套接字发给原生消息宿主。
- 每个请求都要带 `Authorization: Bearer <token>`，并且 Origin 必须是 `chrome-extension://<已登记的插件 ID>`。WS 握手时用 `Sec-WebSocket-Protocol: mc.v1, <token>` 传令牌，避免令牌出现在网址里。

**接口**

```
GET    /v1/health                                   → {version, protocol: 1}
POST   /v1/sessions                                 {source:{kind:'chromium_tab', tab_id, window_id, url, title, favicon_url}, summary_mode}
                                                    → {session_id, ingest_path:'/v1/ingest/<id>'}
WS     /v1/ingest/{session_id}                      音频帧和控制帧（第 6 节）
PATCH  /v1/sessions/{id}                            {summary_mode?, share?, title?, lang?}
POST   /v1/sessions/{id}/stop
GET    /v1/sessions?status=active|recent
GET    /v1/sessions/{id}                            状态、时长、积压、费用、能否共享
GET    /v1/sessions/{id}/transcript?after_rev=&from_ms=&to_ms=
GET    /v1/sessions/{id}/insights
GET    /v1/sessions/{id}/missed?minutes=1|5|15
GET    /v1/sessions/{id}/export?format=md|srt|vtt|json|opus|wav
POST   /v1/sessions/{id}/markers                    {label?}：在当前时刻打点
GET    /v1/groups/{id}/export?audio=tracks|mixed|both&text=md|json
                                                    分轨加混合导出（借鉴 LitLink）。混合版按会话时间对齐，各轨电平归一化后相加；要点和转写仍然按路分开
GET    /v1/search?q=&session=&from=&to=             各自带来源的结果列表，不合成
GET    /v1/events?sessions=a,b                      SSE：status、level、transcript、insight、alert、gap
```

**限制**

- 每条 WS 连接最多每秒 20 帧，单帧不超过 64 KB；
- REST 请求体不超过 256 KB；
- 每个插件 ID 最多 16 条活跃的 WS 连接。

桌面界面不走 HTTP：通过 Tauri 命令调用 `mc-engine` 的同一组函数，用 specta 生成类型。

### 4.11 原生消息宿主（multicorder-host）

**帧格式：** 参考 Anarlog 的 `chrome-native-host`：4 字节小端长度加 UTF-8 的 JSON，单条最大 256 KB。

**消息**

```
插件 → 宿主：{type:'hello', ext_version, protocol:1}
宿主 → 插件：{type:'hello', app_version, protocol:1, status:'ready'|'app_not_running'|'needs_update'}
插件 → 宿主：{type:'pair'}
宿主 → 插件：{type:'paired', port, token, expires_at}
插件 → 宿主：{type:'launch_app'}        // App 没有运行时，用 `open -b <bundle id>` 拉起
```

**安装**

- App 第一次启动时，在下面几个目录写入 `com.multicorder.host.json`：
  - Chrome：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
  - Edge：`…/Microsoft Edge/NativeMessagingHosts/`
  - Brave：`…/BraveSoftware/Brave-Browser/NativeMessagingHosts/`
  - Arc：`…/Arc/User Data/NativeMessagingHosts/`
- 清单里的 `path` 指向 `Multicorder.app/Contents/MacOS/multicorder-host`，`allowed_origins` 只写正式插件和开发插件的 ID。

**宿主到 App：** 连 `run/host.sock`（Unix 套接字，权限 0600），用同样的帧格式要端口和令牌。

### 4.12 界面（React，Tauri 窗口加菜单栏）

| 页面 | 内容 |
|---|---|
| 菜单栏 | 正在录的路数和总时长；“正在发声的 App”列表，一键开录；全部停止 |
| 实时面板（主页） | 每一路一张卡片：来源图标和标题、时长、电平、状态（采集中、重连中、静音、字幕积压）、总结模式开关、共享开关、最新 3 条要点、最新字幕、“我错过了什么”按钮、停止。卡片可以拖动排序；同时 6 路时用两列网格 |
| 会话详情 | 左边是时间轴（音轨的分段、空档、媒体时间），中间是转写（按 revision 显示，被更正的划掉），右边是要点（点证据就跳到音轨并播放）；导出 |
| 资料库 | 会话列表；搜索（按来源和时间筛选） |
| 关注（P1） | 订阅 Catchup 的频道和人物，开播时通知，一键打开页面并开录 |
| 设置 | 转写引擎和模型下载、模型供应商和 Key、隐私（云端功能总开关、数据保留天数）、存储占用、权限状态、插件配对状态 |
| 首次引导 | 依次说明并请求系统音频录制和麦克风权限、安装插件、开机启动 |
| 预设（P1） | 常用的来源组合加报告模板，一键同时开录几路（借鉴 aCapture 的预设） |
| 会话组和多轨时间线（P2） | 同时录的几路上下排成多条轨道，共用一个时间轴；可以对齐播放、单独静音、裁剪片段后导出（借鉴 LitLink 的多轨编辑器）。要点仍然按轨道分开显示，不合成 |

**其他交互：**

- **打点：** 全局快捷键 `⌃⌥M`，在所有正在录的路上打一个点，也可以只打在当前卡片上。点会出现在时间轴、转写和报告里。
- **无障碍：** 所有控件都有 VoiceOver 标签；状态变化（开始、断开、积压、权限丢失）用无障碍通知播报；完全可以用键盘操作。aCapture 的早期用户集中在视障社区，说明多源录音对这类用户价值很高。
- **报告模板：** 发布会、访谈、财报电话会、课程、会议，可以自定义。参考 HyNote 的模板库，但每一节都必须带证据。

- 共享组件放在 `packages/ui`，插件的侧边栏复用同一套卡片。
- 界面上的状态都来自 SSE 或 Tauri 事件，界面本身不保存业务状态。

### 4.13 打包、更新、可观测性

- **打包：** Tauri 打包器生成 DMG，用 Developer ID 签名，开启 hardened runtime，提交公证。
- **更新：** Tauri updater，更新包签名验证。
- **授权项：** `com.apple.security.device.audio-input`；不开沙盒。
- **日志：** `tracing` 写本地滚动日志。**日志里不能出现转写文字、要点或网址的路径部分**，只记 ID 和计数。崩溃上报默认关闭，用户开启后才发，内容只有堆栈。
- **本机指标：** 每一路的帧率、丢帧数、实时积压、转写延迟（P50/P95）、模型费用，显示在设置的诊断页。

### 4.14 性能目标（M1/M2，16 GB）

| 项目 | 目标 |
|---|---|
| 每个 AppTap 加重采样 | CPU 不超过 1%，内存不超过 10 MB |
| Recorder（Opus 24 kbps） | 每一路 CPU 不超过 1% |
| 本机实时转写 | 4 路同时进行，每一路字幕 P50 不超过 10 秒（V-3） |
| 空闲（没有会话） | CPU 不超过 0.2% |
| 存档 | 每一路约 10.8 MB/小时 |

## 5. Chrome 插件

### 5.1 manifest（WXT 生成，最终形态）

```json
{
  "manifest_version": 3,
  "name": "Multicorder",
  "minimum_chrome_version": "116",
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_title": "录这个标签页" },
  "side_panel": { "default_path": "sidepanel.html" },
  "permissions": ["tabCapture", "offscreen", "sidePanel", "storage", "unlimitedStorage",
                  "nativeMessaging", "activeTab", "scripting", "contextMenus", "tabs"],
  "commands": { "toggle-capture": { "suggested_key": { "default": "Alt+Shift+R", "mac": "Alt+Shift+R" },
                                     "description": "开始或停止录这个标签页" } }
}
```

- **不申请 `host_permissions`。** 读视频时间的脚本只在用户调用插件时，借 `activeTab` 用 `scripting.executeScript` 注入。这样安装时没有“读取和更改所有网站数据”的警告。
- `tabs` 权限用来读标题、图标和地址的变化。

### 5.2 上下文分工

| 上下文 | 做什么 | 不做什么 |
|---|---|---|
| service worker | 处理入口事件；`getMediaStreamId`；创建 offscreen；原生消息配对；`tabs.onRemoved`、`onUpdated` 路由；设置图标角标 | 不保存会话状态（MV3 的 service worker 随时会被回收）。状态放在 offscreen 和 `chrome.storage.session` |
| offscreen 文档（唯一，`USER_MEDIA`） | 持有所有 MediaStream；共用的 `AudioContext({sampleRate:48000})`；每路一个 Worklet 和一条 WS；60 秒的重发缓冲；溢出时写 IndexedDB | 不画界面 |
| 媒体时钟脚本 | 读 `<video>` 的时间、暂停、倍速、是否直播；规范化视频 ID；页面跳转时重新注入 | 不读页面的其他内容 |
| 侧边栏 | 每一路一张卡片；通过 SSE 和 REST 直接连本机 App | — |
| 引导页 | 安装或打开 Mac App、配对、权限说明 | — |

### 5.3 开始采集

**入口：** 工具栏图标、快捷键 `Alt+Shift+R`、右键菜单“用 Multicorder 录这个标签页”。三者都算“调用插件”，会给当前 Tab 授予 `activeTab`。

```
SW: onClicked / onCommand / contextMenus.onClicked (tab)
  1. 如果这个 tab 已在采集：chrome.sidePanel.open({tabId}) 然后返回（停止在卡片上操作）
  2. chrome.sidePanel.open({windowId})                          // 必须在同一次用户手势里调用
  3. ensurePaired()：原生消息 hello → pair → 拿到 {port, token}，存进 storage.session
     失败：打开引导页（App 没装、没运行、版本太旧）
  4. ensureOffscreen()：runtime.getContexts 查看；没有就 createDocument({reasons:['USER_MEDIA']})
  5. streamId = await chrome.tabCapture.getMediaStreamId({targetTabId: tab.id})   // 立刻用，几秒就过期
  6. POST /v1/sessions → {session_id}
  7. runtime.sendMessage({target:'offscreen', type:'start', session_id, streamId, tab, port, token})
  8. scripting.executeScript({target:{tabId}, files:['media-clock.js']})          // 只在白名单站点
  9. 角标显示正在录的路数；这个 tab 的标题前缀可选加“● ”（默认关闭）
```

**边界情况**

- **侧边栏里的“录当前标签页”按钮：** 侧边栏里的点击能否算作对当前 Tab 的调用（授予 `activeTab`），要实测（V-E1）。不能的话，按钮改为提示“点工具栏图标”。
- **已被别的扩展或本插件采集的 Tab：** 先查 `chrome.tabCapture.getCapturedTabs()`，提示后放弃。
- **Chrome 重启：** 流不能自动恢复（每个 Tab 都要重新调用一次插件）。会话标为 `stopped(cause='browser_restart')`，卡片上提供“重新开始”。

### 5.4 offscreen 里的音频管线

```js
const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
await ctx.audioWorklet.addModule('pcm-tap.worklet.js');

async function start({ session_id, streamId, muted }) {
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
  const src = ctx.createMediaStreamSource(media);
  const gain = ctx.createGain(); gain.gain.value = muted ? 0 : 1;           // 静默采集：只听其中一路
  src.connect(gain).connect(ctx.destination);                                // Tab 被采集后默认静音，这里接回扬声器
  const tap = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
  src.connect(tap);
  const pipe = new IngestPipe(session_id);                                   // WS、重发缓冲、溢出到 IndexedDB
  tap.port.onmessage = (e) => e.data.kind === 'pcm' ? pipe.push(e.data) : levels.set(session_id, e.data.rms);
  media.getAudioTracks()[0].onended = () => stop(session_id, 'track_ended'); // Tab 关闭等
  sessions.set(session_id, { media, src, gain, tap, pipe });
}
```

**`pcm-tap.worklet.js`（AudioWorkletProcessor）**

- 输入为 48 kHz，混成单声道，经过 31 阶 FIR 低通（截止 7 kHz），**3:1 抽取**得到 16 kHz（共用的 AudioContext 固定为 48 kHz，所以是整数倍抽取，不需要通用的重采样器）。
- 每满 1600 个采样（100 ms），转成 Int16，通过 `port.postMessage({kind:'pcm', buf}, [buf])` 发出（转移所有权，不复制），附带 `seq` 和 `t_ms = performance.timeOrigin + currentTime*1000` 的对应时间。
- 每 100 ms 发一次 RMS 电平。

**为什么所有 Tab 共用一个 `AudioContext`：** 每多一个上下文就多一条音频渲染线程。共用一个上下文时，每个 Tab 是一条独立的节点链（source → gain → destination，source → worklet），节点之间不共享任何缓冲，所以不会串路。要实测 8 个 Tab 时的 CPU 占用和音频卡顿（V-2）。

**退路（V-2 失败时）：** 改成 Meeper 的做法：每一路在一个固定的、不激活的扩展页面里录（`chrome.tabs.create({active:false, pinned:true})`），代价是标签栏里多出页面。

### 5.5 IngestPipe：发给本机 App

- **连接：** 每一路一条 `WebSocket('ws://127.0.0.1:<port>/v1/ingest/<session_id>', ['mc.v1', token])`，帧格式见第 6.1 节。
- **背压：** `ws.bufferedAmount` 超过 512 KB 时，新帧先放进重发缓冲。
- **重发缓冲：** 最近 60 秒（600 帧，约 1.9 MB）。断线后按指数退避重连（0.5 秒到 10 秒）；重连握手时发 `resume_from = 最后确认的 seq + 1`，App 回复 `ack`（每秒一次，带最大连续 seq）。
- **溢出：** 断线超过 60 秒时，把帧写进 IndexedDB（`spill:<session_id>`）；恢复后先补传溢出的部分，再接实时的帧。溢出上限每一路 200 MB；超出后停止这一路，并提示。
- **App 不可用时：** 仍然录。卡片显示“等待 Multicorder App”，不丢音频（在溢出上限以内）。

### 5.6 媒体时钟脚本（视频时间轴）

- **白名单站点：** YouTube、Bilibili、Vimeo、X（Twitter）、Twitch、LinkedIn、各大会议的官网播放器。只在白名单站点注入。
- **做什么：**
  - 找到正在播放的 `<video>`（多个时取面积最大且在播放的一个）；
  - 监听 `play`、`pause`、`seeking`、`seeked`、`ratechange`，并每秒采样一次 `currentTime`；
  - 发给 service worker：`{type:'media_mark', wall_ms: Date.now(), media_ms, paused, rate, live}`。
- **是否直播：**
  - YouTube：页面里播放器状态的 `isLive`，或 `duration` 为 `Infinity`；
  - 其他站点：`duration` 为 `Infinity` 即判为直播。
- **视频 ID：** 从地址解析，例如 YouTube 的 `v=` 参数或 `/live/<id>`，Bilibili 的 `BV…`。
- **转发：** service worker 把标记交给 offscreen，在这一路的 WS 上作为文字帧发出；App 用 `wall_ms` 和音频帧的 `t_ms` 对齐，误差目标在 50 ms 以内（V-4）。
- **页面跳转：** `tabs.onUpdated` 发现地址变化时，记一个 `navigation` 标记。同一个站点内跳转就重新注入；跨站点时 `activeTab` 授权失效，视频时间轴停止，这一路**不再能共享**，但继续录音。

### 5.7 会话状态机（插件侧）

```
idle ─调用插件→ requesting ─拿到流ID且 getUserMedia 成功→ capturing ─WS 断开→ buffering ─重连成功→ capturing
                     │失败                                     │用户停止 / Tab 关闭 / 音轨结束
                     ▼                                         ▼
                   failed                                   stopping → stopped（flush 缓冲，POST stop）
```

- 状态存在 offscreen 的内存里，并镜像到 `chrome.storage.session`，键是 `tabId`。service worker 被回收后重新启动时，从这里恢复路由。
- **Tab 被关闭：** `tabs.onRemoved` 和音轨的 `onended` 都会触发停止，谁先到就用谁，只执行一次。

### 5.8 侧边栏

- 列出本浏览器窗口里的所有会话卡片，也可以切换为“全部来源”，显示 App 端的会话。卡片组件和 Mac App 共用。
- 通过 `EventSource('http://127.0.0.1:<port>/v1/events?…')` 订阅事件。SSE 不支持自定义请求头，所以令牌用 `?t=<短期令牌>` 传递：这个短期令牌由 `POST /v1/sse-ticket` 换取，60 秒内有效、只能用一次。
- 操作：总结模式、共享开关（只有能共享的会话才显示）、“我错过了什么”、静默采集、停止、在 App 里打开。
- 共享前先查询 Catchup：显示“已有 N 人在共享，继续贡献这一路的文字吗？”（[plan.md](plan.md) 第 6 节）。

### 5.9 隐私与提示

- **角标：** 正在录的路数。
- **会议站点**（Meet、Zoom 网页版、Teams 网页版）：开始录制前弹出确认，提醒用户告知参会者，并在卡片上一直显示“录音中”。
- **插件自身不联网**，只连 127.0.0.1。共享给 Catchup 由 Mac App 去发，插件不碰 Catchup 的接口。
- **商店说明里写清楚：** 为什么需要 `tabCapture` 和 `nativeMessaging`；音频只发给本机 App。

### 5.10 兼容性

- **Edge、Brave：** 同一份代码；原生消息宿主的清单路径各不相同（第 4.11 节）。
- **Arc：** 能否打开侧边栏要实测，不支持时改用弹窗。
- **Firefox、Safari：** 不支持 `tabCapture`，不做。

## 6. 协议规范（`packages/protocol`，版本 1）

### 6.1 WS 二进制帧（插件 → App）

| 偏移 | 长度 | 字段 | 说明 |
|---|---|---|---|
| 0 | 4 | magic | ASCII `MCA1` |
| 4 | 4 | seq | u32，小端，每一路从 0 开始连续递增 |
| 8 | 8 | t_ms | f64，小端，这一帧最后一个采样的墙钟时间（毫秒） |
| 16 | 2 | samples | u16，固定为 1600 |
| 18 | 2 | flags | bit0：这一帧来自溢出补传 |
| 20 | 3200 | pcm | Int16 小端，16 kHz 单声道 |

### 6.2 WS 文字帧（JSON）

```
插件 → App：{t:'hello', session_id, resume_from?: number, ext_version}
           {t:'media_mark', wall_ms, media_ms, paused, rate, live, video_key?}
           {t:'navigation', wall_ms, url, title}
           {t:'stop', reason}
App → 插件：{t:'ack', upto_seq}          // 每秒一次
           {t:'throttle', max_fps}       // App 端积压时请插件放慢（只影响补传）
           {t:'close', reason}           // 会话被 App 端停止
```

### 6.3 SSE 事件

`status`、`level`（每秒一次）、`transcript`（带 revision 和 state）、`insight`（操作后的结果）、`gap`、`alert`、`share`（共享人数、是否已有定稿）。

### 6.4 版本

- `/v1/health` 返回 `protocol`。插件发现版本不兼容时，提示更新 App 或插件。
- 只增加字段时版本号不变；删除字段或改变含义时，版本号加 1。

## 7. 测试

| 层 | 内容 | 方法 |
|---|---|---|
| Rust 单元 | 环形缓冲、重采样精度、VAD 块策略（包括 15 秒上限）、Opus 分段和恢复（截断的文件）、WS 帧解析、seq 缺口、要点校验（证据存在、数字出现、撤回联动） | `cargo test`；用假的音频源（参考 Anarlog 的 `audio-mock`） |
| TS 单元 | Worklet 的抽取和滤波（输入扫频信号检查混叠）、帧编码、IngestPipe 的重连和续传 | vitest |
| 集成 | engine 加 local-api 加假的 TabSource：断线重连、溢出补传、模式切换和补转、App 重启后恢复 | `cargo test --features it` |
| **串路验收** | 6 个 `afplay` 进程（各是独立进程，正好测按进程 tap）加 4 个测试网页（各播一段 TTS 音频，**每段埋有不同的专有词**），同时录 2 小时，检查每一路的转写**只含自己的专有词** | 脚本 `scripts/isolation-test.sh`；Playwright 加载插件打开测试网页 |
| 长时间 | 4 小时、8 路；睡眠唤醒、拔插耳机、切换输出设备、断网、磁盘接近满 | 手动加脚本 |
| 系统矩阵 | macOS 14.4、15、26、27；Chrome 稳定版、Edge | 每个版本发布前跑一遍 |
| 隐私 | 不开云端功能时，抓包确认没有任何外连 | Little Snitch 或 `nettop` |

## 8. 代码来源与改造清单

| 我们的模块 | 来源（许可证） | 改造 |
|---|---|---|
| `mc-capture-macos::process` | **Fader** `AudioProcessMonitor.swift`、`HALProperty.swift`（MIT）；SonicFlow `AudioProcessDetector.swift`（MIT）；AudioCap `CoreAudioUtils.swift`（BSD-2） | 用 Rust 和 `cidre` 重写；三级退路的归组（负责进程 → 父进程 → 最外层 .app）；2 秒轮询；服务重启后重建；列表规则；按 bundle ID 合并 |
| `mc-capture-macos::app_tap` | **Fader** `ProcessTap.swift`、`ProcessTap+Idle.swift`、`MixerEngine+Taps.swift`（MIT）；AudioCap `ProcessTap.swift`（BSD-2）；Meetily `capture/core_audio.rs`（MIT） | 每个 App 一个 tap；改成 `Unmuted`、不重新播放；先建后拆；选时钟设备；失败时定时重试；空闲时暂停 IO；macOS 26 的 bundle ID 采集 |
| `mc-capture-macos::orphan`、健康检查 | 借鉴 FineTune 的思路（GPL-3.0，**只看思路，不复制**） | 自己实现：启动时清理名称前缀为 `Multicorder-` 的残留设备；超过 2 秒没有回调就判为 tap 已死 |
| `mc-audio::ring`、`mc-audio::dropout` | Anarlog `audio-actual/rt_ring.rs`、`async_ring.rs`，`listener-core/source/pipeline.rs` 的掉线检测（MIT） | 去掉麦克风和系统声的对齐逻辑，改成每一路独立 |
| `mc-capture-macos::mic` | Anarlog `audio-actual/mic.rs`（MIT） | — |
| `mc-engine::session` | Anarlog `listener-core/actors/session/*`（MIT） | 单会话改成每一路一个；加入 TabSource 和 InsightActor |
| `mc-recorder` | Anarlog `listener-core/actors/recorder/*`（MIT） | 编码从 mp3/wav 改成 Ogg/Opus；加 SHA-256 和分段索引 |
| `mc-vad` | Anarlog `audio-chunking`、`vad`（MIT）；Meetily `vad.rs`（MIT） | 加 15 秒上限 |
| `mc-asr::{whisper, speechanalyzer, soniox}` | Anarlog `whisper-local`、`transcribe-speechanalyzer`、`soniox`（MIT） | 统一到 `AsrAdapter` |
| `mc-asr::parakeet` | Meetily `parakeet_engine`（MIT） | — |
| `apps/host` | Anarlog `chrome-native-host`（MIT） | 消息改为配对；加本机套接字 |
| `apps/extension` 的 SW 和 offscreen 骨架 | Google `sample.tabcapture-recorder`（Apache-2.0） | 扩展成多路；`MediaRecorder` 换成 Worklet 加 WS |
| `mc-insight::numbers` | Catchup `media/src/catchup_media/validators/numbers.py`（自有代码） | 移植到 Rust |
| 回声消除（可选） | Anarlog `aec`（MIT，**模型许可证待核对**） | 只在会议两轨时启用 |

**不复制的：** Screenpipe（商业许可）、OBS（GPL）、FineTune（GPL-3.0）、Meeper（MPL-2.0）、LitLink（专有许可）、Recall.ai 示例插件（没有许可证），这些都只借思路。

**闭源产品：** Notta、aCapture、AppAudio、Audio Hijack、Wasper 等不反编译，也不还原代码，只做黑盒体验（R0-4）。

**流程：**

- 复制进来的代码放在 `third_party/<来源>/`，或者保留原文件头，并加上 `Modified by Multicorder, 2026`；
- `THIRD_PARTY_NOTICES.md` 里写明来源、提交和许可证全文；
- 每次升级上游，记录下新的提交号。

## 9. 实现任务（R0–R2）

| 编号 | 任务 | 验收 |
|---|---|---|
| R0-1 | `mc-capture-macos` 验证：同时开 3 个 `afplay` 进程的 tap，各写一个 WAV | 三个文件互不串音；`set_desc` 增删进程时不断流（V-1） |
| R0-2 | 插件验证：3 个 Tab → offscreen → Worklet → WS → App 写 WAV | 三路互不串音；8 个 Tab 时的 CPU 占用（V-2） |
| R0-3 | 原生消息宿主配对 | 插件拿到端口和令牌；App 没运行时能拉起 |
| R0-4 | 黑盒体验 Notta（5 个 Tab）、aCapture、AppAudio、Wasper、LiveScript、Audio Hijack、LitLink Pro：记录权限提示的类型（Core Audio tap 还是 ScreenCaptureKit）、并发上限、断开和恢复时的表现、导出格式 | 写进竞品报告；以此确认我们的并发上限和交互 |
| R1-1 | `mc-store` 的表结构和迁移；`mc-recorder`；会话的 actor 树 | 杀掉进程后重启，最多丢 1 分钟 |
| R1-2 | AppWatcher 和界面上的“正在发声的 App” | 6 个 App 正确归组（Chrome、Slack、Zoom、Spotify、微信、Safari） |
| R1-3 | 插件的 IngestPipe（续传、溢出）、侧边栏卡片、媒体时钟脚本 | 断开 90 秒后恢复，录音完整 |
| R1-4 | 串路验收脚本 | 2 个 Tab 加 1 个 App 同时 2 小时，零串路 |
| R2-1 | `mc-vad`、`mc-asr`（SenseVoice、Parakeet、Whisper）、调度器 | 4 路同时实时转写，P50 不超过 10 秒（V-3） |
| R2-2 | `mc-insight`：归并、校验、“我错过了什么”、报告 | 95% 以上的要点能点回音轨的对应位置 |
| R2-3 | 模式切换和补转；结束后模式的 corrected 替代 | 切换前后的文字连续 |
| R2-4 | 检索与导出；诊断页 | — |

## 10. 待验证事项

| 编号 | 事项 | 不成立时 |
|---|---|---|
| V-1 | 每个 App 一个 tap，同时 6 路，在 `Unmuted`（只录不放）时的 CPU 占用和稳定性；先建后拆有没有空档；`Tap::set_desc` 能否原地更新而不断流。Fader 和 FineTune 在生产中同时运行多个 tap，可行性风险已大幅降低 | `set_desc` 不行就只用先建后拆 |
| V-7 | 不能调用私有函数 `responsibility_get_pid_responsible_for_pid` 时（例如以后系统移除），归组是否仍然可用 | 退回父进程和路径；Safari 的声音会显示成单独的 WebKit 辅助进程，界面上提示用户 |
| V-2 | 一个 offscreen 文档、一个 AudioContext 下 8 个 Tab 是否稳定；后台 2 小时会不会被回收 | 改成每一路一个扩展页（Meeper 的做法） |
| V-3 | 本机引擎在 M1/M2 上能同时实时转写几路 | 降低默认路数；实时字幕默认用云端（需要用户自带 Key） |
| V-4 | 视频时间标记和音频帧的对齐误差 | 共享时窗口放宽到 30 秒 |
| V-5 | 签名、公证之后，tap 和原生消息宿主是否正常 | — |
| V-E1 | 侧边栏里的点击能否授予 `activeTab` 并调用 `getMediaStreamId` | 只保留工具栏图标、快捷键和右键菜单三个入口 |
| V-6 | Anarlog `aec` 的 ONNX 模型许可证 | 不启用回声消除，只分两轨 |
