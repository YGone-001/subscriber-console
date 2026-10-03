import { SWRConfig } from 'swr';
import { AuthProvider } from './AuthProvider';
import { GlobalErrorBoundary } from './GlobalErrorBoundary';
import { I18nProvider } from './I18nProvider';
import { ThemeProvider } from './ThemeProvider';

export function AppProviders({ children }: { children: React.ReactNode }) {
  return <GlobalErrorBoundary><SWRConfig value={{ provider: () => new Map() }}><ThemeProvider><I18nProvider><AuthProvider>{children}</AuthProvider></I18nProvider></ThemeProvider></SWRConfig></GlobalErrorBoundary>;
}
