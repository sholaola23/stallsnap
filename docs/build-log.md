# Build log

Dated record of what was built and when, for the hackathon rule that only work from Mon 26 Oct to Wed 4 Nov 2026 counts. Times are UK.

## Mon 26 Oct 2026

- 16:49: repo created with the README "Before the event" note and the MIT licence.
- 21:12: WhatsApp test number set-up recorded in `docs/whatsapp-setup.md` (setting names only).

## Fri 30 Oct 2026

- Stage 1, stall photo to cut-outs (`src/image/`, `src/meta/`):
  - Meta Model API client that streams every call and caches the answer on disk, so reruns are free.
  - Spend guard: paid calls are off unless `STALLSNAP_LIVE=1`, with a per-run call cap and a daily dollar cap kept in a local ledger.
  - Muse Spark lists each product line on the stall, with a box around one clear example (perception grounding, JSON schema output).
  - SAM 3.1 turns those boxes into masks (box prompts, up to 16 objects a request).
  - Each product is cut from the trader's own photo onto a transparent background and a white catalogue card. Nothing is generated.
  - `bun run cutouts <photo>` writes the cut-outs, cards, a mask overlay and a summary with the spend.
  - Tests use a synthetic photo and a fake API; CI never makes a paid call.

### Decisions

| Decision | Why |
|---|---|
| Spark finds products, then SAM gets box prompts | SAM takes one noun phrase per request, and a stall has many product types. One Spark call plus one SAM call per 16 products is cheaper and returns names with the masks. |
| One box per product line, not per item | A catalogue needs one clear picture of each product, not every tin in a stack. |
| Photo shrunk to 1600px and turned upright before any call | Spark boxes, SAM masks and the cut-outs then share one set of pixel coordinates, and requests stay small. |
| A mask covering under 12% of its box is skipped | A sliver usually means SAM caught an edge or a shadow; showing it would look broken. The product is reported as skipped, never filled in. |
