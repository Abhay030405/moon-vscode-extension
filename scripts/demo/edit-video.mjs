// edit-video.mjs: turn the silent demo recording into the final video.
//
//   node scripts/demo/edit-video.mjs --video raw.mp4 [--out final.mp4] [--cues docs/demo/narration.json]
//        [--voice "Microsoft Zira Desktop"] [--rate 1] [--voice-dir my-voice/] [--ffmpeg path]
//        [--keep-audio 0.3] [--no-captions] [--no-zoom] [--intro demo-build/moon-intro.mp4]
//        [--outro demo-build/moon-outro.mp4] [--voice en-IN-PrabhatNeural --rate +50%]
//
// A voice name ending in "Neural" uses edge-tts (pip install edge-tts), the same voice as the intro;
// it sends only the narration text to Microsoft's read-aloud service.
//
// For each cue in narration.json that has an "at" time it adds:
//   - a voice line: <voice-dir>/<id>.wav if you recorded it yourself, else the computer voice
//     (Windows System.Speech, macOS `say`);
//   - an animated caption with the same words; *words in stars* are highlighted;
//   - "badge": a section label in the top-left corner (stays until the next badge) and a title
//     that fades in at the top for two seconds;
//   - "zoom": [centreX, centreY, factor, seconds]: a smooth zoom on part of the screen.
//     centreX/centreY are fractions of the frame (0.5, 0.5 = middle).
// "speed": [{from, to, factor}] at the top of narration.json fast-forwards stretches of model
// waiting (raw times, default factor 1.75) with a visible "1.75x >> fast-forward" label.
// Nothing is ever cut. Cue "at" times are always in the RAW recording; the script maps them.
// It also writes one check image per cue into <out folder>/check/ so you can see each zoom.
// Needs ffmpeg (Windows: winget install Gyan.FFmpeg; macOS: brew install ffmpeg).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ROOT, fail, runMain } from "../lib/local-files.mjs";

const MAX_VIDEO_SECONDS = 240; // the competition's 4-minute limit
const CAPTION_GAP = 0.15; // seconds between one caption's end and the next one's start
const CAPTION_TAIL = 0.4; // seconds a caption stays after its voice ends
const TITLE_SECONDS = 2.0; // how long a section title stays at the top
const ZOOM_RAMP = 0.6; // seconds to zoom in and to zoom out
const CHECK_OFFSET = 1.2; // seconds after a cue starts for its check image
const DEFAULT_SPEED = 1.75; // fast-forward factor when a speed span gives none
const MAX_SPEED = 4; // faster than this hides what happened
// Colours in ASS order (&HAABBGGRR, AA = transparency).
const WHITE = "&H00FFFFFF";
const HIGHLIGHT = "&H00BCDCE9"; // soft gold (#E9DCBC)
const CAPTION_BOX = "&H103D2016"; // navy (#16203D), as in the intro
const BADGE_BOX = "&H003F8BB3"; // moon gold (#B38B3F)

function args() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) fail(`Unexpected argument ${a[i]}`);
    const key = a[i].slice(2);
    if (key.startsWith("no-")) out[key] = true;
    else out[key] = a[++i];
  }
  return out;
}

function parseTime(t, id) {
  const m = String(t).match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) fail(`Cue "${id}": "at" must look like m:ss or m:ss.s, got "${t}".`);
  return Number(m[1]) * 60 + Number(m[2]);
}

const plain = (text) => text.replace(/\*/g, "");

function assTime(s) {
  const cs = Math.max(0, Math.round(s * 100));
  const p = (n) => String(n).padStart(2, "0");
  return `${Math.floor(cs / 360000)}:${p(Math.floor(cs / 6000) % 60)}:${p(Math.floor(cs / 100) % 60)}.${p(cs % 100)}`;
}

function srtTime(s) {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/** Caption text for ASS: escape braces and backslashes, colour the *starred* words. */
function assText(text) {
  const safe = text.replace(/\\/g, "/").replace(/[{}]/g, "");
  return safe.replace(/\*([^*]+)\*/g, `{\\c${HIGHLIGHT}&}$1{\\c${WHITE}&}`);
}

/** Duration in seconds of a PCM WAV file, read from its header. */
function wavSeconds(file) {
  const b = readFileSync(file);
  const byteRate = b.readUInt32LE(28);
  let pos = 12;
  while (pos < b.length - 8) {
    const id = b.toString("ascii", pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    if (id === "data") return size / byteRate;
    pos += 8 + size + (size % 2);
  }
  fail(`${file} is not a PCM WAV file.`);
}

/** Neural voice through edge-tts, trimmed of silence at both ends, as a WAV. */
function neuralVoice(text, file, voice, rate, ffmpeg) {
  const mp3 = file.replace(/\.wav$/, ".mp3");
  const ok = ["python", "python3", "py"].some((py) =>
    spawnSync(py, ["-m", "edge_tts", "--voice", voice, `--rate=${rate ?? "+0%"}`, "--text", text, "--write-media", mp3]).status === 0 && existsSync(mp3));
  if (!ok) fail("edge-tts failed (pip install edge-tts), or pick a built-in voice with --voice.");
  const trim = "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse";
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", mp3, "-af", trim, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", file]);
}

function speak(text, file, voice, rate, ffmpeg) {
  if (voice && /Neural$/.test(voice)) return neuralVoice(text, file, voice, rate, ffmpeg);
  if (process.platform === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Speech",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      voice ? `$s.SelectVoice('${voice.replace(/'/g, "''")}')` : "",
      `$s.Rate = ${Number(rate ?? 1)}`,
      `$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}')`,
      "$s.Speak([Console]::In.ReadToEnd())",
      "$s.Dispose()",
    ].filter(Boolean).join("; ");
    const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { input: text });
    if (r.status !== 0) fail(`Text to speech failed: ${r.stderr}`);
  } else if (process.platform === "darwin") {
    const aiff = file.replace(/\.wav$/, ".aiff");
    execFileSync("say", [...(voice ? ["-v", voice] : []), "-o", aiff, text]);
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", aiff, file]);
  } else {
    fail("No built-in voice on this OS. Record the lines yourself and pass --voice-dir.");
  }
}

function probe(ffmpeg, video) {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-i", video], { encoding: "utf8" });
  const text = r.stderr ?? "";
  const d = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const v = text.match(/Stream #.*Video:.*?, (\d{2,5})x(\d{2,5})/);
  if (!d || !v) fail(`ffmpeg could not read ${video}.`);
  return {
    seconds: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
    width: Number(v[1]),
    height: Number(v[2]),
    hasAudio: /Stream #.*Audio:/.test(text),
  };
}

/** Captions, badges and titles as one ASS subtitle file. */
function buildAss(cues, info, fast = []) {
  const { width: W, height: H, seconds } = info;
  const px = (f) => Math.round(H * f);
  const styles = [
    `Style: Caption,Arial,${px(0.034)},${WHITE},${WHITE},${CAPTION_BOX},${CAPTION_BOX},0,0,0,0,100,100,0,0,4,${px(0.008)},0,2,${Math.round(W * 0.14)},${Math.round(W * 0.14)},${px(0.045)},1`,
    `Style: Badge,Arial,${px(0.024)},${WHITE},${WHITE},${BADGE_BOX},${BADGE_BOX},1,0,0,0,100,100,0,0,3,${px(0.01)},0,7,0,0,0,1`,
    `Style: Fast,Arial,${px(0.024)},${WHITE},${WHITE},${CAPTION_BOX},${CAPTION_BOX},1,0,0,0,100,100,0,0,4,${px(0.01)},0,9,${px(0.025)},${px(0.025)},${px(0.022)},1`,
    `Style: Title,Arial,${px(0.05)},${WHITE},${WHITE},${CAPTION_BOX},${CAPTION_BOX},1,0,0,0,100,100,0,0,4,${px(0.012)},0,8,0,0,${px(0.07)},1`,
  ];
  const events = [];
  const badgeX = px(0.025);
  const badgeY = px(0.022);
  cues.forEach((c, i) => {
    const next = cues[i + 1]?.start ?? seconds;
    if (c.caption !== false) {
      const end = Math.max(Math.min(c.start + c.length + CAPTION_TAIL, next - CAPTION_GAP), c.start + 1);
      events.push(`Dialogue: 0,${assTime(c.start)},${assTime(end)},Caption,,0,0,0,,{\\fad(180,140)\\fscx96\\fscy96\\t(0,180,\\fscx100\\fscy100)}${assText(c.text)}`);
    }
    if (c.badge) {
      const nextBadge = cues.slice(i + 1).find((x) => x.badge)?.start ?? seconds;
      const label = assText(c.badge);
      events.push(`Dialogue: 1,${assTime(c.start)},${assTime(nextBadge)},Badge,,0,0,0,,{\\move(${badgeX - px(0.04)},${badgeY},${badgeX},${badgeY},0,300)\\fad(300,200)}${label}`);
      events.push(`Dialogue: 2,${assTime(c.start)},${assTime(Math.min(c.start + TITLE_SECONDS, next))},Title,,0,0,0,,{\\fad(250,350)\\fscx85\\fscy85\\t(0,300,\\fscx100\\fscy100)}${label}`);
    }
  });
  for (const s of fast) {
    events.push(`Dialogue: 3,${assTime(s.outFrom)},${assTime(s.outTo)},Fast,,0,0,0,,{\\fad(150,150)}${s.factor}x  >>  fast-forward`);
  }
  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles, "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events, "",
  ].join("\n");
}

/** ffmpeg filter for the zooms: scale up by Z(t), then crop the original size around the target. */
function zoomFilter(cues, info) {
  const zooms = cues.filter((c) => Array.isArray(c.zoom)).map((c) => {
    const [cx, cy, factor, seconds] = c.zoom;
    if (![cx, cy, factor, seconds].every((n) => typeof n === "number") || factor < 1 || cx < 0 || cx > 1 || cy < 0 || cy > 1) {
      fail(`Cue "${c.id}": zoom must be [centreX 0..1, centreY 0..1, factor >= 1, seconds].`);
    }
    return { s: c.raw, d: seconds + 2 * ZOOM_RAMP, cx, cy, f: factor };
  });
  if (!zooms.length) return null;
  const { width: W, height: H } = info;
  // e(t): 0 outside a zoom, smoothly up to 1 and back down (smoothstep of a clipped ramp).
  const ease = (z) => {
    const u = `clip(min((t-${z.s.toFixed(3)})/${ZOOM_RAMP},(${(z.s + z.d).toFixed(3)}-t)/${ZOOM_RAMP}),0,1)`;
    return `(${u})*(${u})*(3-2*(${u}))`;
  };
  const Z = `(1${zooms.map((z) => `+${(z.f - 1).toFixed(3)}*${ease(z)}`).join("")})`;
  const CX = `(${W / 2}${zooms.map((z) => `+${(z.cx * W - W / 2).toFixed(1)}*${ease(z)}`).join("")})`;
  const CY = `(${H / 2}${zooms.map((z) => `+${(z.cy * H - H / 2).toFixed(1)}*${ease(z)}`).join("")})`;
  return (
    `scale=w='2*trunc(${W}*${Z}/2)':h='2*trunc(${H}*${Z}/2)':eval=frame:flags=bicubic,` +
    // crop keeps the input size it saw first, so iw/ih would stay W/H here: use the zoom factor itself.
    `crop=${W}:${H}:x='clip(${CX}*${Z}-${W / 2},0,${W}*${Z}-${W}-2)':y='clip(${CY}*${Z}-${H / 2},0,${H}*${Z}-${H}-2)'`
  );
}

/** Speed spans from narration.json ("speed": [{from, to, factor}]) as sorted raw-time segments. */
function speedSegments(spec, seconds) {
  const spans = (spec ?? []).map((s, i) => {
    const from = parseTime(s.from, `speed[${i}]`);
    const to = parseTime(s.to, `speed[${i}]`);
    const factor = s.factor ?? DEFAULT_SPEED;
    if (!(to > from) || factor < 1 || factor > MAX_SPEED) fail(`speed[${i}]: need from < to and 1 <= factor <= ${MAX_SPEED}.`);
    return { from, to: Math.min(to, seconds), factor };
  }).sort((a, b) => a.from - b.from);
  spans.forEach((s, i) => { if (i && s.from < spans[i - 1].to) fail("speed spans overlap."); });
  // Whole timeline as segments: normal speed between the fast spans.
  const segs = [];
  let t = 0;
  for (const s of spans) {
    if (s.from > t) segs.push({ from: t, to: s.from, factor: 1 });
    segs.push(s);
    t = s.to;
  }
  if (t < seconds) segs.push({ from: t, to: seconds, factor: 1 });
  let outT = 0;
  for (const s of segs) { s.outFrom = outT; outT += (s.to - s.from) / s.factor; s.outTo = outT; }
  return segs;
}

/** Raw recording time -> time in the final video. */
function mapTime(segs, t) {
  const s = segs.find((x) => t >= x.from && t < x.to) ?? segs[segs.length - 1];
  return s.outFrom + (Math.min(t, s.to) - s.from) / s.factor;
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

async function main() {
  const o = args();
  if (!o.video) fail("Pass --video <raw recording>.");
  const ffmpeg = o.ffmpeg ?? "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) fail("ffmpeg not found. Install it (winget install Gyan.FFmpeg) or pass --ffmpeg <path>.");

  const video = resolve(o.video);
  const out = resolve(o.out ?? join(dirname(video), basename(video).replace(/\.[^.]+$/, "") + "-final.mp4"));
  const outDir = dirname(out);
  const clipsDir = join(outDir, "voice-clips");
  mkdirSync(clipsDir, { recursive: true });
  const spec = JSON.parse(readFileSync(resolve(o.cues ?? join(ROOT, "docs/demo/narration.json")), "utf8"));

  const info = probe(ffmpeg, video);
  const segs = speedSegments(spec.speed, info.seconds);
  const outSeconds = segs[segs.length - 1].outTo;
  // --intro: the animated intro (scripts/demo/intro) goes in front; the demo is rendered first on its own.
  const intro = o.intro ? resolve(o.intro) : null;
  if (intro && !existsSync(intro)) fail(`Intro not found: ${intro}. Render it with: node scripts/demo/intro/render-intro.mjs`);
  const introSeconds = intro ? probe(ffmpeg, intro).seconds : 0;
  // --outro: closing slides (render-intro.mjs --spec outro.json) go at the end.
  const outro = o.outro ? resolve(o.outro) : null;
  if (outro && !existsSync(outro)) fail(`Outro not found: ${outro}. Render it with: node scripts/demo/intro/render-intro.mjs --spec outro.json`);
  const outroSeconds = outro ? probe(ffmpeg, outro).seconds : 0;
  const body = intro || outro ? out.replace(/\.mp4$/i, "") + "-body.mp4" : out;
  const cues = spec.cues
    .filter((c) => c.at !== null && c.at !== undefined)
    .map((c) => { const raw = parseTime(c.at, c.id); return { ...c, raw, start: mapTime(segs, raw) }; })
    .sort((a, b) => a.raw - b.raw);
  if (!cues.length) fail('No cue has an "at" time yet. Fill them in docs/demo/narration.json.');
  const late = cues.filter((c) => c.raw >= info.seconds);
  if (late.length) fail(`These cues start after the video ends: ${late.map((c) => c.id).join(", ")}.`);
  const fast = segs.filter((s) => s.factor > 1);
  console.log(`Video: ${info.width}x${info.height}, ${info.hasAudio ? "has" : "no"} audio. Raw ${fmt(info.seconds)}, final ${fmt(outSeconds + introSeconds + outroSeconds)}${intro || outro ? ` (intro ${fmt(introSeconds)} + demo ${fmt(outSeconds)} + outro ${fmt(outroSeconds)})` : ""}${fast.length ? ` (${fast.length} fast-forward spans)` : ""}.`);
  if (outSeconds + introSeconds + outroSeconds > MAX_VIDEO_SECONDS) console.log(`WARNING: the final video is longer than ${fmt(MAX_VIDEO_SECONDS)}, the competition limit.`);

  // 1. One voice clip per cue (voices are never sped up).
  for (const c of cues) {
    const own = o["voice-dir"] ? join(resolve(o["voice-dir"]), `${c.id}.wav`) : null;
    c.clip = own && existsSync(own) ? own : join(clipsDir, `${c.id}.wav`);
    if (c.clip !== own) speak(plain(c.text), c.clip, o.voice, o.rate, ffmpeg);
    c.length = wavSeconds(c.clip);
  }
  cues.forEach((c, i) => {
    const next = cues[i + 1]?.start ?? outSeconds;
    if (c.start + c.length > next) {
      console.log(`WARNING: "${c.id}" speaks for ${c.length.toFixed(1)} s but the next cue comes ${(next - c.start).toFixed(1)} s later in the final video. Move a cue, shorten the line, or raise --rate.`);
    }
  });

  // 2. Captions (ASS for the video, SRT for YouTube), in final-video time.
  const outInfo = { ...info, seconds: outSeconds };
  writeFileSync(join(outDir, "captions.ass"), buildAss(cues, outInfo, fast));
  writeFileSync(join(outDir, "captions.srt"), cues.map((c, i) => {
    const next = cues[i + 1]?.start ?? outSeconds;
    const end = Math.max(Math.min(c.start + c.length + CAPTION_TAIL, next - CAPTION_GAP), c.start + 1);
    return `${i + 1}\n${srtTime(c.start)} --> ${srtTime(end)}\n${plain(c.text)}\n`;
  }).join("\n"));

  // 3. Video: zoom (raw time), then speed segments, then text on top (final time).
  const inputs = ["-i", video];
  const filters = [];
  const zoom = o["no-zoom"] ? null : zoomFilter(cues, info);
  const textOn = !o["no-captions"];
  const n = segs.length;
  filters.push(`[0:v]${zoom ? zoom + "," : ""}split=${n}${segs.map((_, i) => `[vs${i}]`).join("")}`);
  segs.forEach((s, i) => filters.push(`[vs${i}]trim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},setpts=(PTS-STARTPTS)/${s.factor}[vp${i}]`));
  filters.push(`${segs.map((_, i) => `[vp${i}]`).join("")}concat=n=${n}:v=1:a=0${textOn ? "[vc];[vc]ass=captions.ass" : ""}[vout]`);

  // 4. Audio: the recording's own sound (quieter, sped with the video) or silence, plus every voice clip.
  const keep = Number(o["keep-audio"] ?? 0.3);
  if (info.hasAudio) {
    filters.push(`[0:a]asplit=${n}${segs.map((_, i) => `[as${i}]`).join("")}`);
    segs.forEach((s, i) => filters.push(`[as${i}]atrim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},asetpts=PTS-STARTPTS,atempo=${s.factor}[ap${i}]`));
    filters.push(`${segs.map((_, i) => `[ap${i}]`).join("")}concat=n=${n}:v=0:a=1,volume=${keep}[base]`);
  } else {
    inputs.push("-f", "lavfi", "-t", outSeconds.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
    filters.push("[1:a]anull[base]");
  }
  const firstClip = info.hasAudio ? 1 : 2;
  cues.forEach((c, i) => {
    inputs.push("-i", c.clip);
    const ms = Math.round(c.start * 1000);
    filters.push(`[${firstClip + i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[v${i}]`);
  });
  filters.push(`[base]${cues.map((_, i) => `[v${i}]`).join("")}amix=inputs=${cues.length + 1}:duration=first:normalize=0[aout]`);

  console.log(`Rendering ${cues.length} voice lines, ${textOn ? "captions, " : ""}${zoom ? cues.filter((c) => c.zoom).length : 0} zooms, ${fast.length} fast-forward spans...`);
  // Run inside the output folder so the subtitle filter gets a plain file name (no drive-letter escaping).
  const r = spawnSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-stats",
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
    body,
  ], { cwd: outDir, stdio: "inherit" });
  if (r.status !== 0) fail("ffmpeg failed; see above.");

  if (intro || outro) {
    // Intro first and outro last, each scaled to the recording's size, around the edited demo.
    const { width: w, height: h } = info;
    const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`;
    const aud = "aresample=48000,aformat=channel_layouts=stereo";
    const parts = [intro, body, outro].filter(Boolean);
    const graph = parts.map((p, i) => `[${i}:v]${p === body ? "setsar=1,fps=30" : fit}[v${i}];[${i}:a]${aud}[a${i}]`).join(";") +
      ";" + parts.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${parts.length}:v=1:a=1[v][a]`;
    const j = spawnSync(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error", "-stats", ...parts.flatMap((p) => ["-i", p]),
      "-filter_complex", graph,
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out,
    ], { stdio: "inherit" });
    if (j.status !== 0) fail("ffmpeg could not join the intro and outro; see above.");
  }

  // 5. One check image per cue (inside its zoom when it has one).
  const checkDir = join(outDir, "check");
  mkdirSync(checkDir, { recursive: true });
  for (const c of cues) {
    const rawT = c.raw + (c.zoom ? ZOOM_RAMP + Math.min(c.zoom[3], 2) / 2 : CHECK_OFFSET);
    const t = Math.min(mapTime(segs, rawT), outSeconds - 0.1);
    spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-ss", t.toFixed(2), "-i", body, "-frames:v", "1", "-vf", "scale=960:-2", join(checkDir, `${c.id}.png`)]);
  }

  // 6. Where each part starts in the final video (for the write-up's scorecard).
  console.log("\nTimes in the final video:");
  if (intro) console.log(`   0:00  intro (animation)`);
  for (const c of cues) console.log(`  ${fmt(c.start + introSeconds).padStart(5)}  ${c.id}${c.badge ? `  [${c.badge}]` : ""}`);
  if (outro) console.log(`  ${fmt(outSeconds + introSeconds).padStart(5)}  outro (deployment, thank you)`);
  console.log(`\nDone: ${out} (${fmt(outSeconds + introSeconds + outroSeconds)})\nCaptions for YouTube: ${join(outDir, "captions.srt")}\nCheck images: ${checkDir}`);
}

await runMain(main);
