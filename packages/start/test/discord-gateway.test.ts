/**
 * The gateway lifecycle, driven frame by frame against a fake socket. These
 * are the cases that cost real outages: an identify sent where a resume was
 * due, a heartbeat that stops, a close code retried forever that only a person
 * can fix, and a session kept after Discord refused the resume.
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
  DiscordGateway,
  GatewaySocket,
  GatewayState,
} from "../src/discord-gateway.js";
import {
  discordGateway,
  GUILD_MESSAGES,
  GUILDS,
  MESSAGE_CONTENT,
} from "../src/discord-gateway.js";

const START = 1_700_000_000_000;
const INTERVAL = 41_250;

/**
 * A frame listener returns void, so a delivered frame is handled on the
 * microtask queue with nothing to await. Draining it is how a test sees the
 * state the frame wrote.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve();
  }
};

class FakeStorage {
  rows = new Map<string, unknown>();
  alarm: number | null = null;
  alarmsSet: number[] = [];
  deletes = 0;

  get = async <T>(key: string): Promise<T | undefined> =>
    this.rows.get(key) as T | undefined;
  put = async (key: string, value: unknown): Promise<void> => {
    this.rows.set(key, value);
  };
  setAlarm = async (at: number): Promise<void> => {
    this.alarm = at;
    this.alarmsSet.push(at);
  };
  deleteAlarm = async (): Promise<void> => {
    this.alarm = null;
    this.deletes += 1;
  };
}

class FakeSocket implements GatewaySocket {
  sent: Record<string, unknown>[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null =
    null;
  throwOnSend = false;
  private handlers = new Map<string, (event: unknown) => void>();

  send(data: string): void {
    if (this.throwOnSend) {
      throw new Error("socket gone");
    }
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  addEventListener(
    type: "message" | "close",
    handler: (event: {
      data?: unknown;
      code?: number;
      reason?: string;
    }) => void,
  ): void {
    this.handlers.set(type, handler as (event: unknown) => void);
  }

  /** As the runtime would: deliver a frame to the listener the link attached. */
  deliver(frame: unknown): void {
    this.handlers.get("message")?.({ data: JSON.stringify(frame) });
  }

  hangUp(code: number, reason = ""): void {
    this.handlers.get("close")?.({ code, reason });
  }

  /** The last op of a kind the link sent, or undefined. */
  lastOp(op: number): Record<string, unknown> | undefined {
    return this.sent.filter((frame) => frame.op === op).at(-1);
  }
}

const hello = (heartbeat = INTERVAL) => ({
  op: 10,
  d: { heartbeat_interval: heartbeat },
});

const ready = (session = "sess_1", seq = 1) => ({
  op: 0,
  s: seq,
  t: "READY",
  d: { session_id: session, resume_gateway_url: "wss://resume.discord.gg" },
});

describe("discordGateway", () => {
  let storage: FakeStorage;
  let socket: FakeSocket;
  let clock: number;
  let link: DiscordGateway;
  let dispatched: { type: string; data: unknown }[];
  let open: Mock<(url: string) => Promise<GatewaySocket | null>>;
  let discover: Mock<() => Promise<string | null>>;

  const state = () => storage.rows.get("gateway") as GatewayState;

  const build = (overrides: Record<string, unknown> = {}) => {
    dispatched = [];
    open = vi.fn<(url: string) => Promise<GatewaySocket | null>>(
      async () => socket,
    );
    discover = vi.fn<() => Promise<string | null>>(
      async () => "wss://gateway.discord.gg",
    );
    link = discordGateway({
      token: "a-bot-token",
      intents: GUILD_MESSAGES | MESSAGE_CONTENT,
      storage,
      dispatch: ["MESSAGE_CREATE"],
      onDispatch: ({ type, data }) => {
        dispatched.push({ type, data });
      },
      discover,
      open,
      identity: "testbot",
      log: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => clock,
      random: () => 0.5,
      ...overrides,
    });
    return link;
  };

  /**
   * Connected and live, which is where most of the interesting cases start.
   * Each frame is settled before the next, as a Durable Object's input gate
   * does: it holds back the next event while a storage call is in flight.
   */
  const goLive = async () => {
    await link.tick(true);
    socket.deliver(hello());
    await settle();
    socket.deliver(ready());
    await settle();
  };

  beforeEach(() => {
    storage = new FakeStorage();
    socket = new FakeSocket();
    clock = START;
    build();
  });

  it("identifies with the intents it was given when there is no session", async () => {
    await link.tick(true);
    expect(open).toHaveBeenCalledWith(
      "wss://gateway.discord.gg/?v=10&encoding=json",
    );

    socket.deliver(hello());
    await settle();

    expect(socket.lastOp(2)).toEqual({
      op: 2,
      d: {
        token: "a-bot-token",
        intents: GUILD_MESSAGES | MESSAGE_CONTENT,
        properties: { os: "linux", browser: "testbot", device: "testbot" },
      },
    });
    // The first heartbeat goes at a random point in the interval, not at 0.
    expect(storage.alarm).toBe(START + INTERVAL / 2);
  });

  it("resumes on the resume url, and sends no identify", async () => {
    await goLive();
    expect(state().session).toBe("sess_1");

    // A fresh object, as an eviction leaves it: state in storage, no socket.
    const second = new FakeSocket();
    socket = second;
    build();
    await link.tick(true);

    expect(discover).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      "wss://resume.discord.gg/?v=10&encoding=json",
    );
    second.deliver(hello());
    await settle();
    expect(second.lastOp(6)).toEqual({
      op: 6,
      d: { token: "a-bot-token", session_id: "sess_1", seq: 1 },
    });
    expect(second.lastOp(2)).toBeUndefined();
  });

  it("goes live on READY and keeps the session and resume url", async () => {
    await goLive();
    const status = await link.status();
    expect(status.phase).toBe("live");
    expect(status.session).toBe(true);
    expect(status.socket).toBe(true);
    expect(state().resumeUrl).toBe("wss://resume.discord.gg");
    expect(state().attempt).toBe(0);
  });

  it("only hands on the dispatches it was asked for", async () => {
    await goLive();
    socket.deliver({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "m1" } });
    socket.deliver({ op: 0, s: 3, t: "TYPING_START", d: { id: "t1" } });
    await settle();
    expect(dispatched).toEqual([
      { type: "MESSAGE_CREATE", data: { id: "m1" } },
    ]);
  });

  it("survives a handler that throws, and keeps reading frames", async () => {
    const error = vi.fn();
    build({
      onDispatch: () => {
        throw new Error("handler broke");
      },
      log: { warn: () => {}, error },
    });
    await goLive();
    socket.deliver({ op: 0, s: 2, t: "MESSAGE_CREATE", d: {} });
    await settle();
    await settle();
    expect(error).toHaveBeenCalled();

    socket.deliver({ op: 0, s: 3, t: "MESSAGE_CREATE", d: {} });
    await settle();
    expect(state().seq).toBe(3);
    expect(state().phase).toBe("live");
  });

  it("moves the sequence forward only", async () => {
    await goLive();
    socket.deliver({ op: 0, s: 9, t: "MESSAGE_CREATE", d: {} });
    await settle();
    socket.deliver({ op: 0, s: 4, t: "MESSAGE_CREATE", d: {} });
    await settle();
    expect(state().seq).toBe(9);
  });

  it("answers a heartbeat request at once and waits for the ack", async () => {
    await goLive();
    socket.deliver({ op: 1, d: null });
    await settle();
    expect(socket.lastOp(1)).toEqual({ op: 1, d: 1 });
    expect(state().acked).toBe(false);

    socket.deliver({ op: 11 });
    await settle();
    expect(state().acked).toBe(true);
  });

  it("heartbeats on its alarm and schedules the next one", async () => {
    await goLive();
    clock = START + 20_000;
    await link.alarm();
    expect(socket.lastOp(1)).toEqual({ op: 1, d: 1 });
    expect(state().acked).toBe(false);
    expect(storage.alarm).toBe(clock + INTERVAL);
  });

  it("reopens when a heartbeat went unanswered", async () => {
    await goLive();
    await link.alarm();
    expect(state().acked).toBe(false);

    clock = START + INTERVAL;
    await link.alarm();
    // Closed with our own resume code, not 1000, which would end the session.
    expect(socket.closed).toEqual({ code: 4900, reason: "no heartbeat ack" });
    expect(state().phase).toBe("reconnecting");
    expect(storage.alarm).toBe(clock + 1000);
  });

  it("reconnects rather than heartbeating into a socket that is gone", async () => {
    await goLive();
    socket.throwOnSend = true;
    const second = new FakeSocket();
    open.mockImplementation(async () => second);
    await link.alarm();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("reconnects when Discord asks (op 7)", async () => {
    await goLive();
    socket.deliver({ op: 7, d: null });
    await settle();
    expect(socket.closed?.code).toBe(4900);
    expect(state().phase).toBe("reconnecting");
    expect(state().session).toBe("sess_1");
    expect(storage.alarm).toBe(START + 1000);
  });

  it("keeps the session on a resumable invalid session, and drops it otherwise", async () => {
    await goLive();
    socket.deliver({ op: 9, d: true });
    await settle();
    expect(state().session).toBe("sess_1");
    expect(socket.closed?.code).toBe(4900);

    await goLive();
    socket.deliver({ op: 9, d: false });
    await settle();
    expect(state().session).toBeNull();
    expect(state().seq).toBeNull();
    // 1000 ends the session, which is what a non-resumable one wants.
    expect(socket.closed?.code).toBe(1000);
    // 1 to 5 seconds before identifying again, as Discord asks.
    expect(storage.alarm).toBe(START + 3000);
  });

  it("parks a close only a person can fix, and stops the alarm", async () => {
    await goLive();
    const before = storage.deletes;
    socket.hangUp(4014, "disallowed intents");
    await settle();

    expect(state().phase).toBe("failed");
    expect(state().why).toContain("4014");
    expect(storage.alarm).toBeNull();
    expect(storage.deletes).toBe(before + 1);
  });

  it("leaves a parked link alone for an hour, then tries again", async () => {
    await goLive();
    socket.hangUp(4004, "authentication failed");
    await settle();
    const tries = open.mock.calls.length;

    clock = START + 3_599_999;
    await link.tick(true);
    expect(open).toHaveBeenCalledTimes(tries);

    clock = START + 3_600_001;
    await link.tick(true);
    expect(open).toHaveBeenCalledTimes(tries + 1);
  });

  it("drops the session when Discord refuses the resume", async () => {
    await goLive();
    socket.hangUp(4009, "session timed out");
    await settle();
    expect(state().phase).toBe("reconnecting");
    expect(state().session).toBeNull();
    expect(state().resumeUrl).toBeNull();
  });

  it("backs off further on every close in a row, and resets on READY", async () => {
    await goLive();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      socket.hangUp(1006);
      await settle();
      waits.push((storage.alarm as number) - clock);
      // The alarm reconnects; a fresh socket each time.
      socket = new FakeSocket();
      open.mockImplementation(async () => socket);
      await link.alarm();
    }
    expect(waits).toEqual([1000, 2000, 5000, 15_000, 60_000, 60_000]);

    socket.deliver(hello());
    await settle();
    socket.deliver(ready("sess_2", 20));
    await settle();
    expect(state().attempt).toBe(0);
  });

  it("forgets a resume url that will not open, so the next try asks Discord", async () => {
    await goLive();
    socket = new FakeSocket();
    build();
    open.mockImplementation(async () => null);
    await link.tick(true);
    expect(state().resumeUrl).toBeNull();
    expect(state().phase).toBe("reconnecting");
  });

  it("retries when there is no gateway url to be had", async () => {
    discover.mockImplementation(async () => null);
    await link.tick(true);
    expect(state().phase).toBe("reconnecting");
    expect(state().why).toBe("no gateway url");
    expect(open).not.toHaveBeenCalled();
  });

  it("parks with no token rather than opening a socket", async () => {
    build({ token: undefined });
    await link.tick(true);
    expect(state().phase).toBe("failed");
    expect(state().why).toBe("no bot token");
    expect(open).not.toHaveBeenCalled();
    expect(storage.alarm).toBeNull();
  });

  describe("tick", () => {
    it("does nothing while the link is live and answering", async () => {
      await goLive();
      clock = START + 60_000;
      await link.tick(true);
      expect(open).toHaveBeenCalledTimes(1);
    });

    it("reopens a link that went quiet with a heartbeat unanswered", async () => {
      await goLive();
      await link.alarm();
      socket.deliver({ op: 0, s: 2, t: "MESSAGE_CREATE", d: {} });
      await settle();
      const quietAt = clock;

      clock = quietAt + 90_000;
      await link.tick(true);
      expect(open).toHaveBeenCalledTimes(1);

      clock = quietAt + 90_001;
      await link.tick(true);
      expect(open).toHaveBeenCalledTimes(2);
    });

    it("shuts the link down when the bot is switched off", async () => {
      await goLive();
      const status = await link.tick(false);
      expect(status.phase).toBe("off");
      expect(socket.closed).toEqual({ code: 1000, reason: "off" });
      expect(state().session).toBeNull();
      expect(storage.alarm).toBeNull();
    });

    it("costs nothing once it is already off", async () => {
      await link.tick(false);
      const deletes = storage.deletes;
      await link.tick(false);
      expect(storage.deletes).toBe(deletes);
      expect(open).not.toHaveBeenCalled();
    });

    it("waits out a connect that has not reached READY yet", async () => {
      await link.tick(true);
      clock = START + 59_000;
      await link.tick(true);
      expect(open).toHaveBeenCalledTimes(1);

      clock = START + 61_000;
      await link.tick(true);
      expect(open).toHaveBeenCalledTimes(2);
    });
  });

  it("ignores frames from a socket it has already replaced", async () => {
    await goLive();
    const stale = socket;
    stale.hangUp(1006);
    await settle();

    socket = new FakeSocket();
    open.mockImplementation(async () => socket);
    await link.alarm();
    socket.deliver(hello());
    await settle();
    socket.deliver(ready("sess_2", 10));
    await settle();

    stale.deliver({ op: 0, s: 99, t: "MESSAGE_CREATE", d: { id: "ghost" } });
    await settle();
    expect(dispatched).toEqual([]);
    expect(state().seq).not.toBe(99);
  });

  it("never leaves two sockets live when a wedged connect finishes late", async () => {
    // Two identifies on one shard means Discord sends every event twice and
    // counts both against the session limit. A connect abandoned as wedged
    // must not adopt its socket after a newer one already has.
    const slow = new FakeSocket();
    const quick = new FakeSocket();
    let releaseSlow: (socket: GatewaySocket) => void = () => {};
    open.mockImplementationOnce(
      () =>
        new Promise<GatewaySocket>((resolve) => {
          releaseSlow = resolve;
        }),
    );
    open.mockImplementationOnce(async () => quick);

    const first = link.tick(true);
    await settle();
    clock = START + 61_000;
    await link.tick(true);
    expect(open).toHaveBeenCalledTimes(2);

    releaseSlow(slow);
    await first;
    await settle();

    expect(slow.closed).toEqual({ code: 4900, reason: "superseded" });
    expect(quick.closed).toBeNull();

    // The one that stayed is the one the link talks to.
    quick.deliver(hello());
    await settle();
    expect(quick.lastOp(2)).toBeTruthy();
    expect(slow.lastOp(2)).toBeUndefined();
  });

  it("discovers with Discord's user agent and upgrades over https, by default", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const accepted = Object.assign(socket, { accept: vi.fn() });
    build({
      discover: undefined,
      open: undefined,
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.includes("/gateway/bot")) {
          return Response.json({ url: "wss://gateway.discord.gg" });
        }
        return { status: 101, webSocket: accepted } as unknown as Response;
      },
    });
    await link.tick(true);

    const [bot, upgrade] = calls;
    const botHeaders = new Headers(bot?.init?.headers);
    expect(botHeaders.get("authorization")).toBe("Bot a-bot-token");
    expect(botHeaders.get("user-agent")).toMatch(/^DiscordBot \(/);
    expect(bot?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(upgrade?.url).toBe("https://gateway.discord.gg/?v=10&encoding=json");
    expect(new Headers(upgrade?.init?.headers).get("upgrade")).toBe(
      "websocket",
    );
    expect(accepted.accept).toHaveBeenCalledOnce();
    expect((await link.status()).socket).toBe(true);
  });

  it("gives the default upgrade a timeout and logs a refused one as an error", async () => {
    const errors: unknown[][] = [];
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    build({
      open: undefined,
      openTimeoutMs: 5000,
      log: {
        info: () => {},
        warn: () => {},
        error: (...a: unknown[]) => errors.push(a),
      },
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response("no", { status: 403 });
      },
    });
    await link.tick(true);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(errors[0]?.[0]).toBe("discord gateway: upgrade refused");
    expect(errors[0]?.[1]).toEqual({ status: 403 });
  });

  it("keeps the bot's own user id from READY across a resume", async () => {
    await link.tick(true);
    socket.deliver(hello());
    await settle();
    socket.deliver({
      op: 0,
      s: 1,
      t: "READY",
      d: {
        session_id: "sess_1",
        resume_gateway_url: "wss://resume.discord.gg",
        user: { id: "bot_42" },
      },
    });
    await settle();
    expect(state().userId).toBe("bot_42");

    socket = new FakeSocket();
    build();
    await link.tick(true);
    socket.deliver(hello());
    await settle();
    socket.deliver({ op: 0, s: 2, t: "RESUMED", d: {} });
    await settle();
    expect((await link.status()).userId).toBe("bot_42");
  });

  it("reconnects on demand, resuming the session unless asked for a fresh one", async () => {
    await goLive();
    const first = socket;
    socket = new FakeSocket();
    await link.reconnect();
    expect(first.closed).not.toBeNull();
    expect(open).toHaveBeenLastCalledWith(
      "wss://resume.discord.gg/?v=10&encoding=json",
    );
    expect(state().session).toBe("sess_1");

    socket = new FakeSocket();
    await link.reconnect({ fresh: true });
    expect(state().session).toBeNull();
    expect(discover).toHaveBeenCalled();
    socket.deliver(hello());
    await settle();
    expect(socket.lastOp(2)).toBeDefined();
    expect(socket.lastOp(6)).toBeUndefined();
  });

  it("restarts a parked link when asked to reconnect", async () => {
    await goLive();
    socket.hangUp(4014, "disallowed intents");
    await settle();
    expect(state().phase).toBe("failed");
    socket = new FakeSocket();
    await link.reconnect({ fresh: true });
    expect(open).toHaveBeenCalledTimes(2);
    expect(state().phase).toBe("connecting");
  });

  it("tells onChange about every phase change, and survives it throwing", async () => {
    const phases: string[] = [];
    const error = vi.fn();
    build({
      onChange: (status: { phase: string }) => {
        phases.push(status.phase);
        throw new Error("alert service down");
      },
      log: { info: () => {}, warn: () => {}, error },
    });
    await goLive();
    expect(phases).toEqual(["connecting", "live"]);
    expect(error).toHaveBeenCalledWith(
      "discord gateway: onChange failed",
      expect.anything(),
    );
  });

  it("writes the sequence with the heartbeat, not every event, when asked", async () => {
    build({ saveSeq: "heartbeat" });
    await goLive();
    const put = vi.spyOn(storage, "put");
    socket.deliver({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "m1" } });
    socket.deliver({ op: 0, s: 3, t: "MESSAGE_CREATE", d: { id: "m2" } });
    await settle();
    expect(put).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(2);
    expect((await link.status()).seq).toBe(3);

    await link.alarm();
    expect(put).toHaveBeenCalledOnce();
    expect(state().seq).toBe(3);
    expect(socket.lastOp(1)).toEqual({ op: 1, d: 3 });
  });

  it("writes the sequence on every event by default", async () => {
    await goLive();
    const put = vi.spyOn(storage, "put");
    socket.deliver({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "m1" } });
    await settle();
    expect(put).toHaveBeenCalledOnce();
    expect(state().seq).toBe(2);
  });

  it("counts invalid sessions in a row toward attempt, and READY resets it", async () => {
    await goLive();
    for (let i = 1; i <= 3; i++) {
      socket.deliver({ op: 9, d: false });
      await settle();
      expect(state().attempt).toBe(i);
      socket = new FakeSocket();
      await link.alarm();
      socket.deliver(hello());
      await settle();
    }
    socket.deliver(ready());
    await settle();
    expect(state().attempt).toBe(0);
  });

  it("has the GUILDS intent", () => {
    expect(GUILDS).toBe(1);
  });

  it("reports no session id, only whether one is stored", async () => {
    await goLive();
    const status = await link.status();
    expect(status).not.toHaveProperty("session", "sess_1");
    expect(status.session).toBe(true);
  });
});
