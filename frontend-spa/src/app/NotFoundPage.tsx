import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <main className="state-page">
      <section className="state-card">
        <p className="eyebrow">404</p>
        <h1>Route not found</h1>
        <Link to="/">Return to the migration shell</Link>
      </section>
    </main>
  );
}
