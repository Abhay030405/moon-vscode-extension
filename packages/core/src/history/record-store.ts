// Keeps each conversation's work record on disk (one JSON file per conversation, in the
// extension's own storage folder), so it survives a VS Code reload and can be read by a
// later chat. TrueForge keeps the conversation itself; its stored events do not carry what
// Moon decided outside the model (command results, the user's applies and undos), so this
// small file does. It holds paths, line ranges, short command endings and decisions only:
// never file contents and never secrets.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { WORK_RECORD_MAX_ENTRIES } from "../shared/constants.js";
import { WorkRecord, type WorkEntry } from "./work-record.js";

export class WorkRecordStore {
  /** Saves in order, one at a time per store (the last save always wins). */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  async load(conversation: string): Promise<WorkRecord> {
    try {
      const entries = JSON.parse(await readFile(this.file(conversation), "utf8")) as WorkEntry[];
      return new WorkRecord(Array.isArray(entries) ? entries : []);
    } catch {
      return new WorkRecord();
    }
  }

  save(conversation: string, record: WorkRecord): Promise<void> {
    const file = this.file(conversation); // a bad id is refused here, not inside the queue
    const entries = record.all.slice(-WORK_RECORD_MAX_ENTRIES);
    const write = async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFile(file, JSON.stringify(entries), "utf8");
    };
    this.queue = this.queue.then(write, write);
    return this.queue;
  }

  async delete(conversation: string): Promise<void> {
    await rm(this.file(conversation), { force: true });
  }

  private file(conversation: string): string {
    // Conversation ids are Moon's own UUIDs; anything else is refused so a name can't leave the folder.
    if (!/^[A-Za-z0-9-]+$/.test(conversation)) throw new Error(`Not a conversation id: ${conversation}`);
    return path.join(this.dir, `${conversation}.json`);
  }
}
