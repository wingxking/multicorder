import React, { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import Regions from "wavesurfer.js/dist/plugins/regions.esm.js";
import Timeline from "wavesurfer.js/dist/plugins/timeline.esm.js";
import { fmtTs, Icon, t } from "@multicorder/ui";

const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

type Selection = { start: number; end: number };

export default function AudioEditor({ audio, onExport, onError }: {
  audio: Blob;
  onExport: (startMs: number, endMs: number) => Promise<void>;
  onError: (message: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const player = useRef<WaveSurfer | null>(null);
  const regions = useRef<Regions | null>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const regionPlugin = Regions.create();
    const waveform = WaveSurfer.create({
      container: container.current,
      height: 72,
      waveColor: cssVar("--text-3", "#8d8d98"),
      progressColor: cssVar("--accent", "#e5484d"),
      cursorColor: cssVar("--accent", "#e5484d"),
      barWidth: 2,
      barGap: 1,
      plugins: [Timeline.create({ height: 19, style: { color: cssVar("--text-3", "#8d8d98"), fontSize: "10px" } }), regionPlugin],
    });
    player.current = waveform;
    regions.current = regionPlugin;
    const captureRegion = (region: Selection) => setSelection({ start: region.start, end: region.end });
    regionPlugin.on("region-created", (region) => {
      regionPlugin.getRegions().forEach((old) => { if (old !== region) old.remove(); });
      captureRegion(region);
    });
    regionPlugin.on("region-updated", captureRegion);
    const disableSelection = regionPlugin.enableDragSelection({ color: "rgba(63,123,230,0.24)", minLength: 0.05 }, 6);
    waveform.on("ready", setDuration);
    waveform.on("timeupdate", setTime);
    waveform.on("play", () => setPlaying(true));
    waveform.on("pause", () => setPlaying(false));
    waveform.on("error", (failure) => setError(failure.message));
    let current = true;
    void waveform.loadBlob(audio).catch((failure) => { if (current) setError(String(failure)); });
    return () => {
      current = false;
      disableSelection();
      waveform.destroy();
      player.current = null;
      regions.current = null;
    };
  }, [audio]);

  async function exportSelection() {
    if (!selection) return;
    setSaving(true);
    try {
      await onExport(Math.floor(selection.start * 1000), Math.ceil(selection.end * 1000));
    } catch (failure) {
      onError(String(failure));
    } finally {
      setSaving(false);
    }
  }

  const play = (range?: Selection) => {
    if (!player.current) return;
    if (playing && !range) player.current.pause();
    else void player.current.play(range?.start, range?.end).catch((failure) => onError(String(failure)));
  };

  return (
    <section className="audio-editor" aria-label={t("Waveform editor")}>
      <div className="editor-wave" ref={container} />
      {error && <p className="banner warn" role="alert">{error}</p>}
      {!error && duration === 0 && <p className="small muted" role="status">{t("Loading waveform…")}</p>}
      <div className="editor-controls">
        <button className="btn" disabled={!duration} onClick={() => play()}><Icon name={playing ? "pause" : "play"} />{playing ? t("Pause") : t("Play")}</button>
        <span className="ts">{fmtTs(time * 1000)} / {fmtTs(duration * 1000)}</span>
        <input className="editor-seek" type="range" aria-label={t("Playback position")} min={0} max={duration} step={0.01} value={time} disabled={!duration} onChange={(e) => player.current?.setTime(Number(e.target.value))} />
        <label className="editor-zoom">{t("Zoom")} <input type="range" min={1} max={8} step={1} value={zoom} disabled={!duration} onChange={(e) => {
          const next = Number(e.target.value);
          setZoom(next);
          const fitted = (container.current?.clientWidth ?? 0) / duration;
          player.current?.zoom(next === 1 ? 0 : fitted * next);
        }} /></label>
      </div>
      {selection ? (
        <div className="editor-controls">
          <span className="ts">{selection.start.toFixed(2)}–{selection.end.toFixed(2)} s</span>
          <button className="btn" onClick={() => play(selection)}>{t("Play selection")}</button>
          <button className="btn" disabled={saving} onClick={() => void exportSelection()}><Icon name="download" />{t("Export selection")}</button>
          <button className="btn" onClick={() => { regions.current?.clearRegions(); setSelection(null); }}>{t("Clear")}</button>
        </div>
      ) : <p className="small muted">{t("Drag across the waveform to select a clip.")}</p>}
    </section>
  );
}
