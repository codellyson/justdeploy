import { createRoot } from 'react-dom/client';
import { bootTheme } from '@codellyson/justui/boot';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './index.css';
import App from './App.jsx';
import { initAnalytics } from './lib/analytics';

// Apply the saved theme before first paint (no flash), sharing state with the just* family.
bootTheme({ keyPrefix: 'justdeploy' });
initAnalytics();

createRoot(document.getElementById('root')).render(<App />);
