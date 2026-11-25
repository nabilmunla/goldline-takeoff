import { createRoot } from 'react-dom/client';
import './styles.css';
import './api';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
