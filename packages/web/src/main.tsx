import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

/**
 * Polices auto-hébergées, sous-ensemblées par `unicode-range` : le navigateur
 * ne télécharge que le latin (29 ko par famille). L'ancien design system
 * déclarait « Inter » sans jamais la charger — l'application rendait donc en
 * police système, différemment sur chaque poste.
 *
 * `wght.css` : graisses variables, sans italique. L'italique n'est chargé que
 * pour la police de texte, où il porte du sens (blocs de réflexion d'un agent).
 */
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist/wght-italic.css';
import '@fontsource-variable/geist-mono/wght.css';

import App from './App';
import './styles/global.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
