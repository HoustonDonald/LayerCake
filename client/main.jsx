import React from 'react';
import { createRoot } from 'react-dom/client';
import { CLOSE_VIEW } from './api.js';
import App from './App.jsx';
import CloseChooser from './components/CloseChooser.jsx';
import './styles.css';

// The window the executable opens as it closes shows only the chooser (#205).
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {CLOSE_VIEW ? <CloseChooser /> : <App />}
  </React.StrictMode>
);
