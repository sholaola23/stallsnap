# WhatsApp intake implementation plan

Status: proposed design; no server, database, worker, tests or deployment currently exists in this repository. This plan is based on `README.md` and `docs/whatsapp-setup.md`, inspected on 28 October 2026. No applicable `AGENTS.md` was found in the repository or its parent directories.

## Existing evidence and boundaries

The setup document records a claimed Meta test number, a system user with access to its test WABA, and one verified test recipient. These are documented dashboard actions, not independently verified live configuration. The intended product receives a stall photo and voice note, then replies with a priced catalogue link.

The documented environment names are `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `ALLOWED_NUMBERS` and `MODEL_API_KEY`. The referenced `.env.example` is absent. Real values must stay outside this public repository. The document names Railway for hosting and explicitly requires Shola's approval before public deployment. The `catalogue_ready` template remains unsubmitted.

This workstream owns webhook ingress, sender authorization, conversation assembly, inbound media retrieval and WhatsApp delivery. Catalogue interpretation, pricing and publication belong to catalogue generation; copy and catalogue UI belong to trader experience. It does not infer prices or expose raw voice notes to catalogue viewers.

## First implementation slice

Use one web process, one durable relational database and one worker process sharing the application package. The worker can poll a database-backed queue initially, avoiding a second queue service. Choose the language/framework with the main implementation plan; contracts below are language-neutral. Neither an in-memory map nor a request background callback is sufficient for durable processing.

1. Add configuration validation and a secret-free `.env.example`; fail startup on missing mandatory values or an empty allowlist. Add a pinned supported Graph API version, database URL and private media storage configuration. Select storage before writing its adapter.
2. Implement `GET /webhook` challenge verification and `POST /webhook` signed durable ingestion.
3. Implement a transactional photo/voice assembler with explicit handling of ambiguity.
4. Download validated media into private storage, then enqueue one generation request.
5. Accept a persisted draft result and send its private owner-review link; send the public catalogue link only after the trader workflow confirms publication.
6. Prove the complete flow against fixtures and mocked external APIs before any public deployment.

## Webhook boundary

`GET /webhook`: require `hub.mode=subscribe`, a nonempty exact match for `hub.verify_token`, and `hub.challenge`. Return the challenge as plain text with HTTP 200 on success; use 403 for a mismatched token and 400 for malformed parameters. Never log the verify token or complete query string. This challenge endpoint does not authenticate POST requests.

`POST /webhook`: retain the exact request bytes before any JSON parser, decompression middleware or body mutation. Enforce a documented body-size limit at the proxy and application. Compute HMAC-SHA256 with `APP_SECRET` over those bytes; compare the decoded 32-byte digest to `X-Hub-Signature-256` using a timing-safe comparison after validating the `sha256=` prefix, hex encoding and length. Missing, malformed or incorrect signatures return 401/403 and cause no processing. Do not verify a reserialized JSON object.

After signature verification, parse and validate the envelope. Iterate every entry, change and message, rather than taking only the first. Require the expected WhatsApp account object and `metadata.phone_number_id` matching the configured receiving number. A status-only event must not create an intake. Handle delivery-status records separately and idempotently. Unknown but valid event types are ignored with a bounded metric.

Normalize both configured allowlist entries and inbound `messages[].from` to one digits-only international identifier (an optional leading `+` is permitted in configuration; reject ambiguous local forms). Require allowlist membership before media resolution/download, model calls, uploads or outbound messages. Drop unauthorized senders without replying, return 200 and retain only a counter, not their message content. Verify membership again at worker dispatch so a removed recipient cannot continue queued paid work. Do not trust a user-provided display name as identity.

For an authorized supported message, atomically insert its minimal normalized record and an ingestion queue job. Return 200 only after commit, targeting a quick acknowledgement without waiting for generation. A database outage returns 503 so Meta can redeliver. Signed malformed payloads return 400; valid unsupported content is acknowledged without creating a generation job. Validate an entire batch before mutation or make each item idempotent so partial failures and retries cannot multiply work.

## Minimal durable records and interfaces

| Record / interface | Required fields and invariant |
| --- | --- |
| `InboundMessage` | `phoneNumberId`, `messageId`, `traderId`, `kind` (`image` or `audio`), `mediaId`, `receivedAt`, `providerTimestamp`, optional `replyToMessageId`. Unique `(phoneNumberId, messageId)`. Use sender number only in a restricted trader record. |
| `Intake` | Opaque `intakeId`, `traderId`, `phoneNumberId`, state, `imageMessageId?`, `audioMessageId?`, `openedAt`, `expiresAt`, version. Each inbound media message belongs to at most one intake. |
| `StoredMedia` | Opaque reference, validated MIME type, byte length, SHA-256, private storage key. No bearer token or expiring provider URL in contracts. |
| `generateCatalogue(request)` | `{jobId, traderId, revision, photo:{assetId,mimeType}, voice:{assetId,mimeType}, locale?,currency?}` → draft or typed failure. `jobId` equals the stable intake ID; start at `revision: 1`. Asset IDs refer to private validated media. Unique `(jobId, revision)` prevents repeat generation. |
| `CatalogueReviewReady` | Proposed workflow event `{eventId, jobId, revision, reviewUrl}`: send a private owner-review link using trader-experience authorization. Generation success alone does not authorize publication. |
| `CataloguePublished` | Proposed workflow event `{eventId, jobId, revision, catalogueId, catalogueUrl}`: enqueue the public catalogue link. Accept only links on the configured application origin; never send an arbitrary model-generated URL. |
| `CatalogueGenerationFailed` | `jobId`, `revision`, safe error code, retryable flag. Internal diagnostics stay outside the trader message. |
| `OutboundMessage` | Unique `(jobId, revision, purpose)` such as `catalogue_ready`, destination trader reference, payload, state, attempts, provider message ID when known. Persist intent before attempting transmission. |

These contracts are proposals for cross-workstream agreement, not existing API types. Store each review/publication event and its outbound intent in one database transaction. Deduplicate workflow events by `eventId`; the published `revision` identifies the immutable snapshot. Resolve the recipient server-side from `jobId`, never from a client-supplied number. Publication and its event are atomic in the trader workflow; delivery failure does not roll back publication. Trader review and publication are separate from intake completion. Redact private review URLs/tokens from logs; link-preview GET requests must not consume owner-review exchange tokens. Catalogue workers must not call the WhatsApp API directly. Any progress or correction prompt also uses the delivery adapter and the sender/window gates.

## Pairing photo and voice

For the first release, support exactly one active incomplete intake per trader and receiving phone number. Serialize assembly with a database lock or equivalent transactional constraint. Either media type may arrive first. Pair the first complementary supported message within a proposed 15-minute window, measured from first local receipt; retain the provider timestamp for diagnostics without using it as the sole expiry clock. Store the deadline rather than relying on process timers.

States: `waiting_for_image` or `waiting_for_audio` → `ready` → `processing` → `completed` or `failed`; incomplete intakes can become `expired` or `needs_clarification`. Download/generation retries are job state, not new intakes.

If a second image arrives before an audio, or a second audio before an image, do not silently overwrite or guess: mark the intake `needs_clarification`, retain the small message references, and ask the trader to restart with one photo and one voice note. Provide a deterministic `restart` text command that cancels the incomplete intake and opens a fresh collection on the next supported media message. A reply context that unambiguously refers to an active intake may associate the complementary message with it, but must not bypass sender isolation or attach to a completed intake.

On expiry, stop assembly and discard retained incomplete media under the retention policy. Explain that the trader should restart. Delayed complementary messages after expiry cannot revive an old intake; start a new waiting intake and explain which input is still required. While an intake is processing, respond once with a busy message and ask for the next pair after completion. Multi-photo catalogues, parallel intakes and edits to published catalogues are later scope. Trader-experience copy should make these limits clear.

## Media handling

Only after authorization and a durable intake exists, resolve the media ID via the pinned WhatsApp Graph API and download using the server token. Fetch promptly; provider download URLs are temporary. If a URL has expired, resolve the media ID again rather than retrying the same URL forever.

Download only from the provider response through a restricted HTTP adapter. Require HTTPS, validate allowed provider hosts against current provider documentation, prevent redirects to unapproved hosts and prevent token forwarding to other origins. Stream with timeouts and byte limits; do not buffer an unbounded body. Proposed application limits: 10 MB per image and 16 MB per voice note, subject to confirmation against provider and model limits. Validate declared MIME type, actual file signature and decoder behavior. Permit a small explicit image/audio set that both WhatsApp and the selected model accept; treat any required audio conversion as a bounded worker task. Reject corrupt media with a useful retry prompt.

Store media privately with random keys and encryption supplied by the storage service. Generation receives private references or short-lived internal access, never a publicly browseable raw-media URL. Do not log tokens, provider URLs, phone numbers or voice content. Proposed raw-media retention is 24 hours after terminal processing and no longer than 24 hours for abandoned inputs; confirm policy with the owner and implement a cleanup job. A published product image is a separately managed derivative with its own catalogue retention policy.

## Deduplication, retries and outbound delivery

Use unique constraints for inbound messages, intake generation requests and outbound message purposes. Queue workers acquire expiring leases; a crash releases work through lease expiry. All transitions use transactions or compare-and-set versions. Log opaque correlation IDs and safe error codes. Apply bounded per-trader rate limits and a global generation concurrency/budget cap before paid calls.

Retry transient network errors, 429 responses (honoring `Retry-After`) and selected provider 5xx responses using exponential backoff with jitter and a finite attempt/deadline budget. Treat invalid credentials as an operational failure needing attention, and invalid media/unsupported formats as terminal user-correctable errors. Persist the next-attempt time and move exhausted jobs to a reviewable failed state. Redelivery of an inbound message must not reset its attempt budget. Respect catalogue generation’s per-revision provider-call budget (at most two transient retries and one constrained schema repair); scheduler retries must consult persisted attempts rather than multiply internal retries. Completed revisions reuse their draft and stale revisions must not overwrite newer trader edits.

Send a free-form catalogue reply inside the current WhatsApp customer-service window; compute eligibility at send time from the latest qualifying inbound user message. Outside that window, use an approved `catalogue_ready` template with the appropriate language and configured URL parameter. If no approved template exists, hold delivery pending renewed user contact or template availability and expose the blocked state to operators. Validate current provider rules and template parameters during integration. A late result does not justify sending an ineligible free-form message.

WhatsApp delivery is not exactly-once: a successful provider acceptance followed by a connection loss can leave the server unsure whether it sent. Record `sending` before the call and persist the returned provider message ID immediately. Mark ambiguous outcomes `delivery_unknown`; reconcile with status webhooks where possible and use a documented operator/retry policy rather than blindly re-sending. Handle duplicate and out-of-order status events without regressing a terminal delivery state. No read/delivery callback should generate another catalogue.

## Verification and acceptance

Use sanitized fixtures and mocked Graph/model endpoints; no production secrets or paid calls are needed for local checks.

- Challenge success, missing parameters and wrong token; valid raw-byte signature, altered whitespace, invalid digest lengths and missing signature; payload limits.
- Nested batches, wrong receiving-number ID, status-only events, unsupported content and malformed signed JSON.
- Unauthorized sender yields zero media/model/storage/send calls, including after allowlist removal between enqueue and execution.
- Same message delivered concurrently/repeatedly produces one record/job; crash after commit before HTTP acknowledgement safely redelivers; database failure produces retryable acknowledgement failure.
- Photo-first and voice-first ordering, duplicate same-type ambiguity, concurrent complementary messages, expiry/restart, sender isolation and messages during processing.
- Expired download URL refresh, invalid MIME/signature, oversized/slow downloads, unsafe redirect, corrupt audio/image and storage failure.
- Worker crash/lease recovery, bounded transient retry, permanent failure, generation idempotency and duplicate review/publication events produce one logical outbound intent; draft generation cannot trigger public-link delivery.
- Allowed-origin catalogue link; in-window free-form reply; expired-window approved template; unavailable template hold; ambiguous send outcome; duplicate/out-of-order status callbacks.
- One complete fake photo + voice flow results in a persisted generation request and one private review-link intent, followed by one public catalogue-link intent only after an explicit publication fixture.

## Deployment blockers and completion gate

Public deployment is blocked until Shola approves it, as required by the existing setup document. Work before that gate is local and reviewable. The concrete deploy proposal should identify Railway service(s), database/storage costs, secret names, health checks, migration/rollback steps and the exact webhook address without secret values.

Before live end-to-end acceptance, obtain access to the documented secrets through the approved environment; verify supported Graph API/model formats, storage and database configuration, WABA message subscription and receiving-number configuration; register and verify `/webhook`; and confirm the developer's test recipient remains verified and allowlisted. Test-number restrictions still apply. Template submission/approval is separately needed for out-of-window delivery. Record those results in the dated build log only when performed, distinguishing recorded setup from tested behavior.
