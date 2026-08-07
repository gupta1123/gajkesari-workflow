import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";
import styles from "./AppShell.module.css";

type AppShellProps = {
  children: React.ReactNode;
  defaultSidebarCollapsed?: boolean;
};

export function AppShell({ children, defaultSidebarCollapsed = false }: AppShellProps) {
  return (
    <div className={styles.shell}>
      <DashboardSidebar defaultCollapsed={defaultSidebarCollapsed} />

      <main className={styles.main}>{children}</main>
    </div>
  );
}
