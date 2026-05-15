# Messaging App — Messaging Interface

## Conventions

- **Auth**: every HTTP endpoint and WebSocket connection below requires an authenticated user. HTTP uses `Authorization: Bearer <accessToken>`; WebSocket uses the same bearer token during the opening handshake. Missing or invalid auth → `401 unauthenticated` over HTTP, or a WebSocket `error` followed by close code `4401`.
- **Content type**: HTTP request bodies are `application/json`. Malformed JSON → `400 invalid_request`; body present with a non-JSON content type → `415 unsupported_media_type`.
- **List envelope**: every list response is `{ "items": T[], "nextCursor": string | null }`. `nextCursor` is omitted or `null` on the final page.
- **Pagination**: `cursor`, `before`, and `after` tokens are opaque. Clients must not parse them. Invalid, expired, forged, or cross-user cursors → `400 invalid_request`.
- **Limits**: `limit` must be an integer within the documented range. Missing `limit` defaults to `50` unless otherwise specified. Zero, negatives, decimals, and out-of-range values → `400 invalid_request`.
- **Query string**: when an optional query parameter is omitted, its default behavior applies. Supplying an empty string for a typed parameter (`?conversationId=`, `?cursor=`, `?before=`, `?after=`, `?from=`, `?to=`) → `400 invalid_request`.
- **Timestamps**: all timestamps are ISO-8601 datetimes with timezone. Server-created resource timestamps use the server clock. Client-supplied timestamps are accepted only where documented and may not move durable server-created timestamps.
- **Error body**: HTTP errors return `{ "error": { "code": string, "message": string } }`. `code` is stable for clients; `message` is not.
- **Rate limiting**: HTTP `429 rate_limited` responses include `Retry-After` in seconds. Servers may also include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` when those values are safe to expose.

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

## Shared Types

### Message

Single-message endpoints return the `Message` object at the JSON root. Timeline, replies, starred, mention, and thread responses embed this same shape unless their row type adds metadata.

```ts
type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  clientId?: string;                 // Sender's message idempotency key, visible to that sender.
  body: string | null;                // Trimmed. Null for attachment-only (status="sent") or tombstones (status="deleted"); disambiguate via status.
  attachments: AttachmentRef[];
  replyToMessageId: string | null;    // Root message for threaded replies. Null for root timeline messages.
  thread: ThreadSummary | null;       // Present on root messages with replies; null otherwise.
  mentions: MentionTarget[];
  reactions: Reaction[];
  status: "sent" | "deleted";
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  deletedByUserId: string | null;
  deleteForEveryone: boolean;
};
```

`body` is trimmed before storage. A send/update request must contain at least one non-empty `body` after trimming or at least one `attachmentId`; otherwise → `400 invalid_request`. `body` length is `1-4000` characters after trimming when present. `attachmentIds` may contain `0-20` ids, must be unique, and every attachment must be visible to the sender and either unattached or attachable to the target conversation; otherwise → `400`, `403`, or `404` as appropriate.

Durable server messages use only `status: "sent"` or `status: "deleted"`. Transient states such as `"sending"` and `"failed"` are client-local optimistic UI states and are not emitted by this interface. Because both attachment-only and deleted messages have `body: null`, consumers must use `status === "deleted"` and `deletedAt` to distinguish tombstones from valid attachment-only messages.

### AttachmentRef

```ts
type AttachmentRef = {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  url?: string;                       // Present when the caller may download the file.
};
```

### MentionTarget

```ts
type MentionTarget = {
  userId: string;
  displayText?: string;
};
```

### Reaction

```ts
type Reaction = {
  emoji: string;
  skinTone: string | null;
  userId: string;
  createdAt: string;
};
```

`emoji` is one Unicode emoji grapheme or a server-supported custom emoji token. A user may have at most one reaction for a given `(messageId, emoji, skinTone)` tuple. Re-adding the same reaction is idempotent and returns the current reaction. Adding a different `skinTone` for the same `emoji` replaces that user's prior reaction for that `emoji`.

### ThreadSummary

```ts
type ThreadSummary = {
  rootMessageId: string;
  replyCount: number;
  lastReplyId: string | null;
  lastReplyAt: string | null;
  participantIds: string[];
  unreadCount: number;                // Relative to the authenticated user's thread read cursor.
};
```

Threads are one level deep. `replyToMessageId` must identify a visible root message. If a client replies to an existing reply, the server stores the new message under that reply's root message, not as a nested thread.

### Draft

```ts
type Draft = {
  conversationId: string;
  body: string | null;
  attachmentIds: string[];
  replyToMessageId: string | null;
  updatedAt: string;
};
```

There is one draft per authenticated user per conversation. A new `PUT /drafts/{conversationId}` replaces the prior draft for that conversation.

### StarredMessage

```ts
type StarredMessage = Message & {
  starredAt: string;
  starNote: string | null;
};
```

### PinnedMessage

```ts
type PinnedMessage = Message & {
  pinnedAt: string;
  pinnedByUserId: string;
};
```

### Mention

```ts
type Mention = {
  message: Message;
  conversationId: string;
  mentionType: "direct" | "group";
  createdAt: string;
  read: boolean;
};
```

#### Messages, threads, reactions, organization

| Method | Endpoint | Parameters | Description |
|--------|----------|------------|-------------|
| GET | `/conversations/{conversationId}/messages` | Path: `conversationId: string`; Query: `before?: message-id`, `after?: message-id`, `cursor?: string`, `limit?: integer(1-100, default 50)`, `includeDeleted?: boolean` | Loads root timeline messages visible to the caller, newest first by default. `before`, `after`, and `cursor` are mutually exclusive. `before`/`after` are exclusive message anchors; `cursor` continues a prior server page. Replies are excluded except through their root's `thread` summary. Returns `{ items: Message[], nextCursor }`. |
| POST | `/conversations/{conversationId}/messages` | Path: `conversationId: string`; Body: `clientId: string`, `body?: string`, `attachmentIds?: string[]`, `replyToMessageId?: string`, `mentions?: string[]` | Sends a new message. `clientId` is required and idempotent per `(sender, conversationId)`. `replyToMessageId` creates or extends a one-level thread rooted at that message. Returns `201` with the created `Message`, or `200` with the original `Message` for an idempotent duplicate. |
| GET | `/messages/{messageId}` | Path: `messageId: string` | Returns a visible `Message` at the JSON root. Unknown or not visible → `404 not_found`. |
| PATCH | `/messages/{messageId}` | Path: `messageId: string`; Body: `body?: string`, `attachmentIds?: string[]` | Edits an existing non-deleted message owned by the authenticated user. At least one editable field is required. Returns `200` with the updated `Message`. |
| DELETE | `/messages/{messageId}` | Path: `messageId: string`; Body: `deleteFor?: self \| everyone` (default `everyone`), `reason?: string(0-500)` | `everyone` soft-deletes a caller-owned message for all visible participants. Admin/owner deletion of another user's message is allowed only when the conversation policy permits it. `self` hides the message only for the caller. Returns `204` with no body. |
| GET | `/messages/{messageId}/replies` | Path: `messageId: string`; Query: `limit?: integer(1-100, default 50)`, `cursor?: string` | Lists threaded replies to the root message, oldest first within the thread. If `messageId` is itself a reply, the server lists replies for that reply's root. Returns `{ items: Message[], nextCursor }`. |
| POST | `/messages/{messageId}/replies` | Path: `messageId: string`; Body: `clientId: string`, `body?: string`, `attachmentIds?: string[]`, `mentions?: string[]` | Sends a threaded reply. Equivalent to `POST /conversations/{conversationId}/messages` with `replyToMessageId = messageId`, except the conversation is inferred from the root. Returns `201` with the created `Message`, or `200` for an idempotent duplicate. |
| POST | `/messages/{messageId}/pin` | Path: `messageId: string` | Pins a visible message in its conversation. Requires admin/owner for `group`/`channel`; either participant may pin in `direct`. Re-pinning an already pinned message is idempotent. Returns `201` with `PinnedMessage` when a pin is created, or `200` with `PinnedMessage` when the pin already existed. |
| DELETE | `/messages/{messageId}/pin` | Path: `messageId: string` | Same permission requirement as pin. Returns `200` with `PinnedMessage` (the removed pin row) when a pin was present, or `204` when the message was not pinned (idempotent). |
| POST | `/messages/{messageId}/star` | Path: `messageId: string`; Body: `note?: string(0-500)` | Stars/saves a visible message for the authenticated user. `note` is trimmed; whitespace-only becomes `null`. Re-star is idempotent and replaces `note` when supplied. Returns `201` with `StarredMessage` when a star is created, or `200` with `StarredMessage` when an existing star is updated or confirmed. |
| DELETE | `/messages/{messageId}/star` | Path: `messageId: string` | Removes a message from the authenticated user's starred list. Removing a missing star is idempotent and returns `204`. |
| GET | `/starred-messages` | Query: `conversationId?: string`, `limit?: integer(1-100, default 50)`, `cursor?: string` | Lists messages starred by the authenticated user, newest star first. Returns `{ items: StarredMessage[], nextCursor }`. |
| GET | `/mentions` | Query: `conversationId?: string`, `unreadOnly?: boolean`, `from?: iso-date`, `to?: iso-date`, `limit?: integer(1-100, default 50)`, `cursor?: string` | Lists messages that mention the authenticated user, newest mention first. `from` and `to` filter by message creation date inclusively. Returns `{ items: Mention[], nextCursor }`. |
| GET | `/threads` | Query: `conversationId?: string`, `unreadOnly?: boolean`, `participating?: boolean`, `limit?: integer(1-100, default 50)`, `cursor?: string` | Lists visible thread roots with `thread` summary metadata, newest thread activity first. `participating=true` returns threads where the caller sent the root or any reply. Returns `{ items: Message[], nextCursor }`. |
| PATCH | `/threads/{rootMessageId}/read` | Path: `rootMessageId: string`; Body: `messageId?: string`, `readAt?: iso-datetime` | Marks a thread as read through a specific reply or timestamp for the authenticated user. At least one of `messageId` or `readAt` is required. Returns `204` with no body. |
| GET | `/drafts` | Query: `conversationId?: string`, `limit?: integer(1-100, default 50)`, `cursor?: string` | Lists saved message drafts for the authenticated user, newest update first. Returns `{ items: Draft[], nextCursor }`. |
| PUT | `/drafts/{conversationId}` | Path: `conversationId: string`; Body: `body?: string`, `attachmentIds?: string[]`, `replyToMessageId?: string \| null`, `updatedAt?: iso-datetime` | Creates or replaces the authenticated user's draft for a visible conversation. Empty body plus empty attachments deletes any existing draft and returns `204`. Otherwise returns `200` with `Draft`. |
| DELETE | `/drafts/{conversationId}` | Path: `conversationId: string` | Deletes the authenticated user's draft for a conversation. Missing draft is idempotent and returns `204`. |
| POST | `/messages/{messageId}/reactions` | Path: `messageId: string`; Body: `emoji: string`, `skinTone?: string \| null` | Adds or replaces the authenticated user's reaction to a visible message. Returns `200` with `Reaction`. |
| DELETE | `/messages/{messageId}/reactions/{emoji}` | Path: `messageId: string`, `emoji: url-encoded-string`; Query: `skinTone?: string` | Removes the authenticated user's reaction from a visible message. Missing reaction is idempotent and returns `204`. |

Listing a conversation's pinned messages is performed via `GET /conversations/{conversationId}/pinned-messages` in `inbox-interface.md` (the row shape there extends the `Message` model defined above).

## HTTP Semantics

### Visibility and Permissions

- Callers must be members of a `direct` or `group` conversation to read or mutate its messages. Non-members receive `404 not_found` so private conversation existence is not leaked.
- Public channels may expose conversation metadata to non-members, but message reads and all message mutations require membership unless a product-specific policy explicitly allows read-only public history.
- Message authors may edit and delete their own non-deleted messages. Conversation owners/admins may pin messages and may delete other users' messages only when the server enables moderation for that conversation type.
- Deleted messages remain addressable only when they are still needed to preserve timeline/thread structure. Their `body` is `null`, `attachments` is empty, `status` is `"deleted"`, and `deletedAt` is present. `includeDeleted=false` hides tombstones except when omitting them would break pagination anchors.

### Message Lifecycle

- Sending a root message inserts it into the conversation timeline and updates the conversation's last activity.
- Sending a reply inserts it into the root thread, updates the root `thread` summary, and does not appear as a root item in `GET /conversations/{conversationId}/messages`.
- Editing changes only `body` and/or `attachments`. It does not alter `createdAt`, `senderId`, `conversationId`, `replyToMessageId`, reactions, mentions, or thread membership. Successful edit sets `editedAt` to server-now.
- A message cannot be edited after it is deleted. Attempts return `409 conflict`.
- `mentions` must contain unique user ids. Unknown users → `404 not_found`; users not visible in the conversation → `400 invalid_request` or `403 forbidden`. When `mentions` is present, it is the authoritative set for this interface. The server may derive mentions from `body` only when `mentions` is absent.

### Idempotency and Concurrency

- `clientId` is required for message creation over HTTP and WebSocket. For the same `(senderId, conversationId, clientId)`, an exact duplicate returns the original message. Reusing the same `clientId` with a materially different payload → `409 conflict`.
- Concurrent reaction writes by the same user to the same `(messageId, emoji)` resolve last-write-wins by server commit order.
- Read and delivered cursors are monotonic per user. Requests that move a cursor backwards are accepted as no-ops and must not reduce read/delivered state.
- Pin, star, unpin, unstar, draft delete, and reaction delete operations are idempotent where documented above.

### Read and Delivery Cursors

- Conversation read state is maintained by `/conversations/{conversationId}/read` in the inbox/conversation interface and by WebSocket `conversation.read`.
- Thread read state is separate from the conversation root timeline read cursor. `PATCH /threads/{rootMessageId}/read` and WebSocket `thread.read` update only the thread cursor.
- The caller's own messages never increase that caller's unread counts and are considered read/delivered for that caller when created.

### HTTP Error Responses

All non-2xx responses return `{ "error": { "code": string, "message": string } }`.

- `400 invalid_request` — malformed JSON, invalid query/body shape, empty required value, invalid enum, invalid timestamp, out-of-range `limit`, both `before` and `after`, empty message content, or invalid attachment/mention set.
- `401 unauthenticated` — missing or invalid bearer.
- `403 forbidden` — caller is authenticated and can see the resource but lacks permission for the action.
- `404 not_found` — target conversation/message/user/attachment does not exist or is not visible to caller.
- `409 conflict` — idempotency key reused with a different payload, editing/deleting a deleted message, or a state invariant conflict.
- `415 unsupported_media_type` — body present with non-JSON content type.
- `429 rate_limited` — request is valid but exceeds server rate limits.

## WebSocket

Use WebSocket for low-latency fanout, ephemeral activity, receipts, and the latency-sensitive message write path for messages, threads, reactions, and message organization.

### Connection

- **URL**: `GET /ws/messaging` upgraded to WebSocket.
- **Auth**: pass the bearer token using `Authorization: Bearer <accessToken>` during the opening handshake. Browser clients that cannot set headers may use a server-approved subprotocol or short-lived WebSocket ticket, but the authenticated subject is the same user as the HTTP bearer.
- **Encoding**: every frame is a single UTF-8 JSON object. Binary frames are rejected with an `error` event and close code `1003`.
- **Heartbeat**: the server may send protocol-level ping frames. Clients should respond with pong according to the WebSocket protocol. If no frame is received for 60 seconds, clients should reconnect.
- **Close codes**: `4401` unauthenticated, `4403` forbidden, `4409` session conflict or replaced connection, `1011` server error. Clients should use HTTP fetches after reconnect when they receive `sync.required`.
- **Subscriptions**: a connection starts with no conversation subscriptions. User-scoped events such as starred messages, mentions, and direct command acks may be delivered without a conversation subscription. Conversation-scoped fanout requires `conversation.subscribe`.

### Connection and Envelope

Every frame is JSON and uses a versioned envelope so new features can be added without changing the transport contract.

```ts
type MessagingClientCommandType =
  | "conversation.subscribe"
  | "conversation.unsubscribe"
  | "conversation.read"
  | "conversation.delivered"
  | "message.send"
  | "message.update"
  | "message.delete"
  | "message.reply"
  | "message.react"
  | "message.unreact"
  | "thread.read"
  | "typing.start"
  | "typing.stop";

type MessagingServerEventType =
  | "ack"
  | "error"
  | "sync.required"
  | "conversation.subscribed"
  | "conversation.unsubscribed"
  | "message.created"
  | "message.updated"
  | "message.deleted"
  | "message.reply_created"
  | "message.reaction_added"
  | "message.reaction_removed"
  | "message.pinned"
  | "message.unpinned"
  | "message.starred"
  | "message.unstarred"
  | "conversation.receipt_delivered"
  | "conversation.receipt_read"
  | "typing.started"
  | "typing.stopped"
  | "mention.created";

type ClientCommand<T = unknown> = {
  v: 1;
  id: string;                 // Client-generated idempotency key for a command.
  type: MessagingClientCommandType;
  sentAt: string;             // iso-datetime from the client clock.
  traceId?: string;
  conversationId?: string;    // Required for conversation-scoped commands.
  payload: T;
};

type ServerEvent<T = unknown> = {
  v: 1;
  id: string;                 // Server-generated event id.
  type: MessagingServerEventType;
  emittedAt: string;          // iso-datetime from the server clock.
  sequence: number;           // Monotonic within sequenceScope + sequenceKey (see Ordering and Resume).
  sequenceScope: "conversation" | "user" | "connection";
  sequenceKey: string;        // e.g. conversation:<conversationId>, user:<userId>, or connection.
  scope: "user" | "conversation" | "system";
  conversationId?: string;
  actorId?: string;
  payload: T;
};
```

Commands receive either an `ack` or `error` event with `ackId` matching the command `id`. Events that mutate durable state include enough data for optimistic UI reconciliation and cache updates.

`ClientCommand.id` is an idempotency key for the command envelope. For message creation, `payload.clientId` is also required and is the idempotency key for the durable message. Retrying the same command after reconnect should reuse both ids when the client does not know whether the first attempt succeeded.

```ts
type AckPayload = {
  ackId: string;
  status: "accepted" | "applied" | "duplicate";
  serverId?: string;
  sequence?: number;
};

type ErrorPayload = {
  ackId?: string;
  code: "bad_request" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "rate_limited" | "server_error";
  message: string;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
};

type SyncRequiredPayload = {
  reason?: "sequence_gap" | "server_restart" | "permissions_changed" | "unknown";
  // If provided, the client can resume from this sequence on the user resource after refetching state.
  nextSequence?: number;
};
```

### Ordering and Resume

- Durable events carry `sequenceScope` and `sequenceKey` so clients know which monotonic counter `sequence` belongs to. All sockets receiving the same logical durable event for a resource share the same `sequence`, `sequenceScope`, and `sequenceKey`.
- **Conversation resource** (`sequenceScope: "conversation"`, `sequenceKey: "conversation:<conversationId>"`): message lifecycle, reactions, pins, read/delivery receipts, and other conversation-scoped durable fanout. Clients track the last processed `sequence` per conversation independently.
- **User resource** (`sequenceScope: "user"`, `sequenceKey: "user:<userId>"`): stars, mentions, `sync.required`, and other user-scoped durable events for the authenticated user. Clients track the last processed `sequence` per user resource independently.
- **Connection resource** (`sequenceScope: "connection"`, `sequenceKey: "connection"`): `ack`, `error`, subscribe/unsubscribe confirmations, and typing. These are per-socket and not used for cross-device reconciliation; clients must not treat connection `sequence` gaps as durable state gaps.
- Within each `(sequenceScope, sequenceKey)` pair, `sequence` increases by one for every event in that resource stream. Clients must process events in sequence order for each resource they track.
- If the client observes a gap in a durable resource stream, it must stop applying later events for that resource, refetch affected state over HTTP, and wait for or request a fresh stream. The server may proactively emit `sync.required` on the user resource.
- A reconnect does not implicitly replay missed durable events. After reconnect, clients should refetch conversations, messages, threads, reactions, and receipts touched since the last known good sequence for each affected resource. If the server supports replay, it may accept resource-specific resume parameters and either replay from that point or emit `sync.required`.
- Duplicate server events with the same `id` must be ignored by clients after the first application.
- Duplicate client commands with the same `id` return an `ack` with `status: "duplicate"` when the original command was accepted/applied, or an `error` if the duplicate conflicts with the original payload.

### Client -> Server

WebSocket commands are restricted to ephemeral/realtime concerns and the latency-sensitive message write path. Durable-state mutators such as message pin/star are performed over HTTP; clients observe the resulting state via server-pushed events on this socket.

```text
conversation.subscribe
conversation.unsubscribe
conversation.read
conversation.delivered
message.send
message.update
message.delete
message.reply
message.react
message.unreact
thread.read
typing.start
typing.stop
```

**Command payloads**

```ts
type ConversationSubscribePayload = {
  conversationId: string;
  includeRecentMessages?: boolean;
};

type ConversationUnsubscribePayload = {
  conversationId: string;
};

type MessageSendPayload = {
  clientId: string;             // Client-generated idempotency key for the message.
  body?: string;
  attachmentIds?: string[];
  replyToMessageId?: string;    // Set to make this a threaded reply rooted at the referenced message.
  mentions?: string[];
  metadata?: Record<string, unknown>;
};

type MessageUpdatePayload = {
  messageId: string;
  body?: string;
  attachmentIds?: string[];
};

type MessageDeletePayload = {
  messageId: string;
  deleteFor?: "self" | "everyone";
  reason?: string;
};

type MessageReplyPayload = {
  replyToMessageId: string;     // Root message of the thread this reply belongs to.
  clientId: string;
  body?: string;
  attachmentIds?: string[];
  mentions?: string[];
};

type MessageReactionPayload = {
  messageId: string;
  emoji: string;
  skinTone?: string | null;
};

type ReceiptPayload = {
  conversationId: string;
  messageId: string;
  at?: string;                    // Client-observed time; server commit time is authoritative for ordering.
};

type ThreadReadPayload = {
  replyToMessageId: string;     // Root message of the thread being marked read.
  messageId?: string;
  at?: string;
};

type TypingPayload = {
  conversationId: string;
  replyToMessageId?: string;    // Set when typing inside a thread; identifies the thread root.
};

type MessagingClientCommandPayloadByType = {
  "conversation.subscribe": ConversationSubscribePayload;
  "conversation.unsubscribe": ConversationUnsubscribePayload;
  "conversation.read": ReceiptPayload;
  "conversation.delivered": ReceiptPayload;

  "message.send": MessageSendPayload;
  "message.update": MessageUpdatePayload;
  "message.delete": MessageDeletePayload;
  "message.reply": MessageReplyPayload;
  "message.react": MessageReactionPayload;
  "message.unreact": MessageReactionPayload;

  "thread.read": ThreadReadPayload;
  "typing.start": TypingPayload;
  "typing.stop": TypingPayload;
};
```

### Command Semantics

- `conversation.subscribe` requires that the caller can read the conversation. On success the server emits `conversation.subscribed`. If `includeRecentMessages=true`, the server may follow with recent `message.created`/`message.reply_created` events, but clients must still use HTTP for authoritative pagination.
- `conversation.unsubscribe` stops future conversation-scoped fanout on that socket. It does not affect user-scoped events or other devices.
- `conversation.read` and `conversation.delivered` update monotonic per-user cursors through `messageId`. `at` is advisory; server commit order determines final state.
- `message.send`, `message.reply`, `message.update`, `message.delete`, `message.react`, and `message.unreact` use the same validation, permissions, idempotency, and lifecycle rules as their HTTP equivalents.
- `thread.read` updates only the caller's thread read cursor for the root identified by `replyToMessageId`.
- `typing.start` and `typing.stop` are ephemeral. They are never persisted and never require HTTP reconciliation. The server should expire typing state automatically within 10 seconds even if `typing.stop` is not received. `TypingEventPayload.expiresAt` is server-set and authoritative; clients should trust it, and the server must clamp it to no more than 10 seconds after the event's `emittedAt`.

### Server -> Client

```text
ack
error
sync.required
conversation.subscribed
conversation.unsubscribed
message.created
message.updated
message.deleted
message.reply_created
message.reaction_added
message.reaction_removed
message.pinned
message.unpinned
message.starred
message.unstarred
conversation.receipt_delivered
conversation.receipt_read
typing.started
typing.stopped
mention.created
```

**Event payloads**

```ts
type ConversationSubscriptionPayload = {
  conversationId: string;
  subscribedAt: string;
};

type MessageEventPayload = {
  clientId?: string;            // Echoes the sender's idempotency key for optimistic UI reconciliation.
  message: Message;
};

type MessageDeletedPayload = {
  messageId: string;
  conversationId: string;
  deletedAt: string;
  deletedByUserId: string;
  deleteForEveryone: boolean;
};

type ReactionEventPayload = {
  messageId: string;
  conversationId: string;
  userId: string;
  reaction: Reaction;
};

type ConversationReceiptEventPayload = {
  conversationId: string;
  userId: string;
  deliveredMessageId?: string;
  readMessageId?: string;
  at: string;
};

type TypingEventPayload = {
  conversationId: string;
  userId: string;
  replyToMessageId?: string;    // Set when typing inside a thread; identifies the thread root.
  expiresAt: string;
};

type MentionEventPayload = {
  message: Message;
  conversationId: string;
  mentionType: "direct" | "group";
};

type MessagePinnedEventPayload = {
  message: Message;
  pinnedAt: string;
  pinnedByUserId: string;
};

type MessageUnpinnedEventPayload = {
  message: Message;
  unpinnedAt: string;
  unpinnedByUserId: string;
};

type MessageStarEventPayload = {
  message: Message;
  starredAt?: string;
  starNote?: string | null;
};

type MessagingServerEventPayloadByType = {
  ack: AckPayload;
  error: ErrorPayload;
  "sync.required": SyncRequiredPayload;

  "conversation.subscribed": ConversationSubscriptionPayload;
  "conversation.unsubscribed": ConversationSubscriptionPayload;

  "message.created": MessageEventPayload;
  "message.updated": MessageEventPayload;
  "message.deleted": MessageDeletedPayload;
  "message.reply_created": MessageEventPayload;
  "message.reaction_added": ReactionEventPayload;
  "message.reaction_removed": ReactionEventPayload;
  "message.pinned": MessagePinnedEventPayload;
  "message.unpinned": MessageUnpinnedEventPayload;
  "message.starred": MessageStarEventPayload;
  "message.unstarred": MessageStarEventPayload;

  "conversation.receipt_delivered": ConversationReceiptEventPayload;
  "conversation.receipt_read": ConversationReceiptEventPayload;

  "typing.started": TypingEventPayload;
  "typing.stopped": TypingEventPayload;
  "mention.created": MentionEventPayload;
};
```

### Event Delivery Rules

- `ack` and `error` events are delivered only to the socket that sent the command.
- `message.created`, `message.updated`, `message.deleted`, `message.reply_created`, reaction events, pin events, read receipts, delivery receipts, and typing events are delivered to subscribed sockets for users who can currently see the conversation.
- `message.starred` and `message.unstarred` are user-scoped and delivered only to the user who changed their star state.
- `mention.created` is user-scoped and delivered only to mentioned users who can see the message.
- The actor's own socket receives the same durable mutation events as other subscribed sockets, after or near its `ack`, so clients can reconcile optimistic state using `clientId` and `message.id`.
- When permissions change and a user loses access to a conversation, the server should stop conversation-scoped events for that conversation and may emit `sync.required` with `reason: "permissions_changed"`.