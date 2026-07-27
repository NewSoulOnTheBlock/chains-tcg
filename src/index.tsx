// src/index.tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted @font-face rules + the global base styles that used to sit in an
// inline <style> in index.html. Both are emitted as same-origin stylesheets so
// they survive the gateway's `default-src 'self'` CSP.
import './fonts.css';
import './base.css';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);

// Register the service worker so the app becomes installable as a PWA and the
// shell survives flaky mobile networks. Skipped in dev (vite serves from a
// non-standard path) and gracefully no-ops if registration fails.
if (typeof window !== 'undefined' && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* ignore */ });
  });
}
