// Legacy read-only compatibility alias. Mutations are retired (Phase 8.2) and
// must only be performed through the canonical /api/users surface.
export { GET } from '@/app/api/users/route';
export const dynamic = 'force-dynamic';
