"use client";

import React, { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'XCLOUD_THEME_PREFERENCE';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

function systemTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readInitialTheme(): Theme {
  if (typeof document !== 'undefined') {
    const docTheme = document.documentElement.getAttribute('data-theme');
    if (isTheme(docTheme)) return docTheme;
  }

  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) return stored;
    return systemTheme();
  }

  return 'dark';
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
}

/**
 * ThemeProvider
 * ------------------------------------------------------------------
 * Global context provider for managing Dark/Light mode state.
 * Syncs the 'data-theme' attribute on the <html> element and stores
 * the user preference in localStorage (XCLOUD_THEME_PREFERENCE).
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => readInitialTheme());

  useEffect(() => {
    const initialTheme = readInitialTheme();
    setTheme(initialTheme);
    applyTheme(initialTheme);

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleMediaChange = () => {
      if (!isTheme(window.localStorage.getItem(STORAGE_KEY))) {
        setTheme(media.matches ? 'dark' : 'light');
      }
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        setTheme(isTheme(event.newValue) ? event.newValue : systemTheme());
      }
    };

    media.addEventListener('change', handleMediaChange);
    window.addEventListener('storage', handleStorage);
    return () => {
      media.removeEventListener('change', handleMediaChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    applyTheme(newTheme);
    localStorage.setItem(STORAGE_KEY, newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
