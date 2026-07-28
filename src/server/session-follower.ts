import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync
} from "node:fs";
import { join, resolve } from "node:path";
import type { CollectorStatus, FileCursor, QuotaSnapshot } from "../shared/domain.js";
import { initialParserState, parseCodexLine, type ParserState } from "./codex-parser.js";
import type { UsageDatabase } from "./database.js";

const INITIAL_TAIL_BYTES = 4 * 1024 * 1024;

interface FollowerOptions {
  intervalMs?: number;
  now?: () => number;
}

interface ProcessedFile {
  offset: number;
  state: ParserState;
  latestQuotas: QuotaSnapshot[];
  insertedEvents: number;
}

export class SessionFollower {
  private readonly sessionRoot: string;
  private readonly database: UsageDatabase;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private status: CollectorStatus = {
    state: "stopped",
    lastScanAt: null,
    lastEventAt: null,
    lastError: null,
    watchedFiles: 0
  };

  constructor(sessionRoot: string, database: UsageDatabase, options: FollowerOptions = {}) {
    this.sessionRoot = resolve(sessionRoot);
    this.database = database;
    this.intervalMs = options.intervalMs ?? 2_000;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.scanNow();
    this.timer = setInterval(() => this.scanNow(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status = { ...this.status, state: "stopped" };
  }

  getStatus(): CollectorStatus {
    return { ...this.status };
  }

  scanNow(): void {
    const initialized = this.database.getMeta("initialized_at") !== null;
    this.status = { ...this.status, state: initialized ? "watching" : "initializing", lastError: null };
    try {
      const files = listJsonlFiles(this.sessionRoot);
      if (!initialized) this.initialize(files);
      else for (const path of files) this.processAppend(path);
      this.status = {
        state: "watching",
        lastScanAt: this.now(),
        lastEventAt: this.database.getLatestEventAt(),
        lastError: null,
        watchedFiles: files.length
      };
    } catch (error) {
      this.status = {
        ...this.status,
        state: "error",
        lastScanAt: this.now(),
        lastError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private initialize(files: string[]): void {
    const initializedAt = this.now();
    const latestByLimit = new Map<string, QuotaSnapshot>();
    for (const path of files) {
      const result = processFile(
        path,
        Math.max(0, fileSize(path) - INITIAL_TAIL_BYTES),
        initialParserState(),
        false,
        undefined,
        true
      );
      this.database.upsertCursor(toCursor(path, result.offset, result.state, initializedAt));
      for (const quota of result.latestQuotas) {
        const key = `${quota.pool}:${quota.limitId}`;
        const current = latestByLimit.get(key);
        if (!current || quota.occurredAt > current.occurredAt) latestByLimit.set(key, quota);
      }
    }

    for (const [key, quota] of latestByLimit) {
      this.database.insertQuotaSnapshot({
        ...quota,
        eventKey: `baseline:${key}:${initializedAt}`,
        occurredAt: initializedAt,
        baseline: true
      });
    }
    this.database.setMeta("initialized_at", String(initializedAt));
  }

  private processAppend(path: string): void {
    const stored = this.database.getCursor(path);
    const size = fileSize(path);
    const offset = stored && stored.byteOffset <= size ? stored.byteOffset : 0;
    const state: ParserState = stored && stored.byteOffset <= size
      ? { sessionId: stored.sessionId, model: stored.model, sourceSurface: stored.sourceSurface, serviceTier: stored.serviceTier }
      : initialParserState();
    const result = processFile(path, offset, state, true, this.database);
    this.database.upsertCursor(toCursor(path, result.offset, result.state, this.now()));
  }
}

function toCursor(path: string, byteOffset: number, state: ParserState, updatedAt: number): FileCursor {
  return {
    sourcePath: path,
    byteOffset,
    sessionId: state.sessionId,
    model: state.model,
    sourceSurface: state.sourceSurface,
    serviceTier: state.serviceTier,
    updatedAt
  };
}

function fileSize(path: string): number {
  const descriptor = openSync(path, "r");
  try {
    return fstatSync(descriptor).size;
  } finally {
    closeSync(descriptor);
  }
}

function readFrom(path: string, requestedOffset: number, alignToNextLine: boolean): { buffer: Buffer; offset: number } {
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    let offset = Math.min(requestedOffset, size);
    const buffer = Buffer.alloc(size - offset);
    if (buffer.length > 0) readSync(descriptor, buffer, 0, buffer.length, offset);
    if (offset > 0 && alignToNextLine) {
      const firstNewline = buffer.indexOf(0x0a);
      if (firstNewline === -1) return { buffer: Buffer.alloc(0), offset: size };
      offset += firstNewline + 1;
      return { buffer: buffer.subarray(firstNewline + 1), offset };
    }
    return { buffer, offset };
  } finally {
    closeSync(descriptor);
  }
}

function processFile(
  path: string,
  requestedOffset: number,
  initialState: ParserState,
  persist: boolean,
  database?: UsageDatabase,
  alignToNextLine = false
): ProcessedFile {
  const { buffer, offset: actualOffset } = readFrom(path, requestedOffset, alignToNextLine);
  let state = initialState;
  let lineStart = 0;
  let insertedEvents = 0;
  const latestByLimit = new Map<string, QuotaSnapshot>();

  while (lineStart < buffer.length) {
    const newline = buffer.indexOf(0x0a, lineStart);
    if (newline === -1) break;
    const sourceOffset = actualOffset + lineStart;
    const end = newline > lineStart && buffer[newline - 1] === 0x0d ? newline - 1 : newline;
    const line = buffer.toString("utf8", lineStart, end);
    const result = parseCodexLine(line, state, { sourcePath: path, byteOffset: sourceOffset });
    state = result.state;
    if (result.quotaSnapshot) {
      const key = `${result.quotaSnapshot.pool}:${result.quotaSnapshot.limitId}`;
      latestByLimit.set(key, result.quotaSnapshot);
      if (persist) database?.insertQuotaSnapshot(result.quotaSnapshot);
    }
    if (persist && result.usageEvent && database?.insertUsageEvent(result.usageEvent)) insertedEvents += 1;
    lineStart = newline + 1;
  }

  return {
    offset: actualOffset + lineStart,
    state,
    latestQuotas: [...latestByLimit.values()],
    insertedEvents
  };
}

function listJsonlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(resolve(path));
    }
  };
  visit(root);
  return files.sort();
}
