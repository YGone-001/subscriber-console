// Legacy read-only compatibility alias. Mutations are retired (Phase 8.2); the
// canonical mutation surface is PATCH /api/users/{username}.
export { GET } from '@/app/api/users/[username]/route';
export const dynamic = 'force-dynamic';
