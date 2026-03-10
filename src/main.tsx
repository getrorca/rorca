import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles/tokens.css';
import './styles/index.css';
import App from './App';

// Global handler for unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error('[Unhandled rejection]', reason);

  // Dispatch to toast system if mounted (apiFetch errors already handled — skip duplicates)
  window.dispatchEvent(
    new CustomEvent('rorca:unhandled-error', { detail: message }),
  );
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
