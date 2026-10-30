# StallSnap

StallSnap builds a priced catalogue for a market trader from a stall photo and a voice note sent on WhatsApp.

## Before the event

Before the hackathon kickoff (16:00 UK, Mon 26 Oct 2026), there were design notes, an idea spike, a day-one test and early prototype code for StallSnap in a separate repo. None of that is in this repo. Everything here was written after kickoff, and the dated [build log](docs/build-log.md) shows when.

## How it works

| Step | Model | What it does |
|---|---|---|
| Find the products | Muse Spark 1.3 | Lists each product line on the stall with a box around one clear example |
| Cut them out | SAM 3.1 | Turns each box into a pixel mask; each product is cut from the trader's own photo |
| Hear the prices | Muse Voice Transcribe | Turns the voice note into text, biased to the product names from the photo |
| Match the prices | Muse Spark (tool calls) | Sets each price with the trader's own words as proof, and asks about anything unpriced |
| Catalogue page | | A public web page per trader, one card per product with its price, shared as a link |
| WhatsApp loop | WhatsApp Cloud API | The trader sends a photo and a voice note, replies YES, and gets the link back |

Every picture in a catalogue comes from the trader's photo. StallSnap never generates a product the trader doesn't stock.

## Setup

You need [Bun](https://bun.sh) 1.4.4.

```bash
bun install
bun run check        # typecheck and tests; makes no paid calls
```

To run on a real photo, copy `.env.example` to `.env` and add your Meta Model API key. Never commit `.env`.

```bash
set -a; . ./.env; set +a
STALLSNAP_LIVE=1 bun run cutouts path/to/stall.jpg
```

Then price those products from a voice note (or a `.txt` transcript). Voice notes need `ffmpeg`.

```bash
STALLSNAP_LIVE=1 bun run price out/stall/summary.json note.ogg
```

The cut-out command writes `out/<photo name>/`: one transparent PNG and one white catalogue card per product, `overlay.jpg` with the masks drawn on the photo, and `summary.json` with what was found, what was skipped and what the run cost.

Run the server with `bun src/server.ts` (port 3000, or `PORT`). Catalogues live under `data/catalogues/`, or `$STALLSNAP_DATA_DIR/catalogues`.

With the WhatsApp settings from `.env.example` set, the same server answers the webhook at `/webhook`. See [docs/whatsapp-setup.md](docs/whatsapp-setup.md). The `Dockerfile` builds it for Railway; mount a volume at `/data`.

## Spend limits

Every Meta API call is paid, so the client guards each one:

| Setting | Default | Effect |
|---|---|---|
| `STALLSNAP_LIVE` | `0` | Paid calls only happen when this is `1` |
| `STALLSNAP_MAX_CALLS` | `10` | Most paid calls one command may make |
| `STALLSNAP_DAILY_CAP_USD` | `2` | Refuses a call that would take today's estimated spend (UTC day, this machine) past this |

Answers are cached in `.cache/meta/` by request, so running the same photo again costs nothing. `bun run spend` shows today's estimated spend.

## Licence

MIT. See [LICENSE](LICENSE).
