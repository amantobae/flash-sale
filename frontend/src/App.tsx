import { useEffect, useState } from 'react';
import { clearSession, loadSession, saveSession, setUnauthorizedHandler } from './api/client';
import { Notifications } from './components/Notifications';
import { useSale } from './hooks/useSale';
import type { User } from './lib/types';
import { Cart } from './pages/Cart';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { Orders } from './pages/Orders';
import { Storefront } from './pages/Storefront';
import { disconnectSocket } from './socket';

type Page = 'storefront' | 'cart' | 'orders' | 'dashboard';

export function App() {
  const [user, setUser] = useState<User | null>(loadSession);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      disconnectSocket();
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  function logout() {
    clearSession();
    disconnectSocket();
    setUser(null);
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 900 }}>
      <h1>Flash Sale</h1>
      {user ? (
        <Shop key={user.id} user={user} onLogout={logout} />
      ) : (
        <Login
          onLogin={(next) => {
            saveSession(next);
            setUser(next);
          }}
        />
      )}
    </main>
  );
}

function Shop({ user, onLogout }: { user: User; onLogout: () => void }) {
  const store = useSale(user);
  const [page, setPage] = useState<Page>('storefront');

  const tab = (id: Page, label: string) => (
    <button onClick={() => setPage(id)} disabled={page === id}>
      {label}
    </button>
  );

  return (
    <>
      <header style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        {tab('storefront', 'Storefront')}
        {tab('cart', store.reservation ? 'Cart (1)' : 'Cart')}
        {tab('orders', 'Orders')}
        {tab('dashboard', 'Dashboard')}
        <span style={{ marginLeft: 'auto' }}>
          {store.connected ? 'Live' : 'Reconnecting…'} · {user.username}
        </span>
        <button onClick={onLogout}>Log out</button>
      </header>
      {page === 'storefront' && <Storefront store={store} />}
      {page === 'cart' && <Cart store={store} />}
      {page === 'orders' && <Orders store={store} />}
      {page === 'dashboard' && <Dashboard />}
      <Notifications notices={store.notices} onDismiss={store.dismissNotice} />
    </>
  );
}
