import type { Metadata } from "next";
import { Noto_Sans_SC, Sora } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { I18nProvider } from "@/components/I18nProvider";
import { SWRProvider } from "@/components/SWRProvider";
import { GlobalErrorBoundary } from "@/components/GlobalErrorBoundary";

import { NotificationProvider } from "@/components/NotificationProvider";
import ToastContainer from "@/components/ToastContainer";

const displayFont = Sora({
  variable: "--font-display-loaded",
  subsets: ["latin"],
  display: "swap",
});

const interfaceFont = Noto_Sans_SC({
  variable: "--font-interface-loaded",
  subsets: ["latin"],
  display: "swap",
});

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
        <script
          id="xcloud-init-preferences"
          dangerouslySetInnerHTML={{
            __html: `
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
            `,
          }}
        />
      </head>
      <body className={`${displayFont.variable} ${interfaceFont.variable}`}>
        <GlobalErrorBoundary>
          <SWRProvider>
            <ThemeProvider>
              <I18nProvider>
                <NotificationProvider>
                  {children}
                  <ToastContainer />
                </NotificationProvider>
              </I18nProvider>
            </ThemeProvider>
          </SWRProvider>
        </GlobalErrorBoundary>
      </body>
    </html>
  );
}
