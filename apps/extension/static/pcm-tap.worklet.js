// AudioWorkletProcessor: stereo/mono input at the context rate (48 kHz) → mono → 31-tap low-pass
// FIR (~7 kHz) → 3:1 decimation → 16 kHz PCM16, posted in 100 ms frames (1600 samples), plus an
// RMS level every 100 ms. Falls back to linear resampling if the context is not 48 kHz.

const OUT_RATE = 16000;
const FRAME = 1600;

function designLowpass(taps, cutoff, rate) {
  const h = new Float32Array(taps);
  const m = (taps - 1) / 2;
  const fc = cutoff / rate;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)); // Hamming
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / OUT_RATE;
    this.integer = Math.abs(this.ratio - Math.round(this.ratio)) < 1e-6;
    this.h = designLowpass(31, 7000, sampleRate);
    this.hist = new Float32Array(this.h.length);
    this.histPos = 0;
    this.phase = 0;
    this.out = new Int16Array(FRAME);
    this.outPos = 0;
    this.levelAcc = 0;
    this.levelN = 0;
    this.frac = 0;
  }

  emitSample(v) {
    const s = Math.max(-1, Math.min(1, v));
    this.out[this.outPos++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    this.levelAcc += s * s;
    this.levelN++;
    if (this.outPos === FRAME) {
      const buf = this.out.buffer.slice(0);
      const rms = Math.sqrt(this.levelAcc / this.levelN);
      this.port.postMessage({ kind: "pcm", buf, db: rms > 1e-6 ? 20 * Math.log10(rms) : -120 }, [buf]);
      this.outPos = 0;
      this.levelAcc = 0;
      this.levelN = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length;
    const ch = input.length;
    const step = Math.round(this.ratio);
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (let c = 0; c < ch; c++) x += input[c][i];
      x /= ch;
      this.hist[this.histPos] = x;
      this.histPos = (this.histPos + 1) % this.hist.length;
      if (this.integer) {
        if (++this.phase >= step) {
          this.phase = 0;
          let acc = 0;
          for (let k = 0; k < this.h.length; k++) acc += this.h[k] * this.hist[(this.histPos + k) % this.hist.length];
          this.emitSample(acc);
        }
      } else {
        this.frac += 1;
        if (this.frac >= this.ratio) {
          this.frac -= this.ratio;
          let acc = 0;
          for (let k = 0; k < this.h.length; k++) acc += this.h[k] * this.hist[(this.histPos + k) % this.hist.length];
          this.emitSample(acc);
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-tap", PcmTap);
