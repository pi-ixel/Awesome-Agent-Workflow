import type {
  AcpChannel,
  AcpChannelOptions,
  AcpConnectionPort,
  AcpSessionConnection,
  NotificationHandler,
  ServerRequestHandler,
} from "../../contracts/acpConnection.ts";
import { JsonRpcConnection } from "./protocol/JsonRpcConnection.ts";
import type { AcpTransport } from "../../contracts/acpTransport.ts";
import {
  AcpClosedError,
  AcpMethodNotFoundError,
  AcpResponseError,
  AcpTimeoutError,
} from "../../contracts/acpErrors.ts";
import { RequestScheduler } from "./RequestScheduler.ts";
import { parseElicitationForm } from "../../shared/acp/elicitation.ts";
import { asRecord, asString } from "../../shared/acp/parse.ts";

type Channel = {
  id?: string;
  notification?: NotificationHandler;
  server?: ServerRequestHandler;
  failed?: (reason: string) => void;
  background: boolean;
  elicitation: boolean;
  closed: boolean;
  closing: boolean;
  controller: AbortController;
};
/** Owns one transport and routes isolated protocol session channels. */
export class AcpConnection implements AcpConnectionPort {
  private readonly rpc: JsonRpcConnection;
  private readonly scheduler: RequestScheduler;
  private readonly channels = new Set<Channel>();
  private readonly routes = new Map<string, Channel>();
  private readonly early: Array<[string, Readonly<Record<string, unknown>>]> =
    [];
  private initializing?: Promise<unknown>;
  private handshakeSignature?: string;
  private admissionError?: Error;
  private stopping = false;
  private creating = 0;
  private failureReason?: Error;
  private readonly failureListeners = new Set<(reason: Error) => void>();
  onUnavailable(listener: (reason: Error) => void): () => void {
    this.failureListeners.add(listener);
    const error = this.failureReason ?? this.admissionError;
    if (error) listener(error);
    return () => {
      this.failureListeners.delete(listener);
    };
  }
  private reportUnavailable(error: Error): void {
    for (const listener of this.failureListeners) {
      try {
        listener(error);
      } catch {
        /* Isolate resource observers. */
      }
    }
  }
  get available(): boolean {
    return !this.stopping && !this.failureReason && !this.admissionError;
  }
  get runningRequests(): number {
    return this.scheduler.runningRequests;
  }
  get boundSessions(): number {
    return this.channels.size;
  }
  constructor(
    private readonly transport: AcpTransport,
    maxConcurrent: number,
  ) {
    this.scheduler = new RequestScheduler(maxConcurrent);
    const failure = (reason: string) => {
      if (this.failureReason) return;
      this.failureReason = new AcpClosedError(reason);
      this.scheduler.close(this.failureReason);
      for (const c of this.channels) {
        try {
          c.failed?.(reason);
        } catch {
          /* One consumer must not block sibling invalidation. */
        }
      }
      this.early.length = 0;
      if (!this.stopping) this.reportUnavailable(this.failureReason);
    };
    this.rpc = new JsonRpcConnection(transport, {
      onFailure: failure,
      onExit: () => failure("ACP connection exited"),
    });
    this.rpc.setNotificationHandler((method, params) => {
      const c =
        typeof params.sessionId === "string"
          ? this.routes.get(params.sessionId)
          : undefined;
      if (c) c.notification?.(method, params);
      else if (this.creating && typeof params.sessionId === "string") {
        if (this.early.length >= 256) {
          failure("Early session notification buffer exceeded");
          return;
        }
        this.early.push([method, params]);
      }
    });
    this.rpc.setServerRequestHandler((method, params) => {
      const scope =
        typeof params.requestId === "string" ||
        typeof params.requestId === "number"
          ? this.rpc.requestScope(params.requestId)
          : undefined;
      const scopedId = scope?.sessionId;
      if (
        scopedId &&
        typeof params.sessionId === "string" &&
        params.sessionId !== scopedId
      )
        return Promise.reject(new Error("Conflicting session scope"));
      const id =
        typeof params.sessionId === "string" ? params.sessionId : scopedId;
      const owner = [...this.channels].find(
        (channel) => channel === scope?.owner,
      );
      const c = id ? this.routes.get(id) : owner;
      if (owner && c !== owner)
        return Promise.reject(new Error("Conflicting request owner"));
      if (
        !c?.server &&
        method === "elicitation/create" &&
        [...this.channels].some((channel) => channel.elicitation)
      )
        return Promise.resolve({
          action:
            typeof params.sessionId === "string" || parseElicitationForm(params)
              ? "cancel"
              : "decline",
        });
      if (!c?.server) return Promise.reject(new AcpMethodNotFoundError(method));
      return c.server(method, params);
    });
  }
  openChannel(options: AcpChannelOptions = {}): AcpChannel {
    if (this.stopping) throw new Error("Connection is stopping");
    if (this.failureReason) throw this.failureReason;
    if (this.admissionError) throw this.admissionError;
    const c: Channel = {
      background: options.background ?? false,
      elicitation: options.elicitation ?? false,
      failed: options.onFailure,
      closed: false,
      closing: false,
      controller: new AbortController(),
    };
    const bind = (id: string) => {
      const existing = this.routes.get(id);
      if (existing && existing !== c)
        throw new Error("Session is already bound on this connection");
      if (c.id && c.id !== id)
        throw new Error("A shared session cannot change identity");
      c.id = id;
      this.routes.set(id, c);
    };
    const request: AcpSessionConnection["request"] = (
      method,
      params,
      requestOptions,
    ) => {
      if (c.closed || (c.closing && method !== "session/close"))
        return Promise.reject(new Error("Session is closed"));
      if (method === "session/close") {
        c.closing = true;
        c.controller.abort();
      }
      const execute = async () => {
        if (c.closed || (c.closing && method !== "session/close"))
          throw new Error("Session is closed");
        if (this.failureReason) throw this.failureReason;
        if (method === "session/load")
          bind(String((params as { sessionId: string }).sessionId));
        const isNew = method === "session/new";
        if (isNew) {
          if (c.id) throw new Error("Session is already created");
          this.creating++;
        }
        try {
          const result = await this.rpc.request(method, params, {
            owner: c,
            timeoutMs:
              requestOptions?.timeoutMs === undefined
                ? options.requestTimeoutMs
                : requestOptions.timeoutMs,
          });
          const record = asRecord(result);
          const newId = isNew ? asString(record?.sessionId) : null;
          if (isNew && !newId)
            throw new Error(
              "Malformed session/new result; remote state unknown",
            );
          if (method === "session/load" && !record)
            throw new Error(
              "Malformed session/load result; remote state unknown",
            );
          if (c.closed && (isNew || method === "session/load")) {
            const id = isNew ? newId : c.id;
            if (typeof id === "string")
              await this.rpc.request(
                "session/close",
                { sessionId: id },
                { timeoutMs: 15000 },
              );
            throw new Error("Session closed while loading");
          }
          if (newId) {
            bind(newId);
            const replay = this.early.filter(
              (entry) => entry[1].sessionId === c.id,
            );
            for (const entry of replay) c.notification?.(...entry);
            for (let i = this.early.length - 1; i >= 0; i--)
              if (this.early[i]![1].sessionId === c.id) this.early.splice(i, 1);
          }
          if (method === "session/close") {
            if (c.id) this.routes.delete(c.id);
            this.channels.delete(c);
            c.closed = true;
            c.controller.abort();
          }
          return result;
        } catch (error) {
          if (error instanceof AcpTimeoutError) {
            this.admissionError = new Error(
              "Remote request outcome unknown; connection admission quarantined",
            );
            this.scheduler.close(this.admissionError);
          }
          if (method === "session/close") {
            this.admissionError = new Error(
              "Remote session release was not confirmed",
            );
            this.scheduler.close(this.admissionError);
          }
          if (method === "session/load" || isNew) {
            if (!(error instanceof AcpResponseError) && !c.closed) {
              this.admissionError = new Error(
                "Remote session state is unknown; connection admission quarantined",
              );
              this.scheduler.close(this.admissionError);
            }
            if (c.id) this.routes.delete(c.id);
            c.closed = true;
            c.controller.abort();
            this.channels.delete(c);
          }
          if (this.admissionError) this.reportUnavailable(this.admissionError);
          throw error;
        } finally {
          if (isNew && --this.creating === 0) this.early.length = 0;
        }
      };
      if (method === "initialize") {
        const signature = JSON.stringify(params);
        if (
          this.handshakeSignature !== undefined &&
          this.handshakeSignature !== signature
        )
          return Promise.reject(
            new Error("Shared connection handshake configuration mismatch"),
          );
        this.handshakeSignature = signature;
        return (this.initializing ??= execute());
      }
      if (
        [
          "session/new",
          "session/load",
          "session/list",
          "session/prompt",
        ].includes(method)
      ) {
        if (this.admissionError) return Promise.reject(this.admissionError);
        return this.scheduler.request(execute, {
          background: c.background,
          signal: c.controller.signal,
        });
      }
      return execute();
    };
    const port: AcpSessionConnection = {
      request,
      notify: (...args) => {
        if (c.closed || c.closing) throw new Error("Session is closed");
        return this.rpc.notify(...args);
      },
      requestScope: (id) => {
        const scope = this.rpc.requestScope(id);
        return scope?.owner === c ? scope : null;
      },
      setNotificationHandler: (handler) => {
        c.notification = handler;
      },
      setServerRequestHandler: (handler) => {
        c.server = handler;
      },
    };
    this.channels.add(c);
    return {
      port,
      promote: () => {
        if (!this.channels.has(c)) throw new Error("Unknown session");
        c.background = false;
        this.scheduler.promote(c.controller.signal);
      },
      escalate: () => this.kill(),
      close: () => {
        if (c.id) this.routes.delete(c.id);
        c.closed = true;
        c.controller.abort();
        this.channels.delete(c);
      },
    };
  }
  async close() {
    this.stopping = true;
    this.scheduler.close();
    const exit = await this.transport.close();
    await this.transport.dispose?.();
    return exit;
  }
  async kill() {
    this.stopping = true;
    this.scheduler.close();
    const exit = await this.transport.kill();
    await this.transport.dispose?.();
    return exit;
  }
}
