// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = { myHandle: vi.fn(), setMyHandle: vi.fn() };
vi.mock('./context', () => ({ useApi: () => api }));

const { PlayerHandle } = await import('./PlayerHandle');

describe('the player handle section', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const show = async () => {
    await act(async () => root.render(<PlayerHandle />));
    await act(async () => {});
  };
  const input = () => container.querySelector('input') as HTMLInputElement;
  const type = async (value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input(), value);
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const submit = async () => {
    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
  };

  it('shows the current handle', async () => {
    api.myHandle.mockResolvedValue('mossy');
    await show();
    expect(container.textContent).toContain('Your handle is @mossy.');
    expect(input().value).toBe('mossy');
  });

  it('invites the player to choose one when there is none', async () => {
    api.myHandle.mockResolvedValue(null);
    await show();
    expect(container.textContent).toContain('You have not picked a handle yet.');
    expect(container.querySelector('label')?.textContent).toBe('Choose a handle');
  });

  it('saves a normalised handle and shows it', async () => {
    api.myHandle.mockResolvedValue(null);
    api.setMyHandle.mockResolvedValue('reef_fan');
    await show();
    await type('@Reef_Fan');
    await submit();
    expect(api.setMyHandle).toHaveBeenCalledWith('reef_fan');
    expect(container.textContent).toContain('Your handle is @reef_fan.');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Handle saved.');
  });

  it('rejects a malformed handle without calling the server', async () => {
    api.myHandle.mockResolvedValue(null);
    await show();
    await type('x');
    await submit();
    expect(api.setMyHandle).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/3 to 20/);
    expect(input().getAttribute('aria-invalid')).toBe('true');
  });

  it('does not resubmit the handle already held', async () => {
    api.myHandle.mockResolvedValue('mossy');
    await show();
    await submit();
    expect(api.setMyHandle).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('already your handle');
  });

  it('shows the server refusal and keeps the old handle', async () => {
    api.myHandle.mockResolvedValue('mossy');
    api.setMyHandle.mockRejectedValue(new Error('That handle is taken. Pick another.'));
    await show();
    await type('reef_fan');
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'That handle is taken. Pick another.',
    );
    expect(container.textContent).toContain('Your handle is @mossy.');
  });

  it('says so when the handle cannot be loaded', async () => {
    api.myHandle.mockRejectedValue(new Error('Sign in required.'));
    await show();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Sign in required.');
    expect(container.querySelector('form')).toBeNull();
  });
});
