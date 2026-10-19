import { useOptionalSession, useSessionState } from './session';

/** Both buttons unmount the notice, so focus goes to the tank rather than falling to the page. */
export function BirthStatus() {
  const session = useOptionalSession();
  const { birth } = useSessionState();
  return (
    <div className="life-status birth-status" role="status" aria-live="polite">
      {birth && session && (
        <>
          <span>{birth.text}</span>
          <button
            type="button"
            onClick={() => {
              document.getElementById('tank')?.focus();
              session.focusBrood();
            }}
          >
            Show them
          </button>
          <button
            type="button"
            aria-label="Dismiss birth message"
            onClick={() => {
              document.getElementById('tank')?.focus();
              session.dismissBirth();
            }}
          >
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}

/** Speaks and shows what just happened: chores done, errors, and a fish dying while you watch. */
export function LifeStatus() {
  const session = useOptionalSession();
  const state = useSessionState();
  const text = state.error ?? state.notice;
  return (
    <div className="life-status" role={state.error ? 'alert' : 'status'} aria-live="polite">
      {text && (
        <>
          <span>{text}</span>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={() => {
              session?.clearMessages();
            }}
          >
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}
