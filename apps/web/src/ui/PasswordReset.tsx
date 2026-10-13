import { useState, type FormEvent } from 'react';
import { ApiRequestError } from './api';
import { useApi } from './context';
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
          message={
            limited
              ? 'A reset email went out a moment ago. Please wait before asking for another.'
              : submission.error
          }
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

export function ResetPasswordScreen({
  token,
  error,
}: {
  token: string | null;
  error: string | null;
}) {
  const api = useApi();
  const submission = useSubmission();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [stale, setStale] = useState(false);

  if (error || !token || stale) return <ExpiredLink />;

  if (done) {
    return (
      <Panel title="Password changed">
        <p role="status">Your new password is set. Sign in with it to get back to your tank.</p>
        <p className="alt">
          <Link to="/sign-in">Sign in</Link>
        </p>
      </Panel>
    );
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submission
      .run(() => api.resetPassword(token, password), { rethrow: true })
      .then(() => setDone(true))
      .catch((cause: unknown) => {
        if (cause instanceof ApiRequestError && cause.status === 400) setStale(true);
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
