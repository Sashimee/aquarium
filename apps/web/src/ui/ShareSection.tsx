import type { Tank } from '@aquarium/shared';
import { useId, useRef, useState } from 'react';
import { publicUrl, shareView } from '../sync/share';
import type { SessionState, TankSession } from '../sync/session';

type Pending = 'rotate' | 'revoke' | null;

const SHARE_DONE = {
  share: 'Your tank is shared. Copy the link now.',
  rotate: 'You have a new link. The old one no longer works.',
  revoke: 'Sharing is off. The link no longer works.',
} as const;

export function ShareSection({
  session,
  state,
  tank,
}: {
  session: TankSession;
  state: SessionState;
  tank: Tank;
}) {
  const id = useId();
  const [issued, setIssued] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [copied, setCopied] = useState<'copied' | 'manual' | null>(null);
  const [done, setDone] = useState<keyof typeof SHARE_DONE | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const view = shareView(tank, issued);

  const change = async (kind: 'share' | 'rotate' | 'revoke') => {
    setPending(null);
    setCopied(null);
    setDone(null);
    const outcome = await session.changeSharing(kind);
    if (!outcome.ok) return;
    setIssued(kind === 'revoke' ? null : outcome.token);
    setDone(kind);
  };

  const copy = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied('copied');
    } catch {
      field.current?.select();
      setCopied('manual');
    }
  };

  return (
    <section aria-labelledby={`${id}-h`} className="block share">
      <h3 id={`${id}-h`}>Share this tank</h3>
      {view.kind === 'private' && (
        <>
          <p className="hint">
            Anyone with the link can watch this tank, read only. They see its name, fish and decor,
            never your account. Verified players can react with a heart, star or wow.
          </p>
          <button
            type="button"
            className="primary"
            disabled={state.busy}
            onClick={() => void change('share')}
          >
            Create a public link
          </button>
        </>
      )}
      {view.kind === 'fresh' && (
        <>
          <label htmlFor={`${id}-link`}>Public link</label>
          <div className="row">
            <input
              id={`${id}-link`}
              ref={field}
              readOnly
              value={publicUrl(window.location.origin, view.token)}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              onClick={() => void copy(publicUrl(window.location.origin, view.token))}
            >
              Copy link
            </button>
          </div>
          <p className="hint">
            This is the only time the link is shown. Copy it now. If you lose it, get a new link,
            which stops the old one working.
          </p>
        </>
      )}
      {view.kind === 'link-hidden' && (
        <p className="hint">
          This tank is shared, but the link is not stored where it can be shown again. If you need
          it, get a new link. The old link then stops working for everyone who has it.
        </p>
      )}
      <p role="status" className="hint">
        {copied === null && done !== null && SHARE_DONE[done]}
        {copied === 'copied' && 'Link copied.'}
        {copied === 'manual' && 'Copying is blocked here. The link is selected, copy it by hand.'}
      </p>
      {view.kind !== 'private' && (
        <div className="row">
          {pending === null ? (
            <>
              <button type="button" disabled={state.busy} onClick={() => setPending('rotate')}>
                {view.kind === 'link-hidden' ? 'Get a new link' : 'Replace the link'}
              </button>
              <button type="button" disabled={state.busy} onClick={() => setPending('revoke')}>
                Stop sharing
              </button>
            </>
          ) : (
            <div role="group" aria-label="Confirm" className="confirm">
              <p id={`${id}-c`}>
                {pending === 'rotate'
                  ? 'The old link stops working at once. Continue?'
                  : 'Nobody can open the link any more. Continue?'}
              </p>
              <button
                type="button"
                className="primary"
                disabled={state.busy}
                aria-describedby={`${id}-c`}
                onClick={() => void change(pending)}
              >
                {pending === 'rotate' ? 'Yes, get a new link' : 'Yes, stop sharing'}
              </button>
              <button type="button" onClick={() => setPending(null)}>
                Keep as it is
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
