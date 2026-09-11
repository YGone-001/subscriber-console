/**
 * Shared audit utilities for Profile CRUD routes.
 * Ensures consistent safe snapshot handling across POST/PUT/DELETE.
 */

export function safeProfileSnapshot(profile: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!profile) return null;
  const { k, op, opc, amf, sqn, ...safeAuth } = (profile.auth as Record<string, unknown>) || {};
  return {
    name: profile.name,
    title: profile.title,
    description: profile.description,
    access_restriction_data: profile.access_restriction_data,
    ambr: profile.ambr,
    sliceList: profile.sliceList,
    ocsDefaults: profile.ocsDefaults,
    createdAt: profile.createdAt,
    createdBy: profile.createdBy,
    updatedAt: profile.updatedAt,
    updatedBy: profile.updatedBy,
    authConfigured: !!(k || op || opc || amf),
  };
}
