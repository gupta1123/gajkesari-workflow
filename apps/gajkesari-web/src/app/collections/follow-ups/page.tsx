import { AppShell } from "@/components/dashboard/AppShell";
import { FollowUpPipelines } from "@/components/collections/FollowUpPipelines";

export default function FollowUpsRoute() {
  return (
    <AppShell>
      <FollowUpPipelines />
    </AppShell>
  );
}
