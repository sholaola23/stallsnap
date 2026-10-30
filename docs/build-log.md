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

- First live run (Shola's Mac, three third-party test photos, $0.096): 63 products found and cut out, none skipped. The sandal wall hit the 32-product limit and missed the right-hand wall, so the limit went up to 64.
- Sandal wall re-run with the 64 limit ($0.005): Muse Spark listed 60 products, under the limit, and SAM cut out all 60. The right-hand wall is now covered; the gap in the middle is the shop doorway. Some sandals on the bottom right rows still have no mask, and four masks cover under 40% of their box.
- Stage 2, voice note to prices (`src/voice/`, `src/pricing/`):
  - ffmpeg turns the WhatsApp voice note (Ogg Opus) into 24 kHz mono WAV, and Muse Voice Transcribe reads it, biased to English and to the product names from the photo.
  - Muse Spark prices the products with four tools: `set_price`, `ask_trader`, `not_in_photo` and `clear_price`. Our code checks every call before it changes the list.
  - A later voice note corrects the list; the reply the trader reads is written by our code, not the model.
  - `bun run price <summary.json> <note>` prices the products from a photo run.
- QA round 1 fixes to stage 2: the price guard now reads spoken numbers ("five hundred", "two thousand five"), matches the quote on whole words (two or more), and reads a quote covering two products product by product. A quote with no price in it, or two prices and no product word, is refused and the trader is asked instead. New tools `remove_product` ("I no dey sell am") and `rename_product` ("number 4 na egusi", using only the trader's words). The price list numbers products as the photo list does.
- QA round 2 fixes: the guard checks the whole number in the note, so a quote that stops at "two thousand" of "two thousand five hundred" is refused. With several prices in a quote it takes the one in the same clause as the product word, then "500 for Peak", then the nearest, and refuses a tie.

- Stage 3, web catalogue (`src/catalogue/`, `src/server.ts`):
  - Publishing writes the price list and one card per product under a random 12-character link; only products with a real cut-out are published, and unpriced ones say "Ask for price".
  - The page is plain HTML and CSS with no scripts, light and dark, sized for cheap phones. 0 axe violations and no sideways scroll at 320 to 1280px (synthetic test data).
  - The Bun server serves `/c/<link>` and its pictures, with a strict content security policy.

### Decisions

| Decision | Why |
|---|---|
| Spark finds products, then SAM gets box prompts | SAM takes one noun phrase per request, and a stall has many product types. One Spark call plus one SAM call per 16 products is cheaper and returns names with the masks. |
| One box per product line, not per item | A catalogue needs one clear picture of each product, not every tin in a stack. |
| Photo shrunk to 1600px and turned upright before any call | Spark boxes, SAM masks and the cut-outs then share one set of pixel coordinates, and requests stay small. |
| A mask covering under 12% of its box is skipped | A sliver usually means SAM caught an edge or a shadow; showing it would look broken. The product is reported as skipped, never filled in. |
| Every price must quote the trader's own words (whole words, two or more), and the number said for that product, written or spoken, must equal the price | Stops the model setting a price nobody said. A wrong price is worse than a missing one; if the code can't read the number, the trader is asked. |
| A product the trader doesn't sell is removed, not shown as "Ask for price" | The public page must only show what the trader stocks. |
| A new product name must use only words the trader said | Spark can misname loose goods; the trader corrects it, the model can't invent one. |
| Things priced but not in the photo are listed back, never added | StallSnap only shows products the trader actually photographed. |
| Voice biased to English plus the photo's product names | Pidgin isn't one of the 25 supported languages; it is English-based, and the names help with brand words. |
| The model's tool loop stops after 6 turns | Bounds the cost of one voice note even if the model keeps calling tools. |
| Catalogue page has no JavaScript | Loads fast on mobile data and leaves nothing to break or exploit. |
