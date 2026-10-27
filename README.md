# StallSnap

StallSnap builds a priced catalogue for a market trader from a stall photo and a voice note sent on WhatsApp.

## Before the event

**Before the event:** on the morning of kickoff day (Mon 26 Oct 2026, roughly 8am to 1pm UK time), the idea was planned and tested in a separate repo. None of that code, data or test material is in this repo. Everything here was written after kickoff at 4pm UK the same day.

## Status

Work in progress for the Meta Global AI Developer Hackathon 2026 (Indie developer track). Submissions are due Wed 4 Nov 2026, 9pm ET.

## Develop

Needs [Bun](https://bun.sh) 1.4.4. Use bun, never npm.

```bash
bun install
bun run ci          # typecheck, unit tests, messy-input suite
```

The messy-input suite in `test/messy/` holds every attack QA has made on what this README promises. CI runs it on every pull request.

Secrets go in the environment, never in the repo. `.env.example` lists the names the code reads, with no values.

## Build log

See [docs/build-log.md](docs/build-log.md).

## Licence

MIT. See [LICENSE](LICENSE).
