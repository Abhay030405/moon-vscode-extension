// After Moon switched to the backup model, it keeps using the backup and checks the main model
// now and then in the background (a tiny TrueForge session, never a direct model call), with
// the waits growing (resilience.circuitBreaker: first wait, factor, longest wait). When a check
// succeeds, the main model is "recovered", but Moon switches back only when the next task
// starts, never in the middle of one. A wrong key does not fix itself, so the extension also
// calls checkNow() when the model settings change (for example the key is fixed in TrueForge).

export interface BreakerTimes {
  firstProbeMs: number;
  backoffFactor: number;
  maxProbeMs: number;
}

/** closed = use the main model; open = use the backup; recovered = main is back from the next task. */
export type BreakerState = "closed" | "open" | "recovered";

export class CircuitBreaker {
  private current: BreakerState = "closed";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextWaitMs = 0;
  private probing = false;

  constructor(
    private readonly times: BreakerTimes,
    /** Tries the main model once; true when it answered. */
    private readonly probe: () => Promise<boolean>,
    private readonly onChange?: (state: BreakerState) => void,
  ) {}

  get state(): BreakerState {
    return this.current;
  }

  /** The main model failed: use the backup and start the background checks. */
  trip(): void {
    if (this.current === "open") return;
    this.set("open");
    this.nextWaitMs = this.times.firstProbeMs;
    this.schedule();
  }

  /** At the start of a task: true (once) when the main model is back and Moon should switch. */
  takeRecovery(): boolean {
    if (this.current !== "recovered") return false;
    this.set("closed");
    return true;
  }

  /** Check the main model now (settings changed), instead of waiting for the next check. */
  checkNow(): void {
    if (this.current !== "open") return;
    this.clearTimer();
    void this.runProbe();
  }

  dispose(): void {
    this.clearTimer();
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => void this.runProbe(), this.nextWaitMs);
    // Never keep a process (the evals) alive just for a background check.
    (this.timer as { unref?: () => void }).unref?.();
    this.nextWaitMs = Math.min(this.nextWaitMs * this.times.backoffFactor, this.times.maxProbeMs);
  }

  private async runProbe(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    let ok = false;
    try {
      ok = await this.probe();
    } catch {
      ok = false;
    } finally {
      this.probing = false;
    }
    if (this.current !== "open") return;
    if (ok) this.set("recovered");
    else this.schedule();
  }

  private set(state: BreakerState): void {
    this.current = state;
    this.onChange?.(state);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
