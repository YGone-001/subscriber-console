import { Suspense } from 'react';
import { AuditConsole } from './AuditConsole';

export default function AuditLogsPage() {
  return (
    <Suspense fallback={<div className="container"><div className="glass-card">Loading audit console…</div></div>}>
      <AuditConsole />
    </Suspense>
  );
}
