// src/components/Modal.tsx
// One accessible dialog primitive. Before this, most overlays were a plain
// backdrop div with `onClick={onClose}` and a `stopPropagation` panel: no
// dialog role, no aria-modal, no initial focus, no Escape, no focus trap, so
// keyboard and screen-reader users were stranded (frontend-19). This keeps each
// overlay's own look (callers pass panel/backdrop styles) and adds the a11y
// mechanics once: role="dialog", aria-modal, initial focus, focus restore on
// close, a Tab focus loop, and optional Escape / backdrop dismissal.
import React, { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Modal({
  onClose,
  labelledBy,
  label,
  closeOnBackdrop = true,
  closeOnEsc = true,
  backdropStyle,
  panelStyle,
  panelClassName,
  zIndex = 200,
  align = 'center',
  children,
}: {
  /** Called to dismiss. Omit for a blocking dialog with no self-dismiss. */
  onClose?: () => void;
  /** id of the element that titles the dialog (aria-labelledby). */
  labelledBy?: string;
  /** Fallback accessible name when there is no visible title element. */
  label?: string;
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  backdropStyle?: React.CSSProperties;
  panelStyle?: React.CSSProperties;
  panelClassName?: string;
  zIndex?: number;
  /** Where the panel sits in the backdrop flex box. */
  align?: 'center' | 'end' | 'stretch-end';
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Remember what had focus, move focus into the dialog, restore on unmount.
  useEffect(() => {
    restoreRef.current = (document.activeElement as HTMLElement) ?? null;
    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }
    return () => {
      try { restoreRef.current?.focus?.(); } catch { /* element gone */ }
    };
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && closeOnEsc && onClose) {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (items.length === 0) { e.preventDefault(); panel.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || active === panel) { e.preventDefault(); last.focus(); }
    } else if (active === last) {
      e.preventDefault(); first.focus();
    }
  }, [closeOnEsc, onClose]);

  const alignItems = align === 'stretch-end' ? 'stretch' : align === 'end' ? 'flex-end' : 'center';
  const justifyContent = align === 'stretch-end' ? 'flex-end' : 'center';

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      onClick={closeOnBackdrop && onClose ? onClose : undefined}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed', inset: 0, zIndex,
        display: 'flex', alignItems, justifyContent,
        ...backdropStyle,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={panelClassName}
        style={{ outline: 'none', ...panelStyle }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
