import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadAssets } from './assets';
import { detectBundledAi } from './settings';
import './styles.css';

void loadAssets();
void detectBundledAi();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
