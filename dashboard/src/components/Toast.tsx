/**
 * Simple toast notification component.
 *
 * Renders a fixed-position notification in the bottom-right corner
 * that auto-dismisses after a timeout.
 *
 * Usage:
 *   const [toast, setToast] = useState<string | null>(null);
 *   <Toast message={toast} onDismiss={() => setToast(null)} />
 */

import { useEffect } from "react";

interface ToastProps {
  message: string | null;
  onDismiss: () => void;
  /** Auto-dismiss timeout in ms. Default: 4000 */
  timeout?: number;
}

export function Toast({ message, onDismiss, timeout = 4000 }: ToastProps) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onDismiss, timeout);
    return () => clearTimeout(timer);
  }, [message, onDismiss, timeout]);

  if (!message) return null;

  return (
    <div className="toast">
      <span>{message}</span>
      <button className="toast-close" onClick={onDismiss}>&times;</button>
    </div>
  );
}
