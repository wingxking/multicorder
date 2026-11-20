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

## 5. MVP-1.1：防重复录制与插件独立模式（2026-11-19）

用户要求：插件必须能独立运行，可以和 App 本地通信，但不依赖 App；插件录多个 Tab 时，App 不能重复录。设计见技术设计第 4.4.1 节和第 5.11 节。

| 编号 | 任务 | 验收 |
|---|---|---|
| B-1 | 宿主在配对回复里报告浏览器的 bundle ID；Tab 会话带上 `browser` | 单元测试；端到端测试里的配对回复带有 bundle ID |
| B-2 | 引擎：浏览器正在被插件按 Tab 录制时，阻止 App 整体录这个浏览器（409 `duplicate_browser_tabs`，可强制）；`/v1/apps` 标出 `tab_recording`；反方向返回警告 `browser_recorded_by_app` | 引擎和接口测试 |
| B-3 | 桌面界面：App 列表显示“插件正在按 Tab 录制”，确认后可以强制；插件侧边栏显示警告和“停止 App 录制”按钮；静默录制选项 | 类型检查；手动检查 |
| B-4 | 插件独立引擎：MediaRecorder 写 OPFS、切块、转写队列、要点归并、报告、三种模式、结束后模式的解码 | TypeScript 单元测试（切块、数字校验、要点操作、队列顺序） |
| B-5 | 插件存储、设置页、资料库页；侧边栏同时显示本地会话和 App 会话 | 类型检查；截图 |
| B-6 | 端到端：不连接 App，两路同时独立录制，用真实密钥跑通转写、要点、报告，并且零串音 | `scripts/e2e/extension-standalone.mjs` |

### MVP-1.1 测试结果（2026-11-19）

| 验收 | 结果 | 证据 |
|---|---|---|
| B-1 浏览器身份 | ✅ 宿主的回复带上 `browser_bundle_id`（单元测试）；连接模式的插件测试配对成功 | `apps/host` 测试；`test-output/e2e-extension.json` |
| B-2 防重复 | ✅ Tab 正在被插件录制时，App 整体录这个浏览器返回 409 `duplicate_browser_tabs`；`/v1/apps` 里 Chrome 标为 `tab_recording: true` | 引擎和接口测试；`test-output/e2e-dup-guard.json` |
| B-3 界面 | ✅ 桌面 App 列表显示“Tabs recorded by extension”，确认后可以强制；侧边栏显示 App 重复录制的警告，并有“停止”按钮；“静默录制”开关可用 | 两端类型检查通过 |
| B-4 插件独立引擎 | ✅ 8 项 TypeScript 单元测试（切块、数字校验、要点操作、报告、队列顺序、视频 ID） | `pnpm --filter @multicorder/extension test` |
| B-5 存储和页面 | ✅ IndexedDB、OPFS 录音、设置页、资料库页 | `test-output/standalone-library.png` |
| B-6 独立模式端到端 | ✅ 不安装宿主、不开 App：两路同时录制（一路实时，一路结束后），Opus 录音写入 OPFS（82 KB 和 65 KB），用 MOSS 真实转写，Nex 生成要点和中文报告；零串音，证据都来自本路 | `test-output/e2e-extension-standalone.json` |
| 回归 | ✅ Rust 41 项测试通过，clippy 无警告；两路 WS 和连接模式的插件端到端测试仍然通过 | `scripts/e2e/run.sh all` |

**限制（已在设计中说明）：**

- 独立模式只支持云端转写，浏览器内的模型留到下一步；
- 独立模式没有每日花费上限，只记录用量；
- 独立会话还不能导入 App（`POST /v1/import`，P1）；
- 两路音频的相似度比对（没有配对时的兜底）未实现。

## 6. MVP-1.2：服务切换、转写故障与补转、界面（2026-11-19）

用户要求：插件先用本机 Mac 上的服务做转写和总结，上线后切到云端（`multicoder.followkol.live`，尚未部署），插件可以在本机和云端之间切换；确认本机支持多个 App 加多个 Tab 同时录音；转写默认开启；转写服务异常时显示异常，录音照常，可以导出录音，服务恢复后自动补上文字，并提供重试按钮；界面简洁专业，支持浅色和深色。设计见技术设计第 5.11–5.14 节。

| 编号 | 任务 | 验收 |
|---|---|---|
| C-1 | 本机服务接口 `/v1/asr/transcribe`、`/v1/llm/chat`；插件的服务切换（本机、云端、自有密钥）；默认实时总结 | Rust 接口测试；插件 providers 单元测试；端到端：插件不存任何密钥，用本机服务完成两路录音的转写、要点和报告 |
| C-2 | 转写失败的记录（插件 `pending` 表、引擎 `asr_failures` 表）、界面提示、录音导出 | 端到端：服务密钥失效时录音完整、文字缺失有提示、录音可以导出、服务没恢复时重试会报告仍不可用 |
| C-3 | 自动补转和手动重试，补齐后重新生成要点和报告 | 引擎测试；端到端：服务恢复后，一路通过卡片的“重试”按钮补齐，另一路和 Mac 引擎的一路自动补齐 |
| C-4 | 云端不可达时的提示 | 端到端：选择云端后侧边栏显示不可达，录音照常，文字等待补转 |
| C-5 | 界面：共享主题、图标、主题切换；侧边栏、资料库、设置页、桌面 App 重做 | 截图检查浅色和深色 |
| D-1 | 两个 App 和两个 Tab 同时录音 | 端到端：Multicorder.app 用进程 tap 录两个 App，插件独立录两个 Tab 并以同一个 App 为转写服务，四路零串音 |

### MVP-1.2 测试结果（2026-11-20，全部用 Catchup 项目的 MOSS 密钥：转写 `moss-transcribe-diarize-pro`，总结 `nex-n2.6`，不用备用模型）

**先查到的问题：** 用户反映 App 好像没有转写。原因有两个：

1. 安装的 App 的 `config.json` 没有 `service` 项，也没有保存密钥，于是默认用 Multicorder 云端服务；云端尚未部署，31 段转写都失败了（“无法连接 Multicorder 服务”）。已在 App 的配置里改为“自有密钥”，并填入 MOSS 密钥；重启后补转循环自动补齐了这 31 段，三条录音都有了文字、要点和报告。
2. 桌面界面新开的录音默认是“仅录音”（`off`），这种模式完全不转写，与“转写默认开启”的要求不符。已改为“实时”（`apps/desktop/src/main.tsx` 的 `NEW_RECORDING_MODE`）。安装的 App 还没有换成新版本。

| 验收 | 结果 | 证据 |
|---|---|---|
| 单元测试 | ✅ Rust 56 项通过，clippy 无警告；插件 18 项通过（补上了 3 条服务错误的中文翻译）；两端类型检查通过 | `cargo test --workspace`、`pnpm --filter @multicorder/extension test` |
| 回归 | ✅ 两路 WS、连接模式的插件、防重复录制、独立模式（插件自带 MOSS 密钥） | `test-output/e2e-ws.json` 等 |
| C-1 本机服务 | ✅ 插件不存密钥，两路同时录制，通过本机服务转写、生成要点和报告；零串音；录音只存在浏览器里 | `test-output/e2e-service-outage.json` |
| C-2 转写故障 | ✅ 服务的 MOSS 密钥失效时：插件两路和 Mac 引擎一路录音完整；文字缺失有提示和“重试”；服务没恢复时重试会报告仍有待补；Mac 端录音可以导出为 WAV | 同上，截图 `test-output/ui-sidepanel-outage-light.png` |
| C-3 恢复 | ✅ 密钥恢复后：点卡片的“重试”14 秒补齐；另一路 36 秒、Mac 引擎一路 38 秒自动补齐；要点和报告重新生成 | 同上 |
| C-4 云端不可达 | ✅ 侧边栏显示 `multicoder.followkol.live is not reachable`，录音照常，文字等待补转 | 同上 |
| D-1 两个 App 加两个 Tab | ✅ 用已安装的 Multicorder.app：两个 `afplay` 各用一个进程 tap，插件同时独立录两个 Tab 并以这个 App 为转写服务；四路同时进行，各自只有自己的内容（Falcon、斑马、Orchid、长颈鹿），转写引擎都是 `moss:moss-transcribe-diarize-pro`，报告模型是 `moss:nex-n2.6`。测试录音结束后已从 App 中删除 | `test-output/e2e-multi-source.json` |

**测试脚本的修正：** 故障恢复的检查原来会读到故障期间生成的“没有转写到语音”的旧报告，现在等待重新生成的报告和要点。
