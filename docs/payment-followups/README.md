# Payment follow-ups & cash-discount upgrades

Branch: `feature/payment-followups-cash-discount` (from `2f681fd`). Ported in spirit
from the Kalika repo, rewritten Gajkesari-native (`owner_user_id` +
`company_dataset_id` scoping, no Team & Access tables).

**Rule: bank statements are not touched.** Everything here is a new file, table or
route. `npm run check:protected` fails if a protected bank path is edited; CI runs it
(`.github/workflows/protect-bank-statements.yml`).

## What exists

| Piece | Where |
| --- | --- |
| Follow-up tables + atomic send RPCs | `supabase/migrations/20261020120000_payment_followups.sql` |
| Collections tables, only if missing | `supabase/migrations/20261020120100_collections_tables_if_missing.sql` |
| Pure plan logic (+tests) | `apps/api/src/lib/followups/pipeline.ts` |
| RTGS terms and follow-up timing (+tests) | `.../followups/payment-terms.ts`, `payment-follow-up.ts` |
| Rollout gate (+tests) | `.../followups/access.ts` |
| WhatsApp templates / send | `.../followups/messages.ts` |
| Live outstanding read (gateway client) | `.../followups/live-read.ts` |
| Routes | `/api/collections/follow-ups/pipelines`, `.../pipelines/[id]`, `/api/settings/payment-reminders` |
| Pages | `/collections/follow-ups`, `/settings/payment-reminders` |

## Safety properties

- **Operator-initiated only.** No background sender exists; the attempts table has
  `check (automatic = false)`.
- **Every send re-checks Tally.** Send reads open bills live, then claims the send in
  `followup_claim_send` (row lock, revision check, 5-minute verification window,
  connector-session check). An unclear provider answer parks the reminder as
  `uncertain` and is never resent automatically.
- **A missing bill is "review", never "settled".**
- **Dataset isolation.** Every row and query is scoped to the owner and to the datasets
  paired with the caller's browser binding.
- **Fails closed.** Routes return 404 unless `FOLLOWUPS_ENABLED=true` and the user id is
  in `FOLLOWUPS_ALLOWED_OWNERS` (`*` = everyone).

## Rollout

1. Run `docs/payment-followups/phase1-readonly-db-check.sql` (read-only) in Supabase.
2. Apply `20261020120000_payment_followups.sql`. Apply `20261020120100_...` only if the
   check shows `cash_discount_rules`, `debit_note_proposals` or
   `collections_analysis_cache` missing.
3. Set env: `FOLLOWUPS_ENABLED=true`, `FOLLOWUPS_ALLOWED_OWNERS=<your user id>`,
   `FOLLOWUP_WHATSAPP_TEMPLATES_JSON` (see `messages.ts`), `MSG91_AUTHKEY`,
   `MSG91_WHATSAPP_NUMBER`.
4. Send one reminder to your own number against one invoice (keep Tally requests small).
5. After each phase re-run the bank-statement regression: upload, review, post, verify.

## Deliberately not done

- **RTGS rules are not wired into the debit-note analyser (decision).**
  `cash-discount-narration.ts` stays authoritative for debit-note proposals ("X% within N
  days" narrations); changing it would change production behaviour. `payment-terms.ts`
  (ADVANCE RTGS 1.5%, SAME DAY RTGS 1%) only decides when follow-up starts: if an invoice
  narration is supplied when adding a reminder, the first reminder is never due before the
  RTGS payment deadline has passed.
- **No sidebar link (decision).** The sidebar is shown to everyone and the pages 404 for
  owners not on the allowlist. Open `/collections/follow-ups` and
  `/settings/payment-reminders` by URL; add links when the feature is enabled for all.
- **Customer scope and live-only analysis are built without touching the shared live
  path** (`20261020120200_collections_customer_scope.sql`,
  `/api/collections/customer-scope`, `/api/collections/follow-ups/live-candidates`).
  They reuse the existing read-only `fetch_customer_open_bills` gateway operation, so
  the gateway, connector and live-session route are unchanged and no connector release
  is needed. Reads are live (nothing cached or written), limited to customers saved in
  the scope, and at most 10 customers per read so Tally gets small filtered requests.
  Kalika's full-company scan is intentionally not ported.
- **Kalika's `queryPurpose: 'payment_followup'` settled-by-proof branch.** The bridge
  does not implement it, so a bill missing from Tally goes to review.

## Baseline (before this work)

Bridge suite 117/117, gateway 3/3, other libs 210/211 (one known failure in
`bank-statement-ledger-dropdown.test.mjs`, skipped by name in CI), typecheck green.
