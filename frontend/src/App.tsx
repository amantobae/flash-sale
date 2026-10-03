import { useEffect, useState } from 'react';
import { getHealth, type Health } from './api/client';

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; health: Health }
  | { kind: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    getHealth()
      .then((health) => setState({ kind: 'ok', health }))
      .catch((err: Error) => setState({ kind: 'error', message: err.message }));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>Flash Sale</h1>
      {state.kind === 'loading' && <p>Checking backend…</p>}
      {state.kind === 'ok' && (
        <p data-testid="health">
          Backend: <strong>{state.health.status}</strong>, database: <strong>{state.health.db}</strong>
        </p>
      )}
      {state.kind === 'error' && (
        <p data-testid="health" style={{ color: 'crimson' }}>
          Backend unavailable: {state.message}
        </p>
      )}
    </main>
  );
}
