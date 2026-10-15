import fs from "node:fs/promises";
import path from "node:path";
import type { SessionSummary } from "./types.js";

interface StoreFile {
  version: 1;
  sessions: SessionSummary[];
}

/** JSON-file persistence for completed session summaries. Writes are serialized and atomic (tmp + rename). */
export class JsonStore {
  private sessions: SessionSummary[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    try {
      const parsed = JSON.parse(raw) as StoreFile;
      if (!Array.isArray(parsed.sessions)) throw new Error("invalid format");
      this.sessions = parsed.sessions;
    } catch {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      await fs.rename(this.file, backup);
      console.warn(`Could not parse ${this.file}; moved to ${backup} and starting empty.`);
    }
  }

  list(): SessionSummary[] {
    return [...this.sessions].sort((a, b) => b.startTime.localeCompare(a.startTime));
  }

  get(id: string): SessionSummary | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  add(summary: SessionSummary): Promise<void> {
    const write = this.queue.then(async () => {
      const sessions = this.sessions.filter((s) => s.id !== summary.id);
      sessions.push(summary);
      await this.flush(sessions);
      this.sessions = sessions;
    });
    this.queue = write.catch(() => undefined);
    return write;
  }

  private async flush(sessions: SessionSummary[]): Promise<void> {
    const body: StoreFile = { version: 1, sessions };
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(body, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }
}
