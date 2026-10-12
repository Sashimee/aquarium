import type { SessionInfo } from '@aquarium/shared';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ApiRequestError, ClientValidationError, type FieldErrors } from './api';
import { useApi, useAuth } from './context';
import { navigate } from './router';

export function Link({
  to,
  children,
  className,
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} className={className}>
      {children}
    </a>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [title]);
  return (
    <main className="panel" aria-labelledby="panel-title">
      <h1 id="panel-title" ref={heading} tabIndex={-1}>
        {title}
      </h1>
      {children}
    </main>
  );
}

function Field(props: {
  label: string;
  name: string;
  type: 'text' | 'email' | 'password';
  value: string;
  onChange(value: string): void;
  autoComplete: string;
  error?: string | undefined;
  hint?: string;
}) {
  const id = useId();
  const describedBy = [props.hint ? `${id}-hint` : '', props.error ? `${id}-error` : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        name={props.name}
        type={props.type}
        value={props.value}
        autoComplete={props.autoComplete}
        required
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && (
        <p id={`${id}-hint`} className="hint">
          {props.hint}
        </p>
      )}
      {props.error && (
        <p id={`${id}-error`} className="field-error">
          {props.error}
        </p>
      )}
    </div>
  );
}

interface Submission {
  busy: boolean;
  error: string | null;
  fields: FieldErrors;
  failure: ApiRequestError | null;
  run(action: () => Promise<void>, options?: { rethrow?: boolean }): Promise<boolean>;
}

function useSubmission(): Submission {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<ApiRequestError | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (action: () => Promise<void>, options?: { rethrow?: boolean }) => {
    setBusy(true);
    setError(null);
    setFields({});
    setFailure(null);
    try {
      await action();
      return true;
    } catch (cause) {
      if (!alive.current) return false;
      if (cause instanceof ClientValidationError) {
        setFields(cause.fields);
        setError(cause.message);
      } else if (cause instanceof ApiRequestError) {
        setFields(cause.fields);
        setFailure(cause);
        setError(cause.message);
      } else {
        console.error(cause);
        setError('Something went wrong. Try again.');
      }
      if (options?.rethrow) throw cause;
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);
  return { busy, error, fields, failure, run };
}

function FormError({ message }: { message: string | null }) {
  return (
    <p role="alert" className="form-error" hidden={!message}>
      {message}
    </p>
  );
}

export const RESEND_COOLDOWN_SECONDS = 60;

function useCountdown(initial: number): [number, (seconds: number) => void] {
  const [remaining, setRemaining] = useState(initial);
  const active = remaining > 0;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setRemaining((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return [remaining, setRemaining];
}

/** `justSent` means the server already mailed a link, so its per-address cooldown is running. */
function ResendButton({
  email,
  justSent = false,
  inForm = false,
}: {
  email: string;
  justSent?: boolean;
  inForm?: boolean;
}) {
  const api = useApi();
  const submission = useSubmission();
  const [sent, setSent] = useState(false);
  const [remaining, setRemaining] = useCountdown(justSent ? RESEND_COOLDOWN_SECONDS : 0);

  const resend = async () => {
    try {
      await submission.run(() => api.resendVerification(email), { rethrow: true });
      setSent(true);
      setRemaining(RESEND_COOLDOWN_SECONDS);
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.code === 'rate_limited') {
        setRemaining(cause.retryAfterSeconds ?? RESEND_COOLDOWN_SECONDS);
      }
    }
  };

  const waiting = remaining > 0;
  return (
    <>
      <button
        type={inForm ? 'submit' : 'button'}
        className="secondary"
        disabled={submission.busy || waiting || email.length === 0}
        onClick={(e) => {
          e.preventDefault();
          void resend();
        }}
      >
        {waiting ? `Send again in ${remaining}s` : 'Send the verification email again'}
      </button>
      <p role="status" className="hint">
        {sent
          ? 'If that address has an account, a new link is on its way.'
          : justSent && waiting
            ? 'A verification link should be on its way. Check your inbox and spam folder.'
            : ''}
      </p>
      <FormError
        message={
          submission.failure?.code === 'rate_limited'
            ? 'A verification email went out a moment ago. Please wait before asking for another.'
            : submission.error
        }
      />
    </>
  );
}

export function SignInScreen() {
  const auth = useAuth();
  const submission = useSubmission();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [unverified, setUnverified] = useState(false);
  const failureCode = submission.failure?.code;
  useEffect(() => {
    if (failureCode === 'email_not_verified') setUnverified(true);
  }, [failureCode]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submission
      .run(() => auth.signIn({ email, password }))
      .then((ok) => {
        if (ok) navigate('/');
      });
  };

  return (
    <Panel title="Sign in">
      <form onSubmit={onSubmit} noValidate>
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
          error={submission.fields.email}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          error={submission.fields.password}
        />
        <FormError message={submission.error} />
        <button type="submit" disabled={submission.busy}>
          {submission.busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {unverified && <ResendButton email={email} justSent />}
      <p className="alt">
        New here? <Link to="/sign-up">Create an account</Link>
      </p>
    </Panel>
  );
}

export function SignUpScreen() {
  const auth = useAuth();
  const submission = useSubmission();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submission
      .run(() => auth.signUp({ name, email, password }))
      .then((ok) => {
        if (ok) setSentTo(email);
      });
  };

  if (sentTo) {
    return (
      <Panel title="Check your inbox">
        <p>
          We sent a verification link to <strong>{sentTo}</strong>. Open it to finish creating your
          account, then sign in.
        </p>
        <ResendButton email={sentTo} justSent />
        <p className="alt">
          <Link to="/sign-in">Go to sign in</Link>
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="Create an account">
      <form onSubmit={onSubmit} noValidate>
        <Field
          label="Your name"
          name="name"
          type="text"
          autoComplete="nickname"
          value={name}
          onChange={setName}
          error={submission.fields.name}
        />
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
          error={submission.fields.email}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          hint="At least 10 characters."
          error={submission.fields.password}
        />
        <FormError message={submission.error} />
        <button type="submit" disabled={submission.busy}>
          {submission.busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
      <p className="alt">
        Already have an account? <Link to="/sign-in">Sign in</Link>
      </p>
    </Panel>
  );
}

export function VerifyEmailScreen({ error }: { error: string | null }) {
  const { user, status, refresh } = useAuth();
  const [email, setEmail] = useState('');

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error) {
    return (
      <Panel title="That link did not work">
        <p>The verification link is invalid or has expired. Enter your email to get a new one.</p>
        <form onSubmit={(e) => e.preventDefault()} noValidate>
          <Field
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
          />
          <ResendButton email={email} inForm />
        </form>
      </Panel>
    );
  }
  if (status === 'loading') {
    return (
      <Panel title="Verifying…">
        <p role="status">Checking your account.</p>
      </Panel>
    );
  }
  if (user?.emailVerified) {
    return (
      <Panel title="Email verified">
        <p>Thanks, {user.name}. You are signed in.</p>
        <p className="alt">
          <Link to="/">Go to your tank</Link>
        </p>
      </Panel>
    );
  }
  return (
    <Panel title="Verify your email">
      <p>Open the link in the verification email we sent you. After that you can sign in.</p>
      <p className="alt">
        <Link to="/sign-in">Sign in</Link>
      </p>
    </Panel>
  );
}

function describeAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Firefox\//.test(userAgent)
    ? 'Firefox'
    : /Edg\//.test(userAgent)
      ? 'Edge'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser';
  const system = /Android/.test(userAgent)
    ? 'Android'
    : /iPhone|iPad/.test(userAgent)
      ? 'iOS'
      : /Windows/.test(userAgent)
        ? 'Windows'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;
  return system ? `${browser} on ${system}` : browser;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function SessionsScreen() {
  const api = useApi();
  const load = useSubmission();
  const revoke = useSubmission();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);

  const reload = useCallback(async () => {
    await load.run(async () => setSessions(await api.sessions()));
  }, [api, load.run]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <Panel title="Your sessions">
      <FormError message={load.error ?? revoke.error} />
      {sessions && (
        <ul className="sessions">
          {sessions.map((s) => (
            <li key={s.id}>
              <div>
                <strong>{describeAgent(s.userAgent)}</strong>
                {s.current && <span className="badge">This device</span>}
                <p className="hint">Signed in {dateFormat.format(new Date(s.createdAt))}</p>
              </div>
              {!s.current && (
                <button
                  type="button"
                  className="secondary"
                  disabled={revoke.busy}
                  onClick={() => {
                    void revoke
                      .run(() => api.revokeSession(s.id))
                      .then((ok) => {
                        if (ok) void reload();
                      });
                  }}
                >
                  Sign out this device
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!sessions && !load.error && <p role="status">Loading…</p>}
      <p className="alt">
        <Link to="/">Back to the tank</Link>
      </p>
    </Panel>
  );
}

export function NotFoundScreen() {
  return (
    <Panel title="Nothing here">
      <p>That page does not exist.</p>
      <p className="alt">
        <Link to="/">Back to the tank</Link>
      </p>
    </Panel>
  );
}
