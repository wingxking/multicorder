# Third-party notices

Multicorder adapts ideas and code structure from the open-source projects below. Code that was
adapted keeps the attribution in the file header. Projects under copyleft or proprietary licenses
were read for ideas only; no code was copied from them.

## Adapted (permissive licenses)

| Project | License | Commit | Used in |
|---|---|---|---|
| [pantafive/fader](https://github.com/pantafive/fader) | MIT, © 2026 pantafive | a6958a4 | `mc-capture-macos`: responsible-process grouping with fallback, 2 s output polling, list rules, tap rebuild |
| [insidegui/AudioCap](https://github.com/insidegui/AudioCap) | BSD-2-Clause, © 2024 Guilherme Rambo | 6f609e8 | `mc-capture-macos`: process tap + aggregate device sequence, process properties |
| [fastrepl/hyprnote](https://github.com/fastrepl/hyprnote) (Anarlog), excluding `enterprise/` | MIT, © 2023-present Fastrepl, Inc. | 9c1cbe2 | `mc-capture-macos` IO proc structure; `mc-engine` supervision, back-pressure and dropout thresholds; `mc-recorder` chunking/disk reserve; `mc-vad` chunk policy; `apps/host` framing |
| [Zackriya-Solutions/meetily](https://github.com/Zackriya-Solutions/meetily) | MIT, © 2024 Zackriya Solutions | 2166bc6 | tap-only aggregate device; VAD parameters and the 15 s cap lesson (#756) |
| [altuzar/sonicflow](https://github.com/altuzar/sonicflow) | MIT | 134b34f | helper-process de-duplication idea |
| [GoogleChrome/chrome-extensions-samples](https://github.com/GoogleChrome/chrome-extensions-samples) | Apache-2.0, © Google LLC | 7314683 | service worker + offscreen `tabCapture` skeleton |
| [yury/cidre](https://github.com/yury/cidre) | MIT, © Yury Korolev | 7e93f2c | dependency: Apple framework bindings |

The MIT and BSD license texts require the copyright notice and permission notice to be included
with copies; the full texts are reproduced in the respective repositories at the commits above
and must be bundled in `Multicorder.app/Contents/Resources/THIRD_PARTY_NOTICES` for distribution.

## Ideas only (not copied)

FineTune (GPL-3.0), OBS Studio (GPL-2.0), Meeper (MPL-2.0), Screenpipe (commercial license),
LitLink (proprietary), Recall.ai chrome-recording-transcription-extension (no license file).

Closed-source products (Notta, aCapture, AppAudio, Audio Hijack, Granola, Wasper, LiveScript …)
were not decompiled; only their public descriptions were used.

Dependencies from crates.io and npm keep their own licenses (see `Cargo.lock` and `pnpm-lock.yaml`).

## Wavesurfer.js

BSD 3-Clause License

Copyright (c) 2012-2023, katspaugh and contributors
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
