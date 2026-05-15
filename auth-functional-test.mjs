#!/usr/bin/env node
/**
 * Standalone functional tests for auth + current-user endpoints
 * (documented in auth-interface.md).
 *
 * Prerequisite: server listening at BASE_URL (default http://127.0.0.1:3000).
 *
 * Usage:
 *   node auth-functional-test.mjs
 *   BASE_URL=http://localhost:3001 node auth-functional-test.mjs
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createTestResults } from "./test-results.mjs";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const testResults = createTestResults("auth-functional-test.mjs", BASE_URL);

const COLOR = process.stdout.isTTY;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const dim = (s) => c("2", s);

/** @param {string} prefix */
function unique(prefix) {
  const id = randomBytes(5).toString("hex");
  return `${prefix}_${id}`;
}

/**
 * Generate a username-safe unique string capped to `maxLen`.
 * Test case prefixes can be long, while servers often enforce short username limits.
 * @param {string} prefix
 * @param {number} [maxLen]
 */
function uniqueUsername(prefix, maxLen = 20) {
  const safePrefix = String(prefix).replace(/[^a-zA-Z0-9_]/g, "_");
  const suffix = randomBytes(4).toString("hex"); // 8 chars
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
  const started = Date.now();
  const res = await fetch(url, { method, headers, body });
  const ms = Date.now() - started;
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { _nonJson: text };
    }
  }
  return { status: res.status, headers: res.headers, json, text, ms };
}

function assertStatus(res, expected, label) {
  assert.equal(
    res.status,
    expected,
    `${label}: expected HTTP ${expected}, got ${res.status}: ${res.text?.slice(0, 200)}`,
  );
}

/** @param {{ status: number, json: unknown, text?: string }} res */
function assertStatusIn(res, allowed, label) {
  assert.ok(
    allowed.includes(res.status),
    `${label}: expected status ∈ [${allowed.join(", ")}], got ${res.status}: ${res.text?.slice(0, 200)}`,
  );
}

/** @param {unknown} json */
function errorCode(json) {
  if (!json || typeof json !== "object") {return undefined;}
  /** @type {{ error?: { code?: string }; code?: string }} */
  const o = json;
  return o.error?.code ?? o.code;
}

/** Opaque cursor-shaped string (base64url JSON) for pagination expiry tests. */
function opaqueCursorPayload(obj) {
  const json = JSON.stringify(obj);
  return Buffer.from(json, "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
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

/** @type {FixtureUser | null} */
let primary = null;
/** @type {FixtureUser | null} */
let secondary = null;


/** @type {Array<{ name: string, fn: () => Promise<void> }>} */
const CASES = [
  // --- POST /auth/register ---
  {
    name: "POST /auth/register with wrong Content-Type (plain text) → rejected (4xx)",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        rawBody: "email=x",
        contentType: "text/plain",
      });
      assert.ok(res.status >= 400 && res.status < 500, String(res.status));
    },
  },
  {
    name: "POST /auth/register empty JSON object {} → 400 (missing required fields)",
    fn: async () => {
      const res = await api("POST", "/auth/register", { body: {} });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "POST /auth/register missing Content-Type / empty body → rejected (4xx)",
    fn: async () => {
      const res = await api("POST", "/auth/register", { noBody: true });
      assert.ok(res.status >= 400 && res.status < 500, String(res.status));
    },
  },
  {
    name: "POST /auth/register with JSON array body → 400 invalid_body",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        rawBody: "[1,2,3]",
        contentType: "application/json",
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: missing email → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          username: unique("u"),
          password: "password123",
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: missing username → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("e")}@example.test`,
          password: "password123",
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: missing password → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("e")}@example.test`,
          username: unique("u"),
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: invalid email format → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: "not-an-email",
          username: unique("u"),
          password: "password123",
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: username too short → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("e")}@example.test`,
          username: "ab",
          password: "password123",
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: username invalid characters → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("e")}@example.test`,
          username: "bad name!",
          password: "password123",
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: password too short (< 8) → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("e")}@example.test`,
          username: unique("u"),
          password: "short",
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: email normalization / duplicate email → 409 on second",
    fn: async () => {
      const email = `${unique("dup")}@example.test`;
      const u1 = unique("usera");
      const u2 = unique("userb");
      const r1 = await api("POST", "/auth/register", {
        body: { email, username: u1, password: "password123" },
      });
      assertStatus(r1, 200, r1.json);
      const r2 = await api("POST", "/auth/register", {
        body: { email, username: u2, password: "password123" },
      });
      assertStatus(r2, 409, r2.json);
    },
  },
  {
    name: "register: duplicate username (different email) → 409",
    fn: async () => {
      const username = unique("sameuname");
      const r1 = await api("POST", "/auth/register", {
        body: {
          email: `${unique("a")}@example.test`,
          username,
          password: "password123",
        },
      });
      assertStatus(r1, 200, r1.json);
      const r2 = await api("POST", "/auth/register", {
        body: {
          email: `${unique("b")}@example.test`,
          username,
          password: "password123",
        },
      });
      assertStatus(r2, 409, r2.json);
    },
  },
  {
    name: "register: valid user (primary fixture) → 200 + tokens",
    fn: async () => {
      primary = {
        email: `${unique("primary")}@example.test`,
        username: unique("primary"),
        password: "password123",
      };
      const res = await api("POST", "/auth/register", {
        body: {
          email: primary.email,
          username: primary.username,
          password: primary.password,
          deviceId: "fixture-device-1",
          displayName: " Primary ",
        },
      });
      assertStatus(res, 200, res.json);
      assert.ok(res.json?.accessToken, "accessToken");
      assert.ok(res.json?.refreshToken, "refreshToken");
      assert.ok(res.json?.user?.id, "user.id");
      primary.accessToken = res.json.accessToken;
      primary.refreshToken = res.json.refreshToken;
      primary.userId = res.json.user.id;
      assert.equal(res.json.user.displayName, "Primary");
    },
  },
  {
    name: "fixture: secondary user for blocked-user and cross-account tests",
    fn: async () => {
      secondary = {
        email: `${unique("secfx")}@example.test`,
        username: uniqueUsername("secfx"),
        password: "password123",
      };
      const r2 = await api("POST", "/auth/register", {
        body: {
          email: secondary.email,
          username: secondary.username,
          password: secondary.password,
        },
      });
      assertStatus(r2, 200, r2.json);
      secondary.userId = r2.json.user.id;
      secondary.accessToken = r2.json.accessToken;
      secondary.refreshToken = r2.json.refreshToken;
    },
  },
  {
    name: "register: password null → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("nullpw")}@example.test`,
          username: unique("nullpw"),
          password: null,
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: username only whitespace → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("ws")}@example.test`,
          username: "   ",
          password: "password123",
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: username too long (>32) → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("longun")}@example.test`,
          username: "a".repeat(33),
          password: "password123",
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: duplicate email differing only by case → 409 (normalized)",
    fn: async () => {
      const local = unique("caseemail");
      const e1 = `${local}@example.test`;
      const e2 = `${local.toUpperCase()}@EXAMPLE.TEST`;
      const r1 = await api("POST", "/auth/register", {
        body: {
          email: e1,
          username: unique("u1"),
          password: "password123",
        },
      });
      assertStatus(r1, 200, r1.json);
      const r2 = await api("POST", "/auth/register", {
        body: {
          email: e2,
          username: unique("u2"),
          password: "password123",
        },
      });
      assertStatus(r2, 409, r2.json);
    },
  },
  {
    name: "register: duplicate username differing only by case → 409",
    fn: async () => {
      const u = unique("caseuser");
      const mixed = u.slice(0, 1).toUpperCase() + u.slice(1);
      const r1 = await api("POST", "/auth/register", {
        body: {
          email: `${unique("a")}@example.test`,
          username: u,
          password: "password123",
        },
      });
      assertStatus(r1, 200, r1.json);
      const r2 = await api("POST", "/auth/register", {
        body: {
          email: `${unique("b")}@example.test`,
          username: mixed,
          password: "password123",
        },
      });
      assertStatus(r2, 409, r2.json);
    },
  },
  {
    name: "register: email local-part with plus-addressing is distinct account",
    fn: async () => {
      const local = unique("plus");
      const r1 = await api("POST", "/auth/register", {
        body: {
          email: `${local}+tag@example.test`,
          username: unique("p1"),
          password: "password123",
        },
      });
      assertStatus(r1, 200, r1.json);
      const r2 = await api("POST", "/auth/register", {
        body: {
          email: `${local}@example.test`,
          username: unique("p2"),
          password: "password123",
        },
      });
      assertStatus(r2, 200, r2.json);
      assert.notEqual(r1.json.user?.id, r2.json.user?.id);
    },
  },
  {
    name: "register: very long email (>254) → 400",
    fn: async () => {
      const pad = "x".repeat(300);
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${pad}@example.test`,
          username: unique("emaillong"),
          password: "password123",
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: deviceId beyond max length → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("devlen")}@example.test`,
          username: unique("devlen"),
          password: "password123",
          deviceId: "d".repeat(200),
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: displayName empty string → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("dnempty")}@example.test`,
          username: unique("dnempty"),
          password: "password123",
          displayName: "",
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: displayName impractically long → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("dnlong")}@example.test`,
          username: unique("dnlong"),
          password: "password123",
          displayName: "Z".repeat(200),
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: unknown inviteCode ignored → 200",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("inv")}@example.test`,
          username: unique("inv"),
          password: "password123",
          inviteCode: `not-a-real-invite-${unique("x")}`,
        },
      });
      assertStatus(res, 200, res.json);
    },
  },
  {
    name: "register: deviceId empty string normalized as absent → 200",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("devempty")}@example.test`,
          username: unique("devempty"),
          password: "password123",
          deviceId: "",
        },
      });
      assertStatus(res, 200, res.json);
    },
  },
  {
    name: "register: username with Unicode letters outside ASCII rules → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("uniun")}@example.test`,
          username: `юзер_${unique("uni")}`,
          password: "password123",
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: successful signup returns session tokens and/or verification hint",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("xor")}@example.test`,
          username: unique("xor"),
          password: "password123",
        },
      });
      assertStatus(res, 200, res.json);
      const hasSession = !!(res.json.accessToken && res.json.refreshToken);
      const hasVerifyHint = !!(
        res.json.emailVerificationToken ??
        res.json.verificationToken ??
        res.json.requiresEmailVerification
      );
      assert.ok(
        hasSession || hasVerifyHint,
        "expected either issued session tokens or an explicit verification artifact",
      );
    },
  },
  {
    name: "register: unknown JSON field does not break successful signup",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("extra")}@example.test`,
          username: unique("extra"),
          password: "password123",
          unknownClientField: "ignored-or-rejected",
        },
      });
      assertStatus(res, 200, res.json);
      assert.ok(res.json.accessToken);
    },
  },
  {
    name: "register: password max length overflow → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("longpw")}@example.test`,
          username: unique("longpw"),
          password: "p".repeat(300),
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: optional deviceId omitted → still succeeds",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("nodev")}@example.test`,
          username: unique("nodev"),
          password: "password123",
        },
      });
      assertStatus(res, 200, res.json);
      assert.ok(res.json.accessToken || res.json.emailVerificationToken);
    },
  },
  {
    name: "register: password containing username substring is accepted",
    fn: async () => {
      const u = unique("pwuser");
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("pwsub")}@example.test`,
          username: u,
          password: `${u}-Suffix9`,
        },
      });
      assertStatus(res, 200, res.json);
    },
  },
  {
    name: "register: username 'admin' rejected (reserved prefix) → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("adm")}@example.test`,
          username: "admin",
          password: "password123",
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: username starting with Admin (case-insensitive) rejected → 400",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("adm2")}@example.test`,
          username: "Administrator",
          password: "password123",
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "register: reuse deviceId across distinct accounts → 200",
    fn: async () => {
      const shared = `shared-dev-${unique("id")}`;
      const r1 = await api("POST", "/auth/register", {
        body: {
          email: `${unique("sd1")}@example.test`,
          username: unique("sd1"),
          password: "password123",
          deviceId: shared,
        },
      });
      assertStatus(r1, 200, r1.json);
      const r2 = await api("POST", "/auth/register", {
        body: {
          email: `${unique("sd2")}@example.test`,
          username: unique("sd2"),
          password: "password123",
          deviceId: shared,
        },
      });
      assertStatus(r2, 200, r2.json);
    },
  },
  {
    name: "register: username leading/trailing ASCII spaces trimmed → 200",
    fn: async () => {
      const core = unique("trimu");
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("trim")}@example.test`,
          username: `  ${core}  `,
          password: "password123",
        },
      });
      assertStatus(res, 200, res.json);
    },
  },
  {
    name: "register: displayName with excessive internal whitespace accepted → 200",
    fn: async () => {
      const res = await api("POST", "/auth/register", {
        body: {
          email: `${unique("ws")}@example.test`,
          username: unique("ws"),
          password: "password123",
          displayName: `Hello${" ".repeat(40)}World`,
        },
      });
      assertStatus(res, 200, res.json);
    },
  },

  // --- POST /auth/login ---
  {
    name: "POST /auth/login with malformed JSON body → rejected (4xx)",
    fn: async () => {
      const res = await api("POST", "/auth/login", {
        rawBody: '{"identifier":"a","password":',
        contentType: "application/json",
      });
      assert.ok(res.status >= 400 && res.status < 500, String(res.status));
    },
  },
  {
    name: "login: missing identifier → 400",
    fn: async () => {
      const res = await api("POST", "/auth/login", {
        body: { password: "password123" },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "login: missing password → 400",
    fn: async () => {
      const res = await api("POST", "/auth/login", {
        body: { identifier: primary.email },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "login: wrong password → 401",
    fn: async () => {
      const res = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: "wrong-pass-xxx" },
      });
      assertStatus(res, 401, res.json);
    },
  },
  {
    name: "login: unknown user → 401",
    fn: async () => {
      const res = await api("POST", "/auth/login", {
        body: {
          identifier: `${unique("ghost")}@example.test`,
          password: "password123",
        },
      });
      assertStatus(res, 401, res.json);
    },
  },
  {
    name: "login: success by email → 200",
    fn: async () => {
      const res = await api("POST", "/auth/login", {
        body: {
          identifier: primary.email,
          password: primary.password,
          deviceId: "fixture-device-login",
        },
      });
      assertStatus(res, 200, res.json);
      assert.ok(res.json.accessToken);
    },
  },
  {
    name: "login: success by username (case differs) → 200",
    fn: async () => {
      const mixed =
        primary.username.slice(0, 1).toUpperCase() + primary.username.slice(1);
      const res = await api("POST", "/auth/login", {
        body: { identifier: mixed, password: primary.password },
      });
      assertStatus(res, 200, res.json);
    },
  },
  {
    name: "login: identifier with surrounding ASCII whitespace still resolves",
    fn: async () => {
      const res = await api("POST", "/auth/login", {
        body: {
          identifier: `  ${primary.email}  `,
          password: primary.password,
        },
      });
      assertStatus(res, 200, res.json);
    },
  },
  {
    name: "login: MFA-disabled account returns tokens not MFA challenge",
    fn: async () => {
      const res = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(res, 200, res.json);
      assert.ok(res.json.accessToken);
      assert.ok(!res.json.mfaRequired);
      assert.ok(!res.json.mfaTicket);
    },
  },
  {
    name: "login: very long password rejected consistently",
    fn: async () => {
      const res = await api("POST", "/auth/login", {
        body: {
          identifier: primary.email,
          password: "p".repeat(400),
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "login: unicode password round-trip",
    fn: async () => {
      const pw = `パスワード-${unique("pw")}-extra`;
      const email = `${unique("uniPw")}@example.test`;
      const reg = await api("POST", "/auth/register", {
        body: {
          email,
          username: unique("uniPw"),
          password: pw,
        },
      });
      assertStatus(reg, 200, reg.json);
      const res = await api("POST", "/auth/login", {
        body: { identifier: email, password: pw },
      });
      assertStatus(res, 200, res.json);
      assert.ok(res.json.accessToken);
    },
  },
  {
    name: "login: email identifier tolerates mailbox ASCII case drift",
    fn: async () => {
      const [loc, dom] = primary.email.split("@");
      const variant = `${loc.toUpperCase()}@${dom}`;
      const res = await api("POST", "/auth/login", {
        body: { identifier: variant, password: primary.password },
      });
      assert.ok(
        res.status === 200,
        `unexpected ${res.status}`,
      );
    },
  },
  {
    name: "login: oversized deviceId → 400",
    fn: async () => {
      const res = await api("POST", "/auth/login", {
        body: {
          identifier: primary.email,
          password: primary.password,
          deviceId: "z".repeat(400),
        },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "login: repeated bad passwords stay in {401,429} bucket",
    fn: async () => {
      for (let i = 0; i < 18; i++) {
        const res = await api("POST", "/auth/login", {
          body: {
            identifier: primary.email,
            password: `wrong-${i}-${unique("pw")}`,
          },
        });
        assert.ok(
          [401, 429].includes(res.status),
          `unexpected ${res.status}`,
        );
      }
    },
  },
  {
    name: "login: identifier homoglyph Cyrillic 'а' in domain → 401 (different identifier)",
    fn: async () => {
      const spoof = primary.email.replace(/a/g, "а");
      const res = await api("POST", "/auth/login", {
        body: { identifier: spoof, password: primary.password },
      });
      assertStatus(res, 401, res.json);
    },
  },
  {
    name: "login: missing deviceId still authenticates",
    fn: async () => {
      const res = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(res, 200, res.json);
    },
  },
  {
    name: "POST /auth/login: unknown JSON fields do not break successful login",
    fn: async () => {
      const res = await api("POST", "/auth/login", {
        body: {
          identifier: primary.email,
          password: primary.password,
          extraClientField: `junk-${unique("x")}`,
        },
      });
      assertStatus(res, 200, res.json);
      assert.ok(res.json.accessToken);
    },
  },
  {
    name: "POST /auth/login with wrong Content-Type (plain text) → rejected (4xx)",
    fn: async () => {
      const res = await api("POST", "/auth/login", {
        rawBody: "{not-json}",
        contentType: "text/plain",
      });
      assert.ok(res.status >= 400 && res.status < 500, String(res.status));
    },
  },
  {
    name: "login: sequential logins with different deviceIds stay authenticated",
    fn: async () => {
      const a = await api("POST", "/auth/login", {
        body: {
          identifier: primary.email,
          password: primary.password,
          deviceId: `dev-a-${unique("d")}`,
        },
      });
      assertStatus(a, 200, a.json);
      const b = await api("POST", "/auth/login", {
        body: {
          identifier: primary.email,
          password: primary.password,
          deviceId: `dev-b-${unique("d")}`,
        },
      });
      assertStatus(b, 200, b.json);
    },
  },

  // --- POST /auth/logout ---
  {
    name: "logout: refreshToken only (no bearer) → 204",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const rt = login.json.refreshToken;
      const res = await api("POST", "/auth/logout", {
        body: { refreshToken: rt },
      });
      assertStatus(res, 204, res.json);
    },
  },
  {
    name: "logout: bearer without body revokes current session → 204",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("POST", "/auth/logout", {
        bearer: login.json.accessToken,
      });
      assertStatus(res, 204, res.json);
      const me = await api("GET", "/me", { bearer: login.json.accessToken });
      assertStatus(me, 401, me.json);
    },
  },
  {
    name: "logout: allDevices true with bearer → 204",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("POST", "/auth/logout", {
        bearer: login.json.accessToken,
        body: { allDevices: true },
      });
      assertStatus(res, 204, res.json);
    },
  },
  {
    name: "logout: allDevices true still succeeds when refreshToken in body is junk (bearer authorizes)",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("POST", "/auth/logout", {
        bearer: login.json.accessToken,
        body: {
          allDevices: true,
          refreshToken: "invalid-rt-" + unique("x"),
        },
      });
      assertStatus(res, 204, res.json);
    },
  },
  {
    name: "logout: unauthenticated empty body → 204",
    fn: async () => {
      const res = await api("POST", "/auth/logout", { body: {} });
      assertStatus(res, 204, res.json);
    },
  },
  {
    name: "logout: explicit allDevices false without bearer or refreshToken → 204",
    fn: async () => {
      const res = await api("POST", "/auth/logout", {
        body: { allDevices: false },
      });
      assertStatus(res, 204, res.json);
    },
  },
  {
    name: "logout: unknown JSON fields with valid refreshToken still revoke session",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("POST", "/auth/logout", {
        body: {
          refreshToken: login.json.refreshToken,
          clientTraceId: unique("trace"),
        },
      });
      assertStatus(res, 204, res.json);
    },
  },

  // --- POST /auth/refresh ---
  {
    name: "refresh: missing refreshToken → 400",
    fn: async () => {
      const res = await api("POST", "/auth/refresh", { body: {} });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "refresh: invalid refresh token → 401",
    fn: async () => {
      const res = await api("POST", "/auth/refresh", {
        body: { refreshToken: "invalid_refresh_" + unique("x") },
      });
      assertStatus(res, 401, res.json);
    },
  },
  {
    name: "refresh: empty deviceId string normalized as absent → 200",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("POST", "/auth/refresh", {
        body: { refreshToken: login.json.refreshToken, deviceId: "" },
      });
      assertStatus(res, 200, res.json);
    },
  },
  {
    name: "refresh: empty refreshToken string → 400",
    fn: async () => {
      const res = await api("POST", "/auth/refresh", {
        body: { refreshToken: "" },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "refresh: issued access token still corresponds to same principal via GET /me",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const meBefore = await api("GET", "/me", {
        bearer: login.json.accessToken,
      });
      assertStatus(meBefore, 200, meBefore.json);
      const ref = await api("POST", "/auth/refresh", {
        body: { refreshToken: login.json.refreshToken },
      });
      assertStatus(ref, 200, ref.json);
      const meAfter = await api("GET", "/me", { bearer: ref.json.accessToken });
      assertStatus(meAfter, 200, meAfter.json);
      assert.equal(meAfter.json.id, meBefore.json.id);
    },
  },
  {
    name: "refresh: mismatched deviceId accepted (deviceId is advisory) → 200",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: {
          identifier: primary.email,
          password: primary.password,
          deviceId: `bind-${unique("d")}`,
        },
      });
      assertStatus(login, 200, login.json);
      const res = await api("POST", "/auth/refresh", {
        body: {
          refreshToken: login.json.refreshToken,
          deviceId: `other-${unique("d")}`,
        },
      });
      assertStatus(res, 200, res.json);
    },
  },
  {
    name: "POST /auth/refresh with wrong Content-Type (plain text) → rejected (4xx)",
    fn: async () => {
      const res = await api("POST", "/auth/refresh", {
        rawBody: "not-json",
        contentType: "text/plain",
      });
      assert.ok(res.status >= 400 && res.status < 500, String(res.status));
    },
  },
  {
    name: "refresh: unknown JSON fields ignored → 200",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("POST", "/auth/refresh", {
        body: {
          refreshToken: login.json.refreshToken,
          extraField: "ignored-or-invalid",
        },
      });
      assertStatus(res, 200, res.json);
    },
  },

  // --- POST /auth/password/reset ---
  {
    name: "password reset: missing email → 400",
    fn: async () => {
      const res = await api("POST", "/auth/password/reset", { body: {} });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "password reset: invalid email → 400",
    fn: async () => {
      const res = await api("POST", "/auth/password/reset", {
        body: { email: "nope" },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "password reset: known user returns devResetToken (fixture)",
    fn: async () => {
      const res = await api("POST", "/auth/password/reset", {
        body: { email: primary.email },
      });
      assertStatus(res, 200, res.json);
      assert.ok(res.json.devResetToken, "devResetToken for existing user");
    },
  },
  {
    name: "password reset: https localhost redirectUrl accepted → 200",
    fn: async () => {
      const res = await api("POST", "/auth/password/reset", {
        body: {
          email: primary.email,
          redirectUrl: "https://localhost:8443/reset",
        },
      });
      assertStatus(res, 200, res.json);
    },
  },
  {
    name: "password reset: acceptable https redirectUrl succeeds",
    fn: async () => {
      const res = await api("POST", "/auth/password/reset", {
        body: {
          email: primary.email,
          redirectUrl: "https://app.example.com/reset",
        },
      });
      assertStatus(res, 200, res.json);
      assert.equal(res.json.sent, true);
    },
  },
  {
    name: "password reset: email ASCII whitespace trimmed → 200",
    fn: async () => {
      const res = await api("POST", "/auth/password/reset", {
        body: { email: `  ${primary.email}  ` },
      });
      assertStatus(res, 200, res.json);
    },
  },
  {
    name: "password reset: unknown JSON field ignored → 200",
    fn: async () => {
      const res = await api("POST", "/auth/password/reset", {
        body: {
          email: `${unique("rstjunk")}@example.test`,
          clientMeta: { app: "auth-test" },
        },
      });
      assertStatus(res, 200, res.json);
      assert.equal(res.json.sent, true);
    },
  },

  // --- POST /auth/password/reset/confirm ---
  {
    name: "password reset confirm: invalid token → 400",
    fn: async () => {
      const res = await api("POST", "/auth/password/reset/confirm", {
        body: { token: "bad-token-" + unique("t"), newPassword: "newpass999" },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "password reset confirm: newPassword too short → 400",
    fn: async () => {
      const reset = await api("POST", "/auth/password/reset", {
        body: { email: primary.email },
      });
      assert.ok(reset.json.devResetToken);
      const res = await api("POST", "/auth/password/reset/confirm", {
        body: { token: reset.json.devResetToken, newPassword: "short" },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "password reset confirm: valid token completes → 200",
    fn: async () => {
      const reset = await api("POST", "/auth/password/reset", {
        body: { email: primary.email },
      });
      const tok = reset.json.devResetToken;
      assert.ok(tok);
      const res = await api("POST", "/auth/password/reset/confirm", {
        body: { token: tok, newPassword: "password456" },
      });
      assertStatus(res, 200, res.json);
      primary.password = "password456";
      const oldLogin = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: "password123" },
      });
      assertStatus(oldLogin, 401, oldLogin.json);
      const newLogin = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(newLogin, 200, newLogin.json);
      primary.accessToken = newLogin.json.accessToken;
      primary.refreshToken = newLogin.json.refreshToken;
    },
  },
  {
    name: "password reset confirm: missing token → 400",
    fn: async () => {
      const res = await api("POST", "/auth/password/reset/confirm", {
        body: { newPassword: "password999" },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "password reset confirm: missing newPassword → 400",
    fn: async () => {
      const res = await api("POST", "/auth/password/reset/confirm", {
        body: { token: "tok_" + unique("z") },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "password reset confirm: newPassword equals prior password rejected → 400",
    fn: async () => {
      const email = `${unique("samepw")}@example.test`;
      const reg = await api("POST", "/auth/register", {
        body: {
          email,
          username: unique("samepw"),
          password: "password123",
        },
      });
      assertStatus(reg, 200, reg.json);
      const reset = await api("POST", "/auth/password/reset", { body: { email } });
      assertStatus(reset, 200, reset.json);
      const tok = reset.json.devResetToken;
      assert.ok(tok);
      const res = await api("POST", "/auth/password/reset/confirm", {
        body: { token: tok, newPassword: "password123" },
      });
      assertStatus(res, 400, res.json);
      assert.equal(errorCode(res.json), "password_reused");
      const stillLogin = await api("POST", "/auth/login", {
        body: { identifier: email, password: "password123" },
      });
      assertStatus(stillLogin, 200, stillLogin.json);
    },
  },

  // --- POST /auth/email/verify ---
  {
    name: "email verify: invalid token → 400",
    fn: async () => {
      const res = await api("POST", "/auth/email/verify", {
        body: { token: "invalid-" + unique("v") },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "email verify: valid token from register payload chain",
    fn: async () => {
      const reg = await api("POST", "/auth/register", {
        body: {
          email: `${unique("verify")}@example.test`,
          username: unique("verify"),
          password: "password123",
        },
      });
      assertStatus(reg, 200, reg.json);
      const tok = reg.json.emailVerificationToken;
      assert.ok(tok);
      const res = await api("POST", "/auth/email/verify", {
        body: { token: tok },
      });
      assertStatus(res, 200, res.json);
      assert.equal(res.json.verified, true);
    },
  },
  {
    name: "email verify: missing token → 400",
    fn: async () => {
      const res = await api("POST", "/auth/email/verify", { body: {} });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "email verify: bogus structured token → 4xx",
    fn: async () => {
      const res = await api("POST", "/auth/email/verify", {
        body: { token: opaqueCursorPayload({ typ: "verify", exp: 1 }) },
      });
      assert.ok(
        [400, 401].includes(res.status),
        `unexpected ${res.status}`,
      );
    },
  },

  // --- POST /auth/email/verify/resend ---
  {
    name: "email verify resend: no auth + no email → 400",
    fn: async () => {
      const res = await api("POST", "/auth/email/verify/resend", {
        body: {},
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "email verify resend: authenticated → 200 + optional token",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("POST", "/auth/email/verify/resend", {
        bearer: login.json.accessToken,
        body: {},
      });
      assertStatus(res, 200, res.json);
      assert.equal(res.json.sent, true);
    },
  },
  {
    name: "email verify resend: invalid email format → 400",
    fn: async () => {
      const res = await api("POST", "/auth/email/verify/resend", {
        body: { email: "not-email" },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "email verify resend: mixed-case email normalized → 200",
    fn: async () => {
      const local = unique("caseRes");
      const res = await api("POST", "/auth/email/verify/resend", {
        body: { email: `${local.toUpperCase()}@EXAMPLE.TEST` },
      });
      assertStatus(res, 200, res.json);
      assert.ok(!res.json?.userExists, "should not leak existence flag");
    },
  },

  // --- POST /auth/mfa/enroll ---
  {
    name: "MFA enroll: invalid method → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("POST", "/auth/mfa/enroll", {
        bearer: login.json.accessToken,
        body: { method: "totp_invalid" },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "MFA enroll: sms without phone → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("POST", "/auth/mfa/enroll", {
        bearer: login.json.accessToken,
        body: { method: "sms" },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "MFA enroll: totp with redundant phone field ignored → 200",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("POST", "/auth/mfa/enroll", {
        bearer: login.json.accessToken,
        body: { method: "totp", phone: "+15550100" },
      });
      assertStatus(res, 200, res.json);
    },
  },
  {
    name: "MFA enroll: authenticated but missing method → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("POST", "/auth/mfa/enroll", {
        bearer: login.json.accessToken,
        body: {},
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "MFA enroll: TOTP path returns secret and otpauthUrl → 200",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("POST", "/auth/mfa/enroll", {
        bearer: login.json.accessToken,
        body: { method: "totp" },
      });
      assertStatus(res, 200, res.json);
      const hasSecret =
        !!(res.json?.secretBase32 ?? res.json?.totpSecret ?? res.json?.secret);
      const hasQr = !!(
        res.json?.qrCode ??
        res.json?.otpauthUri ??
        res.json?.otpauthUrl
      );
      assert.ok(
        hasSecret || hasQr || res.json?.enrollmentId,
        "totp enroll should expose secret/qr/enrollment handle",
      );
    },
  },

  // --- POST /auth/mfa/enroll/confirm ---
  {
    name: "MFA enroll confirm: unknown enrollmentId → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("POST", "/auth/mfa/enroll/confirm", {
        bearer: login.json.accessToken,
        body: { enrollmentId: "enr_missing_" + unique("z"), code: "123456" },
      });
      assertStatus(res, 400, res.json);
    },
  },

  // --- POST /auth/mfa/verify ---
  {
    name: "MFA verify: expired/unknown ticket → 401",
    fn: async () => {
      const res = await api("POST", "/auth/mfa/verify", {
        body: { mfaTicket: "missing-ticket-" + unique("x"), code: "123456" },
      });
      assertStatus(res, 401, res.json);
    },
  },
  {
    name: "MFA verify: missing mfaTicket → 400",
    fn: async () => {
      const res = await api("POST", "/auth/mfa/verify", {
        body: { code: "123456" },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "MFA verify: missing code → 400",
    fn: async () => {
      const res = await api("POST", "/auth/mfa/verify", {
        body: { mfaTicket: "t_" + unique("x") },
      });
      assertStatus(res, 400, res.json);
    },
  },

  // --- PATCH /me ---
  {
    name: "PATCH /me: invalid username pattern → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("PATCH", "/me", {
        bearer: login.json.accessToken,
        body: { username: "!!!" },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "PATCH /me: username starting with admin rejected → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("PATCH", "/me", {
        bearer: login.json.accessToken,
        body: { username: "adminsBad" },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "PATCH /me: displayName too long → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("PATCH", "/me", {
        bearer: login.json.accessToken,
        body: { displayName: "x".repeat(65) },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "PATCH /me: valid partial update → 200",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("PATCH", "/me", {
        bearer: login.json.accessToken,
        body: { statusMessage: "hello", avatarAttachmentId: "att_placeholder" },
      });
      assertStatus(res, 200, res.json);
      assert.equal(res.json.statusMessage, "hello");
      assert.equal(res.json.avatarAttachmentId, "att_placeholder");
    },
  },
  {
    name: "PATCH /me: username conflict → 409",
    fn: async () => {
      const taken = {
        email: `${unique("taken")}@example.test`,
        username: uniqueUsername("taken"),
        password: "password123",
      };
      const r2 = await api("POST", "/auth/register", {
        body: taken,
      });
      assertStatus(r2, 200, r2.json);

      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("PATCH", "/me", {
        bearer: login.json.accessToken,
        body: { username: taken.username },
      });
      assertStatus(res, 409, res.json);
    },
  },
  {
    name: "PATCH /me: empty object is a valid no-op",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("PATCH", "/me", {
        bearer: login.json.accessToken,
        body: {},
      });
      assertStatus(res, 200, res.json);
      assert.ok(res.json.id);
    },
  },
  {
    name: "PATCH /me: displayName whitespace-only → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("PATCH", "/me", {
        bearer: login.json.accessToken,
        body: { displayName: " \t  " },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "PATCH /me: Unicode displayName allowed when non-empty",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("PATCH", "/me", {
        bearer: login.json.accessToken,
        body: { displayName: "你好 🔒" },
      });
      assertStatus(res, 200, res.json);
      assert.equal(res.json.displayName, "你好 🔒");
    },
  },
  {
    name: "PATCH /me: statusMessage impractically long → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("PATCH", "/me", {
        bearer: login.json.accessToken,
        body: { statusMessage: "x".repeat(600) },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "PATCH /me: malformed JSON body → 4xx",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("PATCH", "/me", {
        bearer: login.json.accessToken,
        rawBody: '{"displayName":oops}',
        contentType: "application/json",
      });
      assert.ok(
        res.status >= 400 && res.status < 500,
        `expected client error, got ${res.status}`,
      );
    },
  },
  {
    name: "PATCH /me: empty raw body (no JSON) → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("PATCH", "/me", {
        bearer: login.json.accessToken,
        noBody: true,
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "PATCH /me: statusMessage empty string clears the field → 200",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("PATCH", "/me", {
        bearer: login.json.accessToken,
        body: { statusMessage: "" },
      });
      assertStatus(res, 200, res.json);
    },
  },
  {
    name: "PATCH /me: statusMessage with many newlines accepted → 200",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("PATCH", "/me", {
        bearer: login.json.accessToken,
        body: { statusMessage: "\n".repeat(80) },
      });
      assertStatus(res, 200, res.json);
    },
  },
  {
    name: "PATCH /me: avatarAttachmentId not found → 404",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("PATCH", "/me", {
        bearer: login.json.accessToken,
        body: { avatarAttachmentId: `att_no_such_${unique("z")}` },
      });
      assertStatus(res, 404, res.json);
    },
  },
  {
    name: "PATCH /me: explicit nulls for optional profile fields clear them → 200",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("PATCH", "/me", {
        bearer: login.json.accessToken,
        body: {
          displayName: null,
          username: null,
          avatarAttachmentId: null,
          statusMessage: null,
        },
      });
      assertStatus(res, 200, res.json);
    },
  },

  // --- GET /me/devices ---
  {
    name: "GET /me/devices: limit=0 → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("GET", "/me/devices?limit=0", {
        bearer: login.json.accessToken,
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "GET /me/devices: bogus cursor → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("GET", "/me/devices?cursor=not-valid-base64url!!!", {
        bearer: login.json.accessToken,
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "GET /me/devices: limit>100 rejects per integer(1-100) (contract)",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("GET", "/me/devices?limit=101", {
        bearer: login.json.accessToken,
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "GET /me/devices: negative limit → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("GET", "/me/devices?limit=-3", {
        bearer: login.json.accessToken,
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "GET /me/devices: non-numeric limit → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("GET", "/me/devices?limit=NaN", {
        bearer: login.json.accessToken,
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "GET /me/devices: non-integer float limit → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("GET", "/me/devices?limit=3.5", {
        bearer: login.json.accessToken,
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "GET /me/devices: limit non-numeric string → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("GET", "/me/devices?limit=abc", {
        bearer: login.json.accessToken,
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "GET /me/devices: expired-shaped opaque cursor → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const dead = opaqueCursorPayload({
        v: 1,
        exp: 946684800,
        u: primary.userId ?? "x",
      });
      const res = await api(
        "GET",
        `/me/devices?limit=10&cursor=${encodeURIComponent(dead)}`,
        { bearer: login.json.accessToken },
      );
      assert.ok(
        [400, 401].includes(res.status),
        `unexpected ${res.status}`,
      );
    },
  },

  // --- DELETE /me/devices/{deviceId} ---
  {
    name: "DELETE /me/devices/{id}: unknown device → 404",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("DELETE", `/me/devices/${unique("nodevice")}`, {
        bearer: login.json.accessToken,
      });
      assertStatus(res, 404, res.json);
    },
  },
  {
    name: "DELETE /me/devices/{id}: URL-encoded path still routes",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const rawId = `enc ${unique("id")}`;
      const put = await api("PUT", `/me/devices/${encodeURIComponent(rawId)}/push-token`, {
        bearer: login.json.accessToken,
        body: { provider: "fcm", token: "tok" },
      });
      assertStatus(put, 200, put.json);
      const del = await api(
        "DELETE",
        `/me/devices/${encodeURIComponent(rawId)}`,
        { bearer: login.json.accessToken },
      );
      assertStatusIn(del, [204, 404], "delete encoded device");
    },
  },
  {
    name: "DELETE /me/devices/{id}: absurdly long path id rejected or not found",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const big = `long-${"L".repeat(320)}`;
      const res = await api("DELETE", `/me/devices/${big}`, {
        bearer: login.json.accessToken,
      });
      assert.ok([400, 404, 414].includes(res.status), String(res.status));
    },
  },
  {
    name: "DELETE /me/devices/{id}: double revoke is idempotent (204/404)",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const devId = `dbl-${unique("dv")}`;
      const put = await api("PUT", `/me/devices/${devId}/push-token`, {
        bearer: login.json.accessToken,
        body: { provider: "fcm", token: "dbl-" + unique("t") },
      });
      assertStatus(put, 200, put.json);
      const d1 = await api("DELETE", `/me/devices/${devId}`, {
        bearer: login.json.accessToken,
      });
      assertStatus(d1, 204, d1.json);
      const d2 = await api("DELETE", `/me/devices/${devId}`, {
        bearer: login.json.accessToken,
      });
      assertStatusIn(d2, [204, 404], "second session delete");
    },
  },
  {
    name: "DELETE /me/devices/{id}: revoke explicit login deviceId session → 204 then /me 401",
    fn: async () => {
      const devId = `sess-${unique("del")}`;
      const login = await api("POST", "/auth/login", {
        body: {
          identifier: primary.email,
          password: primary.password,
          deviceId: devId,
        },
      });
      assertStatus(login, 200, login.json);
      const del = await api("DELETE", `/me/devices/${encodeURIComponent(devId)}`, {
        bearer: login.json.accessToken,
      });
      assertStatus(del, 204, del.json);
      const me = await api("GET", "/me", {
        bearer: login.json.accessToken,
      });
      assertStatus(me, 401, me.json);
    },
  },

  // --- PUT /me/devices/{deviceId}/push-token ---
  {
    name: "PUT push-token: invalid provider → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("PUT", `/me/devices/${unique("dev")}/push-token`, {
        bearer: login.json.accessToken,
        body: { provider: "unknown", token: "tok" },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "PUT push-token: missing token → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("PUT", `/me/devices/${unique("dev")}/push-token`, {
        bearer: login.json.accessToken,
        body: { provider: "fcm" },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "PUT push-token: happy path → 200",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const devId = `push-${unique("d")}`;
      const res = await api("PUT", `/me/devices/${devId}/push-token`, {
        bearer: login.json.accessToken,
        body: {
          provider: "fcm",
          token: "tok-" + unique("t"),
          appVersion: "1.0.0",
          locale: "en-US",
        },
      });
      assertStatus(res, 200, res.json);
      assert.equal(res.json.deviceId, devId);
    },
  },
  {
    name: "PUT push-token: missing provider → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api(
        "PUT",
        `/me/devices/${unique("np")}/push-token`,
        {
          bearer: login.json.accessToken,
          body: { token: "x" },
        },
      );
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "PUT push-token: token too long → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api(
        "PUT",
        `/me/devices/${unique("tl")}/push-token`,
        {
          bearer: login.json.accessToken,
          body: { provider: "fcm", token: "t".repeat(5000) },
        },
      );
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "PUT push-token: same logical device can replace token",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const devId = `replace-${unique("d")}`;
      const a = await api("PUT", `/me/devices/${devId}/push-token`, {
        bearer: login.json.accessToken,
        body: { provider: "fcm", token: "first-" + unique("t") },
      });
      assertStatus(a, 200, a.json);
      const b = await api("PUT", `/me/devices/${devId}/push-token`, {
        bearer: login.json.accessToken,
        body: { provider: "fcm", token: "second-" + unique("t") },
      });
      assertStatus(b, 200, b.json);
      assert.equal(b.json.pushToken.token.startsWith("second-"), true);
    },
  },
  {
    name: "PUT push-token: empty token string → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api(
        "PUT",
        `/me/devices/${unique("emptyTok")}/push-token`,
        {
          bearer: login.json.accessToken,
          body: { provider: "fcm", token: "" },
        },
      );
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "PUT push-token: switching provider on same device succeeds",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const devId = `provsw-${unique("p")}`;
      const a = await api("PUT", `/me/devices/${devId}/push-token`, {
        bearer: login.json.accessToken,
        body: { provider: "apns", token: "apns-" + unique("t") },
      });
      assertStatus(a, 200, a.json);
      const b = await api("PUT", `/me/devices/${devId}/push-token`, {
        bearer: login.json.accessToken,
        body: { provider: "fcm", token: "fcm-" + unique("t") },
      });
      assertStatus(b, 200, b.json);
      const pkt = b.json.pushToken;
      assert.ok(pkt && typeof pkt === "object");
      if ("provider" in pkt) {
        assert.equal(/** @type {{ provider?: string }} */ (pkt).provider, "fcm");
      }
    },
  },
  {
    name: "PUT push-token: extreme appVersion → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api(
        "PUT",
        `/me/devices/${unique("aver")}/push-token`,
        {
          bearer: login.json.accessToken,
          body: {
            provider: "fcm",
            token: "tok-" + unique("t"),
            appVersion: "v".repeat(400),
          },
        },
      );
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "PUT push-token: malformed locale → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api(
        "PUT",
        `/me/devices/${unique("loc")}/push-token`,
        {
          bearer: login.json.accessToken,
          body: {
            provider: "fcm",
            token: "tok-" + unique("t"),
            locale: "__NOT_A_VALID_LOCALE__",
          },
        },
      );
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "PUT push-token: duplicate token on second device for same user → 200",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const tokVal = `dup-${unique("pt")}`;
      const d1 = `pdup-a-${unique("x")}`;
      const d2 = `pdup-b-${unique("y")}`;
      const p1 = await api("PUT", `/me/devices/${d1}/push-token`, {
        bearer: login.json.accessToken,
        body: { provider: "fcm", token: tokVal },
      });
      assertStatus(p1, 200, p1.json);
      const p2 = await api("PUT", `/me/devices/${d2}/push-token`, {
        bearer: login.json.accessToken,
        body: { provider: "fcm", token: tokVal },
      });
      assertStatus(p2, 200, p2.json);
    },
  },
  {
    name: "PUT push-token: identical repeat PUT is idempotent or safe",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const devId = `idem-${unique("p")}`;
      const body = { provider: "fcm", token: `idem-${unique("t")}` };
      const a = await api("PUT", `/me/devices/${devId}/push-token`, {
        bearer: login.json.accessToken,
        body,
      });
      assertStatus(a, 200, a.json);
      const b = await api("PUT", `/me/devices/${devId}/push-token`, {
        bearer: login.json.accessToken,
        body,
      });
      assertStatus(b, 200, b.json);
    },
  },
  {
    name: "PUT push-token: update after device revoked recreates device → 200",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const devId = `rev-${unique("p")}`;
      const put1 = await api("PUT", `/me/devices/${devId}/push-token`, {
        bearer: login.json.accessToken,
        body: { provider: "fcm", token: `t-${unique("x")}` },
      });
      assertStatus(put1, 200, put1.json);
      const delDev = await api("DELETE", `/me/devices/${devId}`, {
        bearer: login.json.accessToken,
      });
      assertStatus(delDev, 204, delDev.json);
      const put2 = await api("PUT", `/me/devices/${devId}/push-token`, {
        bearer: login.json.accessToken,
        body: { provider: "fcm", token: `t-${unique("y")}` },
      });
      assertStatus(put2, 200, put2.json);
    },
  },

  // --- DELETE /me/devices/{deviceId}/push-token ---
  {
    name: "DELETE push-token: unknown device → 404",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api(
        "DELETE",
        `/me/devices/${unique("nopush")}/push-token`,
        { bearer: login.json.accessToken },
      );
      assertStatus(res, 404, res.json);
    },
  },
  {
    name: "DELETE push-token: idempotent-ish second delete → 404",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const devId = `pdel-${unique("x")}`;
      const put = await api("PUT", `/me/devices/${devId}/push-token`, {
        bearer: login.json.accessToken,
        body: { provider: "apns", token: "abc" },
      });
      assertStatus(put, 200, put.json);
      const d1 = await api("DELETE", `/me/devices/${devId}/push-token`, {
        bearer: login.json.accessToken,
      });
      assertStatus(d1, 204, d1.json);
      const d2 = await api("DELETE", `/me/devices/${devId}/push-token`, {
        bearer: login.json.accessToken,
      });
      assertStatusIn(d2, [204, 404], "second push-token delete idempotent");
    },
  },

  // --- GET /me/blocked-users ---
  {
    name: "GET /me/blocked-users: lists pagination shell → 200",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("GET", "/me/blocked-users", {
        bearer: login.json.accessToken,
      });
      assertStatus(res, 200, res.json);
      assert.ok(Array.isArray(res.json.items));
    },
  },
  {
    name: "GET /me/blocked-users: bogus cursor → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api(
        "GET",
        "/me/blocked-users?cursor=%%%bad%%%cursor%%%",
        { bearer: login.json.accessToken },
      );
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "GET /me/blocked-users: limit>100 rejects per integer(1-100)",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("GET", "/me/blocked-users?limit=900", {
        bearer: login.json.accessToken,
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "GET /me/blocked-users: limit=0 → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("GET", "/me/blocked-users?limit=0", {
        bearer: login.json.accessToken,
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "GET /me/blocked-users: negative limit → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("GET", "/me/blocked-users?limit=-2", {
        bearer: login.json.accessToken,
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "GET /me/blocked-users: expired-shaped opaque cursor → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const dead = opaqueCursorPayload({ kind: "blocks", exp: 1 });
      const res = await api(
        "GET",
        `/me/blocked-users?limit=10&cursor=${encodeURIComponent(dead)}`,
        { bearer: login.json.accessToken },
      );
      assert.ok(
        [400, 401].includes(res.status),
        `unexpected ${res.status}`,
      );
    },
  },
  {
    name: "GET /me/blocked-users: limit non-numeric string → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("GET", "/me/blocked-users?limit=abc", {
        bearer: login.json.accessToken,
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "GET /me/blocked-users: non-integer float limit → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("GET", "/me/blocked-users?limit=2.5", {
        bearer: login.json.accessToken,
      });
      assertStatus(res, 400, res.json);
    },
  },

  // --- POST /me/blocked-users ---
  {
    name: "POST /me/blocked-users: block self → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("POST", "/me/blocked-users", {
        bearer: login.json.accessToken,
        body: { userId: primary.userId },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "POST /me/blocked-users: block other → 200; duplicate upserts",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assert.ok(secondary.userId);

      const b1 = await api("POST", "/me/blocked-users", {
        bearer: login.json.accessToken,
        body: { userId: secondary.userId, reason: "spam" },
      });
      assertStatus(b1, 200, b1.json);
      const b2 = await api("POST", "/me/blocked-users", {
        bearer: login.json.accessToken,
        body: { userId: secondary.userId, reason: "again" },
      });
      assertStatus(b2, 200, b2.json);
      assert.equal(b2.json.reason, "again");
    },
  },
  {
    name: "POST /me/blocked-users: missing userId → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api("POST", "/me/blocked-users", {
        bearer: login.json.accessToken,
        body: { reason: "no user" },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "POST /me/blocked-users: reason extremely long → 400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assert.ok(secondary.userId);
      const res = await api("POST", "/me/blocked-users", {
        bearer: login.json.accessToken,
        body: { userId: secondary.userId, reason: "z".repeat(500) },
      });
      assertStatus(res, 400, res.json);
    },
  },
  {
    name: "POST /me/blocked-users: unknown target userId → 404/400",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("POST", "/me/blocked-users", {
        bearer: login.json.accessToken,
        body: { userId: `usr_unknown_${unique("z")}` },
      });
      assertStatusIn(res, [400, 404], "unknown block target");
    },
  },
  {
    name: "POST /me/blocked-users: empty reason treated as absent → 200",
    fn: async () => {
      assert.ok(secondary?.userId);
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const res = await api("POST", "/me/blocked-users", {
        bearer: login.json.accessToken,
        body: { userId: secondary.userId, reason: "" },
      });
      assertStatus(res, 200, res.json);
    },
  },
  {
    name: "POST /me/blocked-users: mutual block (reverse direction) is defined",
    fn: async () => {
      assert.ok(primary?.userId && secondary?.userId);
      const priLogin = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(priLogin, 200, priLogin.json);
      const secLogin = await api("POST", "/auth/login", {
        body: { identifier: secondary.email, password: secondary.password },
      });
      assertStatus(secLogin, 200, secLogin.json);
      await api("DELETE", `/me/blocked-users/${secondary.userId}`, {
        bearer: priLogin.json.accessToken,
      });
      await api("DELETE", `/me/blocked-users/${primary.userId}`, {
        bearer: secLogin.json.accessToken,
      });
      const bFromPri = await api("POST", "/me/blocked-users", {
        bearer: priLogin.json.accessToken,
        body: { userId: secondary.userId },
      });
      assertStatus(bFromPri, 200, bFromPri.json);
      const bFromSec = await api("POST", "/me/blocked-users", {
        bearer: secLogin.json.accessToken,
        body: { userId: primary.userId },
      });
      assertStatus(bFromSec, 200, bFromSec.json);
    },
  },

  // --- DELETE /me/blocked-users/{userId} ---
  {
    name: "DELETE /me/blocked-users: not blocked → 404",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api(
        "DELETE",
        `/me/blocked-users/${unique("notblocked")}`,
        { bearer: login.json.accessToken },
      );
      assertStatus(res, 404, res.json);
    },
  },
  {
    name: "DELETE /me/blocked-users: unblock → 204",
    fn: async () => {
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      const res = await api(
        "DELETE",
        `/me/blocked-users/${secondary.userId}`,
        { bearer: login.json.accessToken },
      );
      assertStatus(res, 204, res.json);
    },
  },
  {
    name: "DELETE /me/blocked-users/{id}: repeated unblock is safe",
    fn: async () => {
      assert.ok(secondary?.userId);
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      const block = await api("POST", "/me/blocked-users", {
        bearer: login.json.accessToken,
        body: { userId: secondary.userId },
      });
      assertStatus(block, 200, block.json);
      const u1 = await api(
        "DELETE",
        `/me/blocked-users/${secondary.userId}`,
        { bearer: login.json.accessToken },
      );
      assertStatus(u1, 204, u1.json);
      const u2 = await api(
        "DELETE",
        `/me/blocked-users/${secondary.userId}`,
        { bearer: login.json.accessToken },
      );
      assertStatusIn(u2, [204, 404], "second unblock");
    },
  },
  {
    name: "DELETE /me/blocked-users/{userId}: URL-encoded path still routes",
    fn: async () => {
      assert.ok(secondary?.userId);
      const login = await api("POST", "/auth/login", {
        body: { identifier: primary.email, password: primary.password },
      });
      assertStatus(login, 200, login.json);
      await api("POST", "/me/blocked-users", {
        bearer: login.json.accessToken,
        body: { userId: secondary.userId },
      });
      const enc = encodeURIComponent(secondary.userId);
      const del = await api("DELETE", `/me/blocked-users/${enc}`, {
        bearer: login.json.accessToken,
      });
      assert.ok(
        [204, 404].includes(del.status),
        `unexpected ${del.status}`,
      );
    },
  },
];

async function main() {
  console.log(`Auth tests → ${BASE_URL}\n`);

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
