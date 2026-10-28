# Trader experience workstream

Status: implementation proposal, 28 October 2026. No product code or deployment is included. Source documents: [README](../../README.md) and [WhatsApp setup](../whatsapp-setup.md).

## Requirements and proposed decisions

The README promises a priced catalogue built from a stall photo and voice note sent on WhatsApp. The setup guide adds a catalogue link sent back on WhatsApp, verified test recipients only, and dropping other senders before paid calls. Neither document specifies review, authentication, publishing, ordering, payments, or a technology stack. The setup guide explicitly requires Shola's yes before public deployment.

This workstream proposes a mobile web review page reached from WhatsApp, explicit publication, and a separate customer link. These are design recommendations, not already agreed product requirements. The goal is for a trader to correct extraction mistakes confidently before customers see prices. Orders, checkout, stock tracking, customer accounts, and a trader dashboard are outside this first pass.

Alternatives considered: immediate public generation is faster but exposes unconfirmed prices; WhatsApp-only corrections avoid a browser switch but make matching corrections to several products cumbersome. A review page provides the clearest small first version.

## Mobile journey

1. After intake and generation, WhatsApp sends “Your catalogue is ready to review” with a private review link. Intake owns message eligibility, delivery, retries and deduplication.
2. The page displays catalogue status, product count, an explanation that it is private, and unresolved items first. Each product card has its crop when available, editable name, price, currency and price basis (for example, each or per kg). Use text fields and a decimal input with a visible currency label; never infer currency from the browser locale.
3. Uncertain or missing information appears beside its field in plain language, for example “Confirm whether this price is per kg.” Show source evidence only in the private review page. Missing values stay blank; zero is not a substitute for a missing price. The trader can correct a field, explicitly confirm a flagged suggestion, or exclude the product. Exclusion is reversible in the draft.
4. “Save changes” persists edits with visible saving/saved/failed feedback. Keep edits visible on failure and warn before leaving with unsaved changes. “Preview” shows the exact customer projection, with a clear private-preview banner.
5. “Publish catalogue” becomes available when at least one product is included, every included product meets validation, all blocking issues on included products are resolved, and there are no unsaved edits. The server repeats these checks. Show the included product count and explain that anyone with the customer link can see the published catalogue.
6. On successful publication, show the customer URL with “Share catalogue” (native share when available) and “Copy link” fallback. Intake sends the public link to the trader via WhatsApp. Publication remains successful if that message fails; show the link immediately and retry delivery separately.
7. Later edits stay private until “Update published catalogue.” Publishing atomically replaces the public snapshot at the same URL. “Unpublish” removes public access while retaining the draft for editing.

A failed generation shows a retry/send-again instruction rather than an empty catalogue labelled ready. A processing link, if intake sends one early, shows progress and a recoverable failure state. All controls must work at a 320px viewport without horizontal scrolling, have visible labels and keyboard focus, and announce save/errors to assistive technology.

## Public and private access

Owner identity comes from verified WhatsApp intake, never from a browser-supplied phone number. Treat review links as credentials: use short-lived, random single-use tokens, store only their hashes, and exchange them for a Secure, HttpOnly, SameSite session scoped to that catalogue. Avoid consuming a token on a GET because link previews can prefetch it; require a deliberate exchange action. Redact tokens in logs, set no-referrer and no-store on private pages, and avoid third-party scripts there. Expired links instruct the trader to request another through WhatsApp; define the resend command with intake.

Every private API checks catalogue ownership/session scope and protects mutations against CSRF. Opaque catalogue IDs alone confer no editing rights. Public catalogue slugs must be independent of review tokens. Public responses include only published names, prices, price bases and approved product images; exclude phone numbers, original voice notes, transcripts, original stall photo, evidence, issue annotations, private URLs and internal IDs. Do not serve private uploads from public storage URLs. Crops should be omitted if an appropriate public product image cannot be isolated.

The customer link is public to anyone who has it; an unguessable slug and noindex are not access controls. Unpublished or unknown slugs return the same unavailable page. Avoid caching public snapshots in the first version so unpublishing takes effect immediately for subsequent requests; already saved copies cannot be revoked.

## Minimum API contracts (proposed)

Generation's canonical proposal lives in [catalogue generation](catalogue-generation.md). Consume `CatalogueDraft { id, jobId, traderId, revision, status: "needs_review", currency, items, issues }`. Each item has stable `id`, nullable `name`, optional `description`, `imageAssetId`, `issues`, and `price { status: "explicit" | "uncertain" | "missing", amountMinor, currency, basis, evidence }`. Money uses integer minor units and ISO 4217 currency; `basis` describes each/kg/bundle or another explicit selling unit. Uncertain amounts remain null, with candidate wording in private evidence. Generation never grants publication approval.

The review layer adds `included` (default true), owner corrections, field confirmations, and issue resolutions scoped to the draft revision, preserving the original extraction for traceability. Require a name, amount, currency and basis for every included item. A zero amount needs explicit owner confirmation. Catalogue-wide blocking issues also need resolution, unless the server can prove they only concern excluded items. Structured issue IDs and affected fields should be added before coding so confirmations target stable issues rather than matching display strings.

These endpoint names are implementation suggestions; agree them with generation and intake before coding. JSON mutations return a new draft revision and use a revision precondition to prevent overwriting another tab's edits. Never accept ownership fields from the client.

| Endpoint | Contract |
| --- | --- |
| `POST /api/review-sessions` | Accept a review token after a deliberate owner action; consume it once, set the scoped session cookie, and redirect to a token-free page. Invalid/expired tokens return a safe access error. |
| `GET /api/catalogues/:id/draft` | Owner only; return processing state, draft revision, products, issues, publication state, and current public URL if published. |
| `PATCH /api/catalogues/:id/draft` | Owner only; submit changed fields/exclusions and expected revision. Validate server-side; record corrections separately from generation evidence; return updated revision and issues. |
| `POST /api/catalogues/:id/publish` | Owner only; accept expected draft revision and idempotency key. Validate, then atomically save the public snapshot, publication revision, public URL and a durable notification event. Retry returns the original result. |
| `POST /api/catalogues/:id/unpublish` | Owner only; disable public access, preserve draft, and return state. Repeated calls are harmless. |
| `GET /api/public/catalogues/:slug` | Anonymous; return published projection only, or 404. |

Error envelope: `{ error: { code, message, fieldErrors? } }`. Use 401 for missing/expired session, 404 for inaccessible catalogue, 409 for revision conflicts, 422 for invalid fields/unresolved issues and 429 for rate limits. A 409 offers reload/reapply and does not silently discard local edits.

Publication notification event: `CataloguePublished { eventId, jobId, revision, catalogueId, catalogueUrl }`, where revision is the published snapshot revision. Intake resolves the trader internally from jobId, validates the URL against the configured origin, and deduplicates eventId; the web client must never choose the WhatsApp recipient. The publish transaction must persist the event, so a process crash cannot lose the follow-up message. Notification failures do not roll back publication.

## Acceptance checks

- A fixture with an ambiguous price stays private, displays its issue beside the right product, and cannot publish until corrected, explicitly confirmed where appropriate, or excluded. Missing required values cannot be confirmed away.
- An owner edits a name and price, saves, reloads, previews and publishes; the customer view exactly matches the confirmed values and price basis.
- Empty catalogues, negative/invalid amounts, unknown currency, blank names and unresolved included items are rejected by the API as well as the UI. Supported currency precision is validated without floating-point rounding.
- A forged owner ID, another catalogue's session, expired/reused token or missing session cannot read or edit the draft. Link-prefetch GETs do not consume access tokens.
- Two tabs cannot overwrite one another silently. Repeated publish requests create one result and one logical delivery event.
- Editing an already published catalogue leaves its customer view unchanged until republished. Unpublishing makes subsequent public requests unavailable.
- Inspect public HTML, JSON and media responses: no private source material, recipient identity, session secret or review credential is present.
- Lost network during save/publish preserves edits or permits safe retry. A WhatsApp delivery failure still leaves a usable published URL on screen.
- On a narrow phone viewport, the trader can complete review, correction and publication with labelled controls; sharing falls back to copying the URL.

## Implementation sequence and dependencies

First align the generated item/issue schema, draft states and owner identity reference with the other workstreams. Then implement persistence and owner access; mobile review/edit/save; public projection and preview; atomic publish/unpublish with notification event; and the acceptance checks above. Start with fixtures, including missing prices and ambiguous units, before connecting model calls. The minimum end-to-end slice is one verified trader, one photo plus voice note, one corrected product, one deliberate publication and one public URL.
