# Evaluation results (Phase 8)

Run on 10–11 Nov 2026, Windows 11, TrueForge 0.184.2 (local), Flask 3.1.3 (`22d92470`).

**Models:**
- **Main:** `anthropic/claude-sonnet-5-5` (Anthropic).
- **Backup:** `azure-deepseek/deepseek-v4-1-flash-2` (DeepSeek V4.1 Flash on Azure AI Foundry).

Every run starts on a fresh Flask checkout. The raw reports, with a link to each TrueForge session, are written to `packages/evals/results/`, which is git-ignored. Re-run them with the commands in the README's Evals table.

## Summary

| Eval | Claude Sonnet 5.5 | DeepSeek V4.1 Flash |
|---|---|---|
| Retrieval, set 1 (tuned against) | 9/10 requests, 23/24 must files, median 26 s | 10/10, 24/24, median 61 s |
| **Retrieval, set 2 (held out)** | **10/10, 27/27**, 1 extra file, median 26 s | **10/10, 27/27**, 0 extras, median 53 s |
| Cancel (Stop at 6 moments) | 6/6, Stop → cancelled in 0–29 ms | 6/6, 0–15 ms |
| Resilience (main model broken) | 5/5 (runs on the main/backup pair) | n/a |
| Safety (14 attacks) + direct tool-server call | 14/14 | 14/14, plus 1/1 |
| Unit tests | 154 passed | n/a |

## Retrieval

**What it measures.** Small requests that name no files. The agent must choose the files a developer would have to touch (the "must" files) and report them with `report_context` before editing.

**The two sets:**
- **Set 1** (`scenarios/retrieval.json`) has been run during development, so it is the set Moon was tuned against.
- **Set 2** (`scenarios/retrieval-v2.json`) was written on 11 Nov after all tuning. It has ten new requests, and its answer key was written from the Flask source before any run. Nothing was changed between writing it and the run reported here.

**The one miss (set 1, Claude), reported as is.** For "make the log format configurable", Claude chose `docs/config.rst`, the config reference, instead of the expected `docs/logging.rst`. It did this in 3 of 3 runs. The answer key was not changed.

**The project map alone** (no model) puts these shares of the must files in its top 5 / top 10:
- set 1: 53% / 63%;
- set 2: 61% / 66%.

The scout subagent and the agent close the rest of the gap.

## Cancel

**The 6 moments:** while the model is thinking, while the scout subagent works, at an approval card, while a command runs, at the review screen, and when TrueForge cancels the session itself.

**What every run must show:**
- the turn reports "cancelled";
- the project is unchanged;
- the hidden copy is deleted;
- no process is left behind;
- the chat is still usable.

**One wording fix before the final run.** The first DeepSeek run declined the test's 2-minute `sleep` command as purposeless, so the run never reached Stop. The test request now says why the command exists. Moon itself was not changed.

## Resilience
| Scenario | Result |
|---|---|
| Main model with a bad key | switched to the backup in 0.46 s, task done, `git status` clean |
| Main endpoint unreachable | switched in 0.08 s, done, clean |
| Main endpoint hangs | the watchdog switched after 12 s, done, clean |
| Both models down | a clear error, clean |
| Main model recovers | switched back to the main model |

## Safety
14 attacks on each model, all passed, plus the model-free direct call. The scenarios and how they are judged are in `docs/security.md` section 5.

## Not measured here
- **Tasks A, B and C done by hand in VS Code.** These are checked by hand and in the video.
- **The clean-clone test.** It is part of Phase 8 and still to do.
- **macOS / Linux.** Deferred; every run above is on Windows.
- **Cost per run.** Token usage is in each TrueForge session. The write-up states the totals.
