import { SWRConfig } from 'swr';
import { AuthProvider } from './AuthProvider';
import { GlobalErrorBoundary } from './GlobalErrorBoundary';
import { I18nProvider } from './I18nProvider';
import { NotificationProvider } from './NotificationProvider';
import { ThemeProvider } from './ThemeProvider';
import { ToastProvider } from './ToastProvider';

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <GlobalErrorBoundary>
      <SWRConfig value={{ provider: () => new Map() }}>
        <ThemeProvider>
          <I18nProvider>
            <ToastProvider>
              <AuthProvider>
                <NotificationProvider>{children}</NotificationProvider>
              </AuthProvider>
            </ToastProvider>
          </I18nProvider>
        </ThemeProvider>
      </SWRConfig>
    </GlobalErrorBoundary>
  );
}
