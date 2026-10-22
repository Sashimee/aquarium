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
import { speciesNameMap, type SpeciesNames } from '../sync/speciesNames';
import { INITIAL_STATE, type SessionState } from '../sync/state';
import type { TankSession } from '../sync/session';
import { useApi, useAuth, useBridge, useRoute } from './context';
import { isReadOnlyView } from './router';

interface SessionContextValue {
  session: TankSession | null;
  loading: boolean;
}

const SessionContext = createContext<SessionContextValue>({ session: null, loading: false });

const LOADING_STATE: SessionState = { ...INITIAL_STATE, phase: 'loading' };
const noopSubscribe = () => () => undefined;

/** Null until a verified user needs a saved tank; the persistence code is fetched only then. */
export function useOptionalSession(): TankSession | null {
  return useContext(SessionContext).session;
}

export function useTankSession(): TankSession {
  const session = useOptionalSession();
  if (!session) throw new Error('useTankSession needs a loaded session; check useOptionalSession');
  return session;
}

export function useSessionState(): SessionState {
  const { session, loading } = useContext(SessionContext);
  const getState = session ? session.getState : () => (loading ? LOADING_STATE : INITIAL_STATE);
  return useSyncExternalStore(session ? session.subscribe : noopSubscribe, getState, getState);
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
  const viewing = isReadOnlyView(useRoute());
  const verified = !viewing && status !== 'loading' && user?.emailVerified === true;
  const [needed, setNeeded] = useState(false);
  useEffect(() => {
    if (verified) setNeeded(true);
  }, [verified]);

  // Visitors without a verified account never get a session, and the fish wait for the session
  // to say whether a saved tank is coming.
  useEffect(() => {
    if (viewing || status === 'loading' || verified || session) return;
    interaction.emit('tank:none', {});
  }, [viewing, status, verified, session, interaction]);

  // Built in an effect so StrictMode's mount, unmount, mount cycle gets a fresh, undisposed session.
  useEffect(() => {
    if (!needed) return;
    let cancelled = false;
    let created: TankSession | null = null;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void created?.onVisible();
    };
    void import('../sync/session').then(({ TankSession }) => {
      if (cancelled) return;
      const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
      created = new TankSession({ api, interaction, ...(storage ? { storage } : {}) });
      document.addEventListener('visibilitychange', onVisible);
      setSession(created);
    });
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      created?.dispose();
      setSession(null);
    };
    // Once needed, the session outlives sign-in changes and is only rebuilt for a new api or bus.
  }, [api, interaction, needed]);

  const identity = status === 'loading' ? null : user ? `${user.id}:${user.emailVerified}` : '';
  useEffect(() => {
    if (!session || identity === null) return;
    void session.setUser(user);
  }, [session, identity]);

  const value = useMemo(() => ({ session, loading: verified && !session }), [session, verified]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
