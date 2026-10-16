export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

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
  private readonly listeners = new Set<() => void>();
  private version = 0;

  attach(win: Window = window): () => void {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      this.deferred = event as InstallPromptEvent;
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

  get hasPrompt(): boolean {
    return this.deferred !== null;
  }

  get wasInstalled(): boolean {
    return this.installed;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** The browser allows one prompt per event, so the event is dropped whatever the answer. */
  async prompt(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    const event = this.deferred;
    if (!event) return 'unavailable';
    this.deferred = null;
    this.changed();
    await event.prompt();
    return (await event.userChoice).outcome;
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

export const installState = new InstallState();
