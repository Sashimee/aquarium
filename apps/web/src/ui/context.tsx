import type { Biome, SignInRequest, SignUpRequest, User } from '@aquarium/shared';
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
import { parseBiome } from '../scene/options';
import type {
  DecorViewState,
  InteractionEvents,
  PlayTool,
  SaveStatus,
} from '../interaction/events';
import { ApiRequestError, createApiClient, type ApiClient } from './api';
import {
  currentHref,
  guardRoute,
  navigate,
  parseRoute,
  redirectFor,
  subscribeToLocation,
  type Route,
} from './router';

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

export function useLatest<Events extends object, K extends keyof Events>(
  bus: EventBus<Events>,
  type: K,
): Events[K] | undefined {
  const [value, setValue] = useState<Events[K] | undefined>(() => bus.peek(type));
  useEffect(() => {
    const off = bus.on(type, setValue);
    setValue(bus.peek(type));
    return off;
  }, [bus, type]);
  return value;
}

export function useCameraMode(): CameraMode {
  const { interaction } = useBridge();
  return useLatest(interaction, 'camera:mode-changed')?.mode ?? 'orbit';
}

export function useDemoBiome(): Biome {
  const { interaction } = useBridge();
  const latest = useLatest(interaction, 'demo:biome-changed');
  return latest?.biome ?? parseBiome(window.location.search);
}

export function usePlayTool(): PlayTool {
  const { interaction } = useBridge();
  return useLatest(interaction, 'play:tool-changed')?.tool ?? 'tap';
}

export function useDecorState(): DecorViewState | null {
  const { interaction } = useBridge();
  return useLatest(interaction, 'decor:state') ?? null;
}

export function useDecorLoadError(): string | null {
  const { interaction } = useBridge();
  return useLatest(interaction, 'decor:load-failed')?.message ?? null;
}

export function useDecorSaveState(): { status: SaveStatus; message: string | null } {
  const { interaction } = useBridge();
  return useLatest(interaction, 'decor:save-state') ?? { status: 'idle', message: null };
}

export function useEngineReady(): EngineEvents['engine:ready'] | null {
  const { engine } = useBridge();
  return useLatest(engine, 'engine:ready') ?? null;
}

export interface AuthState {
  status: 'loading' | 'ready';
  user: User | null;
  signIn(input: SignInRequest): Promise<void>;
  signUp(input: SignUpRequest): Promise<void>;
  signInWithPasskey(): Promise<void>;
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
        const signedIn = await api.me();
        if (!signedIn) {
          throw new ApiRequestError(
            401,
            'unauthenticated',
            'You were signed in, but the session was not kept. Check that your browser accepts cookies and try again.',
          );
        }
        setUser(signedIn);
      },
      signUp: (input) => api.signUp(input),
      async signInWithPasskey() {
        await api.signInWithPasskey();
        const signedIn = await api.me();
        if (!signedIn) {
          throw new ApiRequestError(
            401,
            'unauthenticated',
            'You were signed in, but the session was not kept. Check that your browser accepts cookies and try again.',
          );
        }
        setUser(signedIn);
      },
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

/** Makes the address bar match what the guarded route renders. */
export function useRedirect(): void {
  const { user, status } = useAuth();
  const href = useSyncExternalStore(subscribeToLocation, currentHref);
  useEffect(() => {
    if (status === 'loading') return;
    const target = redirectFor(href, user);
    if (target) navigate(target, true);
  }, [href, status, user]);
}
