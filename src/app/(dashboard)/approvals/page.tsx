import { Suspense } from 'react';
import { ApprovalConsole } from './ApprovalConsole';

export default function ApprovalsPage() {
  return <Suspense fallback={<div className="container">Loading approvals…</div>}><ApprovalConsole /></Suspense>;
}
