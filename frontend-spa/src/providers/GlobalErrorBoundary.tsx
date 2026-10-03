import { Component, type ErrorInfo, type ReactNode } from 'react';

type State = { failed: boolean };
export class GlobalErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };
  static getDerivedStateFromError(): State { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) {}
  render() {
    if (this.state.failed) return <main className="state-page"><h1>Application error</h1><p>Please reload the application.</p></main>;
    return this.props.children;
  }
}
