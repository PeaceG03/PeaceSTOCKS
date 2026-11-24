# Research ledger (append-only, committed)

The one variant log and held-out seal for this repository. `pnpm research` always reads and appends
here; `--out` only receives results. Commit both `.jsonl` files and their `.head` files after every
research run: the committed head is the anchor `gitCommittedHead` checks on every read, so dropping or
re-chaining lines (even with the head file rewritten) is refused as `LOG_TAMPERED`.

- `variants.jsonl`: every evaluated strategy (hashes, per-fold and pooled metrics; no symbols). Its
  distinct candidate hashes are the Holm family size, so it must never be reset.
- `heldout.jsonl`: REGISTER / EVALUATE / RESULT / UNSEAL records of the held-out seal; evaluation
  markers go in `heldout-markers/` and are committed too.

Seeded from the harness-v1 baseline (2026-11-24, scanner "main@f1605fe7 scanner-config-v0.1"):
5 variants, 5 registrations, held-out not evaluated.
