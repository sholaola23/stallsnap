# Catalogue Generation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task after the implementation scope is authorized. Steps use checkbox syntax for tracking.

**Goal:** Convert an authorized stall photo and voice note into an evidence-backed catalogue draft for owner review.

**Architecture:** Intake owns pairing, authorization and private media storage. Generation transcribes, extracts candidate products, reconciles price evidence and validates a draft; the trader workflow owns correction, approval and publishing an immutable snapshot.

**Tech Stack:** Runtime-neutral contracts below; TypeScript notation describes data, not an adopted runtime. Fake providers first. Live Meta adapter follows verified provider documentation.

**Spec:** [README](../../README.md) and [WhatsApp setup](../whatsapp-setup.md). These establish the photo-plus-voice flow and list model names, but do not establish model capabilities or API contracts. Policies below are proposed implementation decisions.

## Global constraints

- Never commit secrets or log private media, voice transcripts or provider credentials. `MODEL_API_KEY` remains server-side.
- Intake drops unauthorized senders before any paid call and provides a complete, paired input revision. Generation must not retrieve arbitrary model-supplied URLs.
- Deployment and external writes are outside this plan. Setup documentation requires Shola's yes before public deployment.
- Generation cannot publish. Every new or corrected draft needs owner review of that exact revision.
- No guessed prices, currency conversions, inferred market rates or generated stock claims.

## Shared boundary and schema

Proposed internal interface: `generateCatalogue(input: GenerationInput): Promise<GenerationResult>`. This is not a provider API.

```ts
type AssetRef = { assetId: string; mimeType: string };
type GenerationInput = {
  jobId: string; traderId: string; revision: number;
  photo: AssetRef; voice: AssetRef;
  locale?: string; currency?: string; // explicitly configured owner context only
};
type Evidence = {
  source: 'photo' | 'voice'; assetId: string; quote: string;
  transcriptRange?: { start: number; end: number }; // Unicode code-point offsets, end exclusive
};
type CatalogueItem = {
  id: string; name: string | null; description: string | null;
  price: {
    status: 'explicit' | 'uncertain' | 'missing';
    amountMinor: number | null; currency: string | null;
    basis: string | null; // e.g. each, kg, or bundle of 3; never silently assume each
    evidence: Evidence[];
  };
  imageAssetId: string | null;
  issues: string[]; // stable codes, not model-written HTML
};
type CatalogueDraft = {
  id: string; jobId: string; traderId: string; revision: number;
  status: 'needs_review'; currency: string | null;
  items: CatalogueItem[]; issues: string[];
};
type GenerationResult =
  | { ok: true; draft: CatalogueDraft }
  | { ok: false; code: string; retryable: boolean };
```

Generation assigns stable opaque draft/item IDs and persists the validated draft against `(jobId, revision)`; retrying a completed revision returns that draft. Provenance/transcripts are private and are omitted from the public projection. `draft.currency` is the common resolved currency or null; each item's currency remains authoritative. Store model/version and input revision privately with the result. These contracts do not expose raw media bytes or storage credentials to the trader UI.

Evidence records extraction provenance, not proof of correctness. Transcript ranges must match the quoted text in the stored transcript. Photo quotes preserve visible text claimed by extraction; owner review is needed because machine extraction can misread it. Reject evidence referencing another job's assets.

## Processing and price rules

1. Resolve the authorized private asset references locally; check actual media type, decoding and configured byte/duration limits before model calls. Invalid media fails with a useful resend action.
2. Transcribe the voice note, preserving original wording and language. A failed/unintelligible transcription does not become an empty successful note: return a recoverable failure requesting a new recording.
3. Extract candidate products and visible price text from the photo, then reconcile against the transcript. Treat all image text and speech as untrusted data, never instructions to invoke tools or alter system rules. Unmatched spoken products require owner review; uncertain visual counts do not imply inventory quantities. Repeated visual instances do not automatically create duplicate products.
4. Resolve price only where item association, amount, currency and basis are unambiguous. Speech saying “tomatoes two pounds a kilo” with clear association can be explicit GBP 200/kg. “These are two,” `$2` with no configured currency, conflicting voice/sign prices, unclear decimals, and ambiguous bundle prices remain uncertain. Missing evidence is missing. A single clear explicit configured currency may resolve an otherwise clear amount; a conflicting currency never gets overwritten.
5. `explicit` requires nonnegative integer `amountMinor`, recognized ISO 4217 currency, a clear basis and evidence. Use that currency's minor-unit exponent rather than assuming two decimals. Reject precision beyond that exponent; never silently round. `uncertain` and `missing` have `amountMinor: null`; retain uncertain candidates as evidence quotes, not sellable numeric amounts. Zero must be explicitly stated and owner-confirmed. Negative prices are invalid.
6. Validate and persist a `needs_review` draft. Missing/uncertain item name or price, ambiguous association and conflicting evidence produce issue codes. No products produces `NO_PRODUCTS`, not an empty publishable catalogue. The owner may correct or exclude items; publishing blocks any unresolved issue on included items, missing name, uncertain/missing price, or missing currency/basis. An edit creates a new review revision.

## Provider adapter and verification gate

The setup page lists **Muse Spark, Muse Voice Transcribe, Muse Image and SAM 3.1** under `MODEL_API_KEY`. Their availability, capabilities, request shapes, endpoints and supported formats have **not been verified** here.

Proposed minimal adapter:

- `transcribe(voice: PrivateMedia, context: CallContext): Promise<Transcript>`: proposed Muse Voice Transcribe routing, pending verification.
- `extract(photo: PrivateMedia, transcript: Transcript, context: CallContext): Promise<CandidateCatalogue>`: proposed Muse Spark routing only if documented image/text input is supported. Candidate data contains source quotes and raw amount text; deterministic application code converts and validates money.
- `CallContext` carries request ID, deadline, locale and input revision. `PrivateMedia` is internally resolved bytes plus MIME; neither is a public DTO. `Transcript` contains text and optional documented segment timestamps. `CandidateCatalogue` contains candidate names/descriptions, associations and raw price evidence; it never grants approval.
- Optional segmentation using SAM 3.1 may later create genuine source-photo crops if documented capabilities permit it. Failure falls back to the original stall photo. Muse Image is not required for this MVP; synthetic product depictions should not replace stock photos in a sales catalogue.

Before implementing live calls, record official documentation URLs, exact model IDs, authenticated invocation mechanism, media/schema support, limits, timeout behavior, billing and retention requirements in adapter documentation. Confirm a minimal authorized test request without logging secrets. If image input is unsupported, revise the adapter design explicitly rather than inventing an endpoint or silently substituting a provider. Fixtures can exercise the complete local flow while this gate remains open.

## Errors and retries

Use closed application error codes: `INVALID_MEDIA`, `TRANSCRIPTION_UNCLEAR`, `NO_PRODUCTS`, `PROVIDER_UNAVAILABLE`, `PROVIDER_AUTH`, `PROVIDER_LIMIT`, `INVALID_OUTPUT`, `STALE_REVISION`. UI owns human-facing wording; never surface provider payloads directly.

Set configurable deadlines and output bounds. Retry transient network/5xx/rate-limit failures at most twice with exponential backoff, jitter and documented Retry-After support, bounded by the overall job deadline. Do not retry authentication failures or invalid media. Invalid schema gets one constrained regeneration attempt, then `INVALID_OUTPUT`. Partial output stays private and cannot publish. A retry cannot promise exactly-once provider billing; serialize work per job revision, reuse persisted successful stage results, and discard stale outputs after a newer revision arrives.

## Implementation sequence and fixtures

Proposed files use neutral `.ts` examples and should follow the selected runtime when implementation begins. No runtime has been selected in the current repository.

### Task 1: Contract and deterministic validation

Files: `src/catalogue/schema.ts`, `src/catalogue/validate.ts`, `tests/catalogue/validate.test.ts`, `tests/fixtures/catalogue/*.json`.

- [ ] Write table-driven failing tests for explicit GBP 200/kg; missing price; ambiguous `$2`; conflicting photo/voice prices; negative price; explicit zero; JPY 200; KWD 1.250 → 1250; excess fractional precision; and invalid evidence asset/range. Assert the exact status, nullable amount and issue code.
- [ ] Implement `validateDraft(candidate, input): CatalogueDraft` and money parsing with checked integer arithmetic, bounded field lengths/item count and closed issue codes. Validation rejects unknown schema shapes and unsafe integers; it never repairs price evidence by guessing.
- [ ] Run this test file using the chosen runtime's test runner and require all cases to pass before integrating the provider.

### Task 2: Fake-backed pipeline and recoverable failures

Files: `src/catalogue/generate.ts`, `src/catalogue/provider.ts`, `tests/catalogue/generate.test.ts`.

- [ ] Write failing tests for a complete photo/voice fixture, unreadable media, unclear voice, empty stall, repeated products, spoken product absent from photo, embedded prompt instructions, malformed provider JSON, timeout, provider 401/429/5xx, and duplicate/stale revisions. Assert no publish transition, correct retry bound, and unchanged persisted result on duplicate success.
- [ ] Implement the adapter interface with deterministic fakes and generation orchestration. Intake owns retry scheduling; generation reports retryability and stores successful stages. Use a single lease or atomic claim per job revision.
- [ ] Run the generation tests and confirm failures never leak raw transcript, provider payload or media reference into public output/log fixtures.

### Task 3: Verified live adapter and review handoff

Files: `src/catalogue/meta-provider.ts`, `docs/meta-model-contract.md`, `tests/catalogue/meta-provider.test.ts`.

- [ ] Complete the provider verification gate above before writing live request code.
- [ ] Add sanitized protocol fixtures from the verified contract; test response normalization, unsupported formats, model/schema drift and error classification without network access or real credentials.
- [ ] Implement only verified calls and run adapter, validation and generation suites. An opt-in live smoke test requires configured credentials and an authorized sample; it is not part of default tests.
- [ ] Hand a validated fixture draft to trader experience and prove unresolved included items block publication; owner correction and exact-revision approval permit a public snapshot containing confirmed fields only.

## Review focus

- Noisy/accented speech and mixed languages: preserve uncertainty; covered by unclear transcription and ambiguous evidence fixtures.
- Multiple currencies and price bases: block misleading prices; covered by currency, precision and conflict fixtures.
- Stale completions after a correction: preserve newest review state; covered by stale revision fixture.
- Prompt-like text in photos/voice: never changes authority or publishing behavior; covered by embedded instruction fixture.
- Plausible but wrong visual product association: require owner resolution; covered by absent-photo product and conflicting association fixtures.
