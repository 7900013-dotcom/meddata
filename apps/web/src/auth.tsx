import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Me } from "./api";

const Ctx = createContext<{ me: Me | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void> }>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    const r = await api.get<{ user: Me | null }>("/api/me").catch(() => ({ user: null }));
    setMe(r.user);
    setLoading(false);
  }, []);
  const logout = useCallback(async () => {
    await api.send("POST", "/api/auth/logout");
    setMe(null);
  }, []);
  useEffect(() => void refresh(), [refresh]);
  return <Ctx.Provider value={{ me, loading, refresh, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
