import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from '../app/AppShell';
import { NotFoundPage } from '../app/NotFoundPage';
import { AuthGate } from '../auth/AuthGate';
import { LoginPage } from '../auth/LoginPage';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/', element: <AuthGate><AppShell /></AuthGate> },
  { path: '*', element: <NotFoundPage /> },
]);
