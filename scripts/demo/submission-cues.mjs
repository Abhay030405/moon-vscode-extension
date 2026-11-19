// submission-cues.mjs: builds docs/demo/submission.json (the cue file for edit-video.mjs) from the
// separate demo clips. Cue and speed times are written per clip below; this script adds each clip's
// start in the joined recording, so a re-recorded clip only needs its own times changed.
//
//   node scripts/demo/submission-cues.mjs --clips <folder> [--ffmpeg path]
//
// It prints the clip order and starts; join the clips in the same order (see docs/demo/video-script.md).

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, fail, runMain } from "../lib/local-files.mjs";

const FPS = 30;

// Each clip: file name, then cues [at, id, text, extras] and fast-forward spans [from, to, factor], in clip time.
const CLIPS = [
  { file: "intro.mp4", speed: [[4.6, 6.33, 2]], cues: [
    [0.2, "d-intro", "This is Flask 3.1.3 in Visual Studio Code, with the *Moon panel* on the left.", { badge: "Live demo · Flask 3.1.3" }],
  ] },
  { file: "stop-clue.mp4", speed: [[5, 9, 2]], cues: [
    [0.6, "a3-stop", "First, *Stop*. I start an inline edit and press Stop while Moon is working.", { badge: "Streaming and Stop" }],
    [9.5, "a3-stopped", "Moon stops at once: *the file was not changed*.", { zoom: [0.55, 0.47, 1.5, 2.5] }],
    [13.6, "a3-clean", "git status is *clean*.", { zoom: [0.5, 0.82, 1.6, 2] }],
  ] },
  { file: "task A first video.mp4", speed: [[6, 9.7, 2.5], [20.5, 23.3, 2]], cues: [
    [0.5, "a-start", "Task A. I select get_debug_flag, press Control I, and paste the instruction.", { badge: "Task A · Inline edit" }],
    [10, "a-diff", "The diff is drawn *in the file*: green lines added, red lines removed, with *Accept and Reject on every hunk*.", { zoom: [0.6, 0.5, 1.5, 4] }],
    [16.5, "a-accept", "I accept each hunk on its own. *Nothing is written* until I accept.", {}],
  ] },
  { file: "task A second video.mp4", speed: [[0, 7, 2]], cues: [
    [7.6, "a-verify", "With FLASK_DEBUG set to off, get_debug_flag now returns *False*.", { zoom: [0.5, 0.8, 1.6, 3] }],
    [12.6, "a-reset", "I restore the file. git status is clean again.", {}],
  ] },
  { file: "task B video 1.mp4", speed: [[12, 55, 4], [63, 67.5, 3], [75, 87, 3], [92, 108.8, 3]], cues: [
    [0.3, "b-start", "Task B, agent mode. The request *names no files*.", { badge: "Task B · Agent mode" }],
    [4, "b-map", "Before any model call, Moon packs a ranked *project map* into an eight thousand token budget.", { zoom: [0.19, 0.27, 1.7, 3.5] }],
    [12.5, "b-scout", "A *scout subagent* searches and reads the code. Each tool call is one line in the live log.", {}],
    [56.2, "b-context", "The *context card* shows the files the scout chose, code, tests and docs, why each one, and the token budget.", { zoom: [0.19, 0.33, 1.8, 4.5] }],
    [68, "b-review", "The agent edited a *hidden copy* and ran pytest: verified. Apply changes opens the review: six hunks in *three files I never named*.", { zoom: [0.19, 0.45, 1.5, 5] }],
    [88, "b-apply", "I press Apply. *Only the accepted hunks* reach my files.", {}],
    [93, "b-summary", "Moon's summary says what changed, and what it did not check.", {}],
  ] },
  { file: "task B video 2.mp4", speed: [[2.5, 8.5, 2.5], [11, 19, 2.5], [19, 27, 4], [35, 47, 3]], cues: [
    [0.5, "b-verify", "In the terminal, flask help lists the new *config* command, and flask config prints the configuration as JSON, with *secrets masked*.", { zoom: [0.5, 0.75, 1.5, 5] }],
    [27.6, "b-session", "This is the same run in *TrueForge's own UI*: the scout subagent, then every *MCP tool call*, from search to apply changes.", { zoom: [0.58, 0.45, 1.35, 4] }],
    [48.3, "b-undo", "Back in the editor, *Undo this whole run* puts all three files back.", { zoom: [0.2, 0.7, 1.7, 3] }],
  ] },
  { file: "task B video 3.mp4", speed: [[0, 5, 2]], cues: [
    [5.3, "b-clean", "git status is *clean*.", { zoom: [0.5, 0.82, 1.6, 2] }],
  ] },
  { file: "task c .mp4", speed: [[19.2, 21.3, 2], [24.5, 29.5, 2], [34.5, 40.1, 3]], cues: [
    [0.3, "c-break", "Task C. This script gives the main Claude provider an *invalid key* in TrueForge.", { badge: "Task C · Resilience" }],
    [5, "c-start", "I repeat Task A.", {}],
    [10.3, "c-switch", "Claude fails, and Moon switches to *DeepSeek on Azure* by itself, on a new TrueForge session. *Nothing was changed*.", { zoom: [0.6, 0.55, 1.5, 4.5] }],
    [16.6, "c-responsive", "The editor stays *responsive* the whole time.", {}],
    [21.5, "c-diff", "The backup's diff arrives for review, and I reject it.", { zoom: [0.66, 0.52, 1.4, 3] }],
    [31, "c-clean", "git status is *clean*: the preview never touched the disk.", { zoom: [0.5, 0.8, 1.6, 3] }],
  ] },
];

function args() {
  const o = {}; const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, "")] = a[i + 1];
  return o;
}

function seconds(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8" });
  const d = (r.stderr ?? "").match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!d) fail(`ffmpeg could not read ${file}.`);
  return Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
}

const mmss = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;

async function main() {
  const o = args();
  if (!o.clips) fail("Pass --clips <folder with the demo clips>.");
  const ffmpeg = o.ffmpeg ?? "ffmpeg";
  const cues = [];
  const speed = [];
  let frames = 0; // clips are joined at 30 fps, so starts are whole frames
  for (const clip of CLIPS) {
    const start = frames / FPS;
    const len = seconds(ffmpeg, join(o.clips, clip.file));
    console.log(`${mmss(start)}  ${clip.file} (${len.toFixed(2)} s)`);
    for (const [at, id, text, extra] of clip.cues) cues.push({ id, at: mmss(start + at), text, ...extra });
    for (const [from, to, factor] of clip.speed ?? []) speed.push({ from: mmss(start + from), to: mmss(start + Math.min(to, len - 0.05)), factor });
    frames += Math.round(len * FPS);
  }
  const spec = {
    $comment: "Generated by scripts/demo/submission-cues.mjs from the separate demo clips; edit the times there, not here.",
    speed,
    cues,
  };
  const out = join(ROOT, "docs/demo/submission.json");
  writeFileSync(out, JSON.stringify(spec, null, 2) + "\n");
  console.log(`Wrote ${out}: ${cues.length} cues, ${speed.length} fast-forward spans.`);
}

await runMain(main);
