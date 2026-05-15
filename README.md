# Messaging Inbox — Implementation Test

Implement the **auth and current-user HTTP API** described in [`auth-interface.md`](auth-interface.md), the **conversation / inbox HTTP API** described in [`inbox-interface.md`](inbox-interface.md), and the **messaging HTTP + WebSocket API** described in [`messaging-interface.md`](messaging-interface.md). This is a timed exercise: use AI to help you finish the implementation within the time window. Any tech stack is fine.

## What to build

Your server should expose:

- **Auth** — endpoints, request/response shapes, error codes, and behaviors defined in `auth-interface.md` (registration, login, refresh, logout, password reset, email verification, MFA, profile updates, devices/sessions, and blocked users).
- **Inbox** — endpoints, shapes, and behaviors defined in `inbox-interface.md` (listing and creating conversations, per-user state, members, read/delivered cursors, pinned messages, join/leave, and shared metadata for groups/channels).
- **Messaging** — endpoints, shapes, and behaviors defined in `messaging-interface.md` (sending and listing messages, edits and deletes, threads and replies, reactions, stars, mentions, drafts, pins, and real-time fanout over WebSocket at `/ws/messaging`).

Conversation and messaging endpoints require a valid bearer token from the auth API.

## Quick check

With your server running (`http://127.0.0.1:3000`), run the preliminary functional suites:

```bash
node auth-functional-test.mjs
node inbox-functional-test.mjs
node messaging-functional-test.mjs
```

These tests cover core flows; passing them does not guarantee a complete solution. Read the specs for edge cases and concurrency rules. The inbox suite depends on auth (it registers users) and may call cross-spec message endpoints for read/delivered/pinned setup. The messaging suite depends on auth and conversation creation as fixtures and exercises both HTTP and WebSocket behavior from `messaging-interface.md`.

## How you will be evaluated

| Dimension | What we look for |
|-----------|------------------|
| **Functional correctness** | Behavior matches `auth-interface.md`, `inbox-interface.md`, and `messaging-interface.md` (status codes, response shapes, flows, idempotency, token rotation, anti-enumeration, cursor principal binding, 403 vs 404 visibility rules, message lifecycle, WebSocket ordering and subscriptions, etc.). Your implementation should cover **edge cases** and resist **race conditions** |
| **Scalability** | Sensible data model and API design for low latency and high throughput. |
| **Security** | Safe auth practices (token handling, replay protection, input validation, redirect allow-list rules, no leakage of secrets in responses). |
