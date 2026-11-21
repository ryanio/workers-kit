/**
 * The Discord gateway lifecycle, for one websocket held open by a Durable
 * Object: identify, heartbeat, resume, back off, and park when only a person
 * can fix it.
 *
 * ## Why it lives in a Durable Object, and why it does not hibernate
 *
 * A gateway connection is outbound, and `state.acceptWebSocket()` takes an
 * *incoming* `WebSocketPair`. It rejects a socket that came back from
 * `fetch()` with "pair has already been accepted or used in a Response", so
 * the hibernation API cannot be used for a gateway socket at all. The socket
 * is accepted by hand and the object stays resident while it is open. One
 * instance per bot (`idFromName("gateway")`), because Discord allows one
 * identify per shard and a second socket would duplicate every event.
 *
 * ## What drives it
 *
 * Two entry points, and all the state in storage so either can run on a cold
 * object:
 *
 * - `alarm()` is the heartbeat. Discord asks for one about every 41 seconds
 *   and the interval arrives in HELLO. The same alarm carries the reconnect
 *   backoff, so a dead socket is reopened without anything else running.
 * - `tick(on)` is the Worker's cron, once a minute. It opens a socket that is
 *   not there, reopens one that has gone quiet with a heartbeat unanswered,
 *   retries a parked link after an hour, and closes everything when the bot is
 *   switched off. The cron is the floor under the alarm: an object evicted
 *   mid-connect leaves no alarm behind, and the tick is what notices.
 *
 * ## Reconnects
 *
 * A close resumes the session, so Discord replays what was missed, after a
 * backoff of 1, 2, 5, 15 then 60 seconds. 4007 and 4009 mean the resume was
 * refused, so the session is dropped and the next connect identifies fresh.
 * 4004 and 4010 to 4014 cannot fix themselves: a bad token, a shard count
 * that does not match, or the Message Content intent left off in the developer
 * portal. Those park the link as `failed` and the tick tries again in an hour,
 * rather than hammering Discord with an identify it will keep refusing.
 *
 * A close the client sends with 1000 or 1001 ends the session, so a close we
 * mean to resume from goes out with 4900 instead.
 */

/** `GUILD_MESSAGES`, for MESSAGE_CREATE in a server. */
export const GUILD_MESSAGES = 1 << 9;
/** `GUILD_MEMBERS`, a privileged intent: turn it on in the developer portal first. */
export const GUILD_MEMBERS = 1 << 1;
/** `MESSAGE_CONTENT`, a privileged intent: without it every message arrives empty. */
export const MESSAGE_CONTENT = 1 << 15;
/** `GUILD_MESSAGE_REACTIONS`. */
export const GUILD_MESSAGE_REACTIONS = 1 << 10;
/** `DIRECT_MESSAGES`. */
export const DIRECT_MESSAGES = 1 << 12;

const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 15_000, 60_000] as const;
/** Our own close code for a close we resume from. */
const RESUME_CLOSE = 4900;
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const NEW_SESSION_CLOSE = new Set([4007, 4009]);
const DEFAULT_STALE_MS = 90_000;
const DEFAULT_WEDGED_MS = 60_000;
const DEFAULT_RETRY_FAILED_MS = 3_600_000;
const DEFAULT_KEY = "gateway";
const GATEWAY_BOT_URL = "https://discord.com/api/v10/gateway/bot";
const USER_AGENT = "DiscordBot (https://github.com/ryanio/workers-kit, 1)";
const DISCOVER_TIMEOUT_MS = 10_000;

/** A Worker's `fetch` makes the websocket upgrade over http(s), not ws(s). */
const upgradeUrl = (url: string): string => url.replace(/^ws(s?):/i, "http$1:");

/** Where the link is, as `status` reports it and storage keeps it. */
export type GatewayPhase =
  | "off"
  | "connecting"
  | "live"
  | "reconnecting"
  | "failed";

/** The link's whole state. Written to storage under one key on every change. */
export interface GatewayState {
  phase: GatewayPhase;
  /** When the phase last changed, unix milliseconds. */
  since: number;
  /** The session to resume, or null to identify fresh. */
  session: string | null;
  /** `resume_gateway_url` from READY. */
  resumeUrl: string | null;
  /** The last sequence number seen, for the resume and the heartbeat. */
  seq: number | null;
  /** The heartbeat interval from HELLO, milliseconds. */
  interval: number | null;
  /** Whether the last heartbeat was answered. */
  acked: boolean;
  /** Closes in a row, which picks the backoff. */
  attempt: number;
  lastEventAt: number | null;
  /** The last close or failure, for a status page. */
  why: string | null;
}

/** What `status()` reports. The session id itself is not handed out. */
export interface GatewayStatus extends Omit<GatewayState, "session"> {
  /** Whether a session is stored, not which one. */
  session: boolean;
  /** Whether a socket is open in this instance right now. */
  socket: boolean;
}

/** The part of a websocket this needs. A Cloudflare `WebSocket` satisfies it. */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message" | "close",
    handler: (event: {
      data?: unknown;
      code?: number;
      reason?: string;
    }) => void,
  ): void;
}

/** The part of `DurableObjectStorage` this needs. */
export interface GatewayStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface GatewayDispatch {
  /** The dispatch name, such as `MESSAGE_CREATE`. */
  type: string;
  /** The event's `d`, as Discord sent it. */
  data: unknown;
  sequence: number | null;
}

export interface GatewayLog {
  info?: (message: string, fields?: Record<string, unknown>) => void;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
  error?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface DiscordGatewayOptions {
  /** The bot token. Missing or empty parks the link as `failed`. */
  token: string | undefined;
  /** The intents bitmask: the `GUILD_MESSAGES`-style constants here, or'd together. */
  intents: number;
  /** The Durable Object's storage, for the state and the alarm. */
  storage: GatewayStorage;
  /**
   * Called for every dispatch, after the link's own bookkeeping. It must not
   * throw: a rejection is reported and swallowed, because one bad event should
   * not take the socket down with it.
   */
  onDispatch?: ((event: GatewayDispatch) => void | Promise<void>) | undefined;
  /** Only these dispatch names reach `onDispatch`. Default every one. */
  dispatch?: readonly string[] | undefined;
  /** Sent in the identify as the OS, browser and device. Default "workers". */
  identity?: string | undefined;
  /**
   * Defaults to the `gateway/bot` endpoint over `fetch`, with Discord's
   * `DiscordBot (url, version)` user agent and a 10 second timeout.
   */
  discover?: (() => Promise<string | null>) | undefined;
  /**
   * Defaults to a websocket upgrade over `fetch`, accepted and returned. The
   * `wss://` URL Discord hands out is fetched as `https://`, since a Worker's
   * `fetch` refuses the `wss:` scheme.
   */
  open?: ((url: string) => Promise<GatewaySocket | null>) | undefined;
  /** Default `console`. Pass a `createLogger` logger to get the fields into Workers Logs. */
  log?: GatewayLog | undefined;
  /** The waits between reconnects, milliseconds. The last one repeats. */
  backoffMs?: readonly number[] | undefined;
  /** Nothing heard for this long with a heartbeat unanswered means reopen. Default 90 seconds. */
  staleMs?: number | undefined;
  /** A connect that has not reached READY by now is tried again. Default 60 seconds. */
  wedgedMs?: number | undefined;
  /** How long a parked link waits before the tick tries again. Default an hour. */
  retryFailedMs?: number | undefined;
  /** The storage key holding the state. Default "gateway". */
  key?: string | undefined;
  /** For tests. */
  now?: (() => number) | undefined;
  /** For tests. Discord asks for the first heartbeat at a random point in the interval. */
  random?: (() => number) | undefined;
  fetch?:
    | ((input: string, init?: RequestInit) => Promise<Response>)
    | undefined;
}

export interface DiscordGateway {
  /**
   * The cron's every minute. `on` is the bot's own switch: false closes the
   * socket and clears the alarm, so a bot turned off costs nothing.
   */
  tick(on: boolean): Promise<GatewayStatus>;
  /** The Durable Object's `alarm()`: the heartbeat and the reconnect timer. */
  alarm(): Promise<void>;
  status(): Promise<GatewayStatus>;
  /** Every frame from the socket goes here. Only a custom `open` needs to call it. */
  frame(socket: GatewaySocket, text: string): Promise<void>;
}

const FRESH: GatewayState = {
  phase: "off",
  since: 0,
  session: null,
  resumeUrl: null,
  seq: null,
  interval: null,
  acked: true,
  attempt: 0,
  lastEventAt: null,
  why: null,
};

const NO_SESSION = { session: null, resumeUrl: null, seq: null } as const;

interface Frame {
  op: number;
  s: number | null;
  t: string | null;
  d: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseFrame(raw: string): Frame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.op !== "number") {
    return null;
  }
  return {
    op: value.op,
    s: typeof value.s === "number" ? value.s : null,
    t: typeof value.t === "string" ? value.t : null,
    d: value.d,
  };
}

/**
 * One gateway link. Hold it on the Durable Object and hand it `fetch` and
 * `alarm`:
 *
 *     export class GatewayObject extends DurableObject<Env> {
 *       private link = discordGateway({
 *         token: this.env.DISCORD_BOT_TOKEN,
 *         intents: GUILD_MESSAGES | MESSAGE_CONTENT,
 *         storage: this.ctx.storage,
 *         dispatch: ["MESSAGE_CREATE"],
 *         onDispatch: ({ data }) => said(this.env, data),
 *       });
 *
 *       async fetch(request: Request) {
 *         const on = new URL(request.url).searchParams.get("on") !== "0";
 *         return Response.json(await this.link.tick(on));
 *       }
 *
 *       alarm() {
 *         return this.link.alarm();
 *       }
 *     }
 */
export function discordGateway(options: DiscordGatewayOptions): DiscordGateway {
  const storage = options.storage;
  const key = options.key ?? DEFAULT_KEY;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const log = options.log ?? console;
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const wedgedMs = options.wedgedMs ?? DEFAULT_WEDGED_MS;
  const retryFailedMs = options.retryFailedMs ?? DEFAULT_RETRY_FAILED_MS;
  const identity = options.identity ?? "workers";
  const doFetch = options.fetch ?? fetch;

  let state: GatewayState | null = null;
  let socket: GatewaySocket | null = null;
  let connecting: Promise<void> | null = null;
  let connectingSince = 0;
  /**
   * Bumped by every connect. A connect that opened a socket only adopts it
   * while its own generation is still the latest, so an attempt abandoned as
   * wedged cannot leave a second socket live: two sockets would mean two
   * identifies for one shard, and Discord counts those against the session
   * limit while sending every event twice.
   */
  let generation = 0;

  const load = async (): Promise<GatewayState> => {
    state ??= {
      ...FRESH,
      ...(await storage.get<Partial<GatewayState>>(key)),
    };
    return state;
  };

  const set = async (patch: Partial<GatewayState>): Promise<void> => {
    const current = await load();
    state = {
      ...current,
      ...patch,
      ...(patch.phase && patch.phase !== current.phase ? { since: now() } : {}),
    };
    await storage.put(key, state);
  };

  const later = (ms: number): Promise<void> => storage.setAlarm(now() + ms);

  const waitFor = (attempt: number): number =>
    backoff[Math.min(attempt, backoff.length - 1)] ?? 60_000;

  const status = async (): Promise<GatewayStatus> => {
    const { session, ...rest } = await load();
    return { ...rest, session: session !== null, socket: socket !== null };
  };

  /** Drops the socket. Its close event is ignored, since it is no longer ours. */
  const drop = (code: number, reason: string): void => {
    const going = socket;
    socket = null;
    try {
      going?.close(code, reason);
    } catch {
      // Already closed.
    }
  };

  const discover = async (): Promise<string | null> => {
    if (options.discover) {
      return options.discover();
    }
    if (!options.token) {
      return null;
    }
    try {
      const response = await doFetch(GATEWAY_BOT_URL, {
        headers: {
          authorization: `Bot ${options.token}`,
          "user-agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
      });
      if (!response.ok) {
        log.warn?.("discord gateway: gateway/bot refused", {
          status: response.status,
        });
        return null;
      }
      const body = (await response.json()) as { url?: unknown };
      return typeof body.url === "string" ? body.url : null;
    } catch (error) {
      log.error?.("discord gateway: gateway/bot failed", { error });
      return null;
    }
  };

  const openSocket = async (url: string): Promise<GatewaySocket | null> => {
    if (options.open) {
      return options.open(url);
    }
    const response = await doFetch(upgradeUrl(url), {
      headers: { upgrade: "websocket" },
    });
    const opened = (response as { webSocket?: unknown }).webSocket as
      | (GatewaySocket & { accept(): void })
      | null
      | undefined;
    if (!opened) {
      return null;
    }
    opened.accept();
    return opened;
  };

  const retry = async (
    why: string,
    patch: Partial<GatewayState> = {},
  ): Promise<void> => {
    const current = await load();
    log.warn?.(`discord gateway: ${why}`);
    await set({
      ...patch,
      phase: "reconnecting",
      why,
      attempt: current.attempt + 1,
    });
    await later(waitFor(current.attempt));
  };

  const closed = async (code: number, reason: string): Promise<void> => {
    socket = null;
    const why = `closed ${code}${reason ? ` ${reason}` : ""}`;
    if (FATAL_CLOSE.has(code)) {
      log.error?.(`discord gateway: ${why}, parked until a person fixes it`);
      await set({ phase: "failed", why, interval: null });
      await storage.deleteAlarm();
      return;
    }
    await retry(why, {
      interval: null,
      ...(NEW_SESSION_CLOSE.has(code) ? NO_SESSION : {}),
    });
  };

  const announce = async (event: GatewayDispatch): Promise<void> => {
    const handler = options.onDispatch;
    if (!handler) {
      return;
    }
    if (options.dispatch && !options.dispatch.includes(event.type)) {
      return;
    }
    try {
      await handler(event);
    } catch (error) {
      log.error?.("discord gateway: dispatch handler failed", {
        error,
        type: event.type,
      });
    }
  };

  const frame = async (ws: GatewaySocket, text: string): Promise<void> => {
    const parsed = parseFrame(text);
    if (!parsed) {
      return;
    }
    const current = await load();
    const patch: Partial<GatewayState> = { lastEventAt: now() };
    if (parsed.s !== null && parsed.s > (current.seq ?? -1)) {
      patch.seq = parsed.s;
    }
    const data = isRecord(parsed.d) ? parsed.d : {};

    switch (parsed.op) {
      case 10: {
        // HELLO. The first heartbeat goes at a random point in the interval,
        // as Discord asks, so a fleet of bots does not beat in lockstep.
        const interval =
          typeof data.heartbeat_interval === "number"
            ? data.heartbeat_interval
            : null;
        if (interval === null) {
          return;
        }
        await set({ ...patch, interval, acked: true });
        await later(Math.floor(interval * random()));
        const resuming = current.session !== null && current.seq !== null;
        ws.send(
          JSON.stringify(
            resuming
              ? {
                  op: 6,
                  d: {
                    token: options.token,
                    session_id: current.session,
                    seq: current.seq,
                  },
                }
              : {
                  op: 2,
                  d: {
                    token: options.token,
                    intents: options.intents,
                    properties: {
                      os: "linux",
                      browser: identity,
                      device: identity,
                    },
                  },
                },
          ),
        );
        return;
      }

      case 11:
        // HEARTBEAT_ACK.
        await set({ ...patch, acked: true });
        return;

      case 1:
        // Discord asking for a heartbeat now.
        ws.send(JSON.stringify({ op: 1, d: current.seq }));
        await set({ ...patch, acked: false });
        return;

      case 7:
        // RECONNECT: Discord asking us to come back on a new socket. The
        // socket goes before the awaited write: a real close landing inside
        // that await would run `closed` and schedule its own backoff, which
        // this would then overwrite with a one second wait.
        drop(RESUME_CLOSE, "op 7");
        await set({
          ...patch,
          phase: "reconnecting",
          interval: null,
          why: "asked to reconnect",
        });
        await later(waitFor(0));
        return;

      case 9: {
        // INVALID_SESSION. `d` true means the session can still be resumed. A
        // fresh identify waits 1 to 5 seconds first, as Discord asks.
        const resumable = parsed.d === true;
        drop(resumable ? RESUME_CLOSE : 1000, "invalid session");
        await set({
          ...patch,
          phase: "reconnecting",
          interval: null,
          why: "invalid session",
          ...(resumable ? {} : NO_SESSION),
        });
        await later(
          resumable ? waitFor(0) : 1000 + Math.floor(random() * 4000),
        );
        return;
      }

      case 0: {
        if (parsed.t === "READY") {
          await set({
            ...patch,
            phase: "live",
            session:
              typeof data.session_id === "string" ? data.session_id : null,
            resumeUrl:
              typeof data.resume_gateway_url === "string"
                ? data.resume_gateway_url
                : null,
            attempt: 0,
            why: null,
          });
        } else if (parsed.t === "RESUMED") {
          await set({ ...patch, phase: "live", attempt: 0, why: null });
        } else {
          await set(patch);
        }
        if (parsed.t !== null) {
          await announce({
            type: parsed.t,
            data: parsed.d,
            sequence: parsed.s,
          });
        }
        return;
      }

      default:
        await set(patch);
        return;
    }
  };

  const connectOnce = async (): Promise<void> => {
    const mine = ++generation;
    drop(RESUME_CLOSE, "reopening");
    if (!options.token) {
      log.error?.("discord gateway: no bot token");
      await set({ phase: "failed", why: "no bot token" });
      await storage.deleteAlarm();
      return;
    }
    await set({ phase: "connecting" });
    const current = await load();
    const url =
      current.session !== null && current.resumeUrl !== null
        ? current.resumeUrl
        : await discover();
    if (!url) {
      await retry("no gateway url");
      return;
    }
    let opened: GatewaySocket | null = null;
    try {
      opened = await openSocket(
        `${url.replace(/\/$/, "")}/?v=10&encoding=json`,
      );
    } catch (error) {
      log.error?.("discord gateway: connect failed", { error });
    }
    if (!opened) {
      // A resume URL that will not open is forgotten, so the next try asks
      // Discord for a fresh one rather than retrying a dead host.
      await retry("upgrade failed", { resumeUrl: null });
      return;
    }
    if (mine !== generation) {
      // A newer connect started while this one was still opening, so its
      // socket is the live one and this socket is nobody's.
      try {
        opened.close(RESUME_CLOSE, "superseded");
      } catch {
        // Already closed.
      }
      return;
    }
    const ws = opened;
    ws.addEventListener("message", (event) => {
      if (socket !== ws) {
        return;
      }
      const text =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      frame(ws, text).catch((error) => {
        log.error?.("discord gateway: frame failed", { error });
      });
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) {
        return;
      }
      closed(event.code ?? 1006, event.reason ?? "").catch((error) => {
        log.error?.("discord gateway: close failed", { error });
      });
    });
    socket = ws;
  };

  /** One connect at a time. A second caller joins the first unless it is wedged. */
  const connect = (): Promise<void> => {
    if (connecting && now() - connectingSince < wedgedMs) {
      return connecting;
    }
    const attempt = connectOnce().finally(() => {
      if (connecting === attempt) {
        connecting = null;
      }
    });
    connecting = attempt;
    connectingSince = now();
    return attempt;
  };

  return {
    status,
    frame,

    async tick(on) {
      const current = await load();
      const at = now();
      if (!on) {
        if (current.phase !== "off") {
          drop(1000, "off");
          await set({
            phase: "off",
            interval: null,
            why: "turned off",
            ...NO_SESSION,
          });
          await storage.deleteAlarm();
        }
        return status();
      }
      if (current.phase === "failed" && at - current.since < retryFailedMs) {
        return status();
      }
      const quiet =
        current.phase === "live" &&
        !current.acked &&
        current.lastEventAt !== null &&
        at - current.lastEventAt > staleMs;
      const waiting =
        current.phase === "connecting" &&
        socket !== null &&
        at - current.since < wedgedMs;
      if ((current.phase === "live" && socket !== null && !quiet) || waiting) {
        return status();
      }
      if (quiet) {
        log.warn?.("discord gateway: quiet, reopening");
      }
      await connect();
      return status();
    },

    async alarm() {
      const current = await load();
      if (current.phase === "off" || current.phase === "failed") {
        return;
      }
      if (
        socket === null ||
        current.phase === "reconnecting" ||
        current.interval === null
      ) {
        await connect();
        return;
      }
      if (!current.acked) {
        log.warn?.("discord gateway: heartbeat unanswered, reopening");
        drop(RESUME_CLOSE, "no heartbeat ack");
        await set({ phase: "reconnecting", interval: null });
        await later(waitFor(0));
        return;
      }
      try {
        socket.send(JSON.stringify({ op: 1, d: current.seq }));
      } catch (error) {
        log.warn?.("discord gateway: heartbeat failed", { error });
        drop(RESUME_CLOSE, "heartbeat failed");
        await connect();
        return;
      }
      await set({ acked: false });
      await later(current.interval);
    },
  };
}
