import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { I18nProvider } from "@/components/I18nProvider";
import { SWRProvider } from "@/components/SWRProvider";
import { GlobalErrorBoundary } from "@/components/GlobalErrorBoundary";

export const metadata: Metadata = {
  title: "4G Core Subscriber Management",
  description: "Web UI for managing xCloud-style user subscription data",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <Script id="xcloud-init-preferences" strategy="beforeInteractive">
          {`
            (function() {
              try {
                var theme = localStorage.getItem('XCLOUD_THEME_PREFERENCE');
                if (theme !== 'light' && theme !== 'dark') {
                  theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                }
                document.documentElement.setAttribute('data-theme', theme);
                document.documentElement.style.colorScheme = theme;
              } catch (e) {}
              try {
                var lang = localStorage.getItem('XCLOUD_LANGUAGE_PREFERENCE');
                if (lang === 'zh') {
                  document.documentElement.setAttribute('lang', 'zh-CN');
                }
              } catch (e) {}
            })();
          `}
        </Script>
      </head>
      <body>
        <GlobalErrorBoundary>
          <SWRProvider>
            <ThemeProvider>
              <I18nProvider>
                {children}
              </I18nProvider>
            </ThemeProvider>
          </SWRProvider>
        </GlobalErrorBoundary>
      </body>
    </html>
  );
}
