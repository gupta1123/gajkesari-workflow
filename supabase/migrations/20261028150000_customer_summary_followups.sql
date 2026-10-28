-- One reminder per customer listing all of their unpaid invoices, next to the
-- existing one-reminder-per-invoice rows. Customer rows keep the same send
-- claim and attempt flow; "invoices" holds the invoices the message lists.
alter table public.invoice_followup_pipelines
  add column if not exists kind text not null default 'invoice' check (kind in ('invoice', 'customer')),
  add column if not exists invoices jsonb check (invoices is null or jsonb_typeof(invoices) = 'array');
