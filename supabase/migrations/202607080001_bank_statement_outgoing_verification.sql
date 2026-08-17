do $$
begin
  if to_regclass('public.tally_bridge_commands') is not null then
    alter table public.tally_bridge_commands
      drop constraint if exists tally_bridge_commands_command_type_check;

    alter table public.tally_bridge_commands
      add constraint tally_bridge_commands_command_type_check
      check (
        command_type in (
          'alter_ledger',
          'create_ledger',
          'sync_masters',
          'post_bank_voucher',
          'fetch_customer_open_bills',
          'create_debit_note',
          'verify_bank_transaction'
        )
      );
  end if;
end
$$;
