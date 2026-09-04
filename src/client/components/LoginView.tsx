import { useState } from 'react';
import { login, loginTotp, logout } from '../api/queries.js';

export interface LoginViewProps {
  onSuccess: () => void;
}

/**
 * Shown in session mode when the user has no live Weblate session.
 * Two steps: credentials, then (only if the account has 2FA enabled)
 * the TOTP/backup-code second factor.
 */
export function LoginView({ onSuccess }: LoginViewProps) {
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await login(username, password);
      if (res.status === 'totp_required') {
        setStep('totp');
      } else {
        onSuccess();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const submitTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loginTotp(token);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  };

  /** Back to the credentials step: the pending (pre-2FA) session is discarded. */
  const cancelTotp = (): void => {
    void logout().catch(() => {}); // server-side pending session cleanup; best effort
    setStep('credentials');
    setToken('');
    setError(null);
  };

  return (
    <div className="h-screen flex items-center justify-center bg-slate-100">
      {step === 'credentials' ? (
        <form
          className="bg-white rounded-lg shadow-md border border-slate-200 p-6 w-full max-w-sm flex flex-col gap-3"
          onSubmit={(e) => void submitCredentials(e)}
        >
          <h1 className="font-semibold text-slate-800 text-lg">
            Weblate <span className="text-sky-600">friendly</span> — Sign in
          </h1>
          <p className="text-sm text-slate-500">
            Use your Weblate account. Credentials are sent only to the backend,
            which holds the Weblate session for you.
          </p>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Username or e-mail
            <input
              autoFocus
              className="rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-sky-500 focus:outline-none"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Password
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                className="w-full rounded border border-slate-300 px-2 py-1.5 pr-8 text-sm focus:border-sky-500 focus:outline-none"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
              <button
                type="button"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 focus:outline-none"
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </label>
          {error !== null && (
            <div className="rounded bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <button
            type="submit"
            className="rounded bg-sky-600 text-white px-3 py-1.5 text-sm hover:bg-sky-700 disabled:opacity-50"
            disabled={busy || username === '' || password === ''}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      ) : (
        <form
          className="bg-white rounded-lg shadow-md border border-slate-200 p-6 w-full max-w-sm flex flex-col gap-3"
          onSubmit={(e) => void submitTotp(e)}
        >
          <h1 className="font-semibold text-slate-800 text-lg">Two-factor authentication</h1>
          <p className="text-sm text-slate-500">
            Your Weblate account is protected with two-factor authentication.
            Enter the current code from your authenticator app (or a backup code).
          </p>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Authentication code
            <input
              autoFocus
              inputMode="numeric"
              placeholder="123 456"
              className="rounded border border-slate-300 px-2 py-1.5 text-sm tracking-widest focus:border-sky-500 focus:outline-none"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="one-time-code"
            />
          </label>
          {error !== null && (
            <div className="rounded bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <button
            type="submit"
            className="rounded bg-sky-600 text-white px-3 py-1.5 text-sm hover:bg-sky-700 disabled:opacity-50"
            disabled={busy || token.trim() === ''}
          >
            {busy ? 'Verifying…' : 'Verify'}
          </button>
          <button
            type="button"
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            disabled={busy}
            onClick={cancelTotp}
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}