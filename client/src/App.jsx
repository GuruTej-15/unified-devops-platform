import { BrowserRouter } from 'react-router';
import AppRoutes from './routes/index.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
