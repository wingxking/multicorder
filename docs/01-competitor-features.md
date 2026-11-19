# Multicorder 竞品功能调研报告

日期：2026-11-18　配套文档：[源码架构对比](02-architecture-comparison.md)、[技术设计](03-technical-design.md)、[产品规划](plan.md)

## 0. 结论

1. **“同时录多路”已经有人在做，但只做了一半。**
   - **按 App 采集：** Audio Hijack 和 MacWhisper 能录指定 App 的声音，但都没有 AI 总结，或者只有转写。
   - **按网页采集：** Notta 的插件最多同时录 5 个网页，Meeper 也支持多个 Tab 并行，但都只在浏览器里。

   没有一个产品把**多个 Tab 和多个原生 App** 放在同一个工作台里，并且每一路有独立的录音、字幕、总结和证据链。
2. **会议速记产品都只录“一场会”。** Granola、Anarlog（原 Hyprnote）、Meetily 都是全局采集系统声音加麦克风，一次只有一个会话。它们的强项是会后笔记、本机隐私和日历集成，不是多路。
3. **直播转写已经有人验证过需求。** LiveScript 做 YouTube/Twitch 的实时逐字稿、检索和关键词提醒，Pro 每月 $19.99 含 10,000 分钟。“看直播时出字幕”不能再当作卖点。
4. **Wasper 的结构和 Multicorder 最像**：Mac App 加 Chrome 插件，插件把 Tab 的声音交给本机 App 转写。但它只录当前一个 Tab，定位是听写和翻译工具，不是多路情报。
5. **Multicorder 可以验证的差异点：**
   - 多个 Tab 加多个 App 同时录，零串路；
   - 每一路单独选择实时或延后总结；
   - 每条要点都能回到音轨的时间码；
   - 本机优先，中英文都好用；
   - 共享文字给 Catchup，形成网络效应。

   这是“整合创新”，不是没人碰过的空白市场。

## 0.1 第二轮复核（2026-11-18 下午）

用户提供了一份新的竞品名单。核实结果和新发现如下，详见第 2.1 节。

- **核实为真：**
  - **Notta** 插件最多同时录 5 个网页；
  - **Meeper** 支持多 Tab；
  - **LitLink Pro** 的 README 写明可以把各个 App 分到 8 条轨道，并按轨道分别存成文件，但**没有 AI 转写和总结**。
- **核实不了：**
  - **AudioFlow Studio**：只找到一个处于第一阶段（虚拟声卡驱动）的 GitHub 项目，没有找到 App Store 上分轨录音的产品；
  - **Magic Note**：找不到；
  - **Hushscript**：确有其事，但它是按量付费的网页转写服务，提供 SDK 和 CLI。“最多 5 个标签页”的插件没有找到出处。

  这三条在本报告里都记为“未核实”。
- **新发现的直接竞品**（按 App 多路采集加本机转写）：
  - **aCapture**：按 App 各存一个文件，本机转写，区分说话人，€19.99 买断；
  - **AppAudio**：Mac App Store 上架，可以同时选多个 App 录音，本机转写。

  两者都没有每一路独立的 AI 总结和证据链。
- **相邻竞品：**
  - **HyNote for Mac**：能录任意 App 和浏览器 Tab，有 AI 总结和 30 多个模板，但能否同时录多路没有说明；
  - **Chrome Audio Capture**：能同时录多个 Tab，只录音；它的版本说明里提到，因为 Chrome 的内存限制，单次录音被限制在 20 或 60 分钟。
- **结论不变：** 截至今天，没有一款产品能同时录“3 个 YouTube Tab 加 Zoom 加腾讯会议”，并给每一路出独立的实时字幕、录音和 AI 总结。

## 1. 范围与证据等级

| 等级 | 含义 |
|---|---|
| A | 官方产品页、定价页、帮助文档 |
| B | 源码或发布记录（见[源码架构对比](02-architecture-comparison.md)） |
| C | 官方营销说法，没有独立实测 |
| D | 第三方评测或目录站，或者历史笔记 |

本报告没有实际购买或试用闭源产品。闭源产品的黑盒体验排在 R0（11/18–11/24）。价格随时会变，签约或对外宣称之前要重新核对。

## 2. 功能矩阵

图例：✅ 有　◐ 部分支持或有条件　✗ 没有　？ 未知

| 产品 | 类别 | 多路同时 | 按 App | 按 Tab | 麦克风单独一轨 | 本机转写 | 实时字幕 | 实时总结 | 会后总结 | 保留录音 | 检索 | 提醒 | 开放接口 | 平台 | 价格 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Audio Hijack** | Mac 录音 | ✅ 多个会话 | ✅ | ✗（浏览器只能整个录） | ✅ | ✅ Transcribe 积木 | ◐ | ✗ | ✗ | ✅ | ✗ | ✗ | ◐ 自动化 | Mac | 买断（价格未核实） | A |
| **MacWhisper** | Mac 转写 | ？ | ✅ Record App Audio | ✗ | ✅ | ✅ | ◐ | ✗ | ✅ | ✅ | ◐ | ✗ | ✗ | Mac | Pro 约 €64 买断 | A/D |
| **Granola** | 会议速记 | ✗ 一场 | ✗ 全局 | ✗ | ✅ | ✗ 云端 | ✅ | ◐ | ✅ 结合手记增强 | ✗ 删除音频 | ✅ | ✗ | ◐ | Mac、Windows、iPhone | 免费；Business 每人每月 $14 | D |
| **Anarlog（原 Hyprnote）** | 会议速记，开源 | ✗ 一场 | ✗ 全局 | ✗（插件只传会议元数据） | ✅ | ✅ | ✅ | ◐ | ✅ | ✅ | ✅ | ✗ | ✅ CLI、MCP | Mac（Windows、Linux 有代码） | 开源 MIT，另有企业版 | A/B |
| **Meetily** | 会议速记，开源 | ✗ 一场 | ✗ 全局 | ✗ | ◐ 和系统声混在一起 | ✅ Whisper、Parakeet | ✅ | ✗ | ✅ | ✅ | ◐ | ✗ | ◐ | Mac、Windows、Linux | 社区版 MIT，另有 PRO | A/B |
| **Screenpipe** | 全天候记录 | ✅ 多设备 | ◐ 全局加会议进程 | ✗ | ✅ | ✅ | ◐ | ◐ | ◐ | ✅ | ✅ | ◐ | ✅ API | Mac、Windows、Linux | 已改为商业许可 | A/B |
| **Notta** | 转写 SaaS | ✅ **最多 5 个网页** | ✗ | ✅ | ◐ | ✗ 云端 | ✅ | ◐ | ✅ | ✅ 云端 | ✅ | ✗ | ◐ | 网页、插件、App | 订阅 | A |
| **Meeper** | 插件，开源 | ✅ 多个 Tab | ✗ | ✅ | ✅ | ✗ 用户的 OpenAI Key | ◐ | ✗ | ✅ | ？ | ◐ | ✗ | ✗ | Chrome | 开源 MPL-2.0；2025-04 后停更 | A/B |
| **Wasper** | Mac 听写加插件 | ✗ 当前一个 Tab | ✗ | ✅ | ✅ 可混入 | ✅ | ？ | ✗ | ？ | ？ | ✅ 历史 | ✗ | ✗ | Mac 加 Chrome（插件可能尚未上架） | 未公开 | A/C |
| **LiveScript** | 直播转写 | ✅（服务端） | ✗ | ◐ 插件 | ✗ | ✗ 云端 | ✅ 自称 1–2 秒 | ✗ | ✗ | ？ | ✅ 全文 | ✅ 关键词、开播 | ✗ 未见公开 API | 网页加插件 | 免费；Pro $19.99/月，含 10,000 分钟 | A/C |
| **Tactiq** | 会议字幕笔记 | ✗ | ✗ | ◐ 读会议网页的字幕 | ✗ | ✗ | ✅ | ◐ | ✅ | ✗ | ✅ | ✗ | ◐ | Chrome | 订阅 | D |
| **Otter** | 会议机器人 | ◐ 按席位 | ✗ | ◐ 插件依附机器人 | ✗ | ✗ | ✅ | ✅ Live Assist（2026-10-27） | ✅ | ✅ | ✅ | ✅ | ✅ | 全平台 | 订阅 | A |
| **Fireflies** | 会议机器人 | ◐ 按席位 | ✗ | ✗ | ✗ | ✗ | ✅ | ✅ 桌面端实时辅助、Fred（2026-11-11） | ✅ | ✅ | ✅ | ✅ | ✅ | 全平台 | 订阅 | A |
| **Podscan** | 播客情报 | ✅（服务端） | — | — | — | ✗ | ✗ | ✗ | ✅ | — | ✅ | ✅ | ✅ Webhook、API | 网页 | Premium $100/月，Professional $200/月 | A |
| **CatchUp（catchup.help）** | 直播总结 | ？ | — | — | — | ？ | ？ | ✅ 自称 | ✅ 章节 | ？ | ？ | ？ | ？ | 网页 | ？ | C |
| **aCapture** | Mac 多源录音 | ✅ 任意多个 App | ✅ 每个 App 一个文件，也可混成一个 | ✗ | ✅ 多支 USB 麦克风、声卡、经 USB 连接的 iPhone 和 iPad | ✅ 区分说话人 | ？ | ✗ | ✗ | ✅ | ✗ | ✗ | ✗ | Mac（14 起，菜单栏，官网销售） | 标准版 €19.99 买断 | C（开发者在论坛的自述；有用户反馈转写会崩溃） |
| **AppAudio** | Mac 多 App 录音 | ✅ 选多个 App 同时录 | ✅ 完全隔离 | ✗ | ？ | ✅ | ？ | ✗ | ✗ | ✅ | ？ | ✗ | ✗ | Mac App Store | ？ | C（Product Hunt 上的开发者自述） |
| **LitLink Pro** | 虚拟声卡加按 App 路由 | ✅ 8 条轨道 | ✅ 按轨道存文件，可左右声道分开 | ✗（只能按 App） | ✅ | ✗ | ✗ | ✗ | ✗ | ✅ 多轨编辑器 | ✗ | ✗ | ✗ | Mac 14 起（按 App 路由要 14.2） | $3.99/月 或 $29 买断 | A（官方 README） |
| **HyNote for Mac** | 速记 | ？ | ◐ 任意 App | ◐ 浏览器 Tab | ✅ | ✅ 支持的机型 | ✅ | ◐ | ✅ 30 多个模板 | ？ | ✅ | ✗ | ✗ | Mac | 有免费档；约 $6.66/月起 | D |
| **Chrome Audio Capture** | 插件 | ✅ 多个 Tab | ✗ | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ mp3/wav | ✗ | ✗ | ✗ | Chrome | 免费 | A（商店页；单次录音曾被限制在 20 或 60 分钟） |
| **Hushscript** | 网页转写服务 | ？（插件未核实） | ✗ | ？ | ✗ | ✗ 云端，处理后删除音频 | ✗ | ✗ | ？ | ✗ | ✗ | ✗ | ✅ SDK、CLI | 网页 | 按量付费，无订阅 | A（官网和 GitHub） |
| **Multicorder（规划）** | 多路工作台 | ✅ 多 Tab 加多 App | ✅ 每个 App 一个 tap | ✅ | ✅ | ✅ 默认本机 | ✅ | ✅ 可修订、带证据 | ✅ | ✅ 1 分钟 Opus 分段 | ✅ 按来源筛选 | ✅ | ✅ 本机 API；共享给 Catchup | Mac 加 Chromium | 自带 Key / 托管额度（待验证） | — |

### 2.1 按产品定义严格对比

**直接竞品的定义：** 能同时录多个 App 或多个网站，并且**每一路独立转写、独立总结**，而不是把所有声音混成一份纪要。

| 产品 | 多个网站同时录 | 多个 App 分轨 | 每一路独立转写 | 每一路独立 AI 总结 | 证据 |
|---|---|---|---|---|---|
| Notta | ✅（最多 5 个） | — | ✅ | ✅ | A |
| Meeper | ✅ | ✗ | ✅ | ◐（有总结功能，是否按 Tab 分开要实测） | A/B |
| Chrome Audio Capture | ✅ | ✗ | ✗ | ✗ | A |
| aCapture | — | ✅ | ✅（本机，区分说话人） | ✗ | C |
| AppAudio | — | ✅ | ✅（本机） | ✗ | C |
| LitLink Pro | ✗（只能按 App） | ✅（8 轨） | ✗ | ✗ | A |
| Audio Hijack | ✗ | ✅ | ◐（Transcribe 积木） | ✗ | A |
| HyNote for Mac | ？ | ？ | ✅ | ✅ | D |
| Screenpipe | ✗ | ◐（全局加会议进程） | ✅ | ◐（检索和分析） | B |
| Hushscript | 未核实 | ✗ | 上传文件转写 | 未核实 | A |
| AudioFlow Studio、Magic Note | 未找到产品 | — | — | — | — |
| **Multicorder** | ✅ | ✅ | ✅ | ✅（可修订、带证据） | — |

**关键区别：**

- **把整个 Chrome 当作一个 App 录，不等于按 Tab 分开录。** LitLink、aCapture、AppAudio 都是在 App 这一级分轨，Chrome 里同时开着的 3 个 YouTube 会混在同一轨。按 Tab 分开必须靠插件。
- **AI 总结要做到“每一路一份”。** 现有的桌面多轨产品都停在“录音加转写”，没有按来源的滚动要点、“我错过了什么”和证据跳转。

### 2.2 新增竞品可以借鉴的功能

| 来源 | 功能 | 放进 Multicorder 的位置 |
|---|---|---|
| LitLink Pro | 每一轨单独存一个文件，同时存一份混合版；多轨编辑器（裁剪、淡入淡出、混音、导出）；轨道可以命名 | 会话组：把同时录的几路编成一组；导出“分轨加混合”；P2 做多轨时间线 |
| LitLink Pro | 把某个 App 送到指定的输出设备（例如音乐走音箱，通话走耳机） | 不做：我们只录，不改变声音的去向 |
| aCapture | 标记（录音中打点）；预设（常用的来源组合）；接 iPhone 和 iPad 的音频（USB）；对 VoiceOver 友好 | 标记和预设放进 P1；全面支持 VoiceOver（aCapture 的早期用户集中在视障社区 AppleVis，说明“多源录音”对无障碍用户价值很高） |
| AppAudio | 宣传点：“完全隔离”每个 App | 把“零串路”做成可以展示的验收报告 |
| HyNote | 30 多个总结模板；本机录音和转写免费 | 报告模板（发布会、访谈、财报、课程、会议）；免费档只用本机 |
| Hushscript | 按量付费、无订阅；SDK 和 CLI | 托管额度支持按量充值；P2 提供 CLI 和 MCP（Anarlog 也有） |
| Chrome Audio Capture | 反面教材：把录音放在内存里，结果单次录音只能 20 或 60 分钟 | 我们的设计是边录边送给本机 App 落盘，没有时长上限 |

## 3. 按能力逐项对比

### 3.1 采集

| 能力 | 谁做得最好 | 做法 | Multicorder 的取舍 |
|---|---|---|---|
| 按 App 录 | Audio Hijack | 积木式会话，按 App 选来源，可以定时 | 每个 App 一个 Core Audio tap；用户只勾选“正在发声的 App”，不用学积木 |
| 多个网页同时录 | Notta（最多 5 个） | 插件的标签页采集 | MV3 的 `tabCapture` 加一个 offscreen 文档持有多个流；上限按实测定（V-2），目标至少 5 个 |
| 网页加本机 App | Wasper | 插件把 Tab 的声音发给本机 App（127.0.0.1） | 同样的结构，但支持多路，并通过原生消息配对 |
| 麦克风和系统声分开 | Granola、Anarlog | 两轨分开，可做回声消除 | 麦克风单独一路；开会时和会议 App 作为同一会话的两轨 |
| 自动开始 | MacWhisper、Anarlog | 识别会议 App 后提醒 | P1：某个 App 开始发声时按规则开录，录会议时显示提示 |

### 3.2 转写与总结

| 能力 | 竞品现状 | Multicorder |
|---|---|---|
| 本机转写 | MacWhisper、Anarlog、Meetily：Whisper、Parakeet、SpeechAnalyzer | 同类引擎按语言选择：中文 SenseVoice，英文 Parakeet，多语言 Whisper |
| 实时字幕 | LiveScript（云端，自称 1–2 秒）、Otter、Granola | 本机分块，3–10 秒；开启云端流式转写后 1–2 秒 |
| 实时总结 | Otter Live Assist、Fireflies：会议场景 | 每一路一份滚动要点（新增、确认、撤回），带证据时间码；“我错过了什么” |
| 会后总结 | 几乎所有产品都有 | 结束后用最准的模型重转写、重总结，取代实时版本 |
| 修订机制 | 公开资料里没看到哪家把要点做成可撤回的 | 要点有 tentative、confirmed、retracted 三种状态；转写被更正后，相关要点跟着撤回 |

### 3.3 检索、提醒、出口

- **检索：** Notta、Otter、LiveScript 都能全文检索。Multicorder 默认在本机检索，按来源和时间筛选，结果点一下就跳到音轨对应的位置。
- **提醒：** LiveScript 有关键词和开播提醒，Podscan 有关键词加 Webhook。Multicorder 先用规则匹配，命中后再交给模型判断要不要提醒；开播提醒来自 Catchup 的雷达。
- **出口：** Anarlog 有 CLI 和 MCP，Podscan 有 API。Multicorder 提供本机 HTTP 接口，导出 Markdown、SRT、VTT、JSON，并能共享给 Catchup。

### 3.4 隐私与合规

| 产品 | 做法 |
|---|---|
| Granola | 不保留音频 |
| Wasper | 默认本机处理，只连 127.0.0.1 |
| Anarlog | 本机 SQLite，每一步都可以选本机或云端 |
| Otter | 2026-08 隐私集体诉讼获准继续审理，是会议录音“未告知”风险的反面教材 |
| MacWhisper | 自动识别会议的功能不在 Mac App Store 版本里，因为沙盒限制 |
| **Multicorder** | 默认本机，不开云端功能就没有任何出站流量；录会议时显示提示；不上 Mac App Store |

## 4. 重点竞品简评

- **Audio Hijack：** 按 App 录音做得最成熟，2026-08 发布 4.6，已支持 macOS 27。它的界面是给音频玩家的积木，没有 AI 总结和检索。**借鉴：** 会话模型、定时录制、把被采的 App 静音的选项。
- **Notta：** 插件最多同时录 5 个网页，所有套餐都有，说明多 Tab 并发在 Chrome 里可行，用户也接受。它全在云端，不录原生 App，没有按来源的证据链。**借鉴：** 并发上限要写清楚；“网页录制”和“会议机器人”两种额度分开计。
- **Wasper：** Mac App 加插件，插件只连本机，默认本机转写；YouTube 链接直接交给本机 App。**借鉴：** 链接投递；隐私说明的写法。R0 要优先黑盒体验。
- **LiveScript：** 贴链接出实时逐字稿，带关键词和开播提醒、字幕导出，插件版用 tab 采集其他网站。它把音频送到自己的服务器。**借鉴：** 定价方式（按分钟）；把“开播提醒”和“开始转写”串成一个动作。
- **Granola：** 体验最轻：不用机器人，会中自己记几笔，会后由 AI 增强。**借鉴：** 会后增强、两轨分开、“我错过了什么”的写法。
- **Anarlog / Meetily（开源）：** 架构值得直接学，见[源码架构对比](02-architecture-comparison.md)。两者都只录“一场会”：全局 tap 加麦克风。
- **Otter / Fireflies：** 会中辅助已经很常见，不要拿它当差异点。
- **aCapture：** 桌面端最接近的竞品。任意多个 App、多支麦克风、声卡和 iPhone 同时录，每个来源各存一个文件，本机转写并区分说话人，€19.99 买断，官网销售，不上 App Store。它没有 AI 总结、检索和浏览器 Tab，有用户反馈转写会崩溃。**借鉴：** 标记、预设、无障碍。
- **AppAudio：** 在 Mac App Store 上架，说明按 App 多路录音能通过 App Store 审核（我们仍然选择不上架，见技术设计第 4.13 节）。功能停在录音加本机转写。
- **LitLink Pro：** 本质是虚拟声卡加按 App 路由，把 App 分到 8 条轨道给 OBS、Discord 或 DAW 用，也能按轨道录成文件。目标用户是主播和播客，不涉及 AI。**借鉴：** 分轨加混合导出、多轨编辑器。

## 5. 空白与定位

**空白：** 公开资料里没看到有产品同时做到以下几点：

- 多个 Tab 加多个原生 App 同时采集，每一路完全隔离；
- 每一路单独选择实时或延后总结，而且总结可以修订；
- 每条要点都有时间码证据；
- 中文、英文和专业术语都好用；
- 多人共享的文字在 Catchup 融合成公开总结。

**定位：** 给每周跟踪 4 个以上音视频信源的人用的“多路工作台”：研究员、投研、创作者、跨境团队。卖点是“不用盯着好几个画面，也不会漏掉能核实的关键内容”，而不是便宜的转写。

**要先实测的假设：**

- 用户真的会同时开 3 路以上；
- 证据链能提高信任和复用；
- 自带 Key 和托管额度各有人买单。

## 6. 定价参考

| 产品 | 价格 | 计量方式 |
|---|---|---|
| LiveScript | 免费；Pro $19.99/月，含 10,000 分钟 | 分钟 |
| Granola | 免费；Business 每人每月 $14 | 席位 |
| MacWhisper | Pro 约 €64 买断 | 买断 |
| Podscan | $100 / $200 每月 | 套餐 |
| Notta | 订阅；网页录制所有套餐都有 | 套餐加分钟 |

Multicorder 的初始实验沿用调研报告：

- 免费：1 路；
- 本机或自带 Key：$7–12/月；
- 托管：$19–29/月，按“流小时”计量，必须有硬上限；
- 新增“共享换额度”。

## 7. 资料

- **Audio Hijack：** [4.6 发布](https://weblog.rogueamoeba.com/2026/08/27/audio-hijack-4-6-is-now-available/)、[产品页](https://www.rogueamoeba.com/audiohijack/)
- **MacWhisper：** [会议录制帮助文档](https://macwhisper.helpscoutdocs.com/article/30-record-meetings)、[评测](https://www.getvoibe.com/resources/macwhisper-review/)
- **Granola：** [评测（二手）](https://skillscouter.com/granola-review/)、[价格（二手）](https://costbench.com/software/ai-meeting-assistants/granola/)
- **Anarlog / Char：** [anarlog.so](https://www.anarlog.so/)、[YC 介绍](https://www.ycombinator.com/companies/char)、[仓库](https://github.com/fastrepl/hyprnote)
- **Meetily：** [仓库](https://github.com/Zackriya-Solutions/meetily)
- **Screenpipe：** [介绍](https://screenpi.pe/about)、[仓库](https://github.com/screenpipe/screenpipe)
- **Notta：** [插件页](https://notta.ai/en/chrome-extension)、[帮助：录制标签页音频](https://support.notta.ai/hc/en-us/articles/36901351478939)
- **Meeper：** [仓库](https://github.com/serg-plusplus/meeper)、[商店页](https://chromewebstore.google.com/detail/meeper-transcribe-summari/pollmehpbdljnolojdajljeoejeglcfi)
- **Wasper：** [插件页](https://wasper.app/browser-extension)、[隐私政策](https://wasper.app/privacy)
- **LiveScript：** [Chrome 商店页](https://chromewebstore.google.com/detail/cpcejjpbnompmlboigpicbegjgobgjmg)、[Product Hunt](https://www.producthunt.com/products/livescript)
- **Tactiq、Otter：** [Tactiq 替代品对比](https://scribbl.co/post/tactiq-alternative)、[Otter Live Assist](https://otter.ai/blog/otter-rethinks-the-meeting-new-ai-preps-you-coaches-you-and-follows-through)
- **Fireflies：** [Fred](https://fireflies.ai/blog/meet-fred-your-AI-teammate)
- **Podscan：** [价格](https://podscan.fm/pricing/)
- **CatchUp：** [catchup.help](https://catchup.help/)
- **调研报告：** 用户提供的《多路音视频实时情报平台：产品调研、PRD 与 Roadmap（2026-11-18）》第 3、8、11 节。
- **第二轮：**
  - aCapture：[AppleVis 发布帖](https://mail.applevis.com/forum/macos-mac-apps/introducing-acapture-multi-source-audio-recording-macos)
  - AppAudio：[Product Hunt](https://www.producthunt.com/products/appaudio-record-transcribe)
  - LitLink：[README](https://github.com/linguaholic/litlink-app)、[AlternativeTo](https://alternativeto.net/software/litlink/about/)
  - HyNote：[DeepLearning.AI 社区介绍](https://community.deeplearning.ai/t/hynote-for-mac-a-walkthrough-of-local-meeting-transcription-and-notes/895008)、[ToolRadar](https://toolradar.com/tools/hynote-for-mac)
  - Chrome Audio Capture：[商店页](https://chromewebstore.google.com/detail/chrome-audio-capture/kfokdmfpdnokpmpbjhjbcabgligoelgp)
  - Hushscript：[官网](https://hushscript.com/)、[CLI](https://github.com/Hushscript/hushscript-cli)
  - AudioFlow Studio：只找到 [GitHub 早期项目](https://github.com/edulazycreator-beep/AudioFlow-Studio)
