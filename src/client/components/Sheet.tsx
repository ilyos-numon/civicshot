import { useEffect, useId, useRef, type ReactNode } from 'react';
import '../styles/base.css';

export interface SheetProps {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose?: () => void;
}

export function Sheet({ open, title, children, onClose }: SheetProps) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="cs-sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="cs-sheet" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <div className="cs-sheet__grip" aria-hidden="true" />
        <h2 className="cs-sheet__title" id={id}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
