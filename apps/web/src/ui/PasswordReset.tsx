import { useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError } from './api';
import { useApi, useAuth } from './context';
import {
  readResetState,
  stateWithResetDone,
  stateWithToken,
  stateWithoutToken,
  withoutTokenParam,
} from './resetToken';
import { Field, FormError, Link, Panel, useSubmission } from './screens';

export function ForgotPasswordScreen() {
  const api = useApi();
  const submission = useSubmission();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submission
      .run(() => api.requestPasswordReset(email))
      .then((ok) => {
        if (ok) setSentTo(email);
      });
  };

  if (sentTo) {
    return (
      <Panel title="Check your inbox">
        <p role="status">
          If <strong>{sentTo}</strong> has an account, a link to set a new password is on its way.
          It works once and expires in one hour.
        </p>
        <p className="alt">
          <Link to="/sign-in">Back to sign in</Link>
        </p>
      </Panel>
    );
  }

  const limited = submission.failure?.code === 'rate_limited';
  return (
    <Panel title="Forgot your password?">
      <p>Enter your email and we will send you a link to set a new one.</p>
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
        <FormError
          message={limited ? 'Too many requests, try again in a few minutes.' : submission.error}
        />
        <button type="submit" disabled={submission.busy}>
          {submission.busy ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
      <p className="alt">
        <Link to="/sign-in">Back to sign in</Link>
      </p>
    </Panel>
  );
}

function ExpiredLink() {
  return (
    <Panel title="That link did not work">
      <p>The reset link is invalid, has expired or was already used. Ask for a new one.</p>
      <p className="alt">
        <Link to="/forgot-password">Send a new reset link</Link>
      </p>
    </Panel>
  );
}

function PasswordChanged() {
  return (
    <Panel title="Password changed">
      <p role="status">Your new password is set. Sign in with it to get back to your tank.</p>
      <p className="alt">
        <Link to="/sign-in">Sign in</Link>
      </p>
    </Panel>
  );
}

export function ResetPasswordScreen({
  token: urlToken,
  error,
}: {
  token: string | null;
  error: string | null;
}) {
  const api = useApi();
  const auth = useAuth();
  const submission = useSubmission();
  const [restored] = useState(() => readResetState(window.history.state));
  const [token, setToken] = useState(urlToken ?? restored.token);
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.append(meta);
    if (urlToken) {
      window.history.replaceState(
        stateWithToken(window.history.state, urlToken),
        '',
        withoutTokenParam(window.location),
      );
    }
    return () => meta.remove();
  }, [urlToken]);

  if (done || (restored.done && !urlToken && !error)) return <PasswordChanged />;
  if (error || !token || stale) return <ExpiredLink />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submission
      .run(
        async () => {
          await api.resetPassword(token, password);
          await auth.refresh();
        },
        { rethrow: true },
      )
      .then(() => {
        window.history.replaceState(
          stateWithResetDone(window.history.state),
          '',
          window.location.pathname + window.location.search + window.location.hash,
        );
        setToken(null);
        setDone(true);
      })
      .catch((cause: unknown) => {
        if (cause instanceof ApiRequestError && cause.status === 400) {
          window.history.replaceState(
            stateWithoutToken(window.history.state),
            '',
            window.location.pathname + window.location.search + window.location.hash,
          );
          setStale(true);
        }
      });
  };

  return (
    <Panel title="Choose a new password">
      <form onSubmit={onSubmit} noValidate>
        <Field
          label="New password"
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
          {submission.busy ? 'Saving…' : 'Set password'}
        </button>
      </form>
    </Panel>
  );
}
