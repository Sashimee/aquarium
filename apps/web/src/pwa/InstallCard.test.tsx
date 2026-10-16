import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InstallCard } from './InstallCard';
import { InstallState, type Environment, type InstallPromptEvent } from './install';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const android: Environment = {
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126.0 Mobile Safari/537.36',
  platform: 'Linux armv8l',
  maxTouchPoints: 5,
  standalone: false,
};

function offered(): InstallState {
  const target = new EventTarget();
  const state = new InstallState();
  state.attach(target as unknown as Window);
  const event = new Event('beforeinstallprompt', { cancelable: true }) as InstallPromptEvent;
  Object.assign(event, { prompt: async () => undefined, userChoice: new Promise(() => undefined) });
  target.dispatchEvent(event);
  return state;
}

const render = (state: InstallState, environment: Environment) =>
  renderToStaticMarkup(<InstallCard state={state} environment={environment} />);

describe('InstallCard', () => {
  it('renders nothing when the browser offers no install', () => {
    expect(render(new InstallState(), android)).toBe('');
  });

  it('offers an enabled install button once the browser deferred its prompt', () => {
    const html = render(offered(), android);
    expect(html).toContain('Install Aquarium');
    expect(html).not.toContain('disabled');
  });

  it('stays visible with a disabled button while the dialog is open', async () => {
    const state = offered();
    void state.prompt();
    await Promise.resolve();
    const html = render(state, android);
    expect(html).toContain('Waiting for your browser');
    expect(html).toContain('disabled');
  });

  it('explains a cancelled install without promising another prompt', async () => {
    const target = new EventTarget();
    const state = new InstallState();
    state.attach(target as unknown as Window);
    const event = new Event('beforeinstallprompt', { cancelable: true }) as InstallPromptEvent;
    Object.assign(event, {
      prompt: async () => undefined,
      userChoice: Promise.resolve({ outcome: 'dismissed' }),
    });
    target.dispatchEvent(event);
    await state.prompt();
    const html = render(state, android);
    expect(html).toContain('Installation was cancelled');
    expect(html).not.toContain('<button');
  });

  it('shows the Add to Home Screen hint on iOS Safari', () => {
    const html = render(new InstallState(), {
      userAgent: IPHONE_SAFARI,
      platform: 'iPhone',
      maxTouchPoints: 5,
      standalone: false,
    });
    expect(html).toContain('Add to Home Screen');
  });

  it('confirms the install when running standalone', () => {
    expect(render(new InstallState(), { ...android, standalone: true })).toContain(
      'installed on this device',
    );
  });
});
