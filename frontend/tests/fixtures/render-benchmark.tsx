/* Test-only entry: installs commit instrumentation before React is imported. */
import './render-commit-hook';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/app/App';
import '../../src/styles/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);