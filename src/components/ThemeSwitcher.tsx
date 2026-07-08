"use client";

import React, { useSyncExternalStore } from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from './ThemeProvider';

/**
 * ThemeSwitcher
 * ------------------------------------------------------------------
 * A toggle button component to switch between dark and light themes.
 * Designed to be mounted in the top navigation header.
 */
export default function ThemeSwitcher() {
  const { theme, toggleTheme } = useTheme();
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  const buttonStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--surface-hover)',
    border: '1px solid var(--surface-border)',
    borderRadius: '50%',
    width: '36px',
    height: '36px',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  };

  if (!mounted) {
    return (
      <button
        style={buttonStyle}
        className="theme-switcher-btn hover-glass"
        aria-hidden="true"
      />
    );
  }

  return (
    <button
      onClick={toggleTheme}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      style={buttonStyle}
      className="theme-switcher-btn hover-glass"
    >
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
