import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export function AppShell() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function logout() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Logout request failed');
      navigate('/login', { replace: true });
    } catch {
      setError('The session could not be ended. Try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="shell-page">
      <section className="shell-card">
        <p className="eyebrow">Static SPA migration foundation</p>
        <h1>xCloud application shell</h1>
        <p>Routing and authentication boundaries are verified here. Business surfaces remain pending migration.</p>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button type="button" onClick={logout} disabled={loading}>{loading ? 'Signing out...' : 'Sign out'}</button>
      </section>
    </main>
  );
}
