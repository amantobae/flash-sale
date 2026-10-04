import type { Notice } from '../hooks/useSale';

export function Notifications({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: number) => void }) {
  if (notices.length === 0) return null;
  return (
    <ul aria-live="polite" className="notices">
      {notices.map((notice) => (
        <li key={notice.id} className="notice">
          <span>{notice.text}</span>
          <button onClick={() => onDismiss(notice.id)} aria-label="Dismiss" className="notice-dismiss">
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
