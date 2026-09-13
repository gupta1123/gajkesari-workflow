"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";

import { apiFetch } from "@/lib/api-client";
import { readPreferredTallyConnectionId } from "@/lib/tally-company-selection";

export type GlobalTallyConnection = {
  id: string;
  status: string;
  displayName?: string | null;
  lastCompanyName?: string | null;
  bridgeConnected?: boolean;
  tallyReachable?: boolean;
  companyLoaded?: boolean;
};

type TallyConnectionStatusValue = {
  connection: GlobalTallyConnection | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

const TallyConnectionStatusContext =
  createContext<TallyConnectionStatusValue | null>(null);

function connectionRank(connection: GlobalTallyConnection) {
  return (
    Number(connection.bridgeConnected) +
    Number(connection.tallyReachable) * 2 +
    Number(connection.companyLoaded) * 4
  );
}

function chooseConnection(connections: GlobalTallyConnection[]) {
  const preferredId = readPreferredTallyConnectionId();
  const preferred = connections.find(
    (connection) => connection.id === preferredId,
  );
  if (preferred) return preferred;

  return [...connections].sort(
    (left, right) => connectionRank(right) - connectionRank(left),
  )[0] ?? null;
}

export function TallyConnectionStatusProvider({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const shouldMonitor = pathname !== "/login";
  const [connection, setConnection] =
    useState<GlobalTallyConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (requestInFlight.current) return requestInFlight.current;

    const request = (async () => {
      try {
        const response = await apiFetch("/api/tally/connections", {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Could not read Tally status");

        const payload = (await response.json()) as {
          connections?: GlobalTallyConnection[];
        };
        setConnection(chooseConnection(payload.connections ?? []));
      } catch {
        setConnection(null);
      } finally {
        setLoading(false);
      }
    })();

    requestInFlight.current = request;
    try {
      await request;
    } finally {
      requestInFlight.current = null;
    }
  }, []);

  useEffect(() => {
    if (!shouldMonitor) {
      setConnection(null);
      setLoading(true);
      return;
    }

    void refresh();

    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh, shouldMonitor]);

  const value = useMemo(
    () => ({ connection, loading, refresh }),
    [connection, loading, refresh],
  );

  return (
    <TallyConnectionStatusContext.Provider value={value}>
      {children}
    </TallyConnectionStatusContext.Provider>
  );
}

export function useTallyConnectionStatus() {
  const value = useContext(TallyConnectionStatusContext);
  if (!value) {
    throw new Error(
      "useTallyConnectionStatus must be used inside TallyConnectionStatusProvider",
    );
  }
  return value;
}
