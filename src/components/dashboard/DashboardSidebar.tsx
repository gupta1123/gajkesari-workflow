"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import {
  Landmark,
  LogOut,
  ChevronsUpDown,
  Settings,
  ChevronLeft,
} from "lucide-react";

import styles from "./DashboardSidebar.module.css";

/* ── Sectioned nav ───────────────────────────── */
const SIDEBAR_SECTIONS = [
  {
    id: "bank-statement",
    title: "Bank Statement",
    items: [
      { href: "/bank-statements", label: "Bank Statement", icon: Landmark },
    ],
  },
];

function isActivePath(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

interface UserInfo {
  name: string;
  email: string;
}

export interface DashboardSidebarProps {
  user?: UserInfo;
}

export function DashboardSidebar({ user }: DashboardSidebarProps) {
  const pathname = usePathname();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const userRowRef = useRef<HTMLDivElement>(null);

  const displayUser: UserInfo = user ?? {
    name: "Admin",
    email: "admin@gajkesari.local",
  };

  const initials = displayUser.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ""}`}>
      {/* ── BRAND ── */}
      <div className={`${styles.brandRow} ${collapsed ? styles.collapsed : ""}`}>
        <div className={styles.brandLeft}>
          <div className={styles.brandLogoMark}>P</div>
          <span className={styles.brandTitle}>Gajkesari</span>
        </div>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={styles.collapseBtn}
          type="button"
        >
          <ChevronLeft className={`h-4 w-4 transition-transform ${collapsed ? "rotate-180" : ""}`} />
        </button>
      </div>

      {/* ── DESKTOP SECTIONED NAVIGATION ── */}
      <nav className={`${styles.navSection} ${styles.desktopNav}`}>
        {SIDEBAR_SECTIONS.map((section) => (
          <div key={section.id} className={styles.sectionGroup}>
            {!collapsed && <h3 className={styles.sectionHeader}>{section.title}</h3>}
            <ul className={styles.navList} role="list">
              {section.items.map((item) => {
                const active = isActivePath(pathname, item.href);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
                    >
                      <div className={styles.navItemLeft}>
                        {active && <div className={styles.activeBar} />}
                        <Icon className={styles.navIcon} />
                        <span className={styles.navTitle}>{item.label}</span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* ── MOBILE FLAT NAVIGATION ── */}
      <nav className={`${styles.navSection} ${styles.mobileNav}`}>
        <ul className={styles.navList} role="list">
          {SIDEBAR_SECTIONS.flatMap((s) => s.items).map((item) => {
            const active = isActivePath(pathname, item.href);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
                >
                  <div className={styles.navItemLeft}>
                    {active && <div className={styles.activeBar} />}
                    <Icon className={styles.navIcon} />
                    <span className={styles.navTitle}>{item.label}</span>
                  </div>
                </Link>
              </li>
            );
          })}
          <li className={styles.mobileLogoutItem}>
            <form action="/auth/signout" method="post">
              <button type="submit" className={`${styles.navItem} ${styles.mobileLogoutButton}`}>
                <div className={styles.navItemLeft}>
                  <LogOut className={styles.navIcon} />
                  <span className={styles.navTitle}>Logout</span>
                </div>
              </button>
            </form>
          </li>
        </ul>
      </nav>

      <div className={styles.spacer} />

      {/* ── USER ROW (opens popover) ── */}
      <div className={styles.userRowWrapper} ref={userRowRef}>
        {/* Logout Popover */}
        {popoverOpen && (
          <>
            {/* Backdrop to close */}
            <div
              className={styles.popoverBackdrop}
              onClick={() => setPopoverOpen(false)}
            />
            <div className={styles.popover}>
              <div className={styles.popoverHeader}>
                <div className={styles.popoverUserAvatar}>{initials}</div>
                <div className={styles.popoverUserInfo}>
                  <div className={styles.popoverUserName}>{displayUser.name}</div>
                  <div className={styles.popoverUserEmail}>{displayUser.email}</div>
                </div>
              </div>
              
              <div className={styles.popoverMenu}>
                <Link href="/settings" className={styles.popoverMenuItem} onClick={() => setPopoverOpen(false)}>
                  <Settings size={14} className={styles.popoverMenuIcon} />
                  <span>Settings</span>
                </Link>
              </div>

              <div className={styles.popoverFooter}>
                <form action="/auth/signout" method="post" className="w-full">
                  <button type="submit" className={styles.popoverLogoutBtn}>
                    <LogOut size={14} />
                    <span>Sign out</span>
                  </button>
                </form>
              </div>
            </div>
          </>
        )}

        <div
          className={styles.userRow}
          onClick={() => setPopoverOpen((o) => !o)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && setPopoverOpen((o) => !o)}
          aria-expanded={popoverOpen}
          aria-haspopup="true"
        >
          <div className={styles.userLeft}>
            <div className={styles.userAvatar}>{initials}</div>
            <div className={styles.userInfo}>
              <span className={styles.userName}>{displayUser.name}</span>
              <span className={styles.userEmail}>{displayUser.email}</span>
            </div>
          </div>
          <ChevronsUpDown size={14} className={styles.userChevron} />
        </div>
      </div>
    </aside>
  );
}
