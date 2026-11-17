/*
 * Browser router instance.
 *
 * The route table lives in `routes.tsx` so it can be inspected without a DOM.
 * This module only binds the table to the browser history.
 */
import { createBrowserRouter } from 'react-router-dom';
import { appRoutes } from './routes';

export const router = createBrowserRouter(appRoutes);
