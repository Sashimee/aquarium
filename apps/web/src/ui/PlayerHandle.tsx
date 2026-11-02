import { useEffect, useId, useState, type FormEvent } from 'react';
import { checkHandle } from '../sync/gifts';
import { useApi } from './context';

type Loaded = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'ready' };

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : 'Something went wrong. Try again.';

export function PlayerHandle() {
  const api = useApi();
  const id = useId();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [current, setCurrent] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    api.myHandle().then(
      (handle) => {
        if (!live) return;
        setCurrent(handle);
        setDraft(handle ?? '');
        setLoaded({ kind: 'ready' });
      },
      (err: unknown) => {
        if (live) setLoaded({ kind: 'failed', message: messageOf(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const checked = checkHandle(draft);
    if (!checked.ok) return setProblem(checked.message);
    if (checked.handle === current) return setProblem('That is already your handle.');
    setProblem(null);
    setSaving(true);
    api.setMyHandle(checked.handle).then(
      (handle) => {
        setCurrent(handle);
        setDraft(handle ?? '');
        setSaved(true);
        setSaving(false);
      },
      (err: unknown) => {
        setProblem(messageOf(err));
        setSaving(false);
      },
    );
  };

  return (
    <section aria-labelledby={`${id}-h`} className="block">
      <h3 id={`${id}-h`}>Player handle</h3>
      {loaded.kind === 'loading' ? <p>Loading your handle...</p> : null}
      {loaded.kind === 'failed' ? (
        <p className="field-error" role="alert">
          {loaded.message}
        </p>
      ) : null}
      {loaded.kind === 'ready' ? (
        <form onSubmit={submit} noValidate>
          <p>
            {current ? (
              <>
                Your handle is <strong>@{current}</strong>.
              </>
            ) : (
              'You have not picked a handle yet.'
            )}
          </p>
          <label htmlFor={`${id}-input`}>{current ? 'New handle' : 'Choose a handle'}</label>
          <input
            id={`${id}-input`}
            value={draft}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={21}
            aria-invalid={problem !== null}
            aria-describedby={`${id}-hint${problem ? ` ${id}-e` : ''}`}
            onChange={(e) => setDraft(e.target.value)}
          />
          <p id={`${id}-hint`} className="hint">
            Other players send you fish and see you in the community by this name. 3 to 20 lowercase
            letters, digits or underscores. A handle you give up cannot be claimed again for 30
            days.
          </p>
          {problem ? (
            <p id={`${id}-e`} className="field-error" role="alert">
              {problem}
            </p>
          ) : null}
          {saved ? <p role="status">Handle saved.</p> : null}
          <button type="submit" disabled={saving}>
            {saving ? 'Saving...' : 'Save handle'}
          </button>
        </form>
      ) : null}
    </section>
  );
}
