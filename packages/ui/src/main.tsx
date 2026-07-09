import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './index.css';
import { initTheme } from './lib/theme';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('missing #root element');

initTheme();

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
