import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

interface Toast {
  id: number;
  message: string;
  kind: 'error' | 'success';
}

interface ToastApi {
  toast: (message: string, kind?: Toast['kind']) => void;
}

const ToastContext = createContext<ToastApi>({ toast: () => {} });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

/** Small indeterminate spinner (optionally with a label). */
export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2" role="status">
      <svg
        className="animate-spin size-4 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
        />
      </svg>
      {label !== undefined && <span>{label}</span>}
    </span>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, kind: Toast['kind'] = 'error') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  }, []);

  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-md">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded px-4 py-2 text-sm shadow-lg text-white ${
              t.kind === 'error' ? 'bg-red-600' : 'bg-emerald-600'
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}