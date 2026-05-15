# Messaging App — Conversation Interface

## Conventions

- **Auth**: every endpoint below requires `Authorization: Bearer <accessToken>`. Missing or invalid bearer → `401 unauthenticated`.
- **Content type**: request bodies are `application/json`. Malformed JSON → `400 invalid_request`; body present with a non-JSON content type → `415 unsupported_media_type`.
- **List envelope**: every list response is `{ "items": T[], "nextCursor": string | null }`. `nextCursor` is omitted or `null` on the final page. See also **Principal binding** under *List responses* for cursor scoping.
- **Pagination**: opaque `cursor` strings are produced by the server. Clients must not parse them. Invalid, forged, or cross-user cursors → `400 invalid_request` (or `403 forbidden` — see *List responses*).
- **Limits**: `limit` must be a positive integer within the documented range. Non-integers, decimals, zero, negatives, and out-of-range values → `400 invalid_request`.
- **Error body**: errors return `{ "error": { "code": string, "message": string } }`. The token after the HTTP status in *Error responses* (e.g. `"code": "conflict"`) is the **exact** `error.code` string clients should match on. Stable `code` values: `invalid_request`, `unauthenticated`, `forbidden`, `not_found`, `conflict`, `unsupported_media_type`, `rate_limited`. `message` is not stable.
- **Success responses**: mutations that change a resource the client displays return `200` (or `201` on create) with a mandatory JSON body at the root — not wrapped in `{ conversation: ... }`. Destructive actions with no useful body return `204` with an empty body. Each endpoint documents exactly one success status and body shape (or status-only for `204`).

## Startup Interface

Any compliant server implementation MUST satisfy the following startup contract.

### Executable

A script named `start-server` (no extension) at the project root, invocable as `./start-server`.

### Readiness signal

When ready to accept HTTP and WebSocket connections, the server MUST emit exactly one JSON line on **stdout**:

```json
{ "type": "server.listening", "host": "<HOST>", "port": <PORT>, "http": "<BASE_URL>" }
```

`host` and `port` are the bound listener. `http` is the base URL clients and tests use (for loopback binds, use `http://127.0.0.1:<port>`).

### Configuration

`PORT` and `HOST` environment variables MAY override the default bind address (`127.0.0.1:3000`).

### Shutdown

The server MUST handle `SIGTERM` by closing listeners and exiting cleanly.

### Stdout format

All log output MUST be NDJSON (one JSON object per line).

## Inbox and conversations

| Method | Endpoint | Parameters | Description |
|--------|----------|------------|-------------|
| GET | `/conversations` | Query: `type?: direct \| group \| channel`, `archived?: boolean`, `pinned?: boolean`, `unread?: boolean`, `mentions?: boolean`, `limit?: integer(1-100, default 50)`, `cursor?: string` | Lists conversations in the authenticated user's inbox. `unread` and `mentions` are sugar for `unreadCount>0` and `mentionCount>0` respectively. |
| POST | `/conversations` | Body: `type: direct \| group \| channel`, `memberIds: string[]`, `title?: string`, `privacy?: public \| private`, `clientId?: string` | Creates a direct, group, or channel conversation. `memberIds` lists peers to add and must **not** include the caller (the caller is implicitly added). For `type=direct`, `memberIds` must contain exactly one peer; the call is idempotent on `(caller, peer)` and returns the existing conversation with 200 if one already exists, otherwise 201. For `type=group`, `memberIds` must contain **at least one** peer (empty `[]` → `400 invalid_request`). For `type=channel`, `memberIds` may be empty (a channel with only the creating user until others join or discover it). `title` and `clientId` are rejected (`400 invalid_request`) for `direct` (direct conversations have no title and are already idempotent on `(caller, peer)`). `privacy` is only meaningful for `channel`; `direct`/`group` reject `privacy=public` (400). For `group`/`channel`, `clientId` provides client-side idempotency: repeated calls with the same `clientId` from the same user return the original conversation with 200. |
| GET | `/conversations/{conversationId}` | Path: `conversationId: string` | Returns conversation metadata and the authenticated user's membership state. |
| PATCH | `/conversations/{conversationId}` | Path: `conversationId: string`; Body: `title?: string`, `avatarAttachmentId?: string`, `topic?: string`, `privacy?: public \| private` | Updates **shared** conversation-level metadata. Requires owner/admin role for `group`/`channel`. For `direct`, all fields are rejected (`400 invalid_request`) — direct conversations have no shared metadata. For `group`/`direct`, supplying `privacy` (whether `public` or `private`) is rejected (`400 invalid_request`) — only `channel` may change `privacy`. Not used for per-user toggles — see `/state`. **Success:** `200` with a **Conversation** body (same shape as `GET /conversations/{id}`). |
| PATCH | `/conversations/{conversationId}/state` | Path: `conversationId: string`; Body: `muted?: boolean`, `mutedUntil?: iso-datetime`, `archived?: boolean`, `pinned?: boolean` | Updates the authenticated user's per-conversation toggles. Available to any member. `muted: true` mutes indefinitely when `mutedUntil` is omitted; with `mutedUntil: <future-iso>` it is timeboxed. `muted: false` unmutes and clears `mutedUntil`. `mutedUntil` without `muted: true` → `400 invalid_request`. When `muted: true`, a non-null `mutedUntil` must be in the future. **Success:** `200` with a **Conversation** body. |
| POST | `/conversations/{conversationId}/join` | Path: `conversationId: string`; Body: `source?: browse \| search \| invite_link` | Joins the authenticated user to a public channel. Non-members receive `404 not_found` for conversations they cannot see (`private` channels, `direct`, `group`, and channels no longer `public`); see **Error responses** below. **Success:** `201` with a **Conversation** body on first join; `200` with a **Conversation** body on idempotent re-join (caller already a member). |
| DELETE | `/conversations/{conversationId}` | Path: `conversationId: string`; Query: `deleteFor?: self \| everyone` (default `self`) | `self`: removes the caller's membership / hides for caller. For `group`/`channel`, the **last owner** leaving via `deleteFor=self` is allowed only if the server defines succession (e.g. auto-promote another admin) or orphan policy; otherwise reject with `400 invalid_request` or `409 conflict`. `everyone`: hard-deletes for all members; requires owner role for `group`/`channel`, or either participant for `direct`. |
| GET | `/conversations/{conversationId}/members` | Path: `conversationId: string`; Query: `role?: owner \| admin \| member`, `limit?: integer(1-100, default 50)`, `cursor?: string` | Lists members of a conversation. |
| POST | `/conversations/{conversationId}/members` | Path: `conversationId: string`; Body: `userIds: string[]`, `role?: admin \| member` (default `member`) | Adds users to a conversation. The supplied `role` applies to every user in `userIds`. Requires admin/owner role for `group`/`channel`. Rejected (400) for `type=direct` (direct conversations have a fixed pair). Users in `userIds` who are **already members** are silently skipped (their existing `role` is preserved — this endpoint never demotes or promotes); the call still succeeds as long as at least one input is valid. An entirely no-op call (every id is already a member) still returns success. **Success:** `201` when at least one user was newly added; `200` when every `userId` was already a member. Body: `{ items: Member[], nextCursor: null }` (same row shape as `GET .../members`). |
| PATCH | `/conversations/{conversationId}/members/{userId}` | Path: `conversationId: string`, `userId: string`; Body: `role?: owner \| admin \| member` | Updates a member's role. Requires owner role to grant `owner`; admin/owner otherwise. Demoting or changing the **sole** `owner` when no other `owner` would remain is rejected (`400 invalid_request` or `409 conflict`) — transfer ownership first. **Success:** `200` with a **Member** body. |
| DELETE | `/conversations/{conversationId}/members/{userId}` | Path: `conversationId: string`, `userId: string` | Removes a member. Admin/owner can remove others; any member may remove themselves (equivalent to `DELETE /conversations/{id}?deleteFor=self`). The **sole owner** cannot be removed (including self-delete) if no other `owner` would remain — reject with `400 invalid_request` (or `409 conflict` if the server frames it as an invariant violation). Admins must transfer ownership (via `PATCH .../members/{userId}` with `role: owner`) before removing or demoting the last owner. **Success:** `204` with an empty body. |
| PATCH | `/conversations/{conversationId}/read` | Path: `conversationId: string`; Body: `messageId?: string`, `readAt?: iso-datetime` | Marks messages through a point in the conversation as read. At least one of `messageId` or `readAt` must be supplied (400 otherwise). When only `readAt` is given, all messages with `createdAt <= readAt` are marked read. When only `messageId` is given, `readAt` defaults to that message's `createdAt`. The caller's own messages do not contribute to `unreadCount` and are implicitly considered read. |
| PATCH | `/conversations/{conversationId}/delivered` | Path: `conversationId: string`; Body: `messageId: string`, `deliveredAt?: iso-datetime` | Records delivery through a specific message. `deliveredAt` defaults to server-now when omitted. |
| GET | `/conversations/{conversationId}/pinned-messages` | Path: `conversationId: string`; Query: `limit?: integer(1-100, default 50)`, `cursor?: string` | Lists messages pinned in a conversation. Pinning itself is performed via the messages API (`POST /messages/{messageId}/pin`), documented separately. Row shape: see **Pinned message row** below (extends the shared **Message** model in `messaging-interface.md` → *Shared Types* → `Message`). |

#### Conversation shape

Single-resource endpoints (`POST /conversations`, `GET /conversations/{conversationId}`, `PATCH /conversations/{conversationId}`, `PATCH /conversations/{conversationId}/state`, and `POST /conversations/{conversationId}/join`) return the **Conversation** object at the JSON root, not wrapped in `{ conversation: ... }`.

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Stable conversation identifier. |
| `type` | `direct \| group \| channel` | |
| `title` | string \| null | Always null for `direct`. |
| `topic` | string \| null | Channel/group topic. |
| `privacy` | `public \| private` | `public` only meaningful for `channel`; `direct`/`group` are always `private`. |
| `avatarAttachmentId` | string \| null | Attachment id from the attachments API (separate spec). |
| `memberIds` | string[] | Up to 50 ids for large conversations; use `GET /conversations/{id}/members` to page through the full list when `memberPreviewTruncated` is true. Always includes the caller when the caller is a member. |
| `memberPreviewTruncated` | boolean | True when `memberIds` is a truncated preview rather than the full set. |
| `unreadCount` | integer ≥ 0 | Messages after the caller's read cursor. |
| `mentionCount` | integer ≥ 0 | Mentions of the caller after their read cursor. |
| `muted` | boolean | Effective mute state for the caller. `false` when unmuted or when a timeboxed mute has expired. |
| `mutedUntil` | iso-datetime \| null | Future deadline for a timeboxed mute; `null` for indefinite mute or unmuted. Reads return effective state only (expired timeboxes appear as `muted: false`, `mutedUntil: null`). |
| `archived` | boolean | Caller's per-conversation archive toggle. |
| `pinned` | boolean | Caller's per-conversation pin toggle. |
| `createdAt` | iso-datetime | |
| `updatedAt` | iso-datetime | Bumped on metadata change or new message. |

#### Member shape

Each object in `GET /conversations/{id}/members`, in `POST /conversations/{id}/members` list responses, and in `PATCH /conversations/{id}/members/{userId}` responses uses:

| Field | Type | Notes |
|-------|------|-------|
| `userId` | string | The member’s user id. Required on every member row. |
| `role` | `owner \| admin \| member` | Effective role in this conversation. |
| `joinedAt` | iso-datetime | When this user became a member. |

Member rows contain exactly `userId`, `role`, and `joinedAt`. Servers must not emit `id` or other aliases for the member’s user id.

#### Pinned message row

Each object in `GET /conversations/{id}/pinned-messages` is a **Message** in the sense of `messaging-interface.md` (*Shared Types* → `Message`): at minimum `id`, `conversationId`, `senderId`, `attachments`, `reactions`, `status`, `createdAt`, plus optional `body`, `replyToMessageId`, `editedAt`, `deletedAt`, etc., as defined there and for `GET /conversations/{id}/messages`.

Pinning adds conversation-local metadata on the same object:

| Field | Type | Notes |
|-------|------|-------|
| `pinnedAt` | iso-datetime | When the message was pinned (server clock). |
| `pinnedByUserId` | string | `userId` of the member who created the pin. |

Order of `items` is **newest pin first** unless a product-specific spec says otherwise; cursors remain opaque either way.

#### List responses

All list endpoints (`/conversations`, `/conversations/{id}/members`, `/conversations/{id}/pinned-messages`) return `{ items: T[], nextCursor: string \| null }`. For `GET /conversations`, each item is a **Conversation** object at the item root, not wrapped in `{ conversation: ... }`. Cursors are opaque.

**Principal binding:** each `nextCursor` is issued for exactly one authenticated subject. Reusing that cursor in a subsequent request authenticated **as a different user** (a different bearer identity than the response that contained the cursor) must fail with HTTP **`400`** or **`403`**—the server must not return **`200`** with another principal’s page stream. Forged, truncated, or otherwise invalid cursors must likewise be rejected with **`400`** or **`403`**.

#### Error responses

All non-2xx responses return `{ error: { code: string, message: string } }`. In the list below, the token after the HTTP status is the **exact** `error.code` string clients should match on (e.g. `"code": "conflict"`), not only a human label.

- `401 unauthenticated` — missing/invalid bearer.
- `403 forbidden` — caller lacks the required role or membership.
- `404 not_found` — conversation/member/message doesn't exist or isn't visible to caller.
- `400 invalid_request` — malformed body or query.
- `409 conflict` — `clientId` reused by the same user with a payload that doesn't match the original `POST /conversations` request; also used by some servers for membership/owner invariants (see member removal above). In all cases `error.code` is the literal string **`conflict`**.
- `415 unsupported_media_type` — body present with a non-JSON content type.

Between `403` and `404`: when the caller is not a member of a non-public conversation, the server returns `404` (existence is hidden from non-members). `403` is reserved for cases where the caller can see the conversation but lacks the required role for the action.

For this rule, **non-public** means any conversation that is not a `channel` with `privacy: public` — i.e. all `direct` conversations, all `group` conversations, and `channel` conversations with `privacy: private`. Only public channels expose existence to non-members (so a non-member GET on a public channel returns `200`; on anything else it returns `404`).
