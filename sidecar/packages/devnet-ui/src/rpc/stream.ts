import { LifecycleEventSchema, type Info, type LifecycleEventData } from "../protocol/schemas";

export type StreamStatus = "connecting" | "live" | "reconnecting" | "offline";

/** Why the caller must reload everything it holds for this node. */
export type ResetReason = "restart" | "gap";

export interface StreamCallbacks {
  onEvent(event: LifecycleEventData): void;
  onStatus(status: StreamStatus): void;
  /** The node restarted (`bootId` changed) or evicted events the client never saw. */
  onReset(reason: ResetReason): void;
  /** Subscribing failed in a way retrying will not fix, for example the explorer is off. */
  onFatal(message: string): void;
}

/** The subset of `WebSocket` the stream uses, so tests can fake it. */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface StreamDeps {
  createSocket(url: string): SocketLike;
  fetchInfo(): Promise<Info>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const SUBSCRIBE_ID = 1;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;
/** After this many failed reconnects the status becomes "offline" (retries continue). */
const OFFLINE_AFTER_ATTEMPTS = 3;

function errorText(record: Record<string, unknown>): { text: string; code: number | null } {
  const raw = record.message ?? record.error;
  if (typeof raw === "object" && raw !== null) {
    const { code, message } = raw as { code?: unknown; message?: unknown };
    return {
      text: typeof message === "string" && message !== "" ? message : "Subscription failed",
      code: typeof code === "number" ? code : null,
    };
  }
  return { text: raw === undefined || raw === null ? "Subscription failed" : String(raw), code: null };
}

/**
 * Follows one node's `explorerEvents` stream and keeps it correct across
 * reconnects. On every (re)connect it reads `info` first:
 *  - a different `bootId` means the node restarted, so `seq` restarted too;
 *  - `lastSeq + 1 < oldestSeq` means the node evicted events this client never
 *    saw;
 * either way the caller is told to reload (`onReset`) and the stream resumes
 * from the node's current `latestSeq`. Otherwise it resumes from `lastSeq`.
 */
export class ExplorerStream {
  private socket: SocketLike | null = null;
  private timer: unknown = null;
  private stopped = true;
  private attempt = 0;
  private bootId: string | null = null;
  private lastSeq = 0;
  /** Bumped by every start() and stop(); a continuation from an older run must do nothing. */
  private run = 0;

  constructor(
    private readonly url: string,
    private readonly deps: StreamDeps,
    private readonly callbacks: StreamCallbacks,
  ) {}

  start(): void {
    this.stop();
    this.stopped = false;
    this.attempt = 0;
    this.bootId = null;
    void this.connect(this.run);
  }

  stop(): void {
    this.run += 1;
    this.stopped = true;
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    this.detach();
  }

  private detach(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  }

  private async connect(run: number): Promise<void> {
    if (this.stopped || run !== this.run) return;
    try {
      this.callbacks.onStatus(this.bootId === null ? "connecting" : "reconnecting");

      let info: Info;
      try {
        info = await this.deps.fetchInfo();
      } catch {
        if (run === this.run) this.scheduleRetry();
        return;
      }
      if (this.stopped || run !== this.run) return;

      if (this.bootId === null) {
        this.lastSeq = info.latestSeq;
      } else if (info.bootId !== this.bootId) {
        this.lastSeq = info.latestSeq;
        this.callbacks.onReset("restart");
      } else if (this.lastSeq + 1 < info.oldestSeq) {
        this.lastSeq = info.latestSeq;
        this.callbacks.onReset("gap");
      }
      this.bootId = info.bootId;
      this.open();
    } catch {
      // createSocket, send or a callback threw: retry instead of stalling silently.
      if (run === this.run) {
        this.detach();
        this.scheduleRetry();
      }
    }
  }

  private open(): void {
    const socket = this.deps.createSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: SUBSCRIBE_ID,
          method: "skandha_subscribe",
          params: ["explorerEvents", this.lastSeq],
        }),
      );
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onclose = () => {
      if (this.socket === socket) this.lost();
    };
    socket.onerror = () => {
      // A close event follows; reconnecting is handled there.
    };
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;

    if (record.id === SUBSCRIBE_ID) {
      if ("result" in record) {
        this.attempt = 0;
        this.callbacks.onStatus("live");
        return;
      }
      // WebSocket errors arrive as `{ message }`, `{ error: "text" }` or `{ error: { code, message } }`.
      const { text, code } = errorText(record);
      if (code === -32601 || /explorer/i.test(text)) {
        this.stopped = true;
        this.detach();
        this.callbacks.onFatal(text);
        this.callbacks.onStatus("offline");
        return;
      }
      this.lost();
      return;
    }

    if (record.method !== "skandha_subscription") return;
    const params = record.params;
    if (typeof params !== "object" || params === null) return;
    const parsed = LifecycleEventSchema.safeParse((params as Record<string, unknown>).result);
    if (!parsed.success) return;
    if (parsed.data.seq <= this.lastSeq) return;
    this.lastSeq = parsed.data.seq;
    this.callbacks.onEvent(parsed.data);
  }

  private lost(): void {
    if (this.stopped) return;
    this.detach();
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** this.attempt);
    this.attempt += 1;
    this.callbacks.onStatus(this.attempt >= OFFLINE_AFTER_ATTEMPTS ? "offline" : "reconnecting");
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.connect(this.run);
    }, delay);
  }
}
