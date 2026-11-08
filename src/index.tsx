// src/index.tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted @font-face rules + the global base styles that used to sit in an
// inline <style> in index.html. Both are emitted as same-origin stylesheets so
// they survive the gateway's `default-src 'self'` CSP.
import './fonts.css';
import './base.css';
import App, { PrintAllCards, isPrintMode } from './App';
import { ErrorBoundary } from './screens/ErrorBoundary';

// Print mode (`#print` / `?print`) mounts the card-sheet renderer directly,
// instead of <App/>, so App's hooks are never behind an early return
// (frontend-04). The root ErrorBoundary catches any render error so a crash
// shows a recover panel instead of a blank white page (frontend-13).
createRoot(document.getElementById('root')!).render(
  isPrintMode()
    ? <PrintAllCards />
    : <ErrorBoundary variant="app"><App /></ErrorBoundary>,
);

// Register the service worker so the app becomes installable as a PWA and the
// shell survives flaky mobile networks. Skipped in dev (vite serves from a
// non-standard path) and gracefully no-ops if registration fails.
if (typeof window !== 'undefined' && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* ignore */ });
  });
}
