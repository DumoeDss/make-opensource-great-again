import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './index.css';
import './lib/i18n';
import { initTheme } from './lib/theme';
import { initLanguage } from './lib/lang';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('missing #root element');

initTheme();
initLanguage();

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
