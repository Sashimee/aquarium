import type { Tank } from '@aquarium/shared';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { speciesNameMap, type SpeciesNames } from '../sync/life';
import { TankSession, type SessionState } from '../sync/session';
import { useApi, useAuth, useBridge } from './context';

const SessionContext = createContext<TankSession | null>(null);

export function useTankSession(): TankSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useTankSession needs a <SessionProvider> ancestor');
  return session;
}

export function useSessionState(): SessionState {
  const session = useTankSession();
  return useSyncExternalStore(session.subscribe, session.getState);
}

export function useActiveTank(): Tank | null {
  const state = useSessionState();
  return state.tanks.find((t) => t.id === state.activeId) ?? null;
}

export function useSpeciesNames(): SpeciesNames {
  const { species } = useSessionState();
  return useMemo(() => speciesNameMap(species), [species]);
}

/** Owns the persistence session and keeps it in step with who is signed in. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { interaction } = useBridge();
  const { user, status } = useAuth();
  const [session, setSession] = useState<TankSession | null>(null);

  // Built in an effect so StrictMode's mount, unmount, mount cycle gets a fresh, undisposed session.
  useEffect(() => {
    const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
    const created = new TankSession({ api, interaction, ...(storage ? { storage } : {}) });
    setSession(created);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void created.onVisible();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      created.dispose();
      setSession(null);
    };
  }, [api, interaction]);

  const identity = status === 'loading' ? null : user ? `${user.id}:${user.emailVerified}` : '';
  useEffect(() => {
    if (!session || identity === null) return;
    void session.setUser(user);
  }, [session, identity]);

  if (!session) return null;
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
