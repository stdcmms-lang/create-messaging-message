# Messaging App — Auth and User Interface

## Conventions

- **Auth**: endpoints below either accept anonymous callers (registration, login, password reset, refresh, email verification, MFA verification) or require `Authorization: Bearer <accessToken>`. Endpoints under `/me` and `/me/*` always require a valid bearer. Missing or invalid bearer where required → `401 unauthenticated`.
- **Content type**: request bodies are `application/json`. Malformed JSON → `400 invalid_request`; body present with a non-JSON content type → `415 unsupported_media_type`.
- **List envelope**: list responses (`GET /me/devices`, `GET /me/blocked-users`) use `{ "items": T[], "nextCursor": string | null }`. `nextCursor` is omitted or `null` on the final page.
- **Pagination**: opaque `cursor` strings are produced by the server. Clients must not parse them. Invalid or forged cursors → `400 invalid_request`.
- **Limits**: `limit` must be a positive integer within the documented range; out-of-range values → `400 invalid_request`.
- **Error body**: errors return `{ "error": { "code": string, "message": string } }`. Stable `code` values are `invalid_request`, `unauthenticated`, `forbidden`, `not_found`, `conflict`, `unsupported_media_type`, `rate_limited`. The status-code → `error.code` mapping matches the other interface specs in this repo. `message` is not stable.
- **`User` shape**: the auth `User` returned here (private to its owner) is the source-of-truth profile. The publicly visible projection — `PublicUserProfile` — is defined in `user-interface.md`; private fields (`email`, `accountState`, etc.) never appear there.

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

## HTTP endpoints

#### Auth and user endpoints

| Method | Endpoint | Parameters | Description |
|--------|----------|------------|-------------|
| POST | `/auth/register` | Body: `email: string`, `username: string`, `password: string`, `displayName?: string`, `deviceId?: string`, `inviteCode?: string` | Creates a new user account and returns access/refresh tokens or a verification challenge. |
| POST | `/auth/login` | Body: `identifier: email \| username`, `password: string`, `deviceId?: string` | Starts a user session and returns access/refresh tokens, or an MFA challenge when MFA is enabled (complete login with `/auth/mfa/verify`). |
| POST | `/auth/logout` | Body: `refreshToken?: string`, `allDevices?: boolean` | Ends the current session or all sessions for the authenticated user. |
| POST | `/auth/refresh` | Body: `refreshToken: string`, `deviceId?: string` | Exchanges a valid refresh token for a new access token. |
| POST | `/auth/password/reset` | Body: `email: string`, `redirectUrl?: https-url` | Requests a password reset. When `redirectUrl` is present, its host must be on the server's redirect allow-list; off-domain and suffix-spoof hosts return `400` (see Special considerations). |
| POST | `/auth/password/reset/confirm` | Body: `token: string`, `newPassword: string` | Completes a password reset using the token from the reset email or link (or `devResetToken` from the reference server during development). |
| POST | `/auth/email/verify` | Body: `token: string` | Verifies an account email using the token from the verification email. |
| POST | `/auth/email/verify/resend` | Body: `email?: string` | Resends the email-verification link to the authenticated user or the given address. |
| POST | `/auth/mfa/enroll` | Body: `method: totp \| sms`, `phone?: string` | Begins MFA enrollment and returns a TOTP secret/QR or sends an SMS challenge. |
| POST | `/auth/mfa/enroll/confirm` | Body: `enrollmentId: string`, `code: string` | Confirms MFA enrollment with the first valid code and returns recovery codes. |
| POST | `/auth/mfa/verify` | Body: `mfaTicket: string`, `code: string`, `rememberDevice?: boolean` | Verifies an MFA challenge and completes login. |
| GET | `/me` | None | Returns the authenticated user's profile and account state. |
| PATCH | `/me` | Body: `displayName?: string`, `username?: string`, `avatarAttachmentId?: string`, `statusMessage?: string` | Updates editable fields on the authenticated user's profile. |
| GET | `/me/devices` | Query: `limit?: integer(1-100)`, `cursor?: string` | Lists devices and sessions associated with the authenticated user. |
| DELETE | `/me/devices/{deviceId}` | Path: `deviceId: string` | Revokes one trusted device or active session. |
| PUT | `/me/devices/{deviceId}/push-token` | Path: `deviceId: string`; Body: `provider: apns \| fcm \| web_push`, `token: string`, `appVersion?: string`, `locale?: string` | Registers or replaces the push notification token for a device. |
| DELETE | `/me/devices/{deviceId}/push-token` | Path: `deviceId: string` | Removes the push notification token for a device. |
| GET | `/me/blocked-users` | Query: `limit?: integer(1-100)`, `cursor?: string` | Lists users blocked by the authenticated user. |
| POST | `/me/blocked-users` | Body: `userId: string`, `reason?: string` | Blocks a user from contacting or discovering the authenticated user. |
| DELETE | `/me/blocked-users/{userId}` | Path: `userId: string` | Removes a user from the authenticated user's block list. |

##### Auth response shapes

Successful responses for the endpoints above include the fields below. Fields are present only when the "When" column is satisfied; absent otherwise. Anti-enumeration is preserved: existence-revealing fields (`devResetToken`, `emailVerificationToken` on resend, `devMfaCode`) appear only when the underlying account/flow exists; otherwise the same response shape is returned with the token omitted.

| Endpoint | Field | Type | When |
|---|---|---|---|
| `POST /auth/register` | `accessToken`, `refreshToken` | `string` | Account is created in `active` state (no verification required) |
| `POST /auth/register` | `user` | `User` | Always |
| `POST /auth/register` | `requiresEmailVerification` | `boolean` | Account is in `pending_verification` state |
| `POST /auth/register` | `emailVerificationToken` | `string` | Account requires email verification; usable against `POST /auth/email/verify` |
| `POST /auth/login` | `accessToken`, `refreshToken`, `user` | — | MFA not required |
| `POST /auth/login` | `mfaRequired` | `true` | Account has MFA enabled |
| `POST /auth/login` | `mfaTicket` | `string` | Account has MFA enabled; passed to `POST /auth/mfa/verify` |
| `POST /auth/login` | `devMfaCode` | `string` | Account has MFA enabled; the code that completes `POST /auth/mfa/verify` |
| `POST /auth/refresh` | `accessToken`, `refreshToken` | `string` | Always (rotation required: prior refresh token is invalidated, replay → `401`) |
| `POST /auth/password/reset` | `sent` | `true` | Always (returned for both known and unknown emails to prevent enumeration) |
| `POST /auth/password/reset` | `devResetToken` | `string` | Email matches an existing account; usable as `token` against `POST /auth/password/reset/confirm` |
| `POST /auth/password/reset/confirm` | — | — | `200` empty body on success; `400` on invalid/consumed token |
| `POST /auth/email/verify` | `verified` | `true` | Token valid and unconsumed |
| `POST /auth/email/verify/resend` | `sent` | `true` | Always |
| `POST /auth/email/verify/resend` | `emailVerificationToken` | `string` | Email maps to an existing pending-verification account |
| `POST /auth/mfa/enroll` | `enrollmentId` | `string` | Always |
| `POST /auth/mfa/enroll` | `totpSecret`, `totpUri` | `string` | `method: "totp"` |
| `POST /auth/mfa/enroll` | `devSmsCode` | `string` | `method: "sms"`; the code that completes `POST /auth/mfa/enroll/confirm` |
| `POST /auth/mfa/enroll/confirm` | `recoveryCodes` | `string[]` | First successful confirm |
| `POST /auth/mfa/verify` | `accessToken`, `refreshToken`, `user` | — | Code matches and ticket is unconsumed |
| `POST /auth/logout` | — | — | `204` no body |
| `GET /me` | `id`, `email`, `username`, `displayName?`, `avatarAttachmentId?`, `statusMessage?`, `accountState: { createdAt, emailVerified, mfaEnabled }` | `User` | Always |
| `PATCH /me` | `id`, `email`, `username`, `displayName?`, `avatarAttachmentId?`, `statusMessage?`, `accountState: { createdAt, emailVerified, mfaEnabled }` | `User` | Always |
| `GET /me/devices` | `items`, `nextCursor?` | `Device[]`, `string` | `items` always; `nextCursor` when more pages |
| `GET /me/devices` | each `Device` | includes stable `deviceId` (session or trusted device) | within `items` |
| `GET /me/blocked-users` | `items`, `nextCursor?` | `BlockedUser[]`, `string` | `items` always; `nextCursor` when more pages |
| `GET /me/blocked-users` | each `BlockedUser` | `userId`, `reason?`, `blockedAt` | within `items` |
| *(public `User`, `Device`, `BlockedUser`)* | — | Never includes password hashes, password reset tokens, email verification tokens, MFA secrets, refresh tokens, or recovery codes | Applies wherever these types appear |
| `PUT /me/devices/{deviceId}/push-token` | `deviceId`, `pushToken: { provider, token, updatedAt, appVersion?, locale? }` | — | Always |
| `DELETE /me/devices/{deviceId}/push-token` | — | — | `204` no body; `404` if device or token unknown |
| `POST /me/blocked-users` | `userId`, `reason?`, `blockedAt` | — | Upsert: a second POST replaces `reason` |
| `DELETE /me/blocked-users/{userId}` | — | — | `204` no body |

### Auth flows

- **Register:** `POST /auth/register` creates the user. If verification is required, the account stays pending until `POST /auth/email/verify`; otherwise tokens are returned immediately.
- **Login (no MFA):** `POST /auth/login` returns `accessToken`, `refreshToken`, and `user`.
- **Login (MFA):** `POST /auth/login` returns an `mfaTicket`; complete with `POST /auth/mfa/verify`. Optional `rememberDevice` marks the device as trusted when `deviceId` was used on login.
- **Refresh:** `POST /auth/refresh` rotates the refresh token and returns a new access (and refresh) pair; the previous refresh token is no longer valid.
- **Logout:** `POST /auth/logout` with `refreshToken` only ends that session without bearer auth; with bearer, `allDevices: true` ends every session for the user.
- **Password reset:** `POST /auth/password/reset` then `POST /auth/password/reset/confirm` with the emailed token (or `devResetToken` in development). A successful reset invalidates all refresh tokens for that user.
- **Email verification:** `POST /auth/email/verify` consumes the verification token; `POST /auth/email/verify/resend` issues another when the account is still pending verification.
- **MFA enrollment:** `POST /auth/mfa/enroll` starts enrollment (TOTP secret/URI or SMS challenge); `POST /auth/mfa/enroll/confirm` with `enrollmentId` and code finishes it and returns `recoveryCodes` on first success.

##### Special considerations

- `emailVerificationToken`, `devResetToken`, `devSmsCode`, `devMfaCode`, and `mfaTicket` are single-use. Replay of `emailVerificationToken` returns `400` or `200` when verification is implemented idempotently. Replay of `devResetToken` returns `400`, `401`, or `409`. Replay of `mfaTicket` returns `400`, `401`, or `409`.
- `PATCH /me` updates only editable profile fields (`displayName`, `username`, `avatarAttachmentId`, `statusMessage`). Unknown fields and immutable fields such as `id`, `email`, `passwordHash`, and `accountState` are ignored and are not persisted.
- `POST /auth/register` ignores attacker-controlled `id`, `emailVerified`, `mfaEnabled`, `passwordHash`, `recoveryCodes`, and `accountState` fields in the request body. New accounts are created with `emailVerified: false` and `mfaEnabled: false` regardless of the request payload, and the server assigns its own `id`.
- `DELETE /me/devices/{deviceId}` revokes only a device or active session associated with the authenticated user and returns `204`. Unknown devices, and devices belonging to another user, return `404`.
- `POST /auth/password/reset/confirm` Password reset and password change invalidate all existing refresh tokens for the user.
- `POST /auth/logout` with `refreshToken` body alone (no bearer) revokes that refresh-token session, invalidates the corresponding access token, and returns `204`. `allDevices: true` invalidates every refresh token for that authenticated user.
- When `POST /auth/password/reset` includes `redirectUrl`, the URL must use the `https` scheme and its **host** must appear on the server's configured redirect host allow-list. If the host is not allow-listed (off-domain), the server returns `400`.
- The server returns `400` for **hostname suffix spoofs** of an allow-listed host: a request host formed by appending one or more DNS labels after an allow-listed name (for example `app.example.com.evil.com` when `app.example.com` is allow-listed).
- `POST /auth/mfa/verify` with `rememberDevice: true` succeeds whether or not the original login supplied `deviceId`. When a `deviceId` was supplied, the trusted device appears in `GET /me/devices`.

##### Reference server — environment variables

The reference server reads optional TTL overrides (seconds, decimal digits only). Omitted variables keep the defaults below. Invalid values or `REFRESH_TOKEN_TTL_SECONDS` less than `ACCESS_TOKEN_TTL_SECONDS` cause the process to exit at startup.

| Variable | Default (seconds) | Allowed range |
|----------|-------------------|-----------------|
| `ACCESS_TOKEN_TTL_SECONDS` | `3600` | `1`–`604800` (7 days) |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` (30 days) | `60`–`34560000` (400 days); must be ≥ access TTL |
| `EMAIL_VERIFY_TTL_SECONDS` | `86400` (1 day) | `300`–`2592000` (30 days) |
| `PASSWORD_RESET_TTL_SECONDS` | `3600` | `60`–`604800` (7 days) |
| `MFA_ENROLLMENT_TTL_SECONDS` | `600` | `60`–`3600` |
| `MFA_TICKET_TTL_SECONDS` | `300` | `30`–`3600` |

Successful `POST /auth/login`, `POST /auth/register` (when tokens are issued), `POST /auth/mfa/verify`, and `POST /auth/refresh` responses include `expiresIn` (seconds) matching the configured access-token TTL.

##### Error and concurrency semantics

- Duplicate `POST /auth/register` requests for the same email or username return `409`. If duplicate registration requests race, exactly one request creates the account and the other returns `409`.
- `POST /me/blocked-users` is an idempotent upsert. Concurrent duplicate block requests for the same `(actor, userId)` both return `200`; the last supplied `reason`, if any, is the stored reason.
- `POST /auth/refresh` rotates refresh tokens atomically. Concurrent exchanges of the same refresh token produce exactly one `200` response; every other concurrent request receives `401` (replay after invalidation).
- Invalid MFA enrollment confirmation codes return `400`. Repeated invalid MFA enrollment confirmation attempts return only `400`, `401`, or `429`.
- Invalid MFA login verification codes return `401`. Repeated invalid MFA verification attempts return only `401` or `429`.
- Concurrent `POST /auth/email/verify` calls with the same valid token produce at least one `200`; other requests should receive response `400`.
- Concurrent `POST /auth/mfa/enroll/confirm` calls with the same valid enrollment code produce exactly one `200`; other requests should receive response `400` or `409`.
- `POST /auth/mfa/verify` consumes a valid `mfaTicket` and confirmation code atomically. Concurrent requests with the same valid `mfaTicket` and code produce exactly one `200` response; every other concurrent response receives `400`, `401`, or `409`.
- Concurrent `POST /auth/password/reset/confirm` calls with the same valid reset token produce at most one `200`; other requests should receive response `400`, `401`, or `409`.
- Concurrent conflicting `PATCH /me` requests return `200` or `409`, and at least one request succeeds.
