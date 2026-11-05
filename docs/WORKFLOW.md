# How we work: live code, fixes and new features

Written 2026-11-05. Re-check the "Where things stand" table before relying on it.

## The idea

There is **one repo** (`gupta1123/gajkesari-workflow`). `main` is the code the client
uses. Every change starts from `main` and goes back into `main`. We do not keep two
long-lived copies of the product.

## What "live" means

- **Web (Netlify):** deploys automatically when `main` changes on GitHub.
  Pushing to `main` is a live deploy.
- **API (Heroku `gajkesari-workflow`):** deployed by hand with a push to the `heroku`
  remote. Nothing deploys it automatically.
- **Order:** deploy Heroku first, then merge to `main` (so the web never calls an API
  that does not have the new code yet).
- **Database (Supabase):** migrations are written as `.sql` files in
  `supabase/migrations/`. The owner applies them by hand. Code never applies them.
  Apply the SQL before deploying code that needs it.

## Folders on disk

All of these are the same repo (Git worktrees). Each folder has one branch.

| Folder | Branch | Use it for |
| --- | --- | --- |
| `GajkesariAIagents` | `main` | The live copy. Hotfixes start here. |
| `GajkesariAIagents-features` | `feature/cd-payment-followups` | Building and testing new features. |

Rules:

- A folder name must say what it is for. If a folder points somewhere else, rename it.
- Before editing, run `git branch --show-current` and check it is the branch you expect.
- Experiments (for example Rust) and old zip copies live outside this folder, or are
  deleted once nobody needs them.

## Branches

- One short-lived branch per piece of work: `fix/<what>` or `feature/<what>`.
- Cut it from `main`. When it is tested and merged, delete it.
- Push every branch to GitHub while working, so nothing exists only on one computer.
- Every client fix on `main` must also reach the features branch (merge `main` into it)
  so the two never drift apart.

## Unfinished features go in switched off

Where possible merge a feature into `main` early, hidden behind a switch, instead of
keeping it on a side branch for weeks. Follow-ups already works this way:

- `FOLLOWUPS_ENABLED=true` turns the routes on (otherwise they return 404).
- `FOLLOWUPS_ALLOWED_OWNERS` limits it to named user ids (`*` = everyone).
- There is no sidebar link until the feature is enabled for everyone.

## Testing before anything goes live

1. Test on the local machine (`npm run dev:local`, or `dev:web` and `dev:api`).
2. Local testing uses the live Supabase database, so be careful with writes.
3. Tally test company is **Solution Nyx**. Send tiny filtered requests, one at a time.
   Never export the whole company; it froze Tally once.
4. Keep WhatsApp keys out of local testing. Do not run the local worker against the
   live database.
5. Checks before merging: `npm run typecheck`, `npm run test:tally-bridge`,
   `npm run test:tally-live-gateway`, and `npm run check:protected` on the features
   branch.
6. After deploying, check once on the live system.

## Bank statements are protected

Bank statement posting writes to the client's Tally and works in production. New
feature work must not edit those files. On the features branch,
`npm run check:protected` fails if it does, and CI runs it
(`.github/workflows/protect-bank-statements.yml`).

## Releasing a feature

1. Apply the feature's SQL migrations in Supabase, in the order stated in its docs.
2. Merge `main` into the feature branch and re-run the checks.
3. Deploy Heroku (push the commit to the `heroku` remote).
4. Merge the feature into `main` (this deploys the web).
5. Tag the live commit, for example `live-2026-11-20`.

## Where things stand (2026-11-05)

| Item | State |
| --- | --- |
| `main` (0bce5ac) | Contains everything in `heroku/main` (0e87bbc, 2026-10-25) plus 14 connector commits for 0.1.93. |
| `feature/cd-payment-followups` (03b93d2) | 49 commits ahead of `main`, nothing missing from `main`. Pushed to GitHub on 2026-11-05. |
| What is really deployed | Not verified. Heroku is at 0e87bbc by its git ref; the Netlify commit was not checked. |
| Follow-ups and Cash Discount | Built, not released. Migrations not applied. |

Old branches that are finished or replaced (safe to delete once confirmed):
`codex/production-fixes`, `integration/connector-0.1.93`, `fix/bridge-version-0.1.93`,
`feature/payment-followups-cash-discount`, `feature/live-customer-scope-analysis`,
`codex/checkpoint-*`, `master`. Check `codex/deploy-bill-allocation` first: it has one
commit that is not in `main`.

## Related repos (not part of this one)

- `nyx-workflows` (`gupta1123/nyx-wokflows`): separate repo for Nyx Solution / Polaad.
- Kalika: where the follow-ups idea was ported from.
- `gajkesari-mobile`: the mobile app, its own repo.
