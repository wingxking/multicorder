# Multicorder 与 Catchup：两个产品的规划与技术架构 v3

日期：2026-11-18　状态：方案，未开发。本文取代同日的 `capture-plan.md`（v1、v2）。

同目录还有三份配套文档：[竞品功能调研](01-competitor-features.md)、[源码架构对比](02-architecture-comparison.md)、[详细技术设计](03-technical-design.md)。产品规划以本文为准，实现以技术设计为准。

**输入：**

- 用户的三轮要求：
  - 两个产品独立；
  - 用户自愿共享文字给 Catchup，同一视频可以多人共享，服务端融合；
  - 定稿后删除实时内容；
  - 名字定为 Multicorder。
- 独立调研报告《多路音视频实时情报平台：产品调研、PRD 与 Roadmap（2026-11-18）》（下称“调研报告”）。
- 五个开源竞品的源码：2026-11-18 克隆到本机临时目录，只读，没有运行。
- 本仓库 `media/` 的代码。

Multicorder 不属于 Catchup 的实施计划。第 7 节是 Catchup 要做的改动，开发前要先写进 `architecture.md`，并在实施计划第 13 节记下决定。

## 0. 结论

1. **名字：Multicorder（中文名“多录”）。** multi 加 recorder，一眼能看出是“同时录多路”。2026-11-18 在 App Store 和网页上没找到同名产品，商标和域名还没查。另外调研报告指出了一个问题：**已有产品 CatchUp（catchup.help）宣称做“直播实时总结”，和 Catchup 是同一品类、同一个名字**。Catchup 上线前要处理这个冲突（D-25）。
2. **两个产品，一张网。**
   - Multicorder 是本地多路录音工具。用户自愿把公开视频的转写文字共享给 Catchup。
   - Catchup 是公开情报站。它把多人共享的文字融合成实时总结，结束后生成最终总结。
   - Catchup 还把自己的“频道开播”信号提供给 Multicorder：用户收到提醒后，打开页面在本机录制。这正好对应调研报告里“云端发现、本地采集”的设计。
3. **桌面端改用 Tauri 2 + Rust + React**（v2 是纯 Swift）。读源码后的依据：
   - Meetily 和 Hyprnote（现名 Char/anarlog）都用 Tauri + Rust，通过 `cidre` 调 Core Audio taps，通过 `wasapi` 支持 Windows，已经在生产中验证过；
   - 调研报告也推荐这套技术栈；
   - React UI 可以和插件、网页共用；
   - 以后加 Windows 只需要换采集层。
4. **插件到桌面：用 WebSocket 推 PCM 帧，不再上传压缩分段。** 插件只做 `tabCapture → AudioWorklet → 16 kHz PCM16 → WebSocket`；存档、切段、转写全在桌面端。这样有两个好处：
   - 去掉了 v2 里 `MediaRecorder` 重开时的缝隙问题（v2 的 V-2）；
   - 实时字幕可以做到秒级。

   配对和元数据走 Chrome 原生消息，Hyprnote 的 `chrome-native-host` 就是这么做的。
5. **采用调研报告的三条硬约束：**
   - 每一路的采集、存档、转写、摘要、上下文都独立，默认不跨来源合成；
   - 每个 AI 观点都能回到具体的音轨和时间码；
   - 云端发现和云端媒体采集是两种不同的权限。

   Catchup 的多人融合只合并**同一个视频**的多份转写，不跨视频合成，和第一条不冲突。
6. **闭源竞品不反编译，也不搬它们的代码。** 已分析的五个开源项目里有三个是 MIT 或 BSD，可以在保留署名的前提下复用（第 3 节）。

## 1. 对调研报告的 review

| 调研报告的主张 | 结论 | 理由 / 调整 |
|---|---|---|
| 一个底座、两种体验（Capture Workspace + Live Intelligence） | **改为两个产品** | Live Intelligence 的“云端发现、订阅、提醒”就是 Catchup 已有的雷达和直播分类（M5-10、M5-11），不必在 Multicorder 里再建一套云服务。Multicorder 通过 Catchup 的公开接口订阅 |
| 每一路独立，默认不跨来源合成 | 采用 | 写成数据模型的不变量（第 5.3 节）。Catchup 融合的是同一视频的多份贡献，不算跨来源 |
| 云端发现和云端采集分属两种权限；YouTube 开发者政策限制下载和存储音视频 | 采用，并**反过来审查 Catchup** | Catchup 现在用 yt-dlp 在服务端下载 YouTube 音频，`plan.md` 已承认违反 YouTube 条款。Multicorder 的共享文字加上平台字幕，可以逐步替代服务端下载（D-24） |
| Tauri 2 + React + Rust 守护进程 + Swift 采集 | 采用，**去掉 Swift** | `cidre` 已经封装了 Core Audio taps 和聚合设备，Meetily 和 Hyprnote 都只用 Rust。少一种语言，一个人开发更现实 |
| 本地 WebSocket 传音频帧，原生消息只做配对 | 采用 | 取代 v2 的 HTTP 分段上传（对插件来说，桌面端总在本机） |
| 转写事件分 `partial/final/corrected/retracted`，摘要用 upsert/confirm/retract，不整篇重写 | 采用 | 和 Catchup 的卡片校验、撤回思路一致；控制费用随时长增长 |
| 存档分段 1–5 分钟，Opus/FLAC，带 SHA-256 | 采用，取 1 分钟 Opus | 存档分段和转写分块分开：转写按 VAD 切，每块不超过 15 秒 |
| 云端转写：Soniox 约 $0.12/小时为首选对照，Deepgram、AssemblyAI、OpenAI 对比；本地用 sherpa-onnx | 采用，并**补充本地引擎** | 本地有 whisper（Metal）、Parakeet（ONNX）、SenseVoice（sherpa-onnx）和 Apple SpeechAnalyzer（macOS 26，Hyprnote 已接入）。本地优先，云端靠用户自带 Key 或付费额度 |
| 首发范围：2 个 Tab + 1 个原生 App，Mac 加 Chromium | 采用 | 第 8 节的 R1 闸门 |
| 定价：免费 / 自带 Key $7–12 / 托管 $19–29 / 团队 $49+，按“流小时”计量 | 采用，作为实验假设 | 新增“共享换额度”：共享文字给 Catchup 的用户获得托管额度，这是 Catchup 覆盖率增长的引擎（M-D3） |
| 先做 15–20 次需求访谈，10 位试点用户连续两周 | 采用 | 放在 R0 和 R4 |
| 调研报告没有多人共享和融合 | **补上** | 用户 2026-11-18 的要求，见第 6 节 |
| 微信、抖音“调研后再定” | 保持 | 不做逆向签名或抓包代理；需要时用 Tab 或 App 采集，个人使用，不共享 |

## 2. 两个产品

### 2.1 定位

|  | Multicorder（多录） | Catchup |
|---|---|---|
| 一句话 | 同时录多个 Tab 和 App，每一路都有字幕、总结和证据 | 全球科技情报站，口头内容也能实时变成要点 |
| 用户 | 每周跟踪 4 个以上音视频信源的人：研究员、投研、创作者、跨境团队 | 读者 |
| 数据 | 默认只在本机 | 公开内容；共享的文字私有保存，定稿后删除 |
| 收入 | 自带 Key 订阅、托管额度、团队版 | 规模化之后的赞助和 B2B |
| 关系 | 向 Catchup 共享文字；从 Catchup 订阅开播信号 | 融合共享的文字；把开播信号提供给 Multicorder |

### 2.2 两个产品之间的三条通道

```
Catchup ──开播信号、频道、人物（公开接口）──▶ Multicorder 的“关注”页 → 提醒 → 用户打开页面，本机录制
Multicorder ──共享文字（自愿，按会话）──────▶ Catchup 的共享接口 → 融合 → 实时总结 → 最终总结
Multicorder ──按链接查询（公开接口）────────▶ Catchup 已有总结时直接给出链接，并显示“已有 N 人在共享”
```

**不经过任何通道的内容：** 音频；App、麦克风和会议的内容；私人会话的总结；Catchup 自己的逐字稿。

## 3. 开源竞品源码分析（2026-11-18）

**分析方式：** 浅克隆到临时目录，只读，没有运行。Hyprnote 的仓库很大，只取了目录树和相关文件。

| 项目 | 许可证 | 技术栈 | 采集做法 | 转写与总结 | 我们复用什么 |
|---|---|---|---|---|---|
| [Meetily](https://github.com/Zackriya-Solutions/meetily) | MIT | Tauri 2 + Rust + Next.js | `cidre` 的 `TapDesc::with_mono_global_tap_excluding_processes`：**全局** tap 加私有聚合设备，**只用 tap，不加输出设备**（否则有回声，代码里专门注明）；`cpal` 采麦克风；两路按时间窗对齐后混音 | Silero VAD（16 kHz），实时路径的静音判定 500 ms，批量 2000 ms；whisper-rs 和 Parakeet（ort）；多家模型供应商写摘要；每 30 秒存一个检查点文件，结束后用 ffmpeg 合并 | 聚合设备的参数、环形缓冲加唤醒的写法、VAD 参数、检查点存档的思路 |
| [Hyprnote / Char](https://github.com/fastrepl/hyprnote) | MIT（2026-11 现状；早期是 AGPL） | Tauri（`apps/desktop`）正迁往 GPUI；150 多个 Rust crate | `audio-actual/speaker/macos.rs` 也是 `cidre` 全局 tap；`wasapi` 支持 Windows；`aec` 消除回声；`detect` 用辅助功能接口识别会议 App 和浏览器会议；`tcc` 查询权限 | `audio-chunking`：VAD 切块，至少 200 ms 语音，短块间隔 250 ms 内合并；`soniox`、`openai-transcription`、`transcribe-speechanalyzer`、`whisper-local`；`pyannote` 分离说话人 | **`chrome-native-host`**：Chrome 原生消息宿主，消息上限 256 KB，只传会议元数据（网址、是否进行中、参会者），写入状态文件给桌面端读——正好是我们配对通道的样板；`audio-chunking` 的块策略；SpeechAnalyzer 的接入 |
| [AudioCap](https://github.com/insidegui/AudioCap) | BSD-2 | Swift | **按进程**：`CATapDescription(stereoMixdownOfProcesses: [objectID])`，聚合设备挂 tap，`AudioDeviceCreateIOProcIDWithBlock` 读数据，`AVAudioFile` 写文件；`kAudioHardwarePropertyProcessObjectList` 列出进程，读 bundle ID 和是否在发声 | — | 按进程建 tap 的参数，改写成 `cidre` 的调用。**注意：** 它用私有 TCC 接口（`TCCAccessPreflight`）查权限，我们不用 |
| [audiotee](https://github.com/makeusabrew/audiotee) | MIT | Swift 命令行 | 全局 tap，PCM 输出到标准输出，可设采样率 | — | 作为第二份 tap 参考 |
| [Meeper](https://github.com/serg-plusplus/meeper) | MPL-2.0（文件级的 copyleft） | MV3，React | 旧接口 `chrome.tabCapture.capture`：每个会话一个扩展页，把 tab 流接回 `AudioContext.destination` 防止静音；`MediaRecorder` 每个窗口停一次、重开一次，再送 Whisper | OpenAI Whisper 加 ChatGPT，用户自带 Key；会话存 IndexedDB | 只借思路，不复制代码（复制的文件要按 MPL 开源） |

**从源码得到的结论：**

1. **几个开源竞品都只做全局 tap，没有按 App 分开**，只有 AudioCap 的示例是按进程的。**按 App 多路**就是 Multicorder 在采集层的实际差异。实现就是“每个 App 一个 `stereoMixdownOfProcesses` tap、一个私有聚合设备”，`cidre` 有对应的 `TapDesc` 构造方法（实现时核对具体签名）。
2. **聚合设备只挂 tap，不挂输出设备**（Meetily 修过这个回声问题）。
3. **VAD 要有最长时长。** Meetily 的 #756 记录了一个问题：连续播放的音频（例如播客）会让一个 VAD 段一直不结束，实时文字迟迟不出。我们给每块设 15 秒上限。
4. **权限检测不用私有接口。** 被拒绝时 tap 只会返回全零（Meetily 注明），检测方法是：建 tap，读 2 秒，全零就提示去系统设置授权。
5. **原生消息只传元数据和控制命令**，单条有大小上限；音频走本机 WebSocket。

## 3.1 闭源竞品

Granola、Audio Hijack、Otter、Fireflies、Notta、LiveScript、Wasper 都是闭源的，许可协议禁止反向工程，所以只做黑盒分析：

- 安装、使用，记录它们的权限请求、流程和界面；
- 测并发上限、延迟和失败时的表现；
- 结论写进竞品表。

其中 **Wasper**（Mac App 加 Chrome 插件，插件把 Tab 的声音交给本机 App 转写）的结构和我们最像，R0 要优先体验。

## 4. Multicorder 的功能

| 优先级 | 功能 | 验收 |
|---|---|---|
| P0 | 多 Tab 同时采集（Chrome、Edge） | 2 个 Tab 各自出独立音轨；停一路不影响另一路 |
| P0 | 多 App 同时采集（每个 App 一个 tap）、麦克风一路 | 2 个 Tab 加 1 个 App 同时 2 小时，**用预埋不同专有词的测试音频检验，零串路** |
| P0 | 先录音：1 分钟 Opus 分段，带 SHA-256；断电或崩溃最多丢 1 分钟 | 杀进程后可以恢复 |
| P0 | 每一路的总结模式：关 / 实时 / 结束后，随时切换；中途切换后补转写 | 切换前后的文字连续 |
| P0 | 实时字幕（partial/final）、滚动要点（upsert/confirm/retract，带证据）、“我错过了什么”（1/5/15 分钟）、结束报告 | 95% 以上的要点可以点回音轨的时间点 |
| P0 | 本地检索（FTS5，按来源和时间筛选），导出 Markdown、SRT、VTT、JSON | — |
| P0 | 隐私：不开云端功能时没有任何出站流量；可以删除一路的全部数据 | 抓包验证 |
| P0 | 共享给 Catchup（只限公开视频的 Tab 会话）、“已有 N 人在共享”提示、录制后补传 | 第 6 节 |
| P1 | 关注：订阅 Catchup 的频道和人物，开播提醒后一键打开并录制 | — |
| P1 | 关键词提醒（规则先匹配，命中后再交给模型判断；有配额和静默时段） | 试点用户认为有用的比例不低于 70% |
| P1 | 自动录制规则（某个 App 开始发声就录；识别会议并显示录音提示） | — |
| P1 | 云端转写（Soniox、Deepgram，用户自带 Key 或托管额度） | — |
| P1 | 会话组和预设：常用的来源组合一键同时开录（借鉴 aCapture）；会议两轨（我 / 对方） | — |
| P1 | 打点（全局快捷键），点会出现在时间轴、转写和报告里（借鉴 aCapture） | — |
| P1 | 报告模板：发布会、访谈、财报电话会、课程、会议（借鉴 HyNote），每一节都带证据 | — |
| P1 | 分轨加混合导出：每一路一个文件，再加一份按时间对齐的混合版；转写和要点仍按路分开（借鉴 LitLink） | — |
| P1 | 无障碍：完整支持 VoiceOver 和键盘操作（aCapture 的早期用户来自视障社区） | VoiceOver 下能走完开录、打点、停止、导出 |
| P2 | 多轨时间线：同组的几路上下排列，对齐播放、裁剪、导出（借鉴 LitLink 的多轨编辑器） | — |
| P2 | 本机 CLI 和 MCP：让其他工具或 AI 助手读取本机的会话、转写和要点（借鉴 Anarlog 和 Hushscript） | 只监听本机，需要令牌 |
| P2 | 会议网页本身有字幕时，读字幕作为免费的转写来源（借鉴 Recall.ai 的示例插件），只在用户自己参加的会议里做 | — |
| P2 | Windows（`wasapi` 按进程 loopback，Windows 10 build 20348+）；手机查看端和分享链接；团队空间 | — |
| 不做 | 绕过 DRM、偷偷录音、逆向签名拉流、默认跨来源合成观点；改变 App 声音的去向（LitLink 那样的路由和虚拟声卡）：我们只录，不改变用户听到的声音 | — |

## 5. Multicorder 的技术架构

### 5.1 仓库结构（独立仓库 `multicorder`，pnpm 加 Cargo 工作区）

```
apps/
  desktop/            Tauri 2：src-tauri（Rust，引擎都在这里）+ src（React UI）
  extension/          WXT + MV3 + React（侧边栏复用 packages/ui）
  native-host/        Rust 命令行：Chrome/Edge 原生消息宿主（参考 Hyprnote 的 chrome-native-host）
crates/
  capture-core/       Source 接口、实时安全的环形缓冲、重采样到 16 kHz（rubato）
  capture-macos/      cidre：进程列表、按 App 归组、每个 App 一个 tap 加聚合设备、麦克风
  archive/            1 分钟 Ogg/Opus 分段（opus + ogg crate），SHA-256，崩溃恢复
  vad/                Silero（ort），每块最长 15 秒
  asr/                AsrAdapter：whisper-rs（Metal）、parakeet（ort）、sherpa-onnx（SenseVoice）、
                      speechanalyzer（macOS 26）、soniox / deepgram（流式）、openai 兼容（批量）
  insight/            滚动要点的归并器、OpenAI 兼容的模型客户端、数字校验（规则移植自 Catchup）
  store/              SQLite WAL + FTS5（rusqlite），迁移
  local-api/          axum，监听 127.0.0.1：WS 接收音频、REST、SSE
  share/              Catchup 客户端：查询、贡献、outbox 重试
packages/
  protocol/           TS 类型由 Rust 用 specta 生成，插件、UI、网页共用
  ui/                 React 组件：每一路一张卡片、时间轴、证据跳转
```

### 5.2 进程与数据流

```
Chrome 插件 offscreen 文档：每个 Tab 一个 AudioWorklet → PCM16 16k 帧（100 ms）+ 视频时间标记 ─WS─┐
                                                                                              ▼
Multicorder.app（Tauri 主进程，tokio）                                         local-api（127.0.0.1）
  每一路一个会话任务组（相互隔离）：
    Source（tap / 麦克风 / WS）→ 环形缓冲 ─┬─▶ archive（1 分钟 Opus，永不阻塞）
                                         └─▶ vad → asr 队列 → transcript_events → insight 归并 → insight_events
  全局：asr 调度器（各路轮转，实时优先，按实测设并发上限）、模型调用限速、usage_ledger 计量
  界面：SSE 推送每一路的字幕和要点；Tauri 窗口和插件侧边栏用同一套 UI
```

- **隔离：** 每一路的队列、失败状态、费用额度、重试都独立。转写或模型卡住时，只会让这一路的文字晚出，**不会丢任何一路的原始音频**（存档是单独的消费者，不和转写共用队列）。
- **原生消息配对：** App 首次启动时，在 Chrome 和 Edge 的 `NativeMessagingHosts` 目录写入宿主清单，只允许 Multicorder 插件的 ID。插件连上宿主后拿到本机端口和一次性令牌，宿主通过本机套接字向主进程要令牌。
- **WS 协议：**
  1. 建连时先发一条 JSON：`{session_id, source: tab, url, title, tab_id}`；
  2. 之后是二进制帧：`seq(u32) + PCM16`；
  3. 文字帧是视频时间标记：`{seq, media_ms, paused, live}`，每秒一次，或在跳转和暂停时立即发。

  断线时，插件在内存里保留最近 60 秒的帧，按 `seq` 续传。
- **安全：**
  - 只监听回环地址；
  - 校验令牌和 Origin（`chrome-extension://<id>`）；
  - 限制帧大小和速率；
  - 模型和云端转写的密钥存钥匙串；
  - 不开云端功能时不发起任何外部连接。

### 5.3 数据模型（SQLite）

隔离不变量：`source → capture_session → audio_segment → transcript_event → insight_event`。所有查询都带 `session_id`，跨会话只能检索，不能合成。

| 表 | 关键字段 |
|---|---|
| `sources` | id、kind（`chromium_tab`/`mac_process`/`mic`）、title、canonical_url、bundle_id、video_key（只限公开视频） |
| `capture_sessions` | id、source_id、status、summary_mode（off/live/after）、share_state（off/on/ended）、asr_provider、started_at、ended_at |
| `audio_segments` | session_id、seq、start_ms、end_ms、path、sha256 |
| `media_marks` | session_id、seq、media_ms、paused、live（视频时间映射，共享时对齐用） |
| `transcript_events` | id、session_id、start_ms、end_ms、media_start_ms、revision、state（partial/final/corrected/retracted）、text、lang、engine、confidence |
| `insight_events` | id、session_id、type、revision、state（tentative/confirmed/retracted）、text、evidence（JSON：事件 ID 和时间） |
| `reports` | session_id、body、is_final |
| `alert_rules` / `alert_events` | 关键词提醒 |
| `usage_ledger` | session_id、provider、unit（流秒、token）、usd |
| `share_outbox` | contribution_id、seq、payload、attempts |

`transcript_fts` 只索引 `final` 和 `corrected` 状态的事件。

### 5.4 转写与总结

- **引擎选择**（每一路单独选，默认本地）：
  - 中文：SenseVoice（sherpa-onnx）；
  - 英文：Parakeet；
  - 多语言或高精度：whisper large-v3-turbo（Metal）；
  - macOS 26 上可以试 SpeechAnalyzer。
- **云端流式**（Soniox、Deepgram）只在用户开启时用，提供 1–2 秒的 partial 字幕。
- **本地实时：** VAD 切块，每块最长 15 秒，文字约晚 3–10 秒出现，直接是 final，没有 partial。
- **结束后模式：** 用最准的本地模型对存档做批量转写，结果标为 `corrected`，替代实时转写的文字。
- **要点归并：**
  1. 每 30–60 秒把新增的 final 文字和当前要点状态交给模型，模型返回一组操作（upsert、confirm、retract），每条带证据事件 ID；
  2. 代码检查证据 ID 确实存在、数字确实出现在证据里（规则移植自 Catchup 的 `validators/numbers.py`），不通过就丢弃。
- **结束报告：** 用全文生成，引用已撤回事件的要点不能写进报告。
- **模型：** OpenAI 兼容接口，配置沿用 `llm_config.json` 的写法（主供应商加备用供应商）。

### 5.5 打包与权限

- **打包：** Tauri 打包器生成 DMG，Developer ID 签名加公证，更新用 Tauri updater。不上 Mac App Store：沙盒限制原生消息宿主的安装位置。
- **权限说明：** Info.plist 写 `NSAudioCaptureUsageDescription` 和 `NSMicrophoneUsageDescription`。权限是否已授权，用“建 tap 读 2 秒，全零就提示”来判断，不用私有 TCC 接口。
- **插件：** 先以不公开的方式提交 Chrome 应用商店，Edge 使用同一份代码。

## 6. 共享与融合（Multicorder → Catchup）

### 6.1 规则

1. **能共享的会话：** 只有白名单平台公开视频的 Tab 会话。必须有 `video_key`，并且有视频时间标记。
2. **默认关闭：** 录制中和录制后都能打开。打开共享会强制在本机转写这一路。
3. **先查询：** 打开共享前先查 Catchup。
   - 已有人在共享时提示：“Catchup 上已有 N 人在共享这个视频，继续贡献这一路的文字吗？”继续就作为一路新的贡献。
   - Catchup 已有最终总结时，直接给出链接。
4. **只发文字：** final 或 corrected 状态的转写片段，带视频时间、语言、引擎和置信度。
5. **匿名：** 每台设备一个令牌，MVP 阶段需要邀请码注册。

### 6.2 接口（Catchup 的 `contracts/share-api.openapi.yaml`）

```
POST /api/share/v1/devices                        邀请码 → 设备令牌
GET  /api/share/v1/status?url=…                   → {video_key, sharable, contributors_live, event_url?, final_ready}
POST /api/share/v1/contributions                  {video_key, url, title, is_live, lang} → id
PUT  /api/share/v1/contributions/{id}/segments/{seq}   {media_start_ms, media_end_ms, wall_clock, text, lang, engine, confidence}
POST /api/share/v1/contributions/{id}/end
```

### 6.3 Catchup 侧的融合

```
contributions · contributed_segments ─fuse→ segments(pass='shared') ─写作循环（现有）→ 实时卡片和滚动总结
                                                                 └─结束→ report(is_final) → 删除实时卡片、滚动总结和贡献文字
```

1. **对齐：** 按视频时间切成 15 秒的窗口。直播没有视频时间标记时，用墙钟时间加每一路的延迟估计。
2. **每个窗口选一份文字：**
   - **两路及以上：** 用字符 n-gram 算相似度，取和其他路最一致的一路；和多数明显不一致的一路判为异常，扣这台设备的信誉分。
   - **只有一路：** 直接采用，标为“单一来源”。
   - **Catchup 自己也有这个窗口的文字：** 优先用自己的，共享的文字只补缺失的窗口。
3. **写作：** 现有写作循环和校验（数字、引用、归属）全部照旧。
4. **定稿：**
   - 直播结束由现有的探测判断；录播在全部贡献结束、而且覆盖率达标或超过等待时间后定稿。
   - 最终总结发布后，通过现有的撤回出口删除实时内容，站点、RSS 和搜索同步删除；贡献的文字置空，只保留统计。

## 7. Catchup 的改动与新规划

| 改动 | 内容 |
|---|---|
| 共享接收 | 新迁移：`segments.pass` 增加 `shared`；新表 `devices`、`contributions`、`contributed_segments`（私有，和逐字稿同等对待）；`pipeline/fuse.py`；`writer.py` 现在只读 `pass='live'` 关联的片段，`repair.py` 只读 `captions`/`repair`，两处都要加入 `shared` |
| 共享接口 | 新契约文件；媒体服务新开一个入口，经站点反向代理对外。运营台端口仍只在本机（规则第 9 条） |
| 定稿后删除实时内容 | 改变现有的“实时卡片定稿后保留”（D-20） |
| 给 Multicorder 的公开接口 | 正在直播、频道和人物、按链接查询。复用架构第 5.3 节的公开读取接口；“按链接查询”和“正在直播列表”如果没有就补上 |
| 少依赖服务端下载 YouTube 音频 | 共享文字和平台字幕覆盖到的场次，不再在服务端下载音频（D-24）。在 Multicorder 的用户量起来之前，保持现状并承认这个风险 |
| 名字冲突 | catchup.help 已在用 CatchUp 做直播总结（D-25） |

**新增待决定事项（写进 Catchup 实施计划第 13 节）：**

| 编号 | 待决定 | 默认做法 |
|---|---|---|
| D-20 | 定稿后删除实时卡片和滚动总结 | 用户 2026-11-18 已提出；需要确认对已发出的链接和 RSS 的影响 |
| D-21 | 可共享平台的白名单 | YouTube、Bilibili 的公开视频和直播 |
| D-22 | 单一来源的窗口是否等到有人印证才公开 | 内测期间直接公开；对外开放后要等印证 |
| D-23 | 设备注册方式 | 邀请码 |
| D-24 | 是否逐步停止在服务端下载 YouTube 音频 | 有共享文字或字幕的场次不再下载 |
| D-25 | Catchup 改名还是并存 | 上线前查商标后决定 |

## 8. Roadmap（目标日期，不是交付承诺；一人开发）

| 阶段 | 日期 | Multicorder | Catchup | 闸门 |
|---|---|---|---|---|
| R0 验证 | 11/18–11/24 | 技术验证：2 个 Tab 走 WS 推 PCM，1 个 App 用 `cidre` 按进程建 tap，原生消息配对；黑盒体验 Wasper、LiveScript、Notta；15–20 次访谈 | 写 D-20 到 D-25 | 两个 Tab 和一个 App 的音轨能分开；权限流程走通 |
| R1 采集 Alpha | 11/25–12/08 | 工作区骨架、`capture-macos`、`archive`、`store`、`local-api`、插件 offscreen 和侧边栏、会话界面 | — | 2 个 Tab 加 1 个 App 同时 2 小时，零串路，没有严重丢帧 |
| R2 分析 Alpha | 12/09–12/29 | `vad`、`asr`（本地三种 + Soniox）、三种总结模式、要点归并、报告、检索、导出；中英文测试集评测 | 架构文档和契约；迁移 | 本地实时文字 P50 不超过 10 秒；云端 partial P50 不超过 2 秒；断线能恢复 |
| R3 共享与关注 | 12/30–2027/01/19 | `share`、共享开关和提示、录制后补传、关注页（Catchup 开播信号）、关键词提醒 | 共享接口、`fuse`、写作接入、定稿与删除、邀请码、正在直播接口 | 3 台设备共享同一场直播、中途断开一路：融合覆盖率不低于 95%，实时总结不断档，定稿后实时内容已删除 |
| R4 可靠性内测 | 01/20–02/16 | 签名、公证、更新；4 小时持续采集；删除数据；自带 Key 和托管额度的定价实验；10–20 位试点用户 | 内测 | 4 小时稳定；4/10 的试点用户连续两周使用 |
| R5 公开 Beta | 02/17–03/31 | 公开下载、插件公开上架、上手引导、错误遥测、收费 | 对外开放共享（D-22 生效） | 激活、留存、成本都达标 |
| R6 扩张 | 2027/04– | Windows、手机查看端、团队 | 更多白名单平台 | 看数据决定 |

Catchup 原有的 M0–M11 继续推进。R2 的中英文评测集和多路转写数据也可以用来做 Catchup M0-03 的基准。

## 9. 验证与指标

| 编号 | 事项 | 方法 / 目标 |
|---|---|---|
| V-1 | 每个 App 一个 tap，最多能同时开几个；辅助进程归组是否正确（Chrome、Electron 类 App） | 6 个 App 同时发声，各自预埋不同的词 |
| V-2 | Chrome 能同时采几个 Tab；offscreen 文档持有多个流时，后台 2 小时会不会被回收 | 4、8、12 个 Tab |
| V-3 | 本地引擎能同时实时转写几路（Mac mini、MacBook Air） | 1、2、4、8 路，测实时率和延迟 |
| V-4 | 视频时间标记和音频帧之间的对齐误差 | 两台设备同时录同一场，比较融合结果 |
| V-5 | `cidre` 的按进程 `TapDesc` 和聚合设备在已签名、已公证的 App 里能否正常工作 | R0 |
| V-6 | 中英文测试集：普通话、中英混讲、专业术语、嘈杂直播、多人重叠、长时会议 | 字错率或词错率、术语召回率、延迟、费用 |

上线指标沿用调研报告第 13 节：

- 零串路；
- 证据覆盖率不低于 95%；
- 术语召回率不低于 90%；
- 提醒有用率不低于 70%；
- 10 位试点用户中至少 4 位连续两周使用；
- 托管套餐的直接成本不超过收入的 40%。

## 10. Multicorder 的待决定事项

| 编号 | 待决定 | 默认做法 |
|---|---|---|
| M-D1 | 商标和域名（multicorder.app 等） | R0 查完再注册 |
| M-D2 | 实时字幕默认用本地还是云端 | 本地；云端靠用户自带 Key |
| M-D3 | 共享换额度的比例 | 共享 1 个流小时的文字，换 X 分钟托管转写（R4 定价实验时决定） |
| M-D4 | 是否开源 | 闭源；复用 MIT/BSD 代码时在“关于”里列出署名 |

## 11. 资料

- **源码：**
  - [Meetily](https://github.com/Zackriya-Solutions/meetily)
  - [Hyprnote / Char](https://github.com/fastrepl/hyprnote)
  - [AudioCap](https://github.com/insidegui/AudioCap)
  - [audiotee](https://github.com/makeusabrew/audiotee)
  - [Meeper](https://github.com/serg-plusplus/meeper)
  - [cidre](https://github.com/yury/cidre)
- **平台：**
  - [Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)
  - [Chrome tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture/)
  - [Windows 按进程 loopback 示例](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
  - [YouTube 开发者政策](https://developers.google.com/youtube/terms/developer-policies)
- **调研报告：** 用户提供的《多路音视频实时情报平台：产品调研、PRD 与 Roadmap（2026-11-18）》，其中的竞品、价格和来源见该报告第 19 节。
- **名字检索：** 2026-11-18 在 App Store 和网页上没找到名为 Multicorder 的产品；CatchUp 的冲突见 [catchup.help](https://catchup.help/)。
