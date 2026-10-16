export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type PromptPhase = 'idle' | 'asking' | 'accepted' | 'dismissed' | 'failed';

export type InstallMode = 'installed' | 'prompt' | 'ios-hint' | 'none';

export interface Environment {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean;
}

const IOS_OTHER_BROWSERS = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|DuckDuckGo|YaBrowser/;

export function isIosSafari(env: Pick<Environment, 'userAgent' | 'platform' | 'maxTouchPoints'>) {
  const appleMobile =
    /iPhone|iPad|iPod/.test(env.userAgent) ||
    (env.platform === 'MacIntel' && env.maxTouchPoints > 1);
  return appleMobile && /Safari\//.test(env.userAgent) && !IOS_OTHER_BROWSERS.test(env.userAgent);
}

export function installMode(env: Environment, hasPrompt: boolean): InstallMode {
  if (env.standalone) return 'installed';
  if (hasPrompt) return 'prompt';
  return isIosSafari(env) ? 'ios-hint' : 'none';
}

export function readEnvironment(win: Window = window): Environment {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    standalone: win.matchMedia('(display-mode: standalone)').matches || nav.standalone === true,
  };
}

/** Holds the browser's deferred install prompt; the event can fire before the UI mounts. */
export class InstallState {
  private deferred: InstallPromptEvent | null = null;
  private installed = false;
  private current: PromptPhase = 'idle';
  private readonly listeners = new Set<() => void>();
  private version = 0;

  attach(win: Window = window): () => void {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      this.deferred = event as InstallPromptEvent;
      this.current = 'idle';
      this.changed();
    };
    const onInstalled = () => {
      this.deferred = null;
      this.installed = true;
      this.changed();
    };
    win.addEventListener('beforeinstallprompt', onPrompt);
    win.addEventListener('appinstalled', onInstalled);
    return () => {
      win.removeEventListener('beforeinstallprompt', onPrompt);
      win.removeEventListener('appinstalled', onInstalled);
    };
  }

  /** True from the moment the browser offers an install until the player's answer is known. */
  get hasPrompt(): boolean {
    return this.deferred !== null || this.current !== 'idle';
  }

  get phase(): PromptPhase {
    return this.current;
  }

  get wasInstalled(): boolean {
    return this.installed;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** The event is kept while the dialog is open and dropped once answered: one prompt per event. */
  async prompt(): Promise<PromptPhase | 'unavailable'> {
    const event = this.deferred;
    if (!event || this.current === 'asking') return 'unavailable';
    this.current = 'asking';
    this.changed();
    try {
      await event.prompt();
      this.current = (await event.userChoice).outcome;
    } catch (cause) {
      console.error('The install prompt failed', cause);
      this.current = 'failed';
    }
    this.deferred = null;
    this.changed();
    return this.current;
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

export const installState = new InstallState();
