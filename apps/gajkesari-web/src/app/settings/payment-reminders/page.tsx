import { AppShell } from "@/components/dashboard/AppShell";
import { CollectionsSettings } from "@/components/collections/CollectionsSettings";

export default function PaymentReminderSettingsRoute() {
  return (
    <AppShell>
      <CollectionsSettings initial="reminders" />
    </AppShell>
  );
}
