# Research ledger (append-only, committed)

The one variant log and held-out seal for this repository. `pnpm research` always reads and appends
here; `--out` only receives results. Commit both `.jsonl` files and their `.head` files after every
research run: the committed head is the anchor `gitCommittedHead` checks on every read, so dropping or
re-chaining lines (even with the head file rewritten) is refused as `LOG_TAMPERED` while the rewrite is
uncommitted. A rewrite committed as a new commit passes that local check; CI's ledger check
(`src/research-ledger-check.ts`) fails on it, because main's committed heads must stay in the chain and
main's held-out markers must stay unchanged. That check is advisory, not a required check (no branch
protection on main, and a PR runs its own copy of the workflow and checker), so a reviewer must look for
it. Outside git the anchor fails open (only the head file guards).

- `variants.jsonl`: every evaluated strategy (hashes, per-fold and pooled metrics; no symbols). Its
  distinct candidate hashes are the Holm family size, so it must never be reset.
- `heldout.jsonl`: REGISTER / EVALUATE / RESULT / UNSEAL records of the held-out seal; evaluation
  markers go in `heldout-markers/` and are committed too.

Seeded from the harness-v1 baseline (2026-11-24, scanner "main@f1605fe7 scanner-config-v0.1"):
5 variants, 5 registrations, held-out not evaluated.
Then the post-floor (v2) baseline (2026-11-24, derived scanner label
"7586e96ac8e4 scanner-v0.1 config-d003c0562045"): 5 more variants and 5 more registrations (same
held-out window), so 10 variants tried and a Holm family of 10; held-out still not evaluated.
