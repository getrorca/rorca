import React from 'react';
import ReactDOM from 'react-dom/client';
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
    new CustomEvent('rorcha:unhandled-error', { detail: message }),
  );
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
