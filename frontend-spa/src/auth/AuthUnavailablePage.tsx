export function AuthUnavailablePage() {
  return (
    <main className="state-page" aria-live="assertive">
      <section className="state-card">
        <p className="eyebrow">Authentication authority unavailable</p>
        <h1>Protected content is unavailable</h1>
        <p>The session authority could not confirm access. Try again after service recovery.</p>
      </section>
    </main>
  );
}
