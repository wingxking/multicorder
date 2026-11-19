# 竞品源码架构对比报告

日期：2026-11-18　配套文档：[竞品功能调研](01-competitor-features.md)、[技术设计](03-technical-design.md)

## 0. 结论

1. **开源竞品里，没有一个做到“多个 App 各录一路”。**
   - Meetily、Anarlog、audiotee 都只建一个**全局** tap，录下整台机器的声音。
   - Screenpipe 在全局 tap 之外，再为会议进程单独建一个 tap，证明同一进程里**可以同时存在多个 tap**。
   - AudioCap 是唯一按进程建 tap 的示例，但一次只录一个进程。
   - 能稳定同时录多个 App 的只有闭源的 Audio Hijack。

   所以“每个 App 一个 tap + 一个私有聚合设备”就是 Multicorder 在采集层的实际差异。系统接口本身支持这样做（`CATapDescription` 可以指定任意一组进程对象，tap 之间相互独立）。

   **第二轮补充：** 开源的“按 App 调音量”工具 **Fader**（MIT，2026-11-13）和 **FineTune**（GPL-3.0，1.9.0 版）在生产环境里给**每个 App 各建一个 tap**，并同时运行几十个。这证明了多路按 App 采集可行（第 3.7 节）。它们还纠正了我们设计里的三处问题：
   - 辅助进程要按“负责进程”归组：WebKit 的 GPU 进程不在 App 包里面，按路径往上找会找错；
   - macOS 26 上，“进程是否在出声”这个属性变化时不发事件，必须轮询；
   - 换 tap 要“先建新的、再拆旧的”，以免断流。
2. **Chrome 多 Tab 有两种做法。**
   - **Meeper：** 每录一个 Tab，就打开一个扩展页面作为录音页（旧接口 `tabCapture.capture`）。
   - **Google 官方示例：** 在 service worker 里取流 ID，交给唯一的 offscreen 文档，由它 `getUserMedia`。
   - Notta 是闭源的，但它的插件最多能同时录 5 个网页，说明并发可行。

   Multicorder 采用第二种：**一个 offscreen 文档持有 N 个流**。第一种作为退路。
3. **桌面端的技术栈已经收敛到 Tauri + Rust + `cidre` + Silero VAD + whisper/Parakeet。** Anarlog 在此基础上用 `ractor` 的 actor 监督树，把采集、录音、转写拆成可以分别重启的子进程（actor）：
   - 转写挂掉只会降级，不影响录音；
   - 录音器有磁盘预留、内存缓冲上限和崩溃恢复。

   Multicorder 把这套结构从“每场会一个会话”扩展成“**每一路一个会话监督者**”。
4. **可以直接复用的代码：**
   - `cidre`（MIT，作为依赖）；
   - AudioCap（BSD-2）；
   - Meetily（MIT）；
   - Anarlog 除 `enterprise/` 以外的部分（MIT）；
   - Google 示例（Apache-2.0）。

   **不能复制的代码：**
   - Screenpipe（已改为商业许可）；
   - OBS（GPL）；
   - Meeper（MPL-2.0：复制的文件必须继续以 MPL 开源）。

   具体清单见第 7 节。
5. **两家竞品都用了私有权限接口。** AudioCap 和 Anarlog 都通过 `dlopen` 加载私有的 TCC 框架，调用 `TCCAccessPreflight` 查询录音权限。Multicorder 默认不用：被拒绝时 tap 只会返回全零（Meetily 注明了这一点），据此判断即可。

## 1. 分析范围与方法

2026-11-18 浅克隆到本机临时目录，只读，没有编译或运行。大仓库只取了相关文件。

| 仓库 | 提交 | 日期 | 许可证 | 用途 |
|---|---|---|---|---|
| [insidegui/AudioCap](https://github.com/insidegui/AudioCap) | 6f609e8 | 2025-08-07 | BSD-2 | 按进程 tap 示例（Swift） |
| [makeusabrew/audiotee](https://github.com/makeusabrew/audiotee) | 56ac954 | 2026-03-31 | MIT | 全局 tap 命令行（Swift） |
| [Zackriya-Solutions/meetily](https://github.com/Zackriya-Solutions/meetily) | 2166bc6 | 2026-11-14 | MIT | 会议速记（Tauri + Rust） |
| [fastrepl/hyprnote](https://github.com/fastrepl/hyprnote)（Anarlog） | 9c1cbe2 | 2026-11-18 | MIT（`enterprise/` 除外） | 会议速记（Tauri → GPUI + Rust） |
| [screenpipe/screenpipe](https://github.com/screenpipe/screenpipe) | 2e9f285 | 2026-11-17 | **商业许可** | 全天候记录（只读思路） |
| [yury/cidre](https://github.com/yury/cidre) | 7e93f2c | 2026-11-18 | MIT | Rust 的 Apple 框架绑定 |
| [serg-plusplus/meeper](https://github.com/serg-plusplus/meeper) | 1c8d2df | 2025-04-28 | MPL-2.0 | 多 Tab 插件 |
| [GoogleChrome/chrome-extensions-samples](https://github.com/GoogleChrome/chrome-extensions-samples) | 7314683 | 2026-11-17 | Apache-2.0 | 官方 tabCapture / offscreen 示例 |

**第二轮新增的仓库：**

| 仓库 | 提交 | 日期 | 许可证 | 用途 |
|---|---|---|---|---|
| [pantafive/fader](https://github.com/pantafive/fader) | a6958a4 | 2026-11-13 | MIT | 按 App 调音量：每个 App 一个 tap |
| [altuzar/sonicflow](https://github.com/altuzar/sonicflow) | 134b34f | 2026-05-16 | MIT | 按 App 调音量 |
| [ronitsingh10/FineTune](https://github.com/ronitsingh10/FineTune) | 2285279 | 2026-07-09 | **GPL-3.0** | 按 App 调音量和路由（只借思路） |
| [linguaholic/litlink-app](https://github.com/linguaholic/litlink-app) | 4bf1fc0 | 2026-11-04 | **专有许可** | 只读了 README |
| [recallai/chrome-recording-transcription-extension](https://github.com/recallai/chrome-recording-transcription-extension) | dbb034d | 2025-11-10 | **没有许可证文件**（默认保留所有权利） | 只读了 README 和 manifest |

闭源产品（Audio Hijack、Notta、Wasper、LiveScript、Granola、MacWhisper、aCapture、AppAudio）**没有反编译，也没有还原代码**。Mac App Store 的标准许可协议和这些产品自己的条款都禁止反向工程，把还原出来的代码用进产品就构成侵权。它们只做黑盒体验：记录行为、权限、界面和限制，然后按我们自己的设计实现。

## 2. 总体架构对比

| 项目 | AudioCap | Meetily | Anarlog | Screenpipe | Meeper |
|---|---|---|---|---|---|
| 形态 | 示例 App | 桌面 App | 桌面 App（另有 CLI、MCP、手机端） | 桌面 App 加引擎 | Chrome 插件 |
| 界面 | SwiftUI | Tauri 2 + Next.js | Tauri（`apps/desktop`）→ GPUI（`apps/desktop-gpui`） | Tauri | React |
| 核心语言 | Swift | Rust | Rust（150 多个 crate） | Rust | TS |
| 系统声音 | **按进程** tap | 全局单声道 tap | 全局单声道 tap | 全局 tap（带 App 排除列表）+ **会议进程 tap** | Tab 流 |
| 麦克风 | — | `cpal`，和系统声**混成一路** | `cpal`，**两轨分开**，有回声消除（ONNX 模型） | `cpal`（自维护的分支） | `getUserMedia` 混入 |
| 并发结构 | 无 | 管线和线程 | **`ractor` actor 监督树** | 管理器加重试 | 每路一个页面 |
| VAD | — | Silero，实时 500 ms、批量 2000 ms | Silero ONNX 或 earshot；块策略最少 200 ms 语音、短块间隔 250 ms 内合并 | Silero（vad-rs 分支） | 无 |
| 转写 | — | whisper-rs、Parakeet（ort） | whisper-local、Soniox、SpeechAnalyzer、OpenAI 兼容、pyannote | whisper-rs、Parakeet | OpenAI Whisper |
| 存储 | 一个 WAV 文件 | 每 30 秒一个检查点文件，最后用 ffmpeg 合并 | 每 60 秒一个分块，写 mp3/ogg/wav；带恢复目录 | SQLite 加文件 | IndexedDB |
| 权限 | 私有 TCC 接口 | 被拒时 tap 返回全零 | 私有 TCC 接口（swift-rs 桥接） | 最低 macOS 14.4 | — |
| 浏览器 | — | — | 原生消息宿主，只传会议元数据 | — | 本身就是插件 |

## 3. 多 App 音频同时获取：各家的实现

### 3.1 系统接口（来自 cidre 的绑定，`cidre/src/core_audio/tap_description.rs`）

| 接口 | 作用 |
|---|---|
| `TapDesc::with_stereo_mixdown_of_processes(ids)` / `with_mono_mixdown_of_processes(ids)` | 只采指定的一组进程对象，混成立体声或单声道。**按 App 采集用这个** |
| `with_*_global_tap_excluding_processes(ids)` | 采全部进程，排除指定的几个 |
| `set_private(true)` | tap 只对本进程可见 |
| `set_mute_behavior(Unmuted / Muted / MutedWhenTapped)` | 采集时被采的 App 是否继续出声 |
| `set_processes()`，以及 `Tap::set_desc()`（`kAudioTapPropertyDescription` 可写） | **改动一个已有 tap 的进程列表**，不用销毁重建 |
| **macOS 26：** `set_bundle_ids()`、`set_process_restore_enabled()` | 按 bundle ID 采集；进程退出后再启动时自动重新加入 tap |
| `Tap::asbd()` | tap 的采样格式 |
| `ca::Process::with_pid()`、进程列表、`is_running_output()`、`bundle_id()` | 进程对象的枚举和状态 |
| `add_prop_listener_block()` | 监听进程列表、默认输出设备的变化 |

读 tap 的数据要先建一个**私有聚合设备**，把 tap 挂在它的 tap 列表里，再在这个设备上注册 IOProc。

### 3.2 AudioCap：按进程（Swift，BSD-2）

`AudioCap/ProcessTap/ProcessTap.swift`：

```swift
let tapDescription = CATapDescription(stereoMixdownOfProcesses: [objectID])
tapDescription.uuid = UUID()
tapDescription.muteBehavior = muteWhenRunning ? .mutedWhenTapped : .unmuted
AudioHardwareCreateProcessTap(tapDescription, &tapID)
// 聚合设备：私有；默认输出设备作为主子设备；tap 列表里只有这个 tap，开启漂移补偿；tap 自动启动
AudioHardwareCreateAggregateDevice(description, &aggregateDeviceID)
AudioDeviceCreateIOProcIDWithBlock(&deviceProcID, aggregateDeviceID, queue, ioBlock)
AudioDeviceStart(aggregateDeviceID, deviceProcID)
```

- **进程列表**（`AudioProcessController.swift`）：读 `kAudioHardwarePropertyProcessObjectList`，逐个读 PID、bundle ID 和“是否在运行”；用 `NSWorkspace.runningApplications` 的变化触发刷新；找不到对应 App 时，用 `proc_pidpath` 往上找最近的 bundle。
- **IOProc 挂在 dispatch queue 上**，所以回调里可以直接 `AVAudioFile.write`。实时线程上不能做这类操作。
- **局限：**
  - 一次只录一个进程。
  - 往上找的是“最近的 bundle”，所以 Chrome 的 `Google Chrome Helper (Renderer).app` 会被当成一个独立的 App。我们要改成找**最外层的 `.app`**。
  - 只在 App 启动或退出时刷新，辅助进程刚开始发声时察觉不到。

### 3.3 Meetily：全局 tap 加麦克风混音（Rust，MIT）

`frontend/src-tauri/src/audio/capture/core_audio.rs`：

- `ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new())`：全局单声道 tap。
- 聚合设备**只放 tap，不放输出设备的子设备列表**。注释说两者都放会听到重复的声音（回声），这是修过的坑。
- IOProc 把数据写进 `ringbuf` 的 `HeapProd<f32>`，并唤醒异步 `Stream`（`WakerState`）。连续丢帧会计数，必要时终止。
- 权限：注释写明“权限被拒时 tap 返回全零”。
- `pipeline.rs`：麦克风和系统声按时间窗对齐，一路领先另一路最多 1 秒，落后的一路补静音，然后混成一路。VAD 的静音判定：实时路径 500 ms，批量 2000 ms。注释引用了 #756：**连续不断的声音会让一个 VAD 段一直不结束**，所以每个段需要设最长时长。
- `incremental_saver.rs`：每 30 秒存一个检查点文件，结束后用 ffmpeg 合并。

### 3.4 Anarlog（原 Hyprnote）：全局 tap，加上生产级的会话监督（Rust，MIT）

**采集**

- `crates/audio-actual/src/speaker/macos.rs`：同样是全局单声道 tap，同样的聚合设备参数。
- 实时回调按 f64、i32、i16 各种采样格式转成 f32，写进实时安全的环形缓冲（`rt_ring.rs`、`async_ring.rs`）。
- 麦克风和系统声由 `capture/joiner.rs` 对齐，最多允许落后 4 个块，队列最多 30 个；然后送进回声消除（`crates/aec`，ONNX 模型 `model_128`）。

**会话结构**（`crates/listener-core`，基于 `ractor`）

```
SessionActor（监督者）
 ├─ SourceActor     采集（麦克风加系统声）
 ├─ RecorderActor   落盘
 └─ ListenerActor   转写（在 post_start 里才启动，连不上只会降级）
```

- 每类子 actor 有自己的重启计数（`RestartTracker`），超过上限就停止，不会无限重试。
- 转写重启后，从内存里回放最近 5 秒（`REPLAY_HISTORY_SECS`），接上之前的进度。
- 音频路由变化（拔耳机、换麦克风）时，重建转写会话。

**`source/pipeline.rs` 的背压参数**

| 参数 | 值 |
|---|---|
| 向转写分发的队列容量 | 32 |
| 转写确认超时 | 1 秒 |
| 向录音器分发的队列容量 | 32 |
| 录音器背压超时 | 2 秒 |
| 掉线检测 | 5 秒窗口里全零的比例超过 15%，就报告“设备不再出声”（蓝牙耳机常见） |

**录音器**（`recorder/chunks.rs`、`disk.rs`）

| 参数 | 值 |
|---|---|
| 每块时长 | 60 秒 |
| 磁盘预留 | 256 MB |
| 存储不可用时的内存缓冲上限 | 64 MB |
| 写盘频率 | 每秒一次 |
| 存储状态检查 | 每 5 秒一次 |
| 结束时的收尾期限 | 10 秒 |

- 编码和落盘分在两个线程；落盘后对目录做 fsync；有 `audio-recovery` 恢复目录。
- 麦克风和系统声各自单独存一个文件（`audio_mic.wav`、`audio_spk.wav`）。

**浏览器**（`crates/chrome-native-host/src/main.rs`）

- 标准的原生消息帧：4 字节小端长度加 JSON。单条最大 256 KB，地址最长 2048。
- 只接收 Google Meet 的会议状态（网址、是否进行中、是否静音、参会者），写到 `char/chrome_state.json` 给桌面端读。**不传音频**。

**其他：** `crates/detect` 用辅助功能接口识别会议 App 和浏览器里的会议；`crates/tcc` 用私有 TCC 接口查询和重置权限；`model-downloader`、`model-manager` 管理本机模型。

### 3.5 Screenpipe：全局 tap 加会议进程 tap（商业许可，只读思路）

**做法**

- 全局 tap，带一份按 App 排除的列表（JSON 文件）。
- 会议进程另建一个 tap（“piggyback”）：只采指定 PID 的输出，**和全局 tap 同时运行**。
- 最低版本定为 macOS 14.4：14.2–14.3 的权限提示属于另一个 TCC 类别，处理起来不可靠。

**值得记下的坑**

- 自己建的私有聚合设备对本进程仍然可见，列设备时要过滤掉，否则用户可能选它当输入，造成回环。
- 每秒轮询一次进程时，调用 `NSRunningApplication.localizedName` 在 Intel Mac 上会崩溃（2026-08-07 的记录）。他们改成只用 libproc 读进程名，并定期排空 autorelease 池。
- 系统常驻进程 `corespeechd`（“嘿 Siri”）几乎一直占着麦克风，必须过滤；FaceTime 的音频引擎 `avconferenced` 则不能过滤。

### 3.7 开源的按 App 混音器：多个 tap 同时运行的生产实践（第二轮）

这类工具要给每个 App 单独调音量，所以必须**给每个 App 建一个 tap**，并且同时运行几十个，正好就是 Multicorder 需要的采集结构。区别在于：

- 它们用 `mutedWhenTapped` 把 App 原本的声音静音，再加上增益从聚合设备重新播放出来；
- 我们只录不放，所以用 `Unmuted`，App 照常出声。

**Fader（MIT，`Fader/Audio/`）**

- **`ProcessTap.swift`：** 每个 App 一个 `CATapDescription(stereoMixdownOfProcesses: processObjectIDs)`，私有。聚合设备的设置：
  - 主子设备和时钟设备都设为输出设备，其余设备开漂移补偿；
  - 名称加上固定前缀，让自己的设备列表能把它过滤掉；
  - 输出路由或默认设备变化时，**重建 tap，不在原 tap 上改**；
  - 新旧两个 tap 用 30 ms 交叉淡入淡出衔接，避免断流。
- **`AudioProcessMonitor.swift`：**
  - 监听 `kAudioHardwarePropertyProcessObjectList`；
  - **每 2 秒轮询一次**每个进程的 `IsRunningOutput`。注释说，在 macOS 26 上这个属性变化时实际收不到事件；
  - 辅助进程用私有函数 `responsibility_get_pid_responsible_for_pid`（通过 `dlsym` 查找）归到“负责的 App”。注释写明这和 TCC 用的归属方式相同，从 macOS 10.14 起一直稳定，找不到这个函数时就退回“每个辅助进程单独算”；
  - 列表规则：正常的 App 一直显示；后台代理和辅助进程只在播放或录音时才显示，这样能把控制中心、Siri 和 GPU 辅助进程排除在外；
  - 同一个 bundle ID 的多个条目合并。
- **`MixerEngine.swift`：** 监听 `kAudioHardwarePropertyServiceRestarted`。Core Audio 服务重启时，所有监听都会失效、进程对象 ID 都会变，必须重新建监听、重新枚举、重建所有 tap。
- **`ProcessTap+Idle.swift`：** App 长时间不出声时暂停这个 tap 的 IO，省电；由一个共用的轻量监视器在它重新出声时恢复。
- **`MixerEngine+Taps.swift`：** tap 建立失败时不会再有 HAL 事件触发，所以按定时器重试。时钟设备优先选有线或内置设备，因为蓝牙设备的时钟会漂。

**FineTune（GPL-3.0，只借思路）**

- **`Engine/ProcessTapController.swift`：** 每个 App 一个控制器。tap 设为 `mutedWhenTapped` 加私有；也可以只采某个设备的某一路输出流。实时线程读取的状态全部是原子变量，不加锁。
- **健康检查：** 记录最后一次音频回调的时间，用来判断 tap 是否已经“死掉”。
- **`OrphanedTapCleanup.swift`：** 启动时销毁上次崩溃或被强制结束后留下的、以 `FineTune-` 开头的聚合设备。原因是这些残留设备带着 `mutedWhenTapped` 的 tap，会让 App 一直没声音。
- **`AudioProcessMonitor.swift`：** 同样用 `responsibility_get_pid_responsible_for_pid`，找不到时沿父进程往上走（这对 Chrome 和 Brave 的辅助进程有效）。系统常驻进程同时按 bundle ID 前缀和进程名过滤。
- **`CrossfadeOrchestrator`：** 切换设备时两个 tap 同时运行，用等功率曲线交叉过渡。

**SonicFlow（MIT）：** `AudioProcessDetector.swift` 把辅助进程合并到父 App 下，并处理 HAL 偶尔把同一个 bundle 列两次的情况（辅助进程继承了父进程的 bundle ID），只保留正在出声的那个。

**LitLink（专有许可，只看了 README）：** 虚拟声卡 “LitLink Audio Bridge” 加按 App 路由。Pro 版把各个 App 分到 8 条轨道（在 OBS、Discord 或 DAW 里各是一个输入），也能按轨道录成单独的文件，带多轨编辑器。最低 macOS 14.0，按 App 路由要 14.2。这是“虚拟设备”路线：用户要在别的软件里选输入。Multicorder 是“直接录”路线，不需要虚拟设备。

**对我们设计的三处修正**

1. **归组：** 按“负责进程”归组，失败时沿父进程往上找，再失败才按可执行文件的路径找最外层的 `.app`。原因是 Safari 和用 WKWebView 的 App 由 WebKit 的 GPU 进程发声，这个进程不在 App 包里面，只按路径找会找错。`responsibility_get_pid_responsible_for_pid` 是私有函数，所以必须有退路，不能依赖它。
2. **状态：** “是否在出声”每 2 秒轮询一次；进程列表用事件监听；Core Audio 服务重启时整体重建。
3. **换 tap：** 进程集合、输出设备或时钟设备变化时，**先建新的 tap，收到它的第一帧后切换写入，再拆掉旧的**。对录音来说，切换点之后只用新 tap 的数据，不需要交叉淡入淡出。`Tap::set_desc` 原地更新降为可选的优化，留待实测（V-1）。

### 3.6 小结：多 App 同时采集的可行做法

（第二轮已按第 3.7 节修正：归组改用“负责进程”；换 tap 改成先建后拆。）

```
每个被选中的 App：
  按“负责进程”归组（失败时沿父进程找，再失败按最外层 .app）得到一组 PID → 各自对应的 Core Audio 进程对象
  → TapDesc::with_mono_mixdown_of_processes(objs)，私有，不静音
  → 私有聚合设备（主子设备 = 默认输出设备；tap 列表 = [这个 tap]，开启漂移补偿；tap 自动启动）
  → IOProc → 实时安全的环形缓冲 → 重采样到 16 kHz → 这一路会话的总线
进程列表变化、输出设备或时钟设备变化 → 先建新的 tap，收到第一帧后切换，再拆旧的（macOS 26 可以用 bundle_ids 加 process_restore 减少重建）
Core Audio 服务重启 → 重新监听、重新枚举、重建全部 tap
启动时 → 清理上次残留的、以 Multicorder- 开头的聚合设备
```

## 4. 多 website 同时获取：各家的实现

### 4.1 Chrome 的约束（官方文档，2026-11-18）

| 约束 | 内容 |
|---|---|
| 调用前提 | 用户在**目标 Tab 上调用过扩展**（点工具栏图标、右键菜单或快捷键），类似 `activeTab` 授权 |
| 调用位置 | Chrome 116 起，service worker 可以调用 `getMediaStreamId` |
| 流 ID | 只能用一次，几秒内不用就过期 |
| 并发 | 文档没有写数量上限；`getCapturedTabs()` 可以查出哪些 Tab 已在采集，避免重复 |
| 静音 | Tab 被采集后不再对用户出声，要用 `AudioContext` 接回扬声器 |
| offscreen 文档 | 每个扩展**只能开一个**。`USER_MEDIA` 理由没有寿命限制；`AUDIO_PLAYBACK` 无声 30 秒后自动关闭。offscreen 里只能用 `runtime` 这个扩展接口，网页接口照常可用 |
| 页面跳转 | 采集在同一 Tab 内跳转后继续，关闭 Tab 或关闭流时结束 |

### 4.2 Google 官方示例（Apache-2.0）

`functional-samples/sample.tabcapture-recorder`：

```js
// service-worker.js
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: '…' });
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  chrome.runtime.sendMessage({ type: 'start-recording', target: 'offscreen', data: streamId });
});
// offscreen.js
const media = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } });
const output = new AudioContext();
output.createMediaStreamSource(media).connect(output.destination);   // 防止 Tab 被静音
recorder = new MediaRecorder(media, …);
```

示例里只有一个 `recorder` 变量，同一时间只能录一路。

### 4.3 Meeper：每路一个录音页（MPL-2.0）

- `src/core/bgWorker.ts`：用户触发（点弹窗、快捷键或右键菜单）后，`chrome.tabs.create({url: '/record/<tabId>', active: false, index: tab.index+1, openerTabId: tab.id})`。**每个被录的 Tab 旁边多开一个扩展页**。
- `src/core/meeper.ts`：在录音页里调用旧接口 `chrome.tabCapture.capture({audio:true})`，并把流接到 `audioCtx.destination` 防止静音；可选混入麦克风。
- `src/lib/capture-audio/record.ts`：每个窗口停一次、重开一次 `MediaRecorder`，把完整的一段送给 Whisper。
- 关闭录音页就结束会话（`tabs.onRemoved`）。
- **优点：** 每一路在独立的页面里，天然隔离。
- **缺点：** 标签栏里多出很多录音页，用户可能误关；旧接口只能在前台调用。

### 4.3.1 Recall.ai 的示例插件（没有许可证文件，只读 README 和 manifest）

- **架构：** MV3，service worker 拿到流 ID，交给 offscreen 文档；在 offscreen 里采集 Tab，可以混入麦克风，用 `MediaRecorder` 录成 webm。另外用内容脚本读 Google Meet 页面上的实时字幕，存成带时间戳的文本。
- **权限：** `activeTab`、`tabCapture`、`offscreen`、`tabs`、`desktopCapture`、`downloads`；`host_permissions` 只给 `meet.google.com`。
- **借鉴：** 会议网页本身有字幕时，读字幕作为“免费的转写来源”。这只在用户自己参加的会议里做，并显示录音提示。我们放进 P2。

### 4.4 闭源产品（黑盒推断，待 R0 实测）

- **Notta：** 最多同时 5 个网页，说明在一个插件里并发采集可行；实现方式不清楚。
- **Wasper：** 录当前一个 Tab，可以混入麦克风；只发到 127.0.0.1 的本机 App；YouTube 链接直接交给 App。
- **LiveScript 插件：** 用 tab 采集其他网站，音频送到自己的服务器。
- **Chrome Audio Capture：** 能同时录多个 Tab；商店页的版本说明提到，因为 Chrome 的内存限制，单次录音被限制在 20 或 60 分钟。可以推断它把整段录音放在内存里。我们的插件边录边送给本机 App，没有这个问题。
- **aCapture、AppAudio（Mac）：** 按 App 多路录音加本机转写。实现方式只能靠黑盒判断（权限提示的类型可以看出用的是 Core Audio tap 还是 ScreenCaptureKit），R0 时体验。

### 4.5 小结：多网页同时采集的可行做法

```
每个 Tab：用户在该 Tab 上调用插件（图标、快捷键或右键菜单）
  → service worker：getMediaStreamId({targetTabId}) → 立即发给 offscreen（流 ID 几秒就过期）
唯一的 offscreen 文档（USER_MEDIA）：
  一个共用的 AudioContext（48 kHz）
  每个 Tab：MediaStreamSource ─┬─▶ destination（可选：静默采集）
                               └─▶ AudioWorkletNode（16 kHz PCM16，100 ms 一帧，电平）→ WebSocket（本机 App）
退路：offscreen 并发不稳定时，改成 Meeper 的“每路一个录音页”
```

## 5. 分段、VAD 与转写调度对比

| 项目 | 音频分段 | VAD | 转写调度 |
|---|---|---|---|
| Meetily | 30 秒检查点 | Silero 16 kHz，静音判定 500 / 2000 ms | 并行转写任务；按提供方选 Whisper 或 Parakeet |
| Anarlog | 60 秒落盘块 | 最少 200 ms 语音，短块间隔 250 ms 内合并；可选 Silero 或 earshot | 实时：流式提供方（Soniox）或本机；批量：`listener2-core` 的渐进式和分段式 |
| Screenpipe | 分段写入加重试 | Silero v5/v6 | 本机 Whisper、Parakeet；有评测工具（WER、DER） |
| **Multicorder** | 存档 1 分钟一个 Opus 文件；转写块不超过 15 秒 | Silero；块策略照搬 Anarlog，另加 15 秒上限（Meetily #756 的教训） | 全局调度：每一路一个队列轮流取，实时优先，之后是结束后模式，最后是补转写 |

## 6. 可靠性、权限与分发

| 方面 | 最佳实践（来源） | Multicorder 的做法 |
|---|---|---|
| 实时回调 | 只写环形缓冲，不分配内存、不加锁（Meetily、Anarlog） | 照做 |
| 录音不受转写影响 | 转写在 `post_start` 里启动，失败只降级（Anarlog） | 每一路的会话监督者照做 |
| 磁盘满或不可写 | 预留 256 MB，内存缓冲最多 64 MB，fsync 目录（Anarlog） | 照做 |
| 掉线检测 | 5 秒里全零超过 15%（Anarlog） | 照做，并在每一路的卡片上提示 |
| 自己建的聚合设备 | 列设备时过滤掉（Screenpipe） | 照做 |
| 进程轮询崩溃 | 不在热路径里调用 `NSRunningApplication`（Screenpipe） | 只用 libproc 和 Core Audio 的属性 |
| 权限检测 | 私有 TCC 接口（AudioCap、Anarlog），或“全零即被拒”（Meetily） | 默认用“全零即被拒”；私有接口不用 |
| 最低系统版本 | 14.4（Screenpipe、AudioCap） | 14.4；macOS 26 以上启用 bundle ID 采集 |
| 分发 | 不上 Mac App Store（MacWhisper 的商店版缺少会议识别） | Developer ID 签名、公证，DMG 分发 |

## 7. 可复用代码清单

| 来源 | 许可证 | 复用什么 | 怎么改 | 义务 |
|---|---|---|---|---|
| `cidre` | MIT | 直接作为依赖：`core_audio`、`av`、`cf`、`ns` | 锁定提交版本 | 保留许可证文本 |
| AudioCap `ProcessTap.swift`、`CoreAudioUtils.swift`、`AudioProcessController.swift` | BSD-2 | 建 tap 和聚合设备的步骤、进程属性读取、进程枚举 | 用 Rust 和 `cidre` 重写；归组改成找“最外层 .app”；监听进程列表的变化 | 保留版权和许可声明 |
| Meetily `capture/core_audio.rs` | MIT | 环形缓冲加唤醒的异步 Stream、聚合设备只挂 tap、丢帧计数 | 全局 tap 改成按进程；单声道 16 kHz | 保留许可证 |
| Meetily `vad.rs` | MIT | Silero 的切段处理 | 加 15 秒上限 | 同上 |
| Anarlog `listener-core`（session、source、recorder、listener 几个 actor） | MIT | 监督树、重启计数、回放历史、背压参数 | 单会话改成每一路一个会话；加入 WS 来源 | 同上；不碰 `enterprise/` |
| Anarlog `listener-core/actors/recorder` | MIT | 分块落盘、磁盘预留、恢复 | 编码从 mp3 改成 Ogg/Opus；加 SHA-256 | 同上 |
| Anarlog `audio-chunking`、`vad`、`audio-actual`（`rt_ring`、`async_ring`、`mic.rs`、`norm.rs`） | MIT | 块策略、环形缓冲、麦克风采集、音量归一化 | — | 同上 |
| Anarlog `chrome-native-host` | MIT | 原生消息帧的读写、大小上限 | 消息改成配对和会话提示 | 同上 |
| Anarlog `aec` | MIT（代码） | 麦克风回声消除 | 会议两轨时启用 | **ONNX 模型的许可证要单独核对** |
| Anarlog `transcribe-speechanalyzer`、`soniox`、`whisper-local`、`model-downloader` | MIT | 转写适配器、模型下载 | 接入我们的 `AsrAdapter` | 同上 |
| Google `sample.tabcapture-recorder` | Apache-2.0 | service worker 加 offscreen 的骨架 | 扩展成多路 | 保留 NOTICE |
| Meeper | MPL-2.0 | 只借思路（每路一个页面的退路方案） | — | 不复制，否则这些文件要按 MPL 开源 |
| **Fader** `AudioProcessMonitor.swift`、`ProcessTap.swift`、`HALProperty.swift`、`MixerEngine.swift`（服务重启部分）、`ProcessTap+Idle.swift` | MIT | 负责进程的归组和退路、2 秒轮询、列表规则、按 bundle ID 合并、自建设备的名称前缀、服务重启后重建、重试定时器、选时钟设备 | 用 Rust 和 `cidre` 重写；不重新播放（`Unmuted`，不加增益）；交叉淡入淡出改成“收到新 tap 的第一帧后切换” | 保留版权和许可声明 |
| **SonicFlow** `AudioProcessDetector.swift` | MIT | 辅助进程合并、重复 bundle 去重 | 同上 | 同上 |
| FineTune | **GPL-3.0** | 只借思路：残留聚合设备的清理、回调健康检查、等功率交叉过渡 | 自己实现 | 不复制 |
| LitLink | 专有许可 | 只借产品思路：分轨加混合导出、多轨编辑器 | — | 不复制 |
| Recall.ai 示例插件 | 没有许可证文件 | 只借思路：读会议网页的字幕 | — | 不复制 |
| Screenpipe、OBS | 商业许可 / GPL | 只借思路 | — | 不复制 |

**合规做法：**

- 仓库根目录放 `THIRD_PARTY_NOTICES.md`，列出每段复用代码的来源、提交和许可证文本；
- 复制过来的文件保留原文件头，并注明“modified by Multicorder”；
- App 的“关于”页列出第三方组件。
