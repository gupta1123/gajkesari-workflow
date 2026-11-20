-- Preserve the installed command allowlist, including commands from earlier releases.
do $$
declare existing_expression text;
begin
  select pg_get_expr(conbin, conrelid) into strict existing_expression
    from pg_constraint
    where conrelid = 'public.tally_bridge_commands'::regclass
      and conname = 'tally_bridge_commands_command_type_check' and contype = 'c';
  alter table public.tally_bridge_commands drop constraint tally_bridge_commands_command_type_check;
  execute format(
    'alter table public.tally_bridge_commands add constraint tally_bridge_commands_command_type_check check ((%s) or command_type in (%L, %L))',
    existing_expression, 'get_connector_diagnostics', 'reconnect_live_channel'
  );
end $$;

-- Support operations must pass the API admin and browser-binding checks.
-- Service-role queue workers bypass RLS. Direct client roles keep their existing access to other command types.
create policy connector_support_api_only on public.tally_bridge_commands
  as restrictive for all to public
  using (command_type not in ('get_connector_diagnostics', 'reconnect_live_channel'))
  with check (command_type not in ('get_connector_diagnostics', 'reconnect_live_channel'));
