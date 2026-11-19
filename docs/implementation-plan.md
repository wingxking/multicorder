# Multicorder 实施计划

版本：1.0（2026-11-19）　怎么建见 [03-technical-design.md](03-technical-design.md)，为什么建见 [plan.md](plan.md)，竞品见 [01](01-competitor-features.md)、[02](02-architecture-comparison.md)。

## 0. 通用完成标准

1. `cargo test --workspace` 和 `cargo clippy --workspace` 通过；`pnpm -r build` 通过。
2. 单元测试不访问外部服务。转写和模型调用只在 `scripts/e2e` 的端到端测试里使用真实密钥，密钥从环境变量读，**不写进仓库**。
3. 隔离不变量（技术设计第 0 节）在代码里有测试。
4. 复制的第三方代码记录在 `THIRD_PARTY_NOTICES.md`。

## 1. 第一版（MVP-1，本次交付）的范围

| 模块 | 本次实现 | 与设计稿的差异（已在技术设计里标注） |
|---|---|---|
| `mc-core` | 类型、ID、配置、事件 | — |
| `mc-store` | SQLite 表结构、迁移、FTS5 检索、启动恢复 | 报警、预设、共享 outbox 的表留到对应功能实现时再加 |
| `mc-audio` | 重采样、电平、掉线检测、WAV 编码 | — |
| `mc-recorder` | 每 60 秒一个分段、SHA-256、磁盘预留、按时间读取 | **存档格式先用 FLAC（纯 Rust，无损，约 20 MB/小时）**；Opus 需要 libopus 和 cmake，等打包流程定下来再换 |
| `mc-vad` | 块策略（最少 200 ms 语音，静音 500 ms 断开，**每块最长 15 秒**，200 ms 前置缓冲） | **先用基于能量的 VAD**；Silero 需要下载 ONNX 运行时和模型，放到 MVP-2 |
| `mc-capture-macos` | 进程枚举，三级归组（负责进程 → 父进程 → 最外层 .app），每个 App 一个 tap 和私有聚合设备，先建后拆，全零检测 | 服务重启监听、省电暂停放到 MVP-2 |
| `mc-asr` | `AsrAdapter` 接口；HTTP 实现：MOSS 协议、OpenAI 兼容协议（Groq、OpenAI）；全局调度（实时优先，按会话轮转） | **本机引擎（Whisper、Parakeet、SenseVoice）放到 MVP-2**：需要下载几百 MB 的模型，单独征得同意后再做 |
| `mc-insight` | OpenAI 兼容的模型客户端（主备切换）；滚动要点的增删确认、证据校验、数字校验；“我错过了什么”；结束报告 | — |
| `mc-engine` | 每一路一个会话监督任务：采集 → 存档 / VAD → 转写 → 要点；三种总结模式及切换和补转；结束后整段转写；Tab 帧的序号缺口处理 | 用 tokio 任务实现监督树，不引入 ractor |
| `mc-local-api` | REST、WS 接收音频、SSE（短期票据）、令牌和 Origin 校验、导出 md/srt/vtt/json | — |
| `apps/mcd` | 无界面的守护进程：开发、测试和排查用 | 设计稿没有，新增 |
| `apps/host` | 原生消息宿主：hello、pair、launch_app；本机套接字配对 | — |
| `apps/extension` | MV3：service worker、offscreen（共用 AudioContext、每个 Tab 一个 Worklet 和 WS、重发缓冲）、媒体时钟脚本、侧边栏 | 溢出到 IndexedDB 放到 MVP-2（目前重发缓冲 60 秒） |
| `apps/desktop` | Tauri 2：内嵌引擎、菜单栏、实时面板、会话详情、App 列表、设置 | 打包签名、公证、自动更新放到 MVP-2 |

**不在 MVP-1：** 麦克风来源（和会议两轨一起放到 MVP-2）、共享给 Catchup（需要 Catchup 先实现接收接口，见 plan.md 第 7 节）、关注、关键词提醒、预设、多轨时间线、Windows。

## 2. 验收（MVP-1）

| 编号 | 验收 | 方法 |
|---|---|---|
| A-1 | 单元测试全部通过 | `cargo test --workspace` |
| A-2 | 两路 Tab 音频（各埋不同的专有词）同时接入，一路实时模式、一路结束后模式；用真实转写和模型密钥跑通：转写、要点（证据有效）、报告、检索、导出；**两路之间零串路** | `scripts/e2e/run.sh` |
| A-3 | 两个 `afplay` 进程同时播放不同的音频，按 App 各建一个 tap，录音互不串音 | `scripts/e2e/app-tap.sh`；需要系统音频录制权限，没有权限时脚本报告“全零” |
| A-4 | 插件：加载到 Chromium，offscreen → Worklet → WS → 引擎的链路在测试页面上跑通 | `scripts/e2e/extension.mjs`（Playwright） |
| A-5 | 桌面 App 能编译、启动，界面能列出会话 | `pnpm --filter desktop tauri build --debug` |

## 3. MVP-2 及以后

1. 本机转写引擎和模型下载管理；Silero VAD。
2. Opus 存档；溢出到 IndexedDB；Core Audio 服务重启监听；省电暂停。
3. 打包：签名、公证、Tauri updater；原生消息宿主随 App 自动安装。
4. P1 功能：预设、打点快捷键、报告模板、分轨加混合导出、关键词提醒、关注、云端流式转写。
5. 共享给 Catchup（先改 Catchup 的架构文档，D-20 到 D-25）。
6. Windows：`wasapi` 按进程 loopback。

## 4. MVP-1 测试结果（2026-11-19，本机 macOS 27.0.1，Apple 芯片）

真实供应商：转写 MOSS `moss-transcribe-diarize-pro`；写作 MOSS `nex-n2.6`（备用：智谱、DeepSeek）。密钥来自 Catchup 项目的 `media/.env`，只在运行时读入环境变量。测试音频由 macOS `say` 生成：A 路是英文，预埋 “Falcon”；B 路是中文，预埋“斑马”。

| 验收 | 结果 | 证据 |
|---|---|---|
| A-1 单元测试 | ✅ 37 项通过；clippy 无警告；两端的 TypeScript 类型检查通过 | `cargo test --workspace` |
| A-2 两路 WS（一路实时、一路结束后） | ✅ 两路互不串音；所有要点的证据都来自本路；中文报告；检索按路分开；SRT 导出正常；视频时间已映射 | `test-output/e2e-ws.json` |
| A-3 两个 App 同时按进程 tap | ✅ 两个 `afplay` 被识别为两个来源，各建一个 tap，转写互不串音（通过 Multicorder.app 运行，已授予“系统音频录制”权限）。录音在播放开始后约 1 秒才启动，所以第一句没有录到 | `test-output/e2e-app-tap.json` |
| A-4 插件（Chrome for Testing） | ✅ 通过原生消息宿主配对；两路同时经 offscreen → Worklet → WS 进入引擎，零空档、零串音；没有用户点击时 `getMediaStreamId` 被正确拒绝（activeTab） | `test-output/e2e-extension.json`、`sidepanel-finished.png` |
| A-5 桌面 App | ✅ 打包成 `Multicorder.app`（debug），启动后引擎、本机接口和配对套接字都正常，并通过它跑完了 A-3 | — |

**测试中发现、需要后续处理的问题：**

1. **由终端启动的进程归属：** 由终端启动的进程，按“负责进程”会归到终端或 Claude Code 名下（Fader、FineTune 的行为也一样）。测试改用 launchd 启动播放器。产品里一般是独立的 App，不受影响。
2. **系统音频权限属于运行引擎的进程：** 用 `mcd` 从终端跑时，权限属于终端，没有授权时 tap 只给全零，检测逻辑会报 `permission_suspected`。
3. **数字被说成英文单词时校验不通过：** ASR 把 “42 million” 写成 “forty-two million”，数字校验因此拒绝了“4200 万”这条要点（宁缺毋滥）。MVP-2 给数字校验加上英文数词归一化。
4. **真实的 `tabCapture` 需要用户点击工具栏图标**，自动化测试无法模拟这一下点击。插件里这一步是标准的 Chrome 流程，需要手动再验一次（V-E1 仍然待测）。
