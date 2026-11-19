# Demo video: run sheet

The video must be at most **4:00**, show Tasks **A, B and C in that order**, each followed by its check on
screen, and show the **TrueForge session during Task B**. Model waiting time may be cut, but **never cut
between giving an instruction and the diff appearing**. Record one take. The edit step adds the voice and captions, never cuts, and can fast-forward
the stretches where Moon is searching or thinking (1.75x, with a "1.75x >> fast-forward" label on screen).
So the raw recording may run a little over 4:00 as long as the final video is at most 4:00; the edit
step prints both lengths.

Target timeline (fits in about 3:45 with Claude's usual speed):

| Time | Part | Scorecard rows |
|---|---|---|
| 0:00 to 0:08 | Intro | |
| 0:08 to 0:25 | Stop during an inline edit, `git status` clean | A3 |
| 0:25 to 1:00 | Task A, check prints `False`, file restored | A1 |
| 1:00 to 3:05 | Task B, context card, approval, review, checks, TrueForge session, Undo | A2, B1, B2, B4 |
| 3:05 to 3:45 | Task C, switch to backup, `git status` clean | B3 |

## Before recording (off camera)

1. Start TrueForge: `powershell -ExecutionPolicy Bypass -File scripts/start-trueforge.ps1`.
2. Make sure both models are registered: `powershell -ExecutionPolicy Bypass -File scripts/setup-providers.ps1`.
3. Make a fresh Flask folder (new folder = no Moon history):
   `powershell -ExecutionPolicy Bypass -File scripts/demo/demo.ps1 prep`. It prints the folder to open.
4. Open that folder in VS Code with the Moon extension. Check the status bar says Moon is connected to TrueForge.
5. Screen: 1920x1080. VS Code zoom in once (Ctrl+=). Moon panel on the right, terminal at the bottom.
   Close other tabs and side bars. Turn on Do Not Disturb so no notifications appear.
6. Terminal: set the default profile to **Git Bash** so the PS command runs exactly as written, then run
   `source .venv/Scripts/activate` and `clear`.
7. Open the TrueForge UI (`http://localhost:8790`) in a browser tab, ready for Task B.
8. Open `docs/demo/paste.txt` (below) in Notepad, out of the recorded area or on a second screen, so you can copy each instruction.
9. Start the recorder: **Snipping Tool** (Win+Shift+R, pick the full screen) or OBS. Windows Game Bar records
   only one window, so it would miss the browser.

## Recording

Say nothing; the voice, captions and animation are added later. Note the time on the recorder when each **cue** event happens,
or find the times afterwards while watching. You will put them into `docs/demo/narration.json`.

### Intro (cue `intro`)
Show VS Code with Flask open and the Moon panel. In the terminal: `git log -1 --oneline` (shows `22d92470`).

### Stop (cues `a3-stop`, `a3-clean`)
1. Open `src/flask/helpers.py`, select the whole `get_debug_flag` function, press **Ctrl+I**, paste the
   Task A instruction, press **Ctrl+Enter**. Cue `a3-stop`.
2. As soon as text starts streaming in the box, press **Stop**. The preview disappears and "Stopped" shows.
3. Terminal: `git status`. Shows nothing to commit. Cue `a3-clean`.

### Task A (cues `a-start`, `a-stream`, `a-diff`, `a-verify`, `a-reset`)
1. Select `get_debug_flag` again, **Ctrl+I**, paste the instruction, **Ctrl+Enter**. Cue `a-start`.
2. While it streams, scroll the file a little to show the editor is not blocked. Cue `a-stream`.
3. The diff appears in the file (green new lines, red old lines). Cue `a-diff`.
   Click **Accept** on each hunk one by one (not Accept all), so per-hunk review is visible. Save (Ctrl+S).
4. Terminal: `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`
   prints `False`. Cue `a-verify`.
5. Terminal: `git checkout -- src/flask/helpers.py && git status` (clean again). Cue `a-reset`.

### Task B (cues `b-start` to `b-undo`)
1. Moon panel, new chat. Paste the Task B instruction exactly, no `@` mentions, send. Cue `b-start`.
2. The context card appears with files, reasons and the budget bar. Pause 2 seconds on it. Cue `b-context`.
3. Let the live log run. Cue `b-log` while tool lines are moving.
4. When the `run_command` card asks to run pytest, click **Allow once**. Cue `b-approve`.
   (Allow again if it asks for another check.)
5. The review screen opens (from the `apply_changes` approval). Scroll so 3 or more files show. Cue `b-review`.
6. Accept the hunks (per file or Accept all), press **Apply**. Cue `b-apply`.
7. Terminal, one after another:
   - `python -m pytest tests/test_cli.py -q` (passes)
   - `flask --help` (lists `config`)
   - `flask --app <demo app path printed by prep> config` (keys with SECRET, PASSWORD, TOKEN, KEY show `"***"`)

   Cue `b-verify` at the pytest result.
8. Click the TrueForge session button in the Moon panel (or switch to the TrueForge tab and open this session).
   Show the turns, the MCP tool calls and the scout subagent for about 6 seconds. Cue `b-session`.
9. Back in VS Code, press **Undo this whole run**, then `git status` in the terminal (clean). Cue `b-undo`.

### Task C (cues `c-break` to `c-diff`, `outro`)
1. Terminal: `node <moon repo>/scripts/demo/task-c.mjs break` (the main provider now has an invalid key). Cue `c-break`.
2. Select `get_debug_flag`, **Ctrl+I**, paste the Task A instruction, **Ctrl+Enter**. Cue `c-start`.
3. The notice "Main model failed (invalid key), switched to backup: ..." appears. Cue `c-switch`.
4. While the backup works, click around and type in another file (then undo the typing). Cue `c-responsive`.
5. The diff appears. Terminal: `git status` (clean, the preview is never saved). Cue `c-diff`.
   Then **Reject all** and `git status` once more.
6. Cue `outro` on the final frame. Stop the recorder.

### After recording (off camera)
1. Put the real key back: `powershell -ExecutionPolicy Bypass -File scripts/demo/demo.ps1 restore`.
2. The raw recording may be longer than 2:55; fast-forwarding the agent's work brings it down. If even
   that cannot fit, record again with less idle time.

## Adding voice, captions and animation

Record with no voice. The edit step adds everything on top of your footage:
- a voice line for each cue (computer voice, or your own recording of any line);
- animated captions, with the important words highlighted in amber;
- a section badge in the top-left corner and a title that fades in when each part starts;
- smooth zoom-ins on the context card, the approval card, the review, the terminal results and the switch notice.

Nothing is cut or sped up.

1. Install ffmpeg once: `winget install Gyan.FFmpeg` (macOS: `brew install ffmpeg`).
2. Watch your recording and set each cue's `"at"` in `docs/demo/narration.json` to its time in the raw
   recording (`"1:07"` or `"1:07.5"`). Or send the times to Claude and it will fill them in.
3. Render the intro once (about 2 minutes; its text is in `scripts/demo/intro/intro.json`):
   `powershell -ExecutionPolicy Bypass -File scripts/demo/demo.ps1 intro`
   It writes `demo-build/moon-intro.mp4` (git-ignored) and stills in `demo-build/intro-check/`. Then:
   `powershell -ExecutionPolicy Bypass -File scripts/demo/demo.ps1 edit --video C:\path\raw.mp4 --intro demo-build/moon-intro.mp4`
4. Open the `check/` folder next to the output: one image per cue, taken inside its zoom. If a zoom misses
   its target, change that cue's `"zoom": [centreX, centreY, factor, seconds]` (centres are fractions of
   the screen, 0.5 is the middle) and run step 3 again.
5. Fast-forward: add spans to `"speed"` at the top of `narration.json`, in raw-recording time, for example
   `"speed": [{ "from": "1:12", "to": "2:05", "factor": 1.75 }]`. Use it only while Moon is searching,
   thinking or running tests. Keep typing the instruction, the diff appearing, approvals and every check
   at normal speed. The script prints the final time of every cue for the scorecard.
6. If it warns that a voice line runs into the next cue: move the next cue a little later, shorten the
   line, or add `--rate 2` for a faster voice.

Other options: `--voice "Microsoft Zira Desktop"` (or David), `--voice-dir my-voice` to use your own
recordings (`my-voice/<cue id>.wav`), `--no-zoom`, `--no-captions`.

Output: `raw-final.mp4`, plus `captions.srt` for YouTube. Upload it as unlisted on YouTube or on Google Drive
("anyone with the link"), then put the time of each part into the write-up's scorecard.

## paste.txt (the exact PS instructions)

Task A and C:
```
Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
```

Task B:
```
Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
```
