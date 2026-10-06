import { Component, type ErrorInfo, type ReactNode } from 'react';
import { DEFAULT_LOCALE, LOCALES } from '../lib/locales';
import { isLocale, LANGUAGE_PREFERENCE_KEY, type Locale } from '../lib/preferences';

type State = { failed: boolean };

function resolveErrorLocale(): Locale {
  try {
    const stored = localStorage.getItem(LANGUAGE_PREFERENCE_KEY);
    if (isLocale(stored)) return stored;
    return window.navigator.language.toLowerCase().startsWith('zh') ? 'zh' : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export class GlobalErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };
  static getDerivedStateFromError(): State { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) {}
  render() {
    if (this.state.failed) {
      const messages = LOCALES[resolveErrorLocale()];
      return <main className="state-page"><h1>{messages.application_error_title}</h1><p>{messages.application_error_body}</p></main>;
    }
    return this.props.children;
  }
}
