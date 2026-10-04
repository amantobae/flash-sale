import { useState, type FormEvent } from 'react';
import { api, describeError } from '../api/client';
import type { User } from '../lib/types';

export function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.login(username.trim());
      onLogin(user);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <label>
        Username{' '}
        <input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={50} autoFocus />
      </label>
      <button type="submit" disabled={busy || username.trim() === ''}>
        {busy ? 'Logging in…' : 'Log in'}
      </button>
      {error && <span style={{ color: 'crimson' }}>{error}</span>}
    </form>
  );
}
