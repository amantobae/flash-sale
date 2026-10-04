import type { Notice } from '../hooks/useSale';

export function Notifications({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: number) => void }) {
  if (notices.length === 0) return null;
  return (
    <ul
      aria-live="polite"
      style={{ position: 'fixed', right: 16, bottom: 16, listStyle: 'none', margin: 0, padding: 0, width: 300 }}
    >
      {notices.map((notice) => (
        <li
          key={notice.id}
          style={{
            background: '#222',
            color: 'white',
            padding: '8px 12px',
            marginTop: 8,
            borderRadius: 4,
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span>{notice.text}</span>
          <button onClick={() => onDismiss(notice.id)} aria-label="Dismiss" style={{ background: 'none', color: 'white', border: 0 }}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
