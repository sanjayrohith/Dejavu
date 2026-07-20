import { ulid } from "../ulid.ts";
import { LocalMirror, type MirrorOptions } from "../shared-mirror/index.ts";
import {
  SharedConnection,
  createSharedHttpTransport,
  type ConnectionSnapshot,
  type SharedHttpTransportOptions,
  type StreamLifecycleEvent,
} from "../shared-mirror/index.ts";
import type {
  DeleteWriteInput,
  HandoffWriteInput,
  RememberWriteInput,
  SharedDeletePayload,
  SharedHandoffPayload,
  SharedRememberPayload,
  SharedSignalAction,
  SharedSignalPayload,
  SharedWriteReceipt,
  SignalWriteInput,
} from "../shared-contract.ts";
import type { LocalRecallQuery, LocalRecallResult } from "../shared-mirror/types.ts";

export interface SharedDejavuOptions {
  gateway: string;
  token?: string;
  author?: string;
  sessionId?: string;
  mirror?: LocalMirror;
  mirrorOptions?: MirrorOptions;
  fetch?: SharedHttpTransportOptions["fetch"];
  /**
   * Called when the server emits a stream lifecycle event (`expires` or
   * `closed`). Default behavior is to schedule an automatic reconnect just
   * before the announced expiry so the next stream attempt re-reads
   * credentials. Set to a custom handler to override.
   */
  onStreamLifecycle?: (event: StreamLifecycleEvent) => void;
  /**
   * Disable the automatic reconnect-before-expiry behavior. The lifecycle
   * callback will still fire so callers can implement their own policy.
   */
  autoReconnectOnExpiry?: boolean;
}

export interface SharedRememberOptions {
  tags?: string[];
  authoredBy?: string;
  sessionId?: string;
  slipId?: string;
}

export interface SharedHandoffOptions {
  next?: string[];
  authoredBy?: string;
  sessionId?: string;
  handoffId?: string;
  kept?: string[];
}

/**
 * Usable shared-memory client facade.
 *
 * Authority writes go through HTTP, the included receipt event is immediately
 * applied to the local mirror, and SharedConnection keeps that mirror current
 * through SSE + catch-up. Current v1 exposes shared kept memories only.
 */
export class SharedDejavu {
  readonly mirror: LocalMirror;
  readonly connection: SharedConnection;
  readonly gateway: string;
  private readonly author: string;
  private readonly token: string | undefined;
  private readonly sessionId: string;
  private readonly runFetch: typeof globalThis.fetch;
  private runAuthedFetch!: typeof globalThis.fetch;
  private ownsMirror: boolean;

  constructor(opts: SharedDejavuOptions) {
    this.gateway = opts.gateway.replace(/\/$/, "");
    this.author = opts.author ?? process.env.DEJAVU_AUTHOR ?? "unknown-agent";
    this.token = opts.token ?? process.env.DEJAVU_SHARED_TOKEN;
    this.sessionId = opts.sessionId ?? process.env.DEJAVU_SESSION ?? ulid();
    this.runFetch = opts.fetch ?? globalThis.fetch;
    this.mirror = opts.mirror ?? new LocalMirror(opts.mirrorOptions);
    this.ownsMirror = !opts.mirror;
    const authedFetch = ((input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (this.token) headers.set("authorization", `Bearer ${this.token}`);
      return this.runFetch(input, { ...init, headers });
    }) as typeof globalThis.fetch;
    const lifecycleHandler = opts.onStreamLifecycle;
    const autoReconnect = opts.autoReconnectOnExpiry ?? true;
    const transport = createSharedHttpTransport({
      baseUrl: this.gateway,
      fetch: authedFetch,
      onLifecycle: (event) => {
        try {
          lifecycleHandler?.(event);
        } catch {
          // Caller errors must not break the lifecycle path.
        }
        if (!autoReconnect) return;
        if (event.kind === "expires" && typeof event.ttlSeconds === "number") {
          // Reconnect a few seconds before the announced expiry.
          const buffer = Math.min(Math.max(event.ttlSeconds - 5, 1), event.ttlSeconds);
          this.scheduleReconnect(buffer * 1000);
        } else if (event.kind === "closed") {
          this.scheduleReconnect(0);
        }
      },
    });
    const fetchStatus = async () => {
      const response = await authedFetch(`${this.gateway}/v1/shared/status`);
      if (!response.ok) throw new Error(`shared status failed: HTTP ${response.status}`);
      return await response.json() as import("../shared-contract.ts").SharedAuthorityStatus;
    };
    this.runAuthedFetch = authedFetch;
    this.connection = new SharedConnection({ mirror: this.mirror, ...transport, fetchStatus });
  }

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectInFlight: Promise<ConnectionSnapshot> | null = null;

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.reconnectInFlight) return;
      this.reconnectInFlight = this.connection.reconnect().finally(() => {
        this.reconnectInFlight = null;
      });
    }, Math.max(0, delayMs));
  }

  static async connect(opts: SharedDejavuOptions): Promise<SharedDejavu> {
    const d = new SharedDejavu(opts);
    await d.connect();
    return d;
  }

  async connect(): Promise<ConnectionSnapshot> {
    return this.connection.start();
  }

  async disconnect(): Promise<ConnectionSnapshot> {
    return this.connection.stop();
  }

  async reconnect(): Promise<ConnectionSnapshot> {
    return this.connection.reconnect();
  }

  status(): ConnectionSnapshot {
    return this.connection.snapshot();
  }

  async refreshStatus(): Promise<ConnectionSnapshot> {
    return this.connection.refreshStatus();
  }

  recall(query: string, limit: number = 8): LocalRecallResult {
    return this.mirror.recallLocal({ query, limit });
  }

  recallLocal(opts: LocalRecallQuery = {}): LocalRecallResult {
    return this.mirror.recallLocal(opts);
  }

  async remember(
    text: string,
    opts: SharedRememberOptions = {},
  ): Promise<SharedWriteReceipt<SharedRememberPayload>> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("dejavu.shared.remember: text is empty");
    const input: RememberWriteInput = {
      slipId: opts.slipId ?? ulid(),
      text: trimmed,
      tags: opts.tags ?? [],
      authoredBy: opts.authoredBy ?? this.author,
      sessionId: opts.sessionId ?? this.sessionId,
    };
    const response = await this.runAuthedFetch(`${this.gateway}/v1/shared/remember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`shared remember failed: HTTP ${response.status}`);
    const receipt = await response.json() as SharedWriteReceipt<SharedRememberPayload>;
    this.mirror.applyReceipt(receipt);
    return receipt;
  }

  async handoff(summary: string, opts: SharedHandoffOptions = {}): Promise<SharedWriteReceipt<SharedHandoffPayload>> {
    const trimmed = summary.trim();
    if (!trimmed) throw new Error("dejavu.shared.handoff: summary is empty");
    const input: HandoffWriteInput = { handoffId: opts.handoffId ?? ulid(), summary: trimmed, next: opts.next ?? [], authoredBy: opts.authoredBy ?? this.author, sessionId: opts.sessionId ?? this.sessionId, kept: opts.kept ?? [] };
    const response = await this.runAuthedFetch(`${this.gateway}/v1/shared/handoff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    if (!response.ok) throw new Error(`shared handoff failed: HTTP ${response.status}`);
    const receipt = await response.json() as SharedWriteReceipt<SharedHandoffPayload>;
    this.mirror.apply(receipt.event);
    return receipt;
  }

  async signal(slipId: string, action: SharedSignalAction): Promise<SharedWriteReceipt<SharedSignalPayload>> {
    if (!slipId.trim()) throw new Error("dejavu.shared.signal: slipId is empty");
    const input: SignalWriteInput = { signalId: ulid(), slipId, action, authoredBy: this.author, sessionId: this.sessionId };
    const response = await this.runAuthedFetch(`${this.gateway}/v1/shared/signal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    if (!response.ok) throw new Error(`shared signal failed: HTTP ${response.status}`);
    const receipt = await response.json() as SharedWriteReceipt<SharedSignalPayload>;
    this.mirror.apply(receipt.event);
    return receipt;
  }

  async delete(slipId: string): Promise<SharedWriteReceipt<SharedDeletePayload>> {
    if (!slipId.trim()) throw new Error("dejavu.shared.delete: slipId is empty");
    const input: DeleteWriteInput = { deleteId: ulid(), slipId, authoredBy: this.author, sessionId: this.sessionId };
    const response = await this.runAuthedFetch(`${this.gateway}/v1/shared/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    if (!response.ok) throw new Error(`shared delete failed: HTTP ${response.status}`);
    const receipt = await response.json() as SharedWriteReceipt<SharedDeletePayload>;
    this.mirror.apply(receipt.event);
    return receipt;
  }

  async close(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.disconnect();
    if (this.ownsMirror) this.mirror.close();
  }
}
