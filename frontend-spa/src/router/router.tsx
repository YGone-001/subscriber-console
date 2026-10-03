import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from '../app/AppShell';
import { MigrationPendingPage } from '../app/MigrationPendingPage';
import { NotFoundPage } from '../app/NotFoundPage';
import { AuthGate } from '../auth/AuthGate';
import { LoginPage } from '../auth/LoginPage';
import { APP_ROUTES } from '../lib/navigation';

const pendingRoutes = APP_ROUTES.filter((route) => route.status === 'pending').map((route) => ({ path: route.targetRoute, element: <MigrationPendingPage /> }));

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { element: <AuthGate><AppShell /></AuthGate>, children: [
    { path: '/', element: <section className="migration-pending"><h1>Shared SPA shell</h1><p>Navigation, appearance, and session handling are ready for later page migrations.</p></section> },
    ...pendingRoutes,
  ] },
  { path: '*', element: <NotFoundPage /> },
]);
