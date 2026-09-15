# Telegram and Client Channels

## 1. Telegram adapter responsibility

The Telegram layer is a presentation and transport adapter. It owns:

- webhook authenticity and Telegram update parsing;
- mapping Telegram user ID to internal User;
- short-lived conversation/navigation state;
- conversion of messages/buttons into application commands;
- rendering localized application results to Telegram text, media, and keyboards;
- Telegram delivery retry/classification and message-reference bookkeeping.

It does not own Profile rules, pair eligibility, prices, credits, Nakh state, Match state, permissions, or moderation decisions.

## 2. Webhook ingress

Production uses Telegram webhooks behind TLS and an edge/load balancer.

Ingress sequence:

1. allow only the configured route and method;
2. enforce body-size and connection limits before parsing;
3. validate Telegram's configured secret-token header with constant-time comparison;
4. parse against the supported Update schema, retaining unknown fields safely;
5. derive `(botId, updateId)` and insert an ingress inbox row with a unique key;
6. enqueue/execute the mapped interaction after durable claim;
7. return success for a duplicate already claimed update;
8. return a retryable failure when durable claim is impossible.

Do not rely on Telegram source IP alone. Rotate webhook secrets with an overlap procedure. Bot tokens never appear in URLs, logs, tracing attributes, or error reports.

Telegram may resend and reorder updates. `update_id` deduplicates transport; application command idempotency protects the business effect. Update processing for one User is serialized through a short per-user queue/lease where ordering affects conversation UX, while business correctness remains in PostgreSQL.

## 3. Conversation state

Telegram menus are not the source of truth.

- Durable signup answers/progress live in PostgreSQL.
- Product state (current Profile, Pending Nakh, payment, Match) is loaded from its module.
- Redis stores a versioned short-lived navigation state such as current screen, selected item/cursor, and expected input type.
- A missing/expired Redis state returns the user to a safe derived home/current step.
- Text expected for one flow carries a flow nonce; stale replies are rejected or re-routed safely.
- The adapter never stores a full Profile, chat transcript, payment payload, or secret in Redis conversation state.

State key example: `tg:conversation:{botId}:{userId}` with TTL and schema version. Writes use compare-and-set revision when two updates race.

## 4. Callback data

Inline-button callback data is a compact opaque token, not trusted state:

```text
v1.<action-code>.<short-token>.<mac>
```

The short token resolves server-side to actor, target, scope, expiry, and one-time/reusable policy. The MAC prevents tampering; actor and scope are revalidated after lookup. Tokens are short-lived for money, moderation, destructive, or state-transition actions. Do not embed private text, balance, Telegram token, predictable database sequence, or authorization decision.

Every callback is answered promptly so the Telegram client stops its loading state. Slow side effects are queued and the bot edits/sends a follow-up when complete.

## 5. Rendering and navigation

- Screen renderers consume typed presentation models and localization intents.
- Buttons reference stable action codes; final labels come from localization.
- HTML/Markdown values are escaped by default.
- Telegram message edits are best-effort; if an old message cannot be edited, send the current state without changing business behavior.
- A screen is reproducible from authoritative state; button history never grants access.
- Pagination cursors are signed, viewer-bound, filter-version-bound, and expire.
- Sensitive profile photos use delivery grants and appropriate variant, never a raw R2 key.

## 6. Telegram delivery

All outbound sends that matter are NotificationDelivery or channel-delivery jobs with a stable delivery ID. The Telegram client adapter classifies:

- success and returned Telegram message ID;
- retry-after response, obeying provider delay;
- temporary network/provider failure;
- terminal blocked/deactivated/chat-not-found outcome;
- malformed request/programming fault.

Global and per-chat concurrency are limited. Safety and payment messages have independent capacity from chat traffic. Provider message IDs are operational metadata only and are not domain identifiers.

## 7. Bot-relay chat

Bot-relay chat is implemented from Chat messages, not by forwarding Telegram messages blindly:

1. identify the sender and current ChatSession;
2. validate input and run the channel-neutral send command;
3. commit ChatMessage and notification delivery intent;
4. worker renders a recipient message with a safe chat alias/context;
5. store provider delivery metadata separately;
6. recipient replies through a signed chat action/current-chat context.

Do not expose the other user's Telegram ID, username, forwarded-message attribution, phone number, or native chat link. Reject Telegram attachments for MVP unless the domain specification is expanded. Report evidence is captured from stored ChatMessage content, not scraped from a Telegram message later.

## 8. Telegram media ingestion

For MVP photo uploads:

- Telegram adapter accepts only supported photo/document types and records Telegram file metadata in a short-lived ingestion job;
- worker retrieves file information/downloads through Telegram, streams through size/type validation and malware/image decoding controls, and writes to a private quarantine prefix;
- Telegram `file_id` is provider metadata and mutable; `file_unique_id` can assist dedupe but does not replace content hashing;
- application marks upload complete only after storage verification, then normal media processing begins.

Future web/mobile clients use an upload-intent endpoint and bounded presigned PUT to the same quarantine workflow. Both paths converge on `CompletePhotoUpload`; downstream media behavior is identical.

Owner media command ingress accepts only the strict `/photos`, `/photos_primary`, `/photos_order`,
and `/photos_delete` grammar. Telegram identity is resolved server-side, mutations carry the Telegram
update ID as their idempotency key, and PostgreSQL rechecks ownership plus Profile version. These
commands are not callback data. Final inline buttons must use the opaque signed action-token design in
Section 4; they must not embed photo IDs or authorization state.

## 9. Telegram Stars interaction

The Telegram adapter may create/send an invoice only after Billing creates a PendingPayment and PaymentRecord with an unguessable unique invoice payload. It answers pre-checkout only after verifying amount, currency `XTR`, payer, payload, target state, and attempt status. Product value is granted only from a durably processed successful-payment update, never merely from pre-checkout success or an invoice-send response.

Detailed fulfillment and correction rules are in [`07-payments-and-entitlements.md`](07-payments-and-entitlements.md).

## 10. Future web and mobile adapters

Future clients call the `/v1` API and reuse commands/queries. They add only channel concerns:

- login/session and CSRF/CORS policy;
- direct-to-R2 upload intent;
- web push/mobile push delivery adapters;
- real-time chat notification via WebSocket/SSE or push;
- client-specific presentation and navigation.

They must not recreate eligibility, prices, entitlement checks, state transitions, or deletion in front-end code. OpenAPI/JSON Schema is generated from the same contract package used by Telegram and contract tests.

## 11. Adapter test gates

- replay identical update and callback many times: one business effect;
- reorder Like/Nakh/payment/chat updates: state remains legal;
- lose Redis conversation state: user resumes safely;
- edit/click an old button: actor/scope/state recheck denies stale action;
- simulate Telegram 429/5xx/blocked bot: correct retry or terminal delivery state;
- inject markup/control characters: escaped output;
- try another user's callback/cursor/token: denied and audited;
- verify no Telegram identifier leaks into profile/chat presentation;
- run application use-case contract suites through both Telegram and HTTP adapters.
