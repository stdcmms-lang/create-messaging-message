#!/usr/bin/env node
/**
 * Standalone functional tests for messaging HTTP + WebSocket
 * (documented in messaging-interface.md).
 *
 * Uses auth + conversation creation only as fixtures. Tests assert spec
 * behavior from messaging-interface.md.
 *
 * Prerequisite: server listening at BASE_URL (default http://127.0.0.1:3000).
 *
 * Usage:
 *   node messaging-functional-test.mjs
 *   BASE_URL=http://localhost:3001 node messaging-functional-test.mjs
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "./min-ws.mjs";
import { createTestResults } from "./test-results.mjs";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const testResults = createTestResults("messaging-functional-test.mjs", BASE_URL);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 10_000);
const WS_TIMEOUT_MS = Number(process.env.WS_TIMEOUT_MS ?? 15_000);
/** Per-frame wait inside multi-step WS flows (keeps failures bounded). */
const WS_JSON_WAIT_MS = Number(process.env.WS_JSON_WAIT_MS ?? 4_000);

const COLOR = process.stdout.isTTY;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const dim = (s) => c("2", s);

/** @param {string} prefix */
function unique(prefix) {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

/**
 * @param {string} prefix
 * @param {number} [maxLen]
 */
function uniqueUsername(prefix, maxLen = 20) {
  const safePrefix = String(prefix).replace(/[^a-zA-Z0-9_]/g, "_");
  const suffix = randomBytes(4).toString("hex");
  const room = Math.max(1, maxLen - 1 - suffix.length);
  const head = safePrefix.slice(0, room);
  return `${head}_${suffix}`.slice(0, maxLen);
}

/**
 * @param {string} method
 * @param {string} path
 * @param {{
 *   headers?: Record<string, string>;
 *   body?: unknown;
 *   rawBody?: string;
 *   contentType?: string;
 *   bearer?: string;
 *   noBody?: boolean;
 * }} [opts]
 */
async function api(method, path, opts = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = { ...opts.headers };
  if (opts.bearer) {headers.authorization = `Bearer ${opts.bearer}`;}
  let body;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    if (opts.contentType) {headers["content-type"] = opts.contentType;}
  } else if (opts.noBody) {
    body = undefined;
  } else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - started;
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { _nonJson: text };
    }
  }
  return { status: res.status, headers: res.headers, contentType, json, text, ms };
}

// --- WebSocket helpers (messaging-interface.md §WebSocket) ---

/** @type {WebSocket[]} */
const trackedWsSockets = [];

/**
 * When the server sends JSON back-to-back (e.g. `ack` then `conversation.subscribed`
 * in one turn), the `ws` client can emit two `message` events before the next
 * `await nextWsJson` installs a listener; the second frame was effectively dropped.
 * A single demux + FIFO queue per socket prevents that.
 *
 * @typedef {{ kind: "json"; value: unknown } | { kind: "binary" } | { kind: "parse"; raw: string }} WsJsonItem
 * @typedef {{ resolve: (v: unknown) => void; reject: (e: Error) => void; label: string; t?: ReturnType<typeof setTimeout> }} WsJsonWaiter
 * @typedef {{ queue: WsJsonItem[]; waiters: WsJsonWaiter[] }} WsJsonIngestState
 */

/** @type {WeakMap<import("ws").WebSocket, WsJsonIngestState>} */
const wsJsonIngestBySocket = new WeakMap();

/**
 * @param {WsJsonIngestState} s
 */
function drainWsJsonIngest(s) {
  while (s.waiters.length > 0 && s.queue.length > 0) {
    const w = s.waiters.shift();
    const item = s.queue.shift();
    if (!w || !item) {return;}
    if (w.t !== undefined) {clearTimeout(w.t);}
    if (item.kind === "json") {w.resolve(item.value);}
    else if (item.kind === "binary") {
      w.reject(new Error(`${w.label}: expected text JSON frame, got binary`));
    } else {
      w.reject(new Error(`${w.label}: invalid JSON frame: ${item.raw}`));
    }
  }
}

/**
 * @param {import("ws").WebSocket} ws
 * @returns {WsJsonIngestState}
 */
function ensureWsJsonIngest(ws) {
  let s = wsJsonIngestBySocket.get(ws);
  if (s) {return s;}
  s = { queue: [], waiters: [] };
  wsJsonIngestBySocket.set(ws, s);

  ws.on("message", (data, isBinary) => {
    /** @type {WsJsonItem} */
    let item;
    if (isBinary) {
      item = { kind: "binary" };
    } else {
      const raw = data.toString();
      try {
        item = { kind: "json", value: JSON.parse(raw) };
      } catch {
        item = { kind: "parse", raw: raw.slice(0, 240) };
      }
    }
    s.queue.push(item);
    drainWsJsonIngest(s);
  });

  ws.on("close", (code, reason) => {
    for (const w of s.waiters) {
      if (w.t !== undefined) {clearTimeout(w.t);}
      w.reject(
        new Error(
          `${w.label}: socket closed before message (code=${code} reason=${reason.toString()})`,
        ),
      );
    }
    s.waiters.length = 0;
    s.queue.length = 0;
  });

  return s;
}

/**
 * @param {WebSocket} ws
 */
function trackWsSocket(ws) {
  ensureWsJsonIngest(ws);
  trackedWsSockets.push(ws);
  // `ws` library does not expose a `closeCode` property; capture it from the
  // close event so tests can read it after the fact.
  /** @type {{ observedCloseCode?: number }} */ (ws).observedCloseCode = undefined;
  ws.on("close", (code) => {
    /** @type {{ observedCloseCode?: number }} */ (ws).observedCloseCode = code;
    const i = trackedWsSockets.indexOf(ws);
    if (i !== -1) {trackedWsSockets.splice(i, 1);}
  });
}

/**
 * @param {string} [path]
 */
function wsUrl(path = "/ws/messaging") {
  const u = new URL(BASE_URL);
  const scheme = u.protocol === "https:" ? "wss:" : "ws:";
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${scheme}//${u.host}${p}`;
}

/**
 * @param {string | undefined} accessToken When undefined, no Authorization header is sent.
 * @param {{ path?: string; query?: string }} [opts]
 */
function openMessagingSocket(accessToken, opts = {}) {
  const path = opts.path ?? "/ws/messaging";
  let url = wsUrl(path);
  if (opts.query) {
    const q = opts.query.replace(/^\?/, "");
    url += (url.includes("?") ? "&" : "?") + q;
  }
  /** @type {Record<string, string>} */
  const headers = {};
  if (accessToken !== undefined && accessToken !== null && accessToken !== "") {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  const ws = new WebSocket(url, { headers });
  trackWsSocket(ws);
  return ws;
}

/**
 * @param {WebSocket} ws
 * @param {string} label
 * @param {number} [timeoutMs]
 */
function waitWsOpen(ws, label, timeoutMs = WS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onErr);
      ws.removeListener("close", onClose);
      reject(new Error(`${label}: WebSocket open timeout`));
    }, timeoutMs);
    const onOpen = () => {
      clearTimeout(t);
      ws.removeListener("error", onErr);
      ws.removeListener("close", onClose);
      resolve();
    };
    const onErr = (err) => {
      clearTimeout(t);
      ws.removeListener("open", onOpen);
      ws.removeListener("close", onClose);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onClose = (code, reason) => {
      clearTimeout(t);
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onErr);
      reject(
        new Error(
          `${label}: WebSocket closed before open (code=${code} reason=${reason.toString()})`,
        ),
      );
    };
    ws.once("open", onOpen);
    ws.once("error", onErr);
    ws.once("close", onClose);
  });
}

/**
 * @param {WebSocket} ws
 * @param {string} label
 * @param {number} [timeoutMs]
 * @returns {Promise<number>}
 */
function waitWsClose(ws, label, timeoutMs = WS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve(/** @type {{ observedCloseCode?: number }} */ (ws).observedCloseCode);
      return;
    }
    const t = setTimeout(() => {
      ws.removeListener("close", onClose);
      reject(new Error(`${label}: WebSocket close timeout`));
    }, timeoutMs);
    function onClose(code) {
      clearTimeout(t);
      resolve(code);
    }
    ws.once("close", onClose);
  });
}

/**
 * @param {WebSocket} ws
 * @param {string} label
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>}
 */
function nextWsJson(ws, label, timeoutMs = WS_JSON_WAIT_MS) {
  const s = ensureWsJsonIngest(ws);
  return new Promise((resolve, reject) => {
    /** @type {{ label: string; t?: ReturnType<typeof setTimeout>; resolve: (v: unknown) => void; reject: (e: Error) => void }} */
    const entry = {
      label,
      resolve: /** @param {unknown} v */ (v) => {
        if (entry.t !== undefined) {clearTimeout(entry.t);}
        resolve(v);
      },
      reject: /** @param {Error} e */ (e) => {
        if (entry.t !== undefined) {clearTimeout(entry.t);}
        reject(e);
      },
    };
    entry.t = setTimeout(() => {
      const i = s.waiters.indexOf(entry);
      if (i !== -1) {s.waiters.splice(i, 1);}
      reject(new Error(`${label}: timeout waiting for WebSocket JSON message`));
    }, timeoutMs);
    s.waiters.push(entry);
    drainWsJsonIngest(s);
  });
}

/**
 * @param {WebSocket} ws
 * @param {string} type
 * @param {string | undefined} conversationId
 * @param {unknown} payload
 * @param {string} [commandId]
 * @returns {string} command id
 */
function sendWsCommand(ws, type, conversationId, payload, commandId = unique("wscmd")) {
  /** @type {Record<string, unknown>} */
  const cmd = {
    v: 1,
    id: commandId,
    type,
    sentAt: new Date().toISOString(),
    payload,
  };
  if (conversationId !== undefined) {cmd.conversationId = conversationId;}
  ws.send(JSON.stringify(cmd));
  return commandId;
}

/**
 * @param {unknown} ev
 * @param {string} label
 */
function assertWsServerEventShape(ev, label) {
  assert.ok(ev && typeof ev === "object", `${label}: server event object`);
  const o = /** @type {Record<string, unknown>} */ (ev);
  assert.equal(o.v, 1, `${label}: v`);
  assert.equal(typeof o.id, "string", `${label}: event id`);
  assert.equal(typeof o.type, "string", `${label}: type`);
  assert.equal(typeof o.emittedAt, "string", `${label}: emittedAt`);
  assert.equal(typeof o.sequence, "number", `${label}: sequence`);
  assert.ok(
    o.sequenceScope === "conversation" ||
      o.sequenceScope === "user" ||
      o.sequenceScope === "connection",
    `${label}: sequenceScope`,
  );
  assert.equal(typeof o.sequenceKey, "string", `${label}: sequenceKey`);
  assert.ok(
    o.scope === "user" || o.scope === "conversation" || o.scope === "system",
    `${label}: scope`,
  );
}

/**
 * @param {unknown} ev
 * @param {"conversation"|"user"|"connection"} expectedScope
 * @param {string} expectedKey
 * @param {string} label
 */
function assertWsOrdering(ev, expectedScope, expectedKey, label) {
  assertWsServerEventShape(ev, label);
  const o = /** @type {Record<string, unknown>} */ (ev);
  assert.equal(o.sequenceScope, expectedScope, `${label}: sequenceScope`);
  assert.equal(o.sequenceKey, expectedKey, `${label}: sequenceKey`);
}

/**
 * @param {unknown} ev
 * @param {string} expectedType
 * @param {string} label
 */
function assertWsServerEventType(ev, expectedType, label) {
  assertWsServerEventShape(ev, label);
  assert.equal(
    /** @type {Record<string, unknown>} */ (ev).type,
    expectedType,
    `${label}: event type`,
  );
}

/**
 * @param {unknown} ev
 * @param {string} ackId
 * @param {string} label
 * @param {("accepted"|"applied"|"duplicate")[]} [allowedStatus]
 */
function assertWsAck(
  ev,
  ackId,
  label,
  allowedStatus = ["accepted", "applied", "duplicate"],
) {
  assertWsServerEventType(ev, "ack", label);
  const p = /** @type {Record<string, unknown>} */ (
    /** @type {{ payload?: unknown }} */ (ev).payload
  );
  assert.ok(p && typeof p === "object", `${label}: ack payload`);
  const pl = /** @type {Record<string, unknown>} */ (p);
  assert.equal(pl.ackId, ackId, `${label}: ackId`);
  assert.ok(
    typeof pl.status === "string" && allowedStatus.includes(/** @type {string} */ (pl.status)),
    `${label}: ack status ∈ ${allowedStatus.join(",")} (got ${pl.status})`,
  );
}

/**
 * @param {WebSocket} ws
 * @param {string} commandId
 * @param {string} conversationId
 * @param {string} label
 */
async function waitForSubscribeSuccess(ws, commandId, conversationId, label) {
  /** @type {unknown | null} */
  let ack = null;
  /** @type {unknown | null} */
  let subscribed = null;
  for (let i = 0; i < 15; i++) {
    const ev = await nextWsJson(ws, `${label} [evt ${i}]`, WS_JSON_WAIT_MS);
    assertWsServerEventShape(ev, label);
    const o = /** @type {Record<string, unknown>} */ (ev);
    if (o.type === "ack") {
      const p = /** @type {{ ackId?: string }} */ (o.payload);
      if (p?.ackId === commandId) {ack = ev;}
    }
    if (o.type === "conversation.subscribed") {
      const p = /** @type {{ conversationId?: string }} */ (o.payload);
      if (p?.conversationId === conversationId) {subscribed = ev;}
    }
    if (ack && subscribed) {
      assertWsAck(ack, commandId, label, ["accepted", "applied"]);
      assertWsServerEventType(subscribed, "conversation.subscribed", `${label} subscribed`);
      return { ack, subscribed };
    }
  }
  throw new Error(`${label}: missing ack and/or conversation.subscribed`);
}

/**
 * @param {WebSocket} ws
 * @param {string} commandId
 * @param {string} conversationId
 * @param {string} label
 */
async function waitForUnsubscribeSuccess(ws, commandId, conversationId, label) {
  /** @type {unknown | null} */
  let ack = null;
  /** @type {unknown | null} */
  let unsub = null;
  for (let i = 0; i < 15; i++) {
    const ev = await nextWsJson(ws, `${label} [evt ${i}]`, WS_JSON_WAIT_MS);
    assertWsServerEventShape(ev, label);
    const o = /** @type {Record<string, unknown>} */ (ev);
    if (o.type === "ack") {
      const p = /** @type {{ ackId?: string }} */ (o.payload);
      if (p?.ackId === commandId) {ack = ev;}
    }
    if (o.type === "conversation.unsubscribed") {
      const p = /** @type {{ conversationId?: string }} */ (o.payload);
      if (p?.conversationId === conversationId) {unsub = ev;}
    }
    if (ack && unsub) {
      assertWsAck(ack, commandId, label, ["accepted", "applied"]);
      assertWsServerEventType(unsub, "conversation.unsubscribed", `${label} unsubscribed`);
      return { ack, unsub };
    }
  }
  throw new Error(`${label}: missing ack and/or conversation.unsubscribed`);
}

/**
 * @param {WebSocket} ws
 * @param {string} conversationId
 * @param {string} clientId
 * @param {string} label
 */
async function waitForMessageCreated(ws, conversationId, clientId, label) {
  for (let i = 0; i < 15; i++) {
    const ev = await nextWsJson(ws, `${label} [evt ${i}]`, WS_JSON_WAIT_MS);
    if (!ev || typeof ev !== "object") {continue;}
    const o = /** @type {Record<string, unknown>} */ (ev);
    if (o.type !== "message.created") {continue;}
    const p = /** @type {{ message?: { conversationId?: string; clientId?: string } }} */ (
      o.payload
    );
    if (p?.message?.conversationId === conversationId && p?.message?.clientId === clientId) {
      assertWsServerEventType(ev, "message.created", label);
      return ev;
    }
  }
  throw new Error(`${label}: no matching message.created`);
}

/**
 * Wait for the ack/error event whose `payload.ackId` matches `commandId`,
 * ignoring intervening broadcast frames (e.g. `message.created`,
 * `typing.started`) that may arrive on the sender's own subscribed socket.
 *
 * The spec (messaging-interface.md §WebSocket) does not pin ack ordering
 * relative to fanout, so callers must match by ackId rather than position.
 *
 * @param {WebSocket} ws
 * @param {string} commandId
 * @param {string} label
 * @returns {Promise<unknown>}
 */
async function waitForCommandResult(ws, commandId, label) {
  for (let i = 0; i < 30; i++) {
    const ev = await nextWsJson(ws, `${label} [evt ${i}]`, WS_JSON_WAIT_MS);
    if (!ev || typeof ev !== "object") {continue;}
    const o = /** @type {Record<string, unknown>} */ (ev);
    if (o.type !== "ack" && o.type !== "error") {continue;}
    const p = /** @type {{ ackId?: string }} */ (o.payload);
    if (p?.ackId === commandId) {return ev;}
  }
  throw new Error(`${label}: no ack/error for command ${commandId}`);
}

function closeAllTrackedWs() {
  for (const ws of [...trackedWsSockets]) {
    try {
      ws.removeAllListeners("error");
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** Lets the server run `close` handlers (hub unregister) before the next case opens sockets. */
function yieldForClosedSockets() {
  return new Promise((resolve) => setTimeout(resolve, 100));
}
function detail(res) {
  return `[${res.contentType}] ${res.text?.slice(0, 200)}`;
}

function assertStatus(res, expected, label) {
  assert.equal(
    res.status,
    expected,
    `${label}: expected HTTP ${expected}, got ${res.status}: ${detail(res)}`,
  );
}

function assertStatusIn(res, allowed, label) {
  assert.ok(
    allowed.includes(res.status),
    `${label}: expected status ∈ [${allowed.join(", ")}], got ${res.status}: ${detail(res)}`,
  );
}

/** @param {unknown} json */
function extractItems(json) {
  if (!json || typeof json !== "object") {return null;}
  const j = /** @type {Record<string, unknown>} */ (json);
  return Array.isArray(j.items) ? j.items : null;
}

/**
 * messaging-interface.md §Conventions ("List envelope") mandates exactly
 * `{ items, nextCursor }`. We deliberately do **not** accept alternative
 * shapes like `next_cursor` or `pagination.next` — that would let a
 * non-conformant server pass.
 * @param {unknown} json
 */
function extractListNextCursor(json) {
  if (!json || typeof json !== "object") {return null;}
  const j = /** @type {Record<string, unknown>} */ (json);
  if (j.nextCursor === null) {return null;}
  if (typeof j.nextCursor === "string") {return j.nextCursor;}
  return null;
}

/**
 * Asserts the list envelope is `{ items, nextCursor: string | null }` and
 * returns the parsed pieces. Use this anywhere we read a list response so
 * the strict-shape rule above is exercised consistently.
 * @param {unknown} json
 * @param {string} label
 */
function readListPage(json, label) {
  assert.ok(json && typeof json === "object", `${label}: list envelope object`);
  const j = /** @type {Record<string, unknown>} */ (json);
  assert.ok(Array.isArray(j.items), `${label}: items array`);
  assert.ok(
    j.nextCursor === null || typeof j.nextCursor === "string",
    `${label}: nextCursor must be string|null (got ${typeof j.nextCursor})`,
  );
  return {
    items: /** @type {unknown[]} */ (j.items),
    nextCursor: /** @type {string|null} */ (j.nextCursor ?? null),
  };
}

/** @param {unknown} json */
function conversationIdFromResponse(json) {
  if (!json || typeof json !== "object") {return undefined;}
  const j = /** @type {Record<string, unknown>} */ (json);
  if (typeof j.id === "string") {return j.id;}
  if (typeof j.conversationId === "string") {return j.conversationId;}
  const conv = j.conversation;
  if (conv && typeof conv === "object") {
    const co = /** @type {Record<string, unknown>} */ (conv);
    if (typeof co.id === "string") {return co.id;}
  }
  return undefined;
}

/** @param {unknown} json */
function messageIdFromResponse(json) {
  if (!json || typeof json !== "object") {return undefined;}
  const j = /** @type {Record<string, unknown>} */ (json);
  if (typeof j.id === "string") {return j.id;}
  const msg = j.message;
  if (msg && typeof msg === "object") {
    const m = /** @type {Record<string, unknown>} */ (msg);
    if (typeof m.id === "string") {return m.id;}
  }
  return undefined;
}

/**
 * Fetches a real, server-issued cursor by walking a list endpoint with
 * limit=1. Mutex tests (cursor + before, cursor + after) need a value the
 * server considers syntactically valid, so the 400 we assert can only come
 * from the mutex check itself. Throws if no cursor is available — the
 * caller is responsible for seeding enough rows that paging produces one.
 *
 * @param {string} path Base path without `?` query string
 * @param {string} bearer
 * @param {string} label
 * @returns {Promise<string>}
 */
async function fetchRealCursor(path, bearer, label) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await api("GET", `${path}${sep}limit=1`, { bearer });
  assert.equal(res.status, 200, `${label}: prefetch for real cursor`);
  const cur = extractListNextCursor(res.json);
  assert.ok(
    typeof cur === "string" && cur.length > 0,
    `${label}: server returned no nextCursor at limit=1 — seed more rows`,
  );
  return /** @type {string} */ (cur);
}

/**
 * @typedef {{
 *   email: string;
 *   username: string;
 *   password: string;
 *   accessToken?: string;
 *   refreshToken?: string;
 *   userId?: string;
 * }} FixtureUser
 */

/** @type {FixtureUser | null} */ let primary = null;
/** @type {FixtureUser | null} */ let secondary = null;
/** @type {FixtureUser | null} */ let tertiary = null;

/** @type {string | undefined} */ let directConversationId;
/** @type {string | undefined} */ let groupConversationId;
/** @type {string | undefined} */ let channelConversationId;

/** @type {string | undefined} */ let rootMessageId;
/** @type {string | undefined} */ let replyMessageId;

/**
 * @param {unknown} m
 * @param {string} label
 */
function assertMessageCore(m, label) {
  assert.ok(m && typeof m === "object", `${label}: message object`);
  const o = /** @type {Record<string, unknown>} */ (m);
  assert.equal(typeof o.id, "string", `${label}: id`);
  assert.equal(typeof o.conversationId, "string", `${label}: conversationId`);
  assert.equal(typeof o.senderId, "string", `${label}: senderId`);
  assert.equal(typeof o.createdAt, "string", `${label}: createdAt`);
  assert.ok(Array.isArray(o.attachments), `${label}: attachments[]`);
  assert.ok(Array.isArray(o.reactions), `${label}: reactions[]`);
  assert.ok(
    typeof o.status === "string",
    `${label}: status`,
  );
}

/**
 * @param {string} tag
 * @returns {Promise<FixtureUser>}
 */
async function registerUser(tag) {
  /** @type {FixtureUser} */
  const u = {
    email: `${unique(`msg_${tag}`)}@example.test`,
    username: uniqueUsername(`msg_${tag}`),
    password: "password123",
  };
  const res = await api("POST", "/auth/register", {
    body: {
      email: u.email,
      username: u.username,
      password: u.password,
      deviceId: `msgfix-${tag}`,
      displayName: `Msg${tag}`,
    },
  });
  assertStatus(res, 200, `register ${tag}`);
  const reg = /** @type {{ accessToken: string; refreshToken: string; user: { id: string } }} */ (
    res.json
  );
  u.accessToken = reg.accessToken;
  u.refreshToken = reg.refreshToken;
  u.userId = reg.user.id;
  return u;
}

/**
 * @typedef {{
 *   name: string;
 *   fn: () => Promise<void>;
 * }} TestCase
 */

/** @type {TestCase[]} */
const CASES = [
  // --- Fixtures ---
  {
    name: "fixture: register primary, secondary, tertiary users",
    fn: async () => {
      primary = await registerUser("pri");
      secondary = await registerUser("sec");
      tertiary = await registerUser("ter");
    },
  },
  {
    name: "fixture: POST /conversations direct + group + channel",
    fn: async () => {
      assert.ok(primary?.accessToken && secondary?.userId && tertiary?.userId);
      // inbox-interface.md (POST /conversations) says direct creation is
      // idempotent on (caller, peer): returns existing with 200, otherwise 201.
      // Group/channel return 201 on create, 200 on a clientId-idempotent replay.
      // We accept [200, 201] for direct here because the fixture is the first
      // creation in this run (so we expect 201) but a shared test environment
      // could already have a row from a prior run.
      const d = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: { type: "direct", memberIds: [secondary.userId] },
      });
      assertStatusIn(d, [200, 201], "direct");
      directConversationId = conversationIdFromResponse(d.json);
      assert.ok(directConversationId);

      const g = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: {
          type: "group",
          memberIds: [secondary.userId, tertiary.userId],
          title: unique("MsgGroup"),
          privacy: "private",
        },
      });
      // Fresh title → must be a fresh create. Pin to 201 to catch a server that
      // silently coalesces creates.
      assertStatus(g, 201, "group");
      groupConversationId = conversationIdFromResponse(g.json);
      assert.ok(groupConversationId);

      const ch = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: {
          type: "channel",
          memberIds: [],
          title: unique("MsgChannel"),
          privacy: "public",
          clientId: unique("ch_cid"),
        },
      });
      assertStatus(ch, 201, "channel");
      channelConversationId = conversationIdFromResponse(ch.json);
      assert.ok(channelConversationId);
    },
  },

  // --- Shared HTTP contract (authed messaging routes) ---
  // Auth on all messaging routes (401 + envelope) is covered by messaging-security-test.mjs.
  {
    name: "shared: malformed JSON POST /conversations/{id}/messages → 4xx",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(directConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          rawBody: '{"clientId":"x",',
          contentType: "application/json",
        },
      );
      assert.ok(res.status >= 400 && res.status < 500, String(res.status));
    },
  },
  {
    name: "shared: 400 responses include { error: { code, message } }",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(directConversationId)}/messages`,
        { bearer: primary.accessToken, body: {} },
      );
      assertStatus(res, 400, "empty body");
      assert.ok(res.json && typeof res.json === "object");
      const e = /** @type {{ error?: { code?: unknown; message?: unknown } }} */ (res.json).error;
      assert.ok(e && typeof e === "object");
      assert.equal(typeof e.code, "string");
      assert.equal(typeof e.message, "string");
    },
  },

  // --- GET /conversations/{conversationId}/messages ---
  {
    name: "GET /conversations/{id}/messages: empty timeline → { items: [], nextCursor: null }",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const res = await api(
        "GET",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        { bearer: primary.accessToken },
      );
      assertStatus(res, 200, "empty list");
      const items = extractItems(res.json);
      assert.ok(Array.isArray(items));
      assert.equal(items.length, 0);
      assert.equal(extractListNextCursor(res.json), null);
    },
  },
  {
    name: "GET /conversations/{id}/messages: seeded roots newest-first; replies excluded from root",
    fn: async () => {
      assert.ok(primary?.accessToken && secondary?.accessToken && directConversationId);
      const a = await api(
        "POST",
        `/conversations/${encodeURIComponent(directConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: { clientId: unique("root_a"), body: "root older" },
        },
      );
      assertStatus(a, 201, "root a");
      const b = await api(
        "POST",
        `/conversations/${encodeURIComponent(directConversationId)}/messages`,
        {
          bearer: secondary.accessToken,
          body: { clientId: unique("root_b"), body: "root newer" },
        },
      );
      assertStatus(b, 201, "root b");
      const rootA = messageIdFromResponse(a.json);
      const rootB = messageIdFromResponse(b.json);
      assert.ok(rootA && rootB);
      const rep = await api(
        "POST",
        `/conversations/${encodeURIComponent(directConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: {
            clientId: unique("reply1"),
            body: "thread reply",
            replyToMessageId: rootA,
          },
        },
      );
      assertStatus(rep, 201, "reply");
      rootMessageId = rootA;
      replyMessageId = messageIdFromResponse(rep.json);

      const list = await api(
        "GET",
        `/conversations/${encodeURIComponent(directConversationId)}/messages`,
        { bearer: primary.accessToken },
      );
      assertStatus(list, 200, "list");
      const items = extractItems(list.json) ?? [];
      const ids = items.map((m) => /** @type {{ id?: string }} */ (m).id);
      assert.ok(ids.includes(rootB), "newer root appears");
      assert.ok(ids.includes(rootA), "older root appears");
      assert.ok(!ids.includes(/** @type {string} */ (replyMessageId)), "reply excluded from root timeline");
      for (let i = 1; i < items.length; i++) {
        const cur = /** @type {{ createdAt?: string }} */ (items[i - 1]).createdAt;
        const prev = /** @type {{ createdAt?: string }} */ (items[i]).createdAt;
        assert.ok(cur && prev);
        assert.ok(
          Date.parse(cur) >= Date.parse(prev),
          "newest-first order",
        );
      }
    },
  },
  {
    name: "GET /conversations/{id}/messages: limit=1 + cursor pages without duplicates",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      const seen = new Set();
      let cursor = null;
      for (let page = 0; page < 50; page++) {
        const q =
          cursor === null
            ? `limit=1`
            : `limit=1&cursor=${encodeURIComponent(cursor)}`;
        const res = await api(
          "GET",
          `/conversations/${encodeURIComponent(directConversationId)}/messages?${q}`,
          { bearer: primary.accessToken },
        );
        assertStatus(res, 200, `page ${page}`);
        const items = extractItems(res.json) ?? [];
        assert.ok(items.length <= 1);
        for (const it of items) {
          const id = /** @type {{ id?: string }} */ (it).id;
          if (id) {
            assert.ok(!seen.has(id), `duplicate id ${id}`);
            seen.add(id);
          }
        }
        const next = extractListNextCursor(res.json);
        if (next === null) {break;}
        cursor = next;
      }
    },
  },
  // limit=0 and limit>100: messaging-security-test.mjs
  {
    name: "GET /conversations/{id}/messages: negative limit → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      const res = await api(
        "GET",
        `/conversations/${encodeURIComponent(directConversationId)}/messages?limit=-2`,
        { bearer: primary.accessToken },
      );
      assertStatus(res, 400, "limit negative");
    },
  },
  {
    name: "GET /conversations/{id}/messages: non-integer limit → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      const res = await api(
        "GET",
        `/conversations/${encodeURIComponent(directConversationId)}/messages?limit=3.5`,
        { bearer: primary.accessToken },
      );
      assertStatus(res, 400, "limit float");
    },
  },
  // Forged / empty-string cursors on list endpoints: messaging-security-test.mjs
  {
    name: "GET /conversations/{id}/messages: empty-string before → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      const res = await api(
        "GET",
        `/conversations/${encodeURIComponent(directConversationId)}/messages?before=`,
        { bearer: primary.accessToken },
      );
      assertStatus(res, 400, "empty before");
    },
  },
  {
    name: "GET /conversations/{id}/messages: before + after mutually exclusive → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      const res = await api(
        "GET",
        `/conversations/${encodeURIComponent(directConversationId)}/messages?before=m1&after=m2`,
        { bearer: primary.accessToken },
      );
      assertStatus(res, 400, "before+after");
    },
  },
  {
    name: "GET /conversations/{id}/messages: before + cursor mutually exclusive → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      // Use a real, server-issued cursor so the 400 here can only come from
      // the mutex check, not from cursor parsing. The direct conversation
      // has ≥2 root messages seeded earlier in this run, so limit=1 must
      // produce a nextCursor; fetchRealCursor asserts that.
      const cur = await fetchRealCursor(
        `/conversations/${encodeURIComponent(directConversationId)}/messages`,
        primary.accessToken,
        "before+cursor",
      );
      const res = await api(
        "GET",
        `/conversations/${encodeURIComponent(directConversationId)}/messages?before=m1&cursor=${encodeURIComponent(cur)}`,
        { bearer: primary.accessToken },
      );
      assertStatus(res, 400, "before+cursor");
    },
  },
  {
    name: "GET /conversations/{id}/messages: unknown conversation → 404",
    fn: async () => {
      assert.ok(primary?.accessToken);
      const res = await api(
        "GET",
        `/conversations/${encodeURIComponent(`conv_${randomUUID()}`)}/messages`,
        { bearer: primary.accessToken },
      );
      assertStatus(res, 404, "unknown conv");
    },
  },

  // --- POST /conversations/{conversationId}/messages ---
  {
    name: "POST /conversations/{id}/messages: missing JSON body → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        { bearer: primary.accessToken, noBody: true },
      );
      assertStatusIn(res, [400, 415], "no body");
    },
  },
  {
    name: "POST /conversations/{id}/messages: missing clientId → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        { bearer: primary.accessToken, body: { body: "hi" } },
      );
      assertStatus(res, 400, "no clientId");
    },
  },
  {
    name: "POST /conversations/{id}/messages: whitespace-only body → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        { bearer: primary.accessToken, body: { clientId: unique("ws"), body: "   \t  " } },
      );
      assertStatus(res, 400, "whitespace body");
    },
  },
  {
    name: "POST /conversations/{id}/messages: body trimmed in stored message",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: { clientId: unique("trim"), body: "  trimmed text  " },
        },
      );
      assertStatus(res, 201, "trim");
      const m = /** @type {Record<string, unknown>} */ (res.json);
      // Spec §Message: body is trimmed before storage. Returned at root.
      assert.equal(m.body, "trimmed text", "body trimmed in response");
    },
  },
  {
    name: "POST /conversations/{id}/messages: body >4000 chars → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: { clientId: unique("long"), body: "x".repeat(4001) },
        },
      );
      assertStatus(res, 400, "too long");
    },
  },
  {
    name: "POST /conversations/{id}/messages: valid → 201 + full Message shape echoed",
    fn: async () => {
      assert.ok(
        primary?.accessToken && primary.userId && groupConversationId,
      );
      const cid = unique("ok201");
      const text = "hello messaging";
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: { clientId: cid, body: text },
        },
      );
      assertStatus(res, 201, "201");
      assertMessageCore(res.json, "created message");
      const m = /** @type {Record<string, unknown>} */ (res.json);
      assert.equal(m.body, text, "body echoed verbatim");
      assert.equal(m.conversationId, groupConversationId, "conversationId matches path");
      assert.equal(m.senderId, primary.userId, "senderId is caller");
      // Spec §Message: clientId is the sender's idempotency key, visible to
      // that sender. The sender of this POST is the same user reading the
      // response, so clientId must be echoed back.
      assert.equal(m.clientId, cid, "clientId echoed back to sender");
      // Root-timeline message: replyToMessageId must be null (not undefined or absent).
      assert.equal(m.replyToMessageId, null, "replyToMessageId null on root");
      assert.equal(m.status, "sent", "status sent on new message");
      assert.deepEqual(m.attachments, [], "attachments [] when not supplied");
      assert.deepEqual(m.reactions, [], "reactions [] on new message");
    },
  },
  {
    name: "POST /conversations/{id}/messages: idempotent duplicate clientId → 200 same message",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const cid = unique("idem_c");
      const first = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: { clientId: cid, body: "idem body" },
        },
      );
      assertStatus(first, 201, "first");
      const id1 = messageIdFromResponse(first.json);
      const second = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: { clientId: cid, body: "idem body" },
        },
      );
      assertStatus(second, 200, "second");
      assert.equal(messageIdFromResponse(second.json), id1);
    },
  },
  // clientId conflict + unknown mention: messaging-security-test.mjs
  {
    name: "POST /conversations/{id}/messages: duplicate mention ids → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && secondary?.userId && groupConversationId);
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: {
            clientId: unique("dupmen"),
            body: "hi",
            mentions: [secondary.userId, secondary.userId],
          },
        },
      );
      assertStatus(res, 400, "dup mentions");
    },
  },
  {
    name: "POST /conversations/{id}/messages: unknown replyToMessageId → 404",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: {
            clientId: unique("badreply"),
            body: "hi",
            replyToMessageId: `msg_${randomUUID()}`,
          },
        },
      );
      assertStatus(res, 404, "bad reply target");
    },
  },
  // Non-member POST denial: messaging-security-test.mjs (IDOR / visibility)
  {
    name: "POST /conversations/{id}/messages: valid mentions → 201",
    fn: async () => {
      assert.ok(primary?.accessToken && secondary?.userId && groupConversationId);
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: {
            clientId: unique("okmen"),
            body: `hey ${secondary.userId}`,
            mentions: [secondary.userId],
          },
        },
      );
      assertStatus(res, 201, "mentions ok");
    },
  },
  {
    name: "GET /conversations/{id}/messages: after + cursor mutually exclusive → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      const cur = await fetchRealCursor(
        `/conversations/${encodeURIComponent(directConversationId)}/messages`,
        primary.accessToken,
        "after+cursor",
      );
      const res = await api(
        "GET",
        `/conversations/${encodeURIComponent(directConversationId)}/messages?after=m1&cursor=${encodeURIComponent(cur)}`,
        { bearer: primary.accessToken },
      );
      assertStatus(res, 400, "after+cursor");
    },
  },

  // --- Pin (implemented subset of messaging-interface.md) ---
  {
    name: "POST /messages/{messageId}/pin: first pin → 201 (created) + pin metadata",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const m = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: { clientId: unique("to_pin"), body: "pin me" },
        },
      );
      assertStatus(m, 201, "create");
      const mid = messageIdFromResponse(m.json);
      assert.ok(mid);
      const pin = await api("POST", `/messages/${encodeURIComponent(mid)}/pin`, {
        bearer: primary.accessToken,
        body: {},
      });
      // Spec: 201 when a pin is created, 200 when updated/confirmed. This
      // message had no prior pin, so 201 is required.
      assertStatus(pin, 201, "pin create");
      assert.equal(/** @type {{ id?: string }} */ (pin.json).id, mid);
      assert.equal(typeof /** @type {{ pinnedAt?: string }} */ (pin.json).pinnedAt, "string");
      assert.equal(
        typeof /** @type {{ pinnedByUserId?: string }} */ (pin.json).pinnedByUserId,
        "string",
      );
    },
  },
  {
    name: "POST /messages/{messageId}/pin: re-pin idempotent → 200",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const m = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: { clientId: unique("repin"), body: "re-pin target" },
        },
      );
      assertStatus(m, 201, "msg");
      const mid = /** @type {string} */ (messageIdFromResponse(m.json));
      const p1 = await api("POST", `/messages/${encodeURIComponent(mid)}/pin`, {
        bearer: primary.accessToken,
        body: {},
      });
      assertStatus(p1, 201, "first pin");
      const p2 = await api("POST", `/messages/${encodeURIComponent(mid)}/pin`, {
        bearer: primary.accessToken,
        body: {},
      });
      // Re-pin must be 200 ("updated or confirmed"), not 201 ("created").
      assertStatus(p2, 200, "re-pin");
    },
  },
  {
    name: "POST /messages/{messageId}/pin: unknown message → 404",
    fn: async () => {
      assert.ok(primary?.accessToken);
      const res = await api(
        "POST",
        `/messages/${encodeURIComponent(`msg_${randomUUID()}`)}/pin`,
        { bearer: primary.accessToken, body: {} },
      );
      assertStatus(res, 404, "unknown");
    },
  },
  {
    name: "POST /messages/{messageId}/pin: non-member on public channel message → 403",
    fn: async () => {
      assert.ok(primary?.accessToken && tertiary?.accessToken && channelConversationId);
      const m = await api(
        "POST",
        `/conversations/${encodeURIComponent(channelConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: { clientId: unique("chmsg"), body: "channel line" },
        },
      );
      assertStatus(m, 201, "channel msg");
      const mid = messageIdFromResponse(m.json);
      assert.ok(mid);
      const pin = await api("POST", `/messages/${encodeURIComponent(mid)}/pin`, {
        bearer: tertiary.accessToken,
        body: {},
      });
      assertStatus(pin, 403, "non-member pin");
    },
  },
  {
    name: "DELETE /messages/{messageId}/pin: unpin → 200 PinnedMessage; repeat idempotent → 204",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const m = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: { clientId: unique("unpin_tgt"), body: "unpin me" },
        },
      );
      assertStatus(m, 201, "msg");
      const mid = /** @type {string} */ (messageIdFromResponse(m.json));
      await api("POST", `/messages/${encodeURIComponent(mid)}/pin`, {
        bearer: primary.accessToken,
        body: {},
      });
      const d1 = await api("DELETE", `/messages/${encodeURIComponent(mid)}/pin`, {
        bearer: primary.accessToken,
      });
      assertStatus(d1, 200, "unpin");
      assert.equal(/** @type {{ id?: string }} */ (d1.json).id, mid);
      assert.equal(typeof /** @type {{ pinnedAt?: string }} */ (d1.json).pinnedAt, "string");
      const d2 = await api("DELETE", `/messages/${encodeURIComponent(mid)}/pin`, {
        bearer: primary.accessToken,
      });
      assertStatus(d2, 204, "unpin again");
    },
  },

  // --- Spec invariants for already-implemented endpoints ---
  {
    name:
      "POST /conversations/{id}/messages: attachmentIds must be unique → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      // Spec §Message: "attachmentIds may contain 0-20 ids, must be unique."
      // The fake attachment ids don't need to exist server-side because the
      // duplicate check is documented to fire before lookup.
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: {
            clientId: unique("dup_att"),
            body: "with attachments",
            attachmentIds: ["att_1", "att_1"],
          },
        },
      );
      assertStatus(res, 400, "duplicate attachmentIds");
    },
  },
  {
    name:
      "POST /conversations/{id}/messages: attachmentIds length 21 (>20) → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const ids = Array.from({ length: 21 }, (_, i) => `att_${i}`);
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: { clientId: unique("att21"), body: "x", attachmentIds: ids },
        },
      );
      assertStatus(res, 400, "attachmentIds >20");
    },
  },
  {
    name:
      "POST /conversations/{id}/messages: empty body + no attachments → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      // Spec §Message: "A send/update request must contain at least one
      // non-empty body after trimming or at least one attachmentId."
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: { clientId: unique("empty_both"), attachmentIds: [] },
        },
      );
      assertStatus(res, 400, "no body + no attachments");
    },
  },
  {
    name:
      "PATCH /conversations/{id}/read: monotonic — older messageId after newer is a no-op",
    fn: async () => {
      assert.ok(
        primary?.accessToken && secondary?.accessToken && groupConversationId,
      );
      // Spec §Idempotency: "Read and delivered cursors are monotonic per user.
      // Requests that move a cursor backwards are accepted as no-ops and must
      // not reduce read/delivered state."
      const a = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: secondary.accessToken,
          body: { clientId: unique("mono_a"), body: "older" },
        },
      );
      assertStatus(a, 201, "older from secondary");
      // Force a strictly-later createdAt. 50ms is generous enough for slow
      // CI runners without making the suite drag.
      await new Promise((r) => setTimeout(r, 50));
      const b = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: secondary.accessToken,
          body: { clientId: unique("mono_b"), body: "newer" },
        },
      );
      assertStatus(b, 201, "newer from secondary");
      const olderId = /** @type {string} */ (messageIdFromResponse(a.json));
      const newerId = /** @type {string} */ (messageIdFromResponse(b.json));

      // Mark up to newer first.
      const fwd = await api(
        "PATCH",
        `/conversations/${encodeURIComponent(groupConversationId)}/read`,
        { bearer: primary.accessToken, body: { messageId: newerId } },
      );
      assertStatusIn(fwd, [200, 204], "read forward");
      // Then attempt to move backwards to older. Spec §Idempotency: backward
      // writes are "accepted as no-ops" — so the call must succeed, not error.
      const back = await api(
        "PATCH",
        `/conversations/${encodeURIComponent(groupConversationId)}/read`,
        { bearer: primary.accessToken, body: { messageId: olderId } },
      );
      assertStatusIn(back, [200, 204], "read backward (must be accepted as no-op)");
      // The "must not reduce read state" half of the invariant requires
      // reading the conversation read cursor back, which lives in the inbox
      // interface (see messaging-interface.md line 181). We don't assert it
      // here to keep this suite scoped to messaging-interface.md; an inbox
      // suite owns that verification.
    },
  },

  // --- WebSocket /ws/messaging (messaging-interface.md §WebSocket) ---
  // WS missing/invalid auth + subscription-gate fanout: messaging-security-test.mjs
  {
    name: "WebSocket /ws/messaging: valid bearer → connection opens",
    fn: async () => {
      assert.ok(primary?.accessToken);
      const ws = openMessagingSocket(primary.accessToken);
      await waitWsOpen(ws, "ws open", WS_TIMEOUT_MS);
      ws.close();
    },
  },
  {
    name: "WebSocket: malformed JSON text frame → error bad_request",
    fn: async () => {
      assert.ok(primary?.accessToken);
      const ws = openMessagingSocket(primary.accessToken);
      await waitWsOpen(ws, "ws", WS_TIMEOUT_MS);
      ws.send("{not-json");
      let ev;
      try {
        ev = await nextWsJson(ws, "malformed");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        assert.fail(
          `expected error JSON frame (bad_request) after malformed send; got: ${msg}. ` +
            "Server may not implement WebSocket frame validation yet.",
        );
      }
      assertWsServerEventType(ev, "error", "malformed");
      const pl = /** @type {{ code?: string }} */ (
        /** @type {{ payload?: unknown }} */ (ev).payload
      );
      assert.equal(pl?.code, "bad_request", "error code bad_request");
      ws.close();
    },
  },
  {
    name: "WebSocket: binary frame → error + close 1003",
    fn: async () => {
      assert.ok(primary?.accessToken);
      const ws = openMessagingSocket(primary.accessToken);
      await waitWsOpen(ws, "ws", WS_TIMEOUT_MS);
      ws.send(Buffer.from([0x00, 0xff]));
      let errEv = null;
      try {
        errEv = await nextWsJson(ws, "binary err");
      } catch {
        /* server may close without a preceding error frame */
      }
      if (errEv) {assertWsServerEventType(errEv, "error", "binary");}
      let closeCode;
      try {
        closeCode = await waitWsClose(ws, "binary close", 5000);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        assert.fail(
          `expected close 1003 after binary frame; readyState=${ws.readyState} ${msg}`,
        );
      }
      assert.equal(closeCode, 1003, "close 1003 unsupported data");
    },
  },
  {
    name: "WebSocket: conversation.subscribe → ack + conversation.subscribed",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const ws = openMessagingSocket(primary.accessToken);
      await waitWsOpen(ws, "ws", WS_TIMEOUT_MS);
      const cmdId = unique("sub");
      sendWsCommand(ws, "conversation.subscribe", groupConversationId, {
        conversationId: groupConversationId,
        includeRecentMessages: false,
      }, cmdId);
      await waitForSubscribeSuccess(ws, cmdId, groupConversationId, "subscribe");
      ws.close();
    },
  },
  {
    name: "WebSocket: conversation.unsubscribe → ack + conversation.unsubscribed",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const ws = openMessagingSocket(primary.accessToken);
      await waitWsOpen(ws, "ws", WS_TIMEOUT_MS);
      const subId = unique("sub2");
      sendWsCommand(ws, "conversation.subscribe", groupConversationId, {
        conversationId: groupConversationId,
      }, subId);
      await waitForSubscribeSuccess(ws, subId, groupConversationId, "pre-subscribe");
      const unsubId = unique("unsub");
      sendWsCommand(ws, "conversation.unsubscribe", groupConversationId, {
        conversationId: groupConversationId,
      }, unsubId);
      await waitForUnsubscribeSuccess(ws, unsubId, groupConversationId, "unsubscribe");
      ws.close();
    },
  },
  {
    name: "WebSocket: message.send fanout → subscribed peer receives message.created",
    fn: async () => {
      assert.ok(
        primary?.accessToken &&
          primary.userId &&
          secondary?.accessToken &&
          groupConversationId,
      );
      const clientId = unique("ws_send");
      const body = "hello over websocket";

      const wsA = openMessagingSocket(primary.accessToken);
      const wsB = openMessagingSocket(secondary.accessToken);
      await waitWsOpen(wsA, "wsA", WS_TIMEOUT_MS);
      await waitWsOpen(wsB, "wsB", WS_TIMEOUT_MS);

      const subA = unique("subA");
      const subB = unique("subB");
      sendWsCommand(wsA, "conversation.subscribe", groupConversationId, {
        conversationId: groupConversationId,
      }, subA);
      sendWsCommand(wsB, "conversation.subscribe", groupConversationId, {
        conversationId: groupConversationId,
      }, subB);
      await waitForSubscribeSuccess(wsA, subA, groupConversationId, "A subscribe");
      await waitForSubscribeSuccess(wsB, subB, groupConversationId, "B subscribe");

      const sendCmd = unique("sendCmd");
      sendWsCommand(wsA, "message.send", groupConversationId, { clientId, body }, sendCmd);

      const ackEv = await waitForCommandResult(wsA, sendCmd, "sender ack");
      assertWsAck(ackEv, sendCmd, "sender", ["accepted", "applied"]);

      const createdA = await waitForMessageCreated(wsA, groupConversationId, clientId, "sender");
      const createdB = await waitForMessageCreated(wsB, groupConversationId, clientId, "peer");

      for (const [tag, ev] of /** @type {const} */ ([["sender", createdA], ["peer", createdB]])) {
        const p = /** @type {{ message?: Record<string, unknown> }} */ (
          /** @type {{ payload?: unknown }} */ (ev).payload
        );
        const m = p?.message;
        assert.ok(m && typeof m === "object", `${tag}: message payload`);
        assertMessageCore(m, `${tag} message.created`);
        assert.equal(m.conversationId, groupConversationId, `${tag}: conversationId`);
        assert.equal(m.senderId, primary.userId, `${tag}: senderId`);
        assert.equal(m.clientId, clientId, `${tag}: clientId`);
        assert.equal(m.body, body, `${tag}: body`);
      }

      wsA.close();
      wsB.close();
    },
  },
  {
    name: "WebSocket: conversation resource sequence shared across sockets and users",
    fn: async () => {
      assert.ok(
        primary?.accessToken &&
          primary.userId &&
          secondary?.accessToken &&
          groupConversationId,
      );
      const convKey = `conversation:${groupConversationId}`;
      const clientId = unique("ws_seq");

      const wsA1 = openMessagingSocket(primary.accessToken);
      const wsA2 = openMessagingSocket(primary.accessToken);
      const wsB = openMessagingSocket(secondary.accessToken);
      await waitWsOpen(wsA1, "wsA1", WS_TIMEOUT_MS);
      await waitWsOpen(wsA2, "wsA2", WS_TIMEOUT_MS);
      await waitWsOpen(wsB, "wsB", WS_TIMEOUT_MS);

      for (const [ws, tag] of /** @type {const} */ ([
        [wsA1, "A1"],
        [wsA2, "A2"],
        [wsB, "B"],
      ])) {
        const subId = unique(`sub_${tag}`);
        sendWsCommand(ws, "conversation.subscribe", groupConversationId, {
          conversationId: groupConversationId,
        }, subId);
        await waitForSubscribeSuccess(ws, subId, groupConversationId, `${tag} subscribe`);
      }

      const sendCmd = unique("seqSend");
      sendWsCommand(wsA1, "message.send", groupConversationId, {
        clientId,
        body: "sequence alignment probe",
      }, sendCmd);

      const ackEv = await waitForCommandResult(wsA1, sendCmd, "sender ack");
      assertWsAck(ackEv, sendCmd, "sender", ["accepted", "applied"]);
      assertWsOrdering(ackEv, "connection", "connection", "ack");

      const createdA1 = await waitForMessageCreated(
        wsA1,
        groupConversationId,
        clientId,
        "sender socket 1",
      );
      const createdA2 = await waitForMessageCreated(
        wsA2,
        groupConversationId,
        clientId,
        "sender socket 2",
      );
      const createdB = await waitForMessageCreated(
        wsB,
        groupConversationId,
        clientId,
        "peer",
      );

      const seqA1 = /** @type {number} */ (
        /** @type {Record<string, unknown>} */ (createdA1).sequence
      );
      for (const [tag, ev] of /** @type {const} */ ([
        ["sender socket 2", createdA2],
        ["peer", createdB],
      ])) {
        assertWsOrdering(ev, "conversation", convKey, tag);
        assert.equal(
          /** @type {Record<string, unknown>} */ (ev).sequence,
          seqA1,
          `${tag}: same conversation sequence as sender socket 1`,
        );
      }
      assertWsOrdering(createdA1, "conversation", convKey, "sender socket 1");
      assert.notEqual(
        /** @type {Record<string, unknown>} */ (ackEv).sequence,
        seqA1,
        "ack connection sequence must differ from conversation durable sequence",
      );

      wsA1.close();
      wsA2.close();
      wsB.close();
    },
  },
  {
    name: "WebSocket: user resource sequence shared across sockets for same user",
    fn: async () => {
      assert.ok(primary?.accessToken && rootMessageId);
      const userKey = `user:${primary.userId}`;

      const ws1 = openMessagingSocket(primary.accessToken);
      const ws2 = openMessagingSocket(primary.accessToken);
      await waitWsOpen(ws1, "ws1", WS_TIMEOUT_MS);
      await waitWsOpen(ws2, "ws2", WS_TIMEOUT_MS);

      const starRes = await api(
        "POST",
        `/messages/${encodeURIComponent(rootMessageId)}/star`,
        { bearer: primary.accessToken, body: { note: "seq probe" } },
      );
      assertStatusIn(starRes, [200, 201], "star");

      /** @param {WebSocket} ws @param {string} label */
      async function waitForStarred(ws, label) {
        for (let i = 0; i < 20; i++) {
          const ev = await nextWsJson(ws, `${label} [${i}]`, WS_JSON_WAIT_MS);
          if (!ev || typeof ev !== "object") {continue;}
          const o = /** @type {Record<string, unknown>} */ (ev);
          if (o.type !== "message.starred") {continue;}
          const p = /** @type {{ message?: { id?: string } }} */ (o.payload);
          if (p?.message?.id === rootMessageId) {
            assertWsServerEventType(ev, "message.starred", label);
            return ev;
          }
        }
        throw new Error(`${label}: no message.starred for root message`);
      }

      const starred1 = await waitForStarred(ws1, "socket 1");
      const starred2 = await waitForStarred(ws2, "socket 2");
      assertWsOrdering(starred1, "user", userKey, "socket 1");
      assertWsOrdering(starred2, "user", userKey, "socket 2");
      assert.equal(
        /** @type {Record<string, unknown>} */ (starred1).sequence,
        /** @type {Record<string, unknown>} */ (starred2).sequence,
        "both sockets share user resource sequence",
      );

      ws1.close();
      ws2.close();
    },
  },
  {
    name: "WebSocket: typing.start / typing.stop → typing.started / typing.stopped + expires clamp",
    fn: async () => {
      assert.ok(primary?.accessToken && secondary?.accessToken && groupConversationId);
      const wsA = openMessagingSocket(primary.accessToken);
      const wsB = openMessagingSocket(secondary.accessToken);
      await waitWsOpen(wsA, "wsA", WS_TIMEOUT_MS);
      await waitWsOpen(wsB, "wsB", WS_TIMEOUT_MS);
      const subA = unique("tsA");
      const subB = unique("tsB");
      sendWsCommand(wsA, "conversation.subscribe", groupConversationId, {
        conversationId: groupConversationId,
      }, subA);
      sendWsCommand(wsB, "conversation.subscribe", groupConversationId, {
        conversationId: groupConversationId,
      }, subB);
      await waitForSubscribeSuccess(wsA, subA, groupConversationId, "A");
      await waitForSubscribeSuccess(wsB, subB, groupConversationId, "B");

      const startId = unique("typStart");
      sendWsCommand(wsA, "typing.start", groupConversationId, {
        conversationId: groupConversationId,
      }, startId);
      const startAck = await waitForCommandResult(wsA, startId, "typing start ack");
      assertWsAck(startAck, startId, "typing.start ack", ["accepted", "applied"]);

      /** @type {unknown | undefined} */
      let started;
      for (let i = 0; i < 15; i++) {
        const ev = await nextWsJson(wsB, `typing started [${i}]`);
        assertWsServerEventShape(ev, "typing");
        const o = /** @type {Record<string, unknown>} */ (ev);
        if (o.type === "typing.started") {
          started = ev;
          break;
        }
      }
      assert.ok(started, "peer saw typing.started");
      assertWsServerEventType(started, "typing.started", "typing.started");
      const so = /** @type {Record<string, unknown>} */ (started);
      const em = Date.parse(String(so.emittedAt));
      const exp = Date.parse(
        String(/** @type {{ expiresAt?: string }} */ (so.payload).expiresAt),
      );
      assert.ok(!Number.isNaN(em) && !Number.isNaN(exp), "typing times parse");
      assert.ok(
        exp - em <= 10_000,
        "expiresAt clamped ≤10s after emittedAt",
      );

      const stopId = unique("typStop");
      sendWsCommand(wsA, "typing.stop", groupConversationId, {
        conversationId: groupConversationId,
      }, stopId);
      const stopAck = await waitForCommandResult(wsA, stopId, "typing stop ack");
      assertWsAck(stopAck, stopId, "typing.stop ack", ["accepted", "applied"]);

      /** @type {unknown | undefined} */
      let stopped;
      for (let i = 0; i < 15; i++) {
        const ev = await nextWsJson(wsB, `typing stopped [${i}]`);
        assertWsServerEventShape(ev, "typing stop");
        const o = /** @type {Record<string, unknown>} */ (ev);
        if (o.type === "typing.stopped") {
          stopped = ev;
          break;
        }
      }
      assert.ok(stopped, "peer saw typing.stopped");
      assertWsServerEventType(stopped, "typing.stopped", "typing.stopped");

      wsA.close();
      wsB.close();
    },
  },
  {
    name: "WebSocket: conversation.delivered / conversation.read → receipt events",
    fn: async () => {
      assert.ok(
        primary?.accessToken &&
          secondary?.accessToken &&
          secondary.userId &&
          groupConversationId,
      );
      const seed = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: secondary.accessToken,
          body: { clientId: unique("seed_rcpt"), body: "for receipts" },
        },
      );
      assertStatus(seed, 201, "seed message");
      const messageId = /** @type {string} */ (messageIdFromResponse(seed.json));

      const wsA = openMessagingSocket(primary.accessToken);
      const wsB = openMessagingSocket(secondary.accessToken);
      await waitWsOpen(wsA, "wsA", WS_TIMEOUT_MS);
      await waitWsOpen(wsB, "wsB", WS_TIMEOUT_MS);
      const subA = unique("rA");
      const subB = unique("rB");
      sendWsCommand(wsA, "conversation.subscribe", groupConversationId, {
        conversationId: groupConversationId,
      }, subA);
      sendWsCommand(wsB, "conversation.subscribe", groupConversationId, {
        conversationId: groupConversationId,
      }, subB);
      await waitForSubscribeSuccess(wsA, subA, groupConversationId, "A sub");
      await waitForSubscribeSuccess(wsB, subB, groupConversationId, "B sub");

      const delId = unique("del");
      sendWsCommand(wsA, "conversation.delivered", groupConversationId, {
        conversationId: groupConversationId,
        messageId,
      }, delId);
      const delAck = await waitForCommandResult(wsA, delId, "delivered ack");
      assertWsAck(delAck, delId, "delivered", ["accepted", "applied"]);

      /** @type {unknown | undefined} */
      let delEv;
      for (let i = 0; i < 15; i++) {
        const ev = await nextWsJson(wsB, `delivered evt [${i}]`);
        const o = /** @type {Record<string, unknown>} */ (ev);
        if (o.type === "conversation.receipt_delivered") {
          const p = /** @type {{ userId?: string; deliveredMessageId?: string }} */ (o.payload);
          if (p?.userId === primary.userId && p?.deliveredMessageId === messageId) {
            delEv = ev;
            break;
          }
        }
      }
      assert.ok(delEv, "peer saw conversation.receipt_delivered for primary");

      const readId = unique("read");
      sendWsCommand(wsA, "conversation.read", groupConversationId, {
        conversationId: groupConversationId,
        messageId,
      }, readId);
      const readAck = await waitForCommandResult(wsA, readId, "read ack");
      assertWsAck(readAck, readId, "read", ["accepted", "applied"]);

      /** @type {unknown | undefined} */
      let readEv;
      for (let i = 0; i < 15; i++) {
        const ev = await nextWsJson(wsB, `read evt [${i}]`);
        const o = /** @type {Record<string, unknown>} */ (ev);
        if (o.type === "conversation.receipt_read") {
          const p = /** @type {{ userId?: string; readMessageId?: string }} */ (o.payload);
          if (p?.userId === primary.userId && p?.readMessageId === messageId) {
            readEv = ev;
            break;
          }
        }
      }
      assert.ok(readEv, "peer saw conversation.receipt_read for primary");

      wsA.close();
      wsB.close();
    },
  },
  {
    name: "WebSocket: duplicate command id → ack status duplicate",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const ws = openMessagingSocket(primary.accessToken);
      await waitWsOpen(ws, "ws", WS_TIMEOUT_MS);
      const subId = unique("dupSub");
      sendWsCommand(ws, "conversation.subscribe", groupConversationId, {
        conversationId: groupConversationId,
      }, subId);
      await waitForSubscribeSuccess(ws, subId, groupConversationId, "subscribe");

      const cmdId = unique("dupCmd");
      const clientId = unique("dup_msg");
      sendWsCommand(ws, "message.send", groupConversationId, { clientId, body: "once" }, cmdId);
      const firstAck = await waitForCommandResult(ws, cmdId, "first ack");
      assertWsAck(firstAck, cmdId, "first", ["accepted", "applied"]);
      await waitForMessageCreated(ws, groupConversationId, clientId, "created");

      sendWsCommand(ws, "message.send", groupConversationId, { clientId, body: "once" }, cmdId);
      const dupAck = await waitForCommandResult(ws, cmdId, "dup ack");
      assertWsAck(dupAck, cmdId, "duplicate command", ["duplicate"]);

      ws.close();
    },
  },
  // WS message.send clientId conflict: same rule as HTTP; messaging-security-test.mjs

  // --- Messages, replies, star, mentions, threads, drafts, reactions ---
  {
    name: "GET /messages/{messageId}: visible message → 200 + Message at root",
    fn: async () => {
      assert.ok(primary?.accessToken && rootMessageId);
      const res = await api(
        "GET",
        `/messages/${encodeURIComponent(rootMessageId)}`,
        { bearer: primary.accessToken },
      );
      assertStatus(res, 200, "GET message");
      assertMessageCore(res.json, "fetched message");
      assert.equal(
        /** @type {{ id?: string }} */ (res.json).id,
        rootMessageId,
        "id round-trips",
      );
    },
  },
  {
    name:
      "PATCH /messages/{messageId}: edit sets editedAt, preserves createdAt/senderId",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const create = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: { clientId: unique("edit_target"), body: "original" },
        },
      );
      assertStatus(create, 201, "create message to edit");
      const mid = /** @type {string} */ (messageIdFromResponse(create.json));
      const before = /** @type {{ createdAt?: string, senderId?: string }} */ (
        create.json
      );
      const res = await api(
        "PATCH",
        `/messages/${encodeURIComponent(mid)}`,
        { bearer: primary.accessToken, body: { body: "edited" } },
      );
      assertStatus(res, 200, "PATCH message");
      const m = /** @type {Record<string, unknown>} */ (res.json);
      assert.equal(m.body, "edited", "body updated");
      assert.equal(m.createdAt, before.createdAt, "createdAt unchanged");
      assert.equal(m.senderId, before.senderId, "senderId unchanged");
      assert.equal(typeof m.editedAt, "string", "editedAt is set after edit");
    },
  },
  // PATCH/DELETE on already-deleted message (409): messaging-security-test.mjs
  {
    name: "DELETE /messages/{messageId}: tombstone has body=null, status=deleted",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const create = await api(
        "POST",
        `/conversations/${encodeURIComponent(groupConversationId)}/messages`,
        {
          bearer: primary.accessToken,
          body: { clientId: unique("to_delete"), body: "delete me" },
        },
      );
      assertStatus(create, 201, "create");
      const mid = /** @type {string} */ (messageIdFromResponse(create.json));
      const del = await api(
        "DELETE",
        `/messages/${encodeURIComponent(mid)}`,
        { bearer: primary.accessToken, body: { deleteFor: "everyone" } },
      );
      assertStatus(del, 204, "delete");
      const get = await api(
        "GET",
        `/messages/${encodeURIComponent(mid)}`,
        { bearer: primary.accessToken },
      );
      assertStatus(get, 200, "get tombstone");
      const m = /** @type {Record<string, unknown>} */ (get.json);
      assert.equal(m.status, "deleted", "status=deleted");
      assert.equal(m.body, null, "body cleared on delete");
      assert.deepEqual(m.attachments, [], "attachments cleared on delete");
      assert.equal(typeof m.deletedAt, "string", "deletedAt set");
    },
  },
  {
    name: "GET /messages/{messageId}/replies: empty thread → list envelope",
    fn: async () => {
      assert.ok(primary?.accessToken && rootMessageId);
      const res = await api(
        "GET",
        `/messages/${encodeURIComponent(rootMessageId)}/replies`,
        { bearer: primary.accessToken },
      );
      assertStatus(res, 200, "replies list");
      readListPage(res.json, "replies");
    },
  },
  {
    name: "POST /messages/{messageId}/replies: → 201 + Message in same conversation",
    fn: async () => {
      assert.ok(primary?.accessToken && rootMessageId && directConversationId);
      const res = await api(
        "POST",
        `/messages/${encodeURIComponent(rootMessageId)}/replies`,
        {
          bearer: primary.accessToken,
          body: { clientId: unique("real_reply"), body: "thread reply via /replies" },
        },
      );
      assertStatus(res, 201, "create reply");
      assertMessageCore(res.json, "reply message");
      const m = /** @type {Record<string, unknown>} */ (res.json);
      assert.equal(
        m.replyToMessageId,
        rootMessageId,
        "replyToMessageId points to root",
      );
      assert.equal(
        m.conversationId,
        directConversationId,
        "conversation inferred from root",
      );
    },
  },
  {
    name: "POST /messages/{messageId}/star then DELETE: star round-trip",
    fn: async () => {
      assert.ok(primary?.accessToken && rootMessageId);
      const add = await api(
        "POST",
        `/messages/${encodeURIComponent(rootMessageId)}/star`,
        { bearer: primary.accessToken, body: { note: "save for later" } },
      );
      assertStatusIn(add, [200, 201], "star created/updated");
      const m = /** @type {Record<string, unknown>} */ (add.json);
      assert.equal(typeof m.starredAt, "string", "starredAt iso string");
      assert.equal(m.starNote, "save for later", "starNote echoed");
      const del = await api(
        "DELETE",
        `/messages/${encodeURIComponent(rootMessageId)}/star`,
        { bearer: primary.accessToken },
      );
      assertStatus(del, 204, "unstar");
    },
  },
  {
    name: "GET /starred-messages: list envelope of StarredMessage",
    fn: async () => {
      assert.ok(primary?.accessToken);
      const res = await api("GET", "/starred-messages", {
        bearer: primary.accessToken,
      });
      assertStatus(res, 200, "starred list");
      readListPage(res.json, "starred-messages");
    },
  },
  // empty-string conversationId on starred-messages: messaging-security-test.mjs
  {
    name: "GET /mentions: empty-string from → 400",
    fn: async () => {
      assert.ok(primary?.accessToken);
      const res = await api("GET", "/mentions?from=", {
        bearer: primary.accessToken,
      });
      assertStatus(res, 400, "empty from");
    },
  },
  {
    name: "GET /mentions: empty-string to → 400",
    fn: async () => {
      assert.ok(primary?.accessToken);
      const res = await api("GET", "/mentions?to=", {
        bearer: primary.accessToken,
      });
      assertStatus(res, 400, "empty to");
    },
  },
  {
    name: "GET /mentions: list envelope of Mention",
    fn: async () => {
      assert.ok(primary?.accessToken);
      const res = await api("GET", "/mentions", {
        bearer: primary.accessToken,
      });
      assertStatus(res, 200, "mentions list");
      readListPage(res.json, "mentions");
    },
  },
  {
    name: "GET /threads: list envelope of Message with thread summary",
    fn: async () => {
      assert.ok(primary?.accessToken);
      const res = await api("GET", "/threads", {
        bearer: primary.accessToken,
      });
      assertStatus(res, 200, "threads list");
      readListPage(res.json, "threads");
    },
  },
  {
    name: "PATCH /threads/{rootMessageId}/read: requires messageId or readAt",
    fn: async () => {
      assert.ok(primary?.accessToken && rootMessageId);
      const bad = await api(
        "PATCH",
        `/threads/${encodeURIComponent(rootMessageId)}/read`,
        { bearer: primary.accessToken, body: {} },
      );
      assertStatus(bad, 400, "empty body");
      const ok = await api(
        "PATCH",
        `/threads/${encodeURIComponent(rootMessageId)}/read`,
        { bearer: primary.accessToken, body: { messageId: rootMessageId } },
      );
      assertStatus(ok, 204, "with messageId");
    },
  },
  {
    name: "GET /drafts then PUT then DELETE: draft round-trip",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      const g = await api("GET", "/drafts", { bearer: primary.accessToken });
      assertStatus(g, 200, "drafts list");
      readListPage(g.json, "drafts");
      const p = await api(
        "PUT",
        `/drafts/${encodeURIComponent(directConversationId)}`,
        { bearer: primary.accessToken, body: { body: "draft" } },
      );
      assertStatus(p, 200, "PUT draft");
      const draft = /** @type {Record<string, unknown>} */ (p.json);
      assert.equal(draft.conversationId, directConversationId, "draft conversationId");
      assert.equal(draft.body, "draft", "draft body echoed");
      const d = await api(
        "DELETE",
        `/drafts/${encodeURIComponent(directConversationId)}`,
        { bearer: primary.accessToken },
      );
      assertStatus(d, 204, "DELETE draft");
    },
  },
  {
    name:
      "PUT /drafts/{conversationId}: empty body + empty attachments → 204 (delete)",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      // Spec: "Empty body plus empty attachments deletes any existing draft
      // and returns 204. Otherwise returns 200 with Draft."
      const res = await api(
        "PUT",
        `/drafts/${encodeURIComponent(directConversationId)}`,
        { bearer: primary.accessToken, body: { body: "", attachmentIds: [] } },
      );
      assertStatus(res, 204, "empty draft deletes");
    },
  },
  {
    name:
      "POST/DELETE /messages/{id}/reactions: reaction round-trip → 200 + 204",
    fn: async () => {
      assert.ok(primary?.accessToken && rootMessageId);
      const r = await api(
        "POST",
        `/messages/${encodeURIComponent(rootMessageId)}/reactions`,
        { bearer: primary.accessToken, body: { emoji: "👍" } },
      );
      assertStatus(r, 200, "react");
      const reaction = /** @type {Record<string, unknown>} */ (r.json);
      assert.equal(reaction.emoji, "👍", "emoji echoed");
      assert.equal(typeof reaction.userId, "string", "userId");
      assert.equal(typeof reaction.createdAt, "string", "createdAt iso");
      const u = await api(
        "DELETE",
        `/messages/${encodeURIComponent(rootMessageId)}/reactions/${encodeURIComponent("👍")}`,
        { bearer: primary.accessToken },
      );
      assertStatus(u, 204, "unreact");
    },
  },
];

/**
 * Teardown — best-effort cleanup so this file is safe to run against a
 * shared environment. We delete each fixture conversation deleteFor=everyone
 * (which the spec lets the owner do) to remove the conversation, members,
 * and message rows we created during the run. Errors here don't fail the
 * suite; the runner prints them and moves on.
 */
async function teardown() {
  closeAllTrackedWs();
  /** @type {Array<[string, string | undefined]>} */
  const targets = [
    ["channel", channelConversationId],
    ["group", groupConversationId],
    ["direct", directConversationId],
  ];
  if (!primary?.accessToken) {return;}
  for (const [label, id] of targets) {
    if (!id) {continue;}
    try {
      const res = await api(
        "DELETE",
        `/conversations/${encodeURIComponent(id)}?deleteFor=everyone`,
        { bearer: primary.accessToken },
      );
      if (res.status >= 400) {
        console.log(
          `${dim("teardown")} ${label} cleanup returned ${res.status}: ${detail(res)}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${dim("teardown")} ${label} cleanup error: ${msg}`);
    }
  }
}

async function main() {
  console.log(`Messaging tests → ${BASE_URL}\n`);

  let passed = 0;
  let failed = 0;

  testResults.installIsolation();

  for (const testCase of CASES) {
    const { name, fn } = testCase;
    testResults.beginCase(name);
    const caseStart = performance.now();
    const label = dim(`${passed + failed + 1}/${CASES.length}`);
    let runError;
    try {
      await fn();
    } catch (err) {
      runError = err;
    } finally {
      closeAllTrackedWs();
      await yieldForClosedSockets();
    }
    const asyncErrors = testResults.endCase();
    const errors = [runError, ...asyncErrors].filter((e) => e !== undefined);
    const durationMs = Math.round(performance.now() - caseStart);
    if (errors.length === 0) {
      passed += 1;
      console.log(`${green("PASS")} ${label} ${name}`);
      testResults.recordCase({
        name,
        status: "pass",
        durationMs,
      });
    } else {
      failed += 1;
      const msg = errors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join("\n");
      console.log(`${red("FAIL")} ${label} ${name}`);
      console.log(`       ${dim(msg)}`);
      testResults.recordCase({
        name,
        status: "fail",
        error: msg,
        durationMs,
      });
    }
  }

  try {
    await teardown();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`${dim("teardown")} unexpected error: ${msg}`);
  }

  console.log("");
  console.log(
    `Done: ${green(`${passed} passed`)}, ${failed ? red(`${failed} failed`) : dim("0 failed")} (${CASES.length} cases)`,
  );


  const exitCode = failed > 0 ? 1 : 0;
  await testResults.finalize({ passed, failed, exitCode });
  if (exitCode === 1) { process.exit(1); }
}

main().catch(async (err) => {
  console.error("Fatal:", err);
  try {
    await testResults.finalize({
      passed: 0,
      failed: 0,
      fatal: err,
      exitCode: 2,
    });
  } catch {
    // ignore write errors
  }
  process.exit(2);
});
