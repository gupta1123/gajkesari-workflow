-- Delivery reports from MSG91 (sent / delivered / read / failed) for payment
-- reminders. `status` keeps meaning "did the provider accept the request";
-- these columns record what happened to the message afterwards.
begin;

alter table public.invoice_followup_attempts
  add column if not exists delivery_status text
    check (delivery_status is null or delivery_status in ('sent', 'delivered', 'read', 'failed')),
  add column if not exists delivery_reason text,
  add column if not exists delivery_updated_at timestamptz;

-- The webhook looks an attempt up by MSG91's request id.
create index if not exists invoice_followup_attempts_provider_reference
  on public.invoice_followup_attempts (provider_reference)
  where provider_reference is not null;

commit;
