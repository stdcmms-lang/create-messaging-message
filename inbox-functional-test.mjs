#!/usr/bin/env node
/**
 * Standalone functional tests for inbox/conversation endpoints
 * (documented in inbox-interface.md).
 *
 * Auth boundaries, clientId tamper, non-member visibility, member-forbidden
 * metadata PATCH, and join-on-non-channel checks live in inbox-security-test.mjs.
 *
 * Prerequisite: server listening at BASE_URL (default http://127.0.0.1:3000).
 *
 * Usage:
 *   node inbox-functional-test.mjs
 *   BASE_URL=http://localhost:3001 node inbox-functional-test.mjs
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createTestResults } from "./test-results.mjs";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const testResults = createTestResults("inbox-functional-test.mjs", BASE_URL);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 10_000);

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
 *   bearer?: string;
 * }} [opts]
 */
async function api(method, path, opts = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = { ...opts.headers };
  if (opts.bearer) {headers.authorization = `Bearer ${opts.bearer}`;}
  let body;
  if (opts.body !== undefined) {
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

/**
 * Conversation responses and inbox list rows must be flat **Conversation** objects
 * per inbox-interface.md. Rejects `{ conversation: { ... } }` wrappers so an
 * inconsistent contract fails loudly.
 * @param {unknown} value
 * @param {string} label
 * @param {string} [rootName]
 */
function unwrapConversation(value, label, rootName = "JSON root") {
  assert.ok(value && typeof value === "object", `${label}: object`);
  const j = /** @type {Record<string, unknown>} */ (value);
  const nested =
    j.conversation && typeof j.conversation === "object"
      ? /** @type {Record<string, unknown>} */ (j.conversation)
      : null;
  const topOk =
    typeof j.id === "string" &&
    ["direct", "group", "channel"].includes(String(j.type));
  if (nested && typeof nested.id === "string") {
    assert.fail(
      `${label}: expected Conversation fields at the ${rootName} per inbox-interface.md (got wrapped { conversation: {...} })`,
    );
  }
  assert.ok(topOk, `${label}: ${rootName} must be a Conversation with id and type`);
  return j;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * @param {unknown} obj
 * @param {string} label
 * @param {{ expectedType?: 'direct'|'group'|'channel' }} [opts]
 */
function assertConversationCoreShape(obj, label, opts = {}) {
  assert.ok(obj && typeof obj === "object", `${label}: object body`);
  const o = /** @type {Record<string, unknown>} */ (obj);
  assert.equal(typeof o.id, "string", `${label}: id string`);
  assert.ok(
    ["direct", "group", "channel"].includes(/** @type {string} */ (o.type)),
    `${label}: type enum`,
  );
  if (opts.expectedType) {
    assert.equal(o.type, opts.expectedType, `${label}: type=${opts.expectedType}`);
  }
  if (o.type === "direct") {
    assert.equal(o.title, null, `${label}: direct title must be null`);
  }
  assert.ok(Array.isArray(o.memberIds), `${label}: memberIds array`);
  assert.equal(
    typeof o.memberPreviewTruncated,
    "boolean",
    `${label}: memberPreviewTruncated boolean`,
  );
  for (const k of ["unreadCount", "mentionCount"]) {
    const v = /** @type {number} */ (o[k]);
    assert.equal(typeof v, "number", `${label}: ${k} number`);
    assert.ok(Number.isInteger(v) && v >= 0, `${label}: ${k} non-negative integer`);
  }
  for (const k of ["muted", "archived", "pinned"]) {
    assert.equal(typeof o[k], "boolean", `${label}: ${k} boolean`);
  }
  for (const k of ["createdAt", "updatedAt"]) {
    const v = /** @type {string} */ (o[k]);
    assert.equal(typeof v, "string", `${label}: ${k} string`);
    assert.ok(ISO_RE.test(v), `${label}: ${k} ISO-8601 (got ${v})`);
  }
  for (const k of ["topic", "avatarAttachmentId"]) {
    const v = o[k];
    assert.ok(
      v === null || typeof v === "string",
      `${label}: ${k} must be string|null (got ${typeof v})`,
    );
  }
  if (o.mutedUntil !== null && o.mutedUntil !== undefined) {
    assert.equal(typeof o.mutedUntil, "string", `${label}: mutedUntil string|null`);
  }
  if (o.type === "direct" || o.type === "group") {
    assert.equal(o.privacy, "private", `${label}: direct/group privacy must be private`);
  } else if (o.type === "channel") {
    assert.ok(
      o.privacy === "public" || o.privacy === "private",
      `${label}: channel privacy must be public|private`,
    );
  }
}

/** @param {unknown} item @param {string} conversationId */
function conversationRowMatchesId(item, conversationId) {
  const o = unwrapConversation(item, "conversation row", "item root");
  return o.id === conversationId;
}

/**
 * @param {unknown} obj
 * @param {string} label
 */
function assertMemberShape(obj, label) {
  assert.ok(obj && typeof obj === "object", `${label}: object body`);
  const o = /** @type {Record<string, unknown>} */ (obj);
  assert.equal(typeof o.userId, "string", `${label}: userId string`);
  assert.ok(
    ["owner", "admin", "member"].includes(/** @type {string} */ (o.role)),
    `${label}: role enum`,
  );
  const joinedAt = /** @type {string} */ (o.joinedAt);
  assert.equal(typeof joinedAt, "string", `${label}: joinedAt string`);
  assert.ok(ISO_RE.test(joinedAt), `${label}: joinedAt ISO-8601`);
}

/**
 * @param {unknown} json
 * @param {string} label
 */
function assertMemberListEnvelope(json, label) {
  assert.ok(json && typeof json === "object", `${label}: object body`);
  const o = /** @type {Record<string, unknown>} */ (json);
  assert.ok(Array.isArray(o.items), `${label}: items array`);
  for (const item of /** @type {unknown[]} */ (o.items)) {
    assertMemberShape(item, `${label} item`);
  }
  assert.equal(o.nextCursor, null, `${label}: nextCursor null`);
}

/** @param {unknown} item @param {string} userId */
function memberRowMatchesUserId(item, userId) {
  if (!item || typeof item !== "object") {return false;}
  const o = /** @type {Record<string, unknown>} */ (item);
  return o.userId === userId;
}

/** @param {unknown} item @param {string} messageId */
function messageRowMatchesId(item, messageId) {
  if (!item || typeof item !== "object") {return false;}
  const o = /** @type {Record<string, unknown>} */ (item);
  return o.id === messageId || o.messageId === messageId;
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
/** @type {string | undefined} */ let disposableGroupId;
/** @type {string | undefined} */ let toggleScratchId;
/** @type {string | undefined} */ let inboxFixtureMessageId;

/**
 * @param {string} tag
 * @returns {Promise<FixtureUser>}
 */
async function registerUser(tag) {
  /** @type {FixtureUser} */
  const u = {
    email: `${unique(`cf_${tag}`)}@example.test`,
    username: uniqueUsername(`cf_${tag}`),
    password: "password123",
  };
  const res = await api("POST", "/auth/register", {
    body: {
      email: u.email,
      username: u.username,
      password: u.password,
      deviceId: `cfix-device-${tag}`,
      displayName: `Conv${tag}Display`,
    },
  });
  assertStatus(res, 200, `register ${tag}`);
  const reg = /** @type {{ accessToken: string; refreshToken: string; user: { id: string } }} */ (
    res.json
  );
  assert.ok(reg?.accessToken, `${tag} accessToken`);
  assert.ok(reg?.refreshToken, `${tag} refreshToken`);
  assert.ok(reg?.user?.id, `${tag} user.id`);
  u.accessToken = reg.accessToken;
  u.refreshToken = reg.refreshToken;
  u.userId = reg.user.id;
  return u;
}

/** @type {Array<{ name: string, fn: () => Promise<void> }>} */
const CASES = [
  {
    name: "fixture: register primary, secondary, tertiary users",
    fn: async () => {
      primary = await registerUser("primary");
      secondary = await registerUser("secondary");
      tertiary = await registerUser("tertiary");
    },
  },

  {
    name: "POST /conversations: direct → 201 + direct shape (title=null)",
    fn: async () => {
      assert.ok(primary?.accessToken && secondary?.userId);
      const res = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: { type: "direct", memberIds: [secondary.userId] },
      });
      assertStatus(res, 201, "create direct");
      assertConversationCoreShape(unwrapConversation(res.json, "direct body"), "direct body", {
        expectedType: "direct",
      });
      directConversationId = conversationIdFromResponse(res.json);
      assert.ok(directConversationId, "directConversationId");
    },
  },
  {
    name: "POST /conversations: direct idempotent on (caller, peer) → 200 + same id",
    fn: async () => {
      assert.ok(primary?.accessToken && secondary?.userId && directConversationId);
      const res = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: { type: "direct", memberIds: [secondary.userId] },
      });
      assertStatus(res, 200, "create direct again (idempotent)");
      assert.equal(
        conversationIdFromResponse(res.json),
        directConversationId,
        "same direct conversation id",
      );
    },
  },
  {
    name: "POST /conversations: private group → 200|201 + group shape",
    fn: async () => {
      assert.ok(primary?.accessToken && secondary?.userId && tertiary?.userId);
      const res = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: {
          type: "group",
          memberIds: [secondary.userId, tertiary.userId],
          title: unique("FixtureGroup"),
          privacy: "private",
        },
      });
      assertStatusIn(res, [200, 201], "create group");
      assertConversationCoreShape(unwrapConversation(res.json, "group body"), "group body", {
        expectedType: "group",
      });
      groupConversationId = conversationIdFromResponse(res.json);
      assert.ok(groupConversationId, "groupConversationId");
    },
  },
  {
    name: "POST /conversations: public channel → 200|201 + channel shape",
    fn: async () => {
      assert.ok(primary?.accessToken);
      const res = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: {
          type: "channel",
          memberIds: [],
          title: unique("FixtureChannel"),
          privacy: "public",
          clientId: unique("channel_client"),
        },
      });
      assertStatusIn(res, [200, 201], "create channel");
      assertConversationCoreShape(unwrapConversation(res.json, "channel body"), "channel body", {
        expectedType: "channel",
      });
      channelConversationId = conversationIdFromResponse(res.json);
      assert.ok(channelConversationId, "channelConversationId");
    },
  },
  {
    name: "POST /conversations: missing `type` → 400",
    fn: async () => {
      assert.ok(primary?.accessToken);
      const res = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: { memberIds: [] },
      });
      assertStatus(res, 400, "create without type");
    },
  },
  {
    name: "POST /conversations: direct with title → 400",
    fn: async () => {
      assert.ok(primary?.accessToken);
      const peer = await registerUser("direct_title_peer");
      assert.ok(peer.userId);
      const res = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: { type: "direct", memberIds: [peer.userId], title: "nope" },
      });
      assertStatus(res, 400, "direct rejects title (fresh peer avoids ambiguous 400 from idempotent direct)");
    },
  },
  {
    name: "POST /conversations: direct with clientId → 400 (inbox-interface.md rejects clientId for direct)",
    fn: async () => {
      assert.ok(primary?.accessToken && tertiary?.userId);
      const res = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: {
          type: "direct",
          memberIds: [tertiary.userId],
          clientId: unique("direct_cid_rejected"),
        },
      });
      assertStatus(res, 400, "direct rejects clientId");
    },
  },
  {
    name: "POST /conversations: direct with 2+ peers → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && secondary?.userId && tertiary?.userId);
      const res = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: { type: "direct", memberIds: [secondary.userId, tertiary.userId] },
      });
      assertStatus(res, 400, "direct requires exactly one peer");
    },
  },
  {
    name: "POST /conversations: group with privacy=public → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && secondary?.userId);
      const res = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: {
          type: "group",
          memberIds: [secondary.userId],
          title: unique("PublicGroup"),
          privacy: "public",
        },
      });
      assertStatus(res, 400, "group rejects privacy=public");
    },
  },
  {
    name: "POST /conversations: group/channel clientId idempotency → same id, 200",
    fn: async () => {
      assert.ok(primary?.accessToken && secondary?.userId);
      const clientId = unique("idem_group");
      const title = unique("IdemGroup");
      const first = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: {
          type: "group",
          memberIds: [secondary.userId],
          title,
          privacy: "private",
          clientId,
        },
      });
      assertStatusIn(first, [200, 201], "first create with clientId");
      const firstId = conversationIdFromResponse(first.json);
      assert.ok(firstId, "first conversation id");
      const second = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: {
          type: "group",
          memberIds: [secondary.userId],
          title,
          privacy: "private",
          clientId,
        },
      });
      assertStatus(second, 200, "second create with same clientId");
      assert.equal(
        conversationIdFromResponse(second.json),
        firstId,
        "same id returned on idempotent replay",
      );
    },
  },

  {
    name: "GET /conversations: default → 200 + includes direct; nextCursor is string|null",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      const res = await api("GET", "/conversations", { bearer: primary.accessToken });
      assertStatus(res, 200, "list inbox");
      const items = extractItems(res.json);
      assert.ok(items, "items[]");
      assert.ok(
        items.some((it) => conversationRowMatchesId(it, directConversationId)),
        "inbox includes direct conversation",
      );
      const j = /** @type {Record<string, unknown>} */ (res.json);
      assert.ok(
        j.nextCursor === null || typeof j.nextCursor === "string",
        "nextCursor is string|null",
      );
    },
  },
  {
    name: "GET /conversations: cursor pagination with limit=1 drains until nextCursor null",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      const seenIds = new Set();
      let cursor = null;
      for (let page = 0; page < 250; page++) {
        const path =
          cursor === null
            ? "/conversations?limit=1"
            : `/conversations?limit=1&cursor=${encodeURIComponent(cursor)}`;
        const res = await api("GET", path, { bearer: primary.accessToken });
        assertStatus(res, 200, `cursor page ${page}`);
        const items = extractItems(res.json) ?? [];
        assert.ok(items.length <= 1, "limit=1");
        const j = /** @type {Record<string, unknown>} */ (res.json);
        const next = j.nextCursor;
        assert.ok(next === null || typeof next === "string", "nextCursor string|null");
        for (const it of items) {
          const row = unwrapConversation(it, "conversation row", "item root");
          const id =
            row && typeof row === "object" && typeof /** @type {Record<string, unknown>} */ (row).id === "string"
              ? /** @type {string} */ (/** @type {Record<string, unknown>} */ (row).id)
              : undefined;
          if (id) {
            assert.ok(!seenIds.has(id), `duplicate conversation id ${id} across cursor pages`);
            seenIds.add(id);
          }
        }
        if (next === null) {break;}
        cursor = next;
      }
      assert.ok(
        seenIds.has(directConversationId),
        "cursor walk should include the fixture direct conversation",
      );
    },
  },
  {
    name: "GET /conversations?type=direct&pinned=false&limit=1 → 200 + filters applied",
    fn: async () => {
      assert.ok(primary?.accessToken);
      const res = await api("GET", "/conversations?type=direct&pinned=false&limit=1", {
        bearer: primary.accessToken,
      });
      assertStatus(res, 200, "filtered inbox");
      const items = extractItems(res.json);
      assert.ok(items, "items[]");
      assert.ok(items.length <= 1, "at most one item");
      for (const it of items) {
        const conv = /** @type {Record<string, unknown>} */ (
          unwrapConversation(it, "conversation row", "item root")
        );
        assert.equal(conv.type, "direct", "filter: type=direct");
        assert.equal(conv.pinned, false, "filter: pinned=false");
      }
    },
  },

  {
    name: "GET /conversations/{id}: direct metadata",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      const res = await api(
        "GET",
        `/conversations/${encodeURIComponent(directConversationId)}`,
        { bearer: primary.accessToken },
      );
      assertStatus(res, 200, "get conversation");
      assertConversationCoreShape(unwrapConversation(res.json, "detail"), "detail", {
        expectedType: "direct",
      });
    },
  },
  {
    name: "GET /conversations/{id}: bogus id → 404",
    fn: async () => {
      assert.ok(primary?.accessToken);
      const res = await api(
        "GET",
        `/conversations/${encodeURIComponent(`bogus_${randomUUID()}`)}`,
        { bearer: primary.accessToken },
      );
      assertStatus(res, 404, "bogus id");
    },
  },

  // Cross-spec messages fixture for read/delivered/pinned-messages.
  // Secondary sends so that primary's unreadCount is non-trivially affected by /read.
  {
    name: "POST /conversations/{id}/messages: seed text message from secondary (cross-spec) → 200|201",
    fn: async () => {
      assert.ok(secondary?.accessToken && directConversationId);
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(directConversationId)}/messages`,
        {
          bearer: secondary.accessToken,
          body: {
            clientId: unique("inbox_msg"),
            body: "inbox functional: read/delivered/pinned setup",
          },
        },
      );
      assertStatusIn(res, [200, 201], "post message");
      inboxFixtureMessageId = messageIdFromResponse(res.json);
      assert.ok(inboxFixtureMessageId, "message id");
    },
  },
  {
    name: "GET /conversations/{id}: primary sees unreadCount ≥ 1 after secondary sends",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      const res = await api(
        "GET",
        `/conversations/${encodeURIComponent(directConversationId)}`,
        { bearer: primary.accessToken },
      );
      assertStatus(res, 200, "get conversation pre-read");
      const conv = /** @type {Record<string, unknown>} */ (unwrapConversation(res.json, "pre-read"));
      assert.ok(
        typeof conv.unreadCount === "number" && conv.unreadCount >= 1,
        `unreadCount ≥ 1 before /read (got ${conv.unreadCount})`,
      );
    },
  },

  {
    name: "PATCH /conversations/{id}/delivered: primary records delivery of secondary's message → 200|204",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId && inboxFixtureMessageId);
      const res = await api(
        "PATCH",
        `/conversations/${encodeURIComponent(directConversationId)}/delivered`,
        {
          bearer: primary.accessToken,
          body: { messageId: inboxFixtureMessageId, deliveredAt: new Date().toISOString() },
        },
      );
      assertStatusIn(res, [200, 204], "patch delivered");
    },
  },
  {
    name: "PATCH /conversations/{id}/delivered: deliveredAt omitted defaults to server-now → 200|204",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId && inboxFixtureMessageId);
      const res = await api(
        "PATCH",
        `/conversations/${encodeURIComponent(directConversationId)}/delivered`,
        {
          bearer: primary.accessToken,
          body: { messageId: inboxFixtureMessageId },
        },
      );
      assertStatusIn(res, [200, 204], "patch delivered (no deliveredAt)");
    },
  },
  {
    name: "PATCH /conversations/{id}/read: primary reads → 200|204; unreadCount=0 after",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId && inboxFixtureMessageId);
      const res = await api(
        "PATCH",
        `/conversations/${encodeURIComponent(directConversationId)}/read`,
        {
          bearer: primary.accessToken,
          body: { messageId: inboxFixtureMessageId, readAt: new Date().toISOString() },
        },
      );
      assertStatusIn(res, [200, 204], "patch read");
      const get = await api(
        "GET",
        `/conversations/${encodeURIComponent(directConversationId)}`,
        { bearer: primary.accessToken },
      );
      assertStatus(get, 200, "re-get after read");
      const conv = /** @type {Record<string, unknown>} */ (unwrapConversation(get.json, "after read"));
      assert.equal(conv.unreadCount, 0, "unreadCount=0");
    },
  },
  {
    name: "PATCH /conversations/{id}/read: empty body (no messageId, no readAt) → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      const res = await api(
        "PATCH",
        `/conversations/${encodeURIComponent(directConversationId)}/read`,
        { bearer: primary.accessToken, body: {} },
      );
      assertStatus(res, 400, "read requires at least one of messageId/readAt");
    },
  },

  {
    name: "GET /conversations/{id}/pinned-messages: after POST /messages/{id}/pin (cross-spec) → 200 + includes msg",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId && inboxFixtureMessageId);
      // Pinned-messages correctness depends on POST /messages/{id}/pin from messaging-app-interface.md.
      // If that messages endpoint is missing or diverges, fail here — not in the inbox spec itself.
      const pinRes = await api(
        "POST",
        `/messages/${encodeURIComponent(inboxFixtureMessageId)}/pin`,
        { bearer: primary.accessToken, body: {} },
      );
      assertStatusIn(pinRes, [200, 201, 204], "pin message (cross-spec)");
      const res = await api(
        "GET",
        `/conversations/${encodeURIComponent(directConversationId)}/pinned-messages?limit=50`,
        { bearer: primary.accessToken },
      );
      assertStatus(res, 200, "pinned-messages");
      const items = extractItems(res.json);
      assert.ok(Array.isArray(items), "pinned-messages items[]");
      assert.ok(
        items.some((it) => messageRowMatchesId(it, inboxFixtureMessageId)),
        "pinned list includes fixture message",
      );
    },
  },

  // Direct conversations reject shared metadata + member adds
  {
    name: "PATCH /conversations/{id}: title on direct → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId);
      const res = await api(
        "PATCH",
        `/conversations/${encodeURIComponent(directConversationId)}`,
        { bearer: primary.accessToken, body: { title: "nope" } },
      );
      assertStatus(res, 400, "direct rejects shared metadata");
    },
  },
  {
    name: "POST /conversations/{id}/members: on direct → 400",
    fn: async () => {
      assert.ok(primary?.accessToken && directConversationId && tertiary?.userId);
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(directConversationId)}/members`,
        { bearer: primary.accessToken, body: { userIds: [tertiary.userId] } },
      );
      assertStatus(res, 400, "direct rejects add-members");
    },
  },

  // Shared metadata PATCH (no user toggles here)
  {
    name: "PATCH /conversations/{id}: title + topic on group → 200; values reflected",
    fn: async () => {
      assert.ok(primary?.accessToken && groupConversationId);
      const newTitle = unique("PatchedTitle");
      const res = await api(
        "PATCH",
        `/conversations/${encodeURIComponent(groupConversationId)}`,
        {
          bearer: primary.accessToken,
          body: { title: newTitle, topic: "functional-test topic" },
        },
      );
      assertStatus(res, 200, "patch group metadata");
      const conv = /** @type {Record<string, unknown>} */ (unwrapConversation(res.json, "patched group"));
      assertConversationCoreShape(conv, "patched group");
      assert.equal(conv.title, newTitle, "title reflected");
      assert.equal(conv.topic, "functional-test topic", "topic reflected");
    },
  },

  // Per-user toggles via /state on a disposable conversation
  {
    name: "POST /conversations: scratch group for /state toggles",
    fn: async () => {
      assert.ok(primary?.accessToken && secondary?.userId);
      const res = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: {
          type: "group",
          memberIds: [secondary.userId],
          title: unique("ToggleScratch"),
          privacy: "private",
        },
      });
      assertStatusIn(res, [200, 201], "create scratch group");
      toggleScratchId = conversationIdFromResponse(res.json);
      assert.ok(toggleScratchId, "toggleScratchId");
    },
  },
  {
    name: "PATCH /conversations/{id}/state: muted+mutedUntil+pinned → reflected on GET",
    fn: async () => {
      assert.ok(primary?.accessToken && toggleScratchId);
      const until = new Date(Date.now() + 3600_000).toISOString();
      const res = await api(
        "PATCH",
        `/conversations/${encodeURIComponent(toggleScratchId)}/state`,
        {
          bearer: primary.accessToken,
          body: { muted: true, mutedUntil: until, pinned: true },
        },
      );
      assertStatus(res, 200, "patch state");
      assertConversationCoreShape(unwrapConversation(res.json, "patch state"), "patch state");
      const get = await api(
        "GET",
        `/conversations/${encodeURIComponent(toggleScratchId)}`,
        { bearer: primary.accessToken },
      );
      assertStatus(get, 200, "re-get scratch");
      const conv = /** @type {Record<string, unknown>} */ (unwrapConversation(get.json, "scratch muted"));
      assert.equal(conv.muted, true, "muted reflected");
      assert.equal(
        Date.parse(String(conv.mutedUntil)),
        Date.parse(until),
        "mutedUntil instant matches (server may normalize ISO string)",
      );
      assert.equal(conv.pinned, true, "pinned reflected");
    },
  },
  {
    name: "PATCH /conversations/{id}/state: muted=false clears mutedUntil → reflected",
    fn: async () => {
      assert.ok(primary?.accessToken && toggleScratchId);
      const res = await api(
        "PATCH",
        `/conversations/${encodeURIComponent(toggleScratchId)}/state`,
        { bearer: primary.accessToken, body: { muted: false } },
      );
      assertStatus(res, 200, "unmute");
      assertConversationCoreShape(unwrapConversation(res.json, "unmute"), "unmute");
      const get = await api(
        "GET",
        `/conversations/${encodeURIComponent(toggleScratchId)}`,
        { bearer: primary.accessToken },
      );
      assertStatus(get, 200, "re-get after unmute");
      const conv = /** @type {Record<string, unknown>} */ (unwrapConversation(get.json, "scratch unmuted"));
      assert.equal(conv.muted, false, "muted cleared");
      assert.equal(conv.mutedUntil, null, "mutedUntil cleared");
    },
  },
  {
    name: "PATCH /conversations/{id}/state: muted=true without mutedUntil → indefinite mute (mutedUntil=null)",
    fn: async () => {
      assert.ok(primary?.accessToken && toggleScratchId);
      const res = await api(
        "PATCH",
        `/conversations/${encodeURIComponent(toggleScratchId)}/state`,
        { bearer: primary.accessToken, body: { muted: true } },
      );
      assertStatus(res, 200, "patch indefinite mute");
      assertConversationCoreShape(
        unwrapConversation(res.json, "patch indefinite mute"),
        "patch indefinite mute",
      );
      const get = await api(
        "GET",
        `/conversations/${encodeURIComponent(toggleScratchId)}`,
        { bearer: primary.accessToken },
      );
      assertStatus(get, 200, "re-get indefinite mute");
      const conv = /** @type {Record<string, unknown>} */ (unwrapConversation(get.json, "indefinite mute"));
      assert.equal(conv.muted, true, "muted=true");
      assert.equal(conv.mutedUntil, null, "mutedUntil=null for indefinite mute");
    },
  },
  {
    name: "PATCH /conversations/{id}/state: archived=true → absent from archived=false listing",
    fn: async () => {
      assert.ok(primary?.accessToken && toggleScratchId);
      const res = await api(
        "PATCH",
        `/conversations/${encodeURIComponent(toggleScratchId)}/state`,
        { bearer: primary.accessToken, body: { archived: true } },
      );
      assertStatus(res, 200, "archive scratch");
      assertConversationCoreShape(unwrapConversation(res.json, "archive scratch"), "archive scratch");
      const list = await api("GET", "/conversations?archived=false&limit=100", {
        bearer: primary.accessToken,
      });
      assertStatus(list, 200, "list non-archived");
      const items = extractItems(list.json) ?? [];
      assert.ok(
        !items.some((it) => conversationRowMatchesId(it, toggleScratchId)),
        "archived conv absent from archived=false listing",
      );
      const archivedList = await api("GET", "/conversations?archived=true&limit=100", {
        bearer: primary.accessToken,
      });
      assertStatus(archivedList, 200, "list archived");
      const archItems = extractItems(archivedList.json) ?? [];
      assert.ok(
        archItems.some((it) => conversationRowMatchesId(it, toggleScratchId)),
        "archived conv present under archived=true",
      );
    },
  },

  // DELETE deleteFor=self via QUERY param
  {
    name: "POST /conversations: disposable group for leave-self test",
    fn: async () => {
      assert.ok(primary?.accessToken && secondary?.userId);
      const res = await api("POST", "/conversations", {
        bearer: primary.accessToken,
        body: {
          type: "group",
          memberIds: [secondary.userId],
          title: unique("DisposableGroup"),
          privacy: "private",
        },
      });
      assertStatusIn(res, [200, 201], "create disposable group");
      disposableGroupId = conversationIdFromResponse(res.json);
      assert.ok(disposableGroupId, "disposableGroupId");
    },
  },
  {
    name: "DELETE /conversations/{id}?deleteFor=self → 200|204; absent from caller's inbox",
    fn: async () => {
      assert.ok(primary?.accessToken && disposableGroupId);
      const res = await api(
        "DELETE",
        `/conversations/${encodeURIComponent(disposableGroupId)}?deleteFor=self`,
        { bearer: primary.accessToken },
      );
      assertStatusIn(res, [200, 204], "leave/hide self");
      const list = await api("GET", "/conversations?limit=100", {
        bearer: primary.accessToken,
      });
      assertStatus(list, 200, "list after leave");
      const items = extractItems(list.json) ?? [];
      assert.ok(
        !items.some((it) => conversationRowMatchesId(it, disposableGroupId)),
        "disposable group absent after deleteFor=self",
      );
    },
  },

  // Join semantics
  {
    name: "POST /conversations/{id}/join: secondary joins public channel → 201",
    fn: async () => {
      assert.ok(secondary?.accessToken && channelConversationId);
      const res = await api(
        "POST",
        `/conversations/${encodeURIComponent(channelConversationId)}/join`,
        { bearer: secondary.accessToken, body: { source: "browse" } },
      );
      assertStatus(res, 201, "join public channel");
    },
  },

  // Members
  {
    name: "GET /conversations/{id}/members: includes primary + secondary",
    fn: async () => {
      assert.ok(primary?.accessToken && channelConversationId && primary.userId && secondary?.userId);
      const primaryUserId = primary.userId;
      const secondaryUserId = secondary.userId;
      const res = await api(
        "GET",
        `/conversations/${encodeURIComponent(channelConversationId)}/members?limit=100`,
        { bearer: primary.accessToken },
      );
      assertStatus(res, 200, "list members");
      const items = extractItems(res.json);
      assert.ok(items, "items[]");
      assert.ok(items.some((it) => memberRowMatchesUserId(it, primaryUserId)), "includes primary");
      assert.ok(
        items.some((it) => memberRowMatchesUserId(it, secondaryUserId)),
        "includes secondary after join",
      );
    },
  },
  {
    name: "POST /conversations/{id}/members: add tertiary → verified via GET",
    fn: async () => {
      assert.ok(primary?.accessToken && channelConversationId && tertiary?.userId);
      const tertiaryUserId = tertiary.userId;
      const add = await api(
        "POST",
        `/conversations/${encodeURIComponent(channelConversationId)}/members`,
        { bearer: primary.accessToken, body: { userIds: [tertiaryUserId], role: "member" } },
      );
      assertStatus(add, 201, "add members");
      assertMemberListEnvelope(add.json, "add members");
      const list = await api(
        "GET",
        `/conversations/${encodeURIComponent(channelConversationId)}/members?limit=100`,
        { bearer: primary.accessToken },
      );
      assertStatus(list, 200, "list after add");
      const items = extractItems(list.json) ?? [];
      assert.ok(
        items.some((it) => memberRowMatchesUserId(it, tertiaryUserId)),
        "tertiary present after add",
      );
    },
  },
  {
    name: "PATCH /conversations/{id}/members/{userId}: promote tertiary to admin → in role=admin listing",
    fn: async () => {
      assert.ok(primary?.accessToken && channelConversationId && tertiary?.userId);
      const tertiaryUserId = tertiary.userId;
      const patch = await api(
        "PATCH",
        `/conversations/${encodeURIComponent(channelConversationId)}/members/${encodeURIComponent(tertiaryUserId)}`,
        { bearer: primary.accessToken, body: { role: "admin" } },
      );
      assertStatus(patch, 200, "patch member role");
      assertMemberShape(patch.json, "patch member role");
      assert.equal(
        /** @type {Record<string, unknown>} */ (patch.json).role,
        "admin",
        "patched role admin",
      );
      const list = await api(
        "GET",
        `/conversations/${encodeURIComponent(channelConversationId)}/members?role=admin&limit=100`,
        { bearer: primary.accessToken },
      );
      assertStatus(list, 200, "list admins");
      const items = extractItems(list.json) ?? [];
      assert.ok(
        items.some((it) => memberRowMatchesUserId(it, tertiaryUserId)),
        "tertiary appears in role=admin listing",
      );
    },
  },
  {
    name: "DELETE /conversations/{id}/members/{userId}: remove tertiary → absent from list",
    fn: async () => {
      assert.ok(primary?.accessToken && channelConversationId && tertiary?.userId);
      const tertiaryUserId = tertiary.userId;
      const del = await api(
        "DELETE",
        `/conversations/${encodeURIComponent(channelConversationId)}/members/${encodeURIComponent(tertiaryUserId)}`,
        { bearer: primary.accessToken },
      );
      assertStatus(del, 204, "remove member");
      const list = await api(
        "GET",
        `/conversations/${encodeURIComponent(channelConversationId)}/members?limit=100`,
        { bearer: primary.accessToken },
      );
      assertStatus(list, 200, "list after remove");
      const items = extractItems(list.json) ?? [];
      assert.ok(
        !items.some((it) => memberRowMatchesUserId(it, tertiaryUserId)),
        "tertiary absent after remove",
      );
    },
  },
  {
    name: "PATCH /conversations/{id}: channel privacy public→private reflected on GET",
    fn: async () => {
      assert.ok(primary?.accessToken && channelConversationId);
      const patch = await api(
        "PATCH",
        `/conversations/${encodeURIComponent(channelConversationId)}`,
        { bearer: primary.accessToken, body: { privacy: "private" } },
      );
      assertStatus(patch, 200, "patch channel privacy");
      const patched = /** @type {Record<string, unknown>} */ (
        unwrapConversation(patch.json, "patch channel response")
      );
      assertConversationCoreShape(patched, "patch channel response", { expectedType: "channel" });
      assert.equal(patched.privacy, "private", "privacy in PATCH response");
      const get = await api(
        "GET",
        `/conversations/${encodeURIComponent(channelConversationId)}`,
        { bearer: primary.accessToken },
      );
      assertStatus(get, 200, "get channel after privacy");
      const conv = /** @type {Record<string, unknown>} */ (
        unwrapConversation(get.json, "get channel after privacy")
      );
      assert.equal(conv.privacy, "private", "privacy on GET");
    },
  },
];

async function main() {
  console.log(`Conversation tests → ${BASE_URL}\n`);

  let passed = 0;
  let failed = 0;

  testResults.installIsolation();

  for (const { name, fn } of CASES) {
    testResults.beginCase(name);
    const caseStart = performance.now();
    const label = dim(`${passed + failed + 1}/${CASES.length}`);
    let runError;
    try {
      await fn();
    } catch (err) {
      runError = err;
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
      console.error(`${red("FAIL")} ${label} ${name}`);
      console.error(`       ${dim(msg)}`);
      testResults.recordCase({
        name,
        status: "fail",
        error: msg,
        durationMs,
      });
    }
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
