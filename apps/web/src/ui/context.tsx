import type { SignInRequest, SignUpRequest, User } from '@aquarium/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { EngineEvents, EventBus } from '../engine/events';
import type { CameraMode } from '../interaction/camera';
import type { InteractionEvents } from '../interaction/events';
import { createApiClient, type ApiClient } from './api';
import { currentHref, guardRoute, parseRoute, subscribeToLocation, type Route } from './router';

export interface UiBridge {
  engine: EventBus<EngineEvents>;
  interaction: EventBus<InteractionEvents>;
}

const BridgeContext = createContext<UiBridge | null>(null);
const ApiContext = createContext<ApiClient | null>(null);

export function useBridge(): UiBridge {
  const bridge = useContext(BridgeContext);
  if (!bridge) throw new Error('useBridge needs a <UiProviders> ancestor');
  return bridge;
}

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi needs a <UiProviders> ancestor');
  return api;
}

export function useCameraMode(): CameraMode {
  const { interaction } = useBridge();
  const [mode, setMode] = useState<CameraMode>('orbit');
  useEffect(() => interaction.on('camera:mode-changed', (e) => setMode(e.mode)), [interaction]);
  return mode;
}

export function useEngineReady(): EngineEvents['engine:ready'] | null {
  const { engine } = useBridge();
  const [info, setInfo] = useState<EngineEvents['engine:ready'] | null>(null);
  useEffect(() => engine.on('engine:ready', setInfo), [engine]);
  return info;
}

export interface AuthState {
  status: 'loading' | 'ready';
  user: User | null;
  signIn(input: SignInRequest): Promise<void>;
  signUp(input: SignUpRequest): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth needs a <UiProviders> ancestor');
  return auth;
}

function AuthProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [user, setUser] = useState<User | null>(null);

  const refresh = useCallback(async () => {
    try {
      setUser(await api.me());
    } catch (error) {
      console.error('Could not read the current session', error);
      setUser(null);
    } finally {
      setStatus('ready');
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      refresh,
      async signIn(input) {
        await api.signIn(input);
        await refresh();
      },
      signUp: (input) => api.signUp(input),
      async signOut() {
        await api.signOut();
        setUser(null);
      },
    }),
    [api, refresh, status, user],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function UiProviders({
  bridge,
  api,
  children,
}: {
  bridge: UiBridge;
  api?: ApiClient;
  children: ReactNode;
}) {
  const client = useMemo(() => api ?? createApiClient(), [api]);
  return (
    <BridgeContext.Provider value={bridge}>
      <ApiContext.Provider value={client}>
        <AuthProvider>{children}</AuthProvider>
      </ApiContext.Provider>
    </BridgeContext.Provider>
  );
}

export function useRoute(): Route {
  const { user, status } = useAuth();
  const href = useSyncExternalStore(subscribeToLocation, currentHref);
  const route = parseRoute(href);
  return status === 'loading' ? route : guardRoute(route, user);
}
