import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";
import styles from "./AppShell.module.css";

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  return (
    <div className={styles.shell}>
      <DashboardSidebar />

      <main className={styles.main}>{children}</main>
    </div>
  );
}
