// Which model a task uses: the main model, or the backup while the main one is failing.
// One router per editor window, shared by inline edit and agent mode, so a broken main model
// found by one is skipped by the other too.
//
// A task tries its first model; on a failure that switching can help, it tries the other one
// (each at most once per task). Both failed = a clear message, nothing changed.

import { PROBE_MESSAGE } from "../shared/constants.js";
import type { AgentChat } from "../trueforge/chat.js";
import { CircuitBreaker, type BreakerState, type BreakerTimes } from "./circuit-breaker.js";
import type { Failure } from "./error-classifier.js";

/** One background check of a model: a tiny turn on its own TrueForge session. */
export async function probeModel(chat: AgentChat): Promise<boolean> {
  let ok = false;
  try {
    await chat.send(PROBE_MESSAGE, (event) => {
      if (event.type === "done") ok = event.status === "done";
    });
  } finally {
    chat.stop();
  }
  return ok;
}

export interface ModelPair {
  /** "provider/model" names as TrueForge knows them. */
  main: string;
  backup: string;
}

export class ModelRouter {
  private readonly breaker: CircuitBreaker;

  constructor(
    readonly models: ModelPair,
    times: BreakerTimes,
    /** Tries a model once in the background (a tiny TrueForge session); true when it answered. */
    probe: (model: string) => Promise<boolean>,
    onChange?: (state: BreakerState) => void,
  ) {
    this.breaker = new CircuitBreaker(times, () => probe(models.main), onChange);
  }

  get state(): BreakerState {
    return this.breaker.state;
  }

  /**
   * The model a new task starts on. `switchedBack`: the main model is back after a failure;
   * the task uses it again (said once, so the user sees the switch back).
   */
  startTask(): { model: string; switchedBack: boolean } {
    if (this.breaker.takeRecovery()) return { model: this.models.main, switchedBack: true };
    return { model: this.breaker.state === "closed" ? this.models.main : this.models.backup, switchedBack: false };
  }

  /** The model in use right now, without starting a task (the backup until a task switches back). */
  get current(): string {
    return this.breaker.state === "closed" ? this.models.main : this.models.backup;
  }

  /** A model failed during a task. The main model failing (in a way switching helps) opens the breaker. */
  reportFailure(model: string, failure: Failure): void {
    if (model === this.models.main && failure.switchModel) this.breaker.trip();
  }

  /** The next model to try in this task, or undefined when every model was tried. */
  next(tried: ReadonlySet<string>): string | undefined {
    const order = this.breaker.state === "open" ? [this.models.backup, this.models.main] : [this.models.main, this.models.backup];
    return order.find((m) => !tried.has(m));
  }

  role(model: string): "main" | "backup" {
    return model === this.models.main ? "main" : "backup";
  }

  /** The model settings changed (e.g. the key was fixed in TrueForge): check the main model now. */
  settingsChanged(): void {
    this.breaker.checkNow();
  }

  dispose(): void {
    this.breaker.dispose();
  }
}
