#!/usr/bin/env node
// Renders the 1-minute animated intro (scripts/demo/intro/intro.html) to an MP4 with voice,
// captions and a soft ambient pad.
//
//   node scripts/demo/intro/render-intro.mjs [--out demo-build/moon-intro.mp4] [--voice <name>]
//        [--ffmpeg <path>] [--chrome <path>] [--fps 30] [--no-music] [--offline] [--rate +30%]
//        [--spec outro.json]   (the closing slides: same page, other scenes)
//
// Voice: the Indian English neural voice from intro.json via edge-tts (pip install edge-tts;
// it sends only the narration text to Microsoft's read-aloud service). --offline, or no
// edge-tts, uses the Windows voice instead. Frames are drawn in headless Chrome, one by one,
// so the animation is exact and never drops frames.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const SIZE = { width: 1920, height: 1080 };
const DEFAULT_LEAD = 0.35; // seconds between a scene appearing and its voice starting
const MUSIC_VOLUME = 0.07;

function fail(msg) { console.error(`render-intro: ${msg}`); process.exit(1); }
function args() {
  const o = {}; const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const k = a[i].slice(2);
    if (a[i + 1] === undefined || a[i + 1].startsWith("--")) o[k] = true; else o[k] = a[++i];
  }
  return o;
}
function seconds(ffmpeg, file) {
  const probe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace("ffmpeg", "ffprobe"));
  const r = spawnSync(probe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  const s = Number(r.stdout.trim());
  if (!(s > 0)) fail(`could not read the length of ${file}`);
  return s;
}
// Length of the spoken part: voice files end with silence, which would only slow the intro down.
function speechSeconds(ffmpeg, file) {
  const total = seconds(ffmpeg, file);
  const r = spawnSync(ffmpeg, ["-hide_banner", "-i", file, "-af", "silencedetect=n=-40dB:d=0.15", "-f", "null", "-"], { encoding: "utf8" });
  const starts = [...r.stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const lastStart = starts[starts.length - 1];
  const trailing = starts.length > ends.length || (ends.length && total - ends[ends.length - 1] < 0.05);
  return trailing && lastStart > 0.5 ? lastStart + 0.1 : total;
}
function findChrome() {
  const c = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return c.find((p) => existsSync(p));
}

// ---------- voice ----------
function edgeTts(text, voice, rate, file) {
  for (const py of ["python", "python3", "py"]) {
    const r = spawnSync(py, ["-m", "edge_tts", "--voice", voice, `--rate=${rate}`, "--text", text, "--write-media", file], { encoding: "utf8" });
    if (r.status === 0 && existsSync(file)) return true;
  }
  return false;
}
function windowsVoice(text, voice, file) {
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
    `try { $s.SelectVoice('${voice.replace(/'/g, "''")}') } catch {}; $s.Rate = 0; $s.SetOutputToWaveFile('${file.replace(/'/g, "''")}'); ` +
    `$s.Speak([Console]::In.ReadToEnd()); $s.Dispose()`;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { input: text, encoding: "utf8" });
  if (r.status !== 0) fail(`Windows voice failed: ${r.stderr}`);
}

// ---------- ambient pad (synthesised, so there is no music licence to worry about) ----------
// A soft, slowly breathing chord under the voice: A, E, A, C#, B (Aadd9), plain sine partials.
function writeDrone(file, total) {
  const sr = 44100, n = Math.ceil(total * sr);
  const out = new Float32Array(n);
  const notes = [110, 164.81, 220, 277.18, 329.63, 493.88];
  const gains = [0.9, 0.6, 0.5, 0.35, 0.3, 0.12];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    notes.forEach((f, k) => {
      const swell = 0.6 + 0.4 * Math.sin(2 * Math.PI * (0.05 + k * 0.013) * t + k * 1.7);
      v += gains[k] * swell * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.003 * t + k));
    });
    out[i] = v;
  }
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  const fadeIn = 2 * sr, fadeOut = 2.5 * sr;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const g = Math.min(1, i / fadeIn, (n - i) / fadeOut);
    buf.writeInt16LE(Math.round((out[i] / peak) * 0.9 * g * 32767), 44 + i * 2);
  }
  writeFileSync(file, buf);
}

// ---------- headless Chrome over the DevTools protocol (no npm packages needed) ----------
async function openChrome(chromePath) {
  const profile = mkdtempSync(join(tmpdir(), "moon-intro-"));
  const proc = spawn(chromePath, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--hide-scrollbars",
    "--force-device-scale-factor=1", `--window-size=${SIZE.width},${SIZE.height}`, "--no-first-run", "about:blank",
  ], { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(portFile)) fail("Chrome did not start.");
  const port = readFileSync(portFile, "utf8").split("\n")[0].trim();
  let pages = [];
  for (let i = 0; i < 50 && !pages.length; i++) {
    try { pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((p) => p.type === "page"); } catch {}
    if (!pages.length) await new Promise((r) => setTimeout(r, 100));
  }
  if (!pages.length) fail("could not reach Chrome's page.");
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; waiting.set(i, (d) => (d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const close = () => { try { ws.close(); } catch {} proc.kill(); setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 500); };
  return { send, close };
}
async function evaluate(send, expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) fail(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function main() {
  const o = args();
  const ffmpeg = o.ffmpeg ?? "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) fail("ffmpeg not found. Install it (winget install Gyan.FFmpeg) or pass --ffmpeg <path>.");
  const chrome = o.chrome ?? findChrome();
  if (!chrome) fail("Chrome or Edge not found. Pass --chrome <path>.");
  const fps = Number(o.fps ?? 30);
  const spec = JSON.parse(readFileSync(resolve(HERE, o.spec ?? "intro.json"), "utf8"));
  const out = resolve(o.out ?? join(ROOT, "demo-build", "moon-intro.mp4"));
  const name = basename(out).replace(/.mp4$/i, "").replace(/^moon-/, "");
  const work = join(dirname(out), `${name}-work`);
  mkdirSync(work, { recursive: true });

  // 1. Voice lines, then the timeline built around them.
  const voice = o.voice ?? spec.voice;
  let online = !o.offline;
  const timeline = [];
  let t = 0;
  for (const sc of spec.scenes) {
    let file = join(work, `${sc.id}.mp3`);
    if (!(online && edgeTts(sc.text, voice, o.rate ?? spec.rate ?? "+0%", file))) {
      if (online) console.log("edge-tts is not available; using the Windows voice. (pip install edge-tts for the neural voice.)");
      online = false;
      file = join(work, `${sc.id}.wav`);
      windowsVoice(sc.text, o.voice && !o.voice.includes("Neural") ? o.voice : spec.fallbackVoice, file);
    }
    const len = speechSeconds(ffmpeg, file);
    const lead = sc.lead ?? DEFAULT_LEAD;
    const dur = lead + len + (spec.pause ?? 0.7) + (sc.tail ?? 0);
    timeline.push({ id: sc.id, text: sc.text, start: t, dur, voiceAt: t + lead, voiceLen: len, file });
    t += dur;
  }
  const total = t + 0.5;
  console.log(`Intro: ${timeline.length} scenes, ${total.toFixed(1)} s. Voice: ${online ? voice : "Windows"}.`);
  for (const s of timeline) console.log(`  ${s.start.toFixed(1).padStart(5)} s  ${s.id}`);

  // 2. Frames from headless Chrome, piped into ffmpeg.
  const silent = join(work, "intro-video.mp4");
  const { send, close } = await openChrome(chrome);
  try {
    await send("Emulation.setDeviceMetricsOverride", { ...SIZE, deviceScaleFactor: 1, mobile: false });
    await send("Page.enable");
    await send("Page.navigate", { url: pathToFileURL(join(HERE, "intro.html")).href + "?render" });
    for (let i = 0; i < 200; i++) {
      const ok = await send("Runtime.evaluate", { expression: "typeof window.ready", returnByValue: true }).catch(() => null);
      if (ok?.result?.value === "object") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await evaluate(send, "window.ready.then(() => true)");
    await evaluate(send, `setTimeline(${JSON.stringify(timeline.map(({ file, ...s }) => s))}); true`);

    const enc = spawn(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", silent], { stdio: ["pipe", "inherit", "inherit"] });
    const frames = Math.ceil(total * fps);
    for (let f = 0; f < frames; f++) {
      const url = await evaluate(send, `renderAt(${(f / fps).toFixed(4)}); document.getElementById("c").toDataURL("image/jpeg", 0.95)`);
      const buf = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
      if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once("drain", r));
      if (f % fps === 0) process.stdout.write(`\r  frames ${f}/${frames}`);
    }
    enc.stdin.end();
    const code = await new Promise((r) => enc.on("close", r));
    process.stdout.write(`\r  frames ${frames}/${frames}\n`);
    if (code !== 0) fail("ffmpeg could not encode the frames.");
  } finally { close(); }

  // 3. Sound: drone under the voice lines.
  const inputs = ["-i", silent];
  const filters = [];
  let mixIn = [];
  if (!o["no-music"]) {
    const drone = join(work, "pad.wav");
    writeDrone(drone, total);
    inputs.push("-i", drone);
    filters.push(`[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${MUSIC_VOLUME}[m]`);
    mixIn.push("[m]");
  }
  const first = o["no-music"] ? 1 : 2;
  timeline.forEach((s, i) => {
    inputs.push("-i", s.file);
    const ms = Math.round(s.voiceAt * 1000);
    filters.push(`[${first + i}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${ms}|${ms}[v${i}]`);
    mixIn.push(`[v${i}]`);
  });
  filters.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:duration=longest:normalize=0,alimiter=limit=0.9,apad,atrim=0:${total.toFixed(3)}[a]`);
  const r = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...inputs, "-filter_complex", filters.join(";"),
    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out], { stdio: "inherit" });
  if (r.status !== 0) fail("ffmpeg could not add the sound.");

  // 4. A still from each scene to check.
  const checkDir = join(dirname(out), `${name}-check`);
  mkdirSync(checkDir, { recursive: true });
  for (const s of timeline) {
    for (const f of [0.35, 0.65, 0.95]) {
      const at = Math.min(s.start + s.dur * f, total - 0.2);
      spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-ss", at.toFixed(2), "-i", out, "-frames:v", "1", "-vf", "scale=1280:-2", join(checkDir, `${s.id}-${Math.round(f * 100)}.png`)]);
    }
  }
  console.log(`Done: ${out} (${total.toFixed(1)} s)\nStills: ${checkDir}`);
}

main().catch((e) => fail(e.stack ?? String(e)));
