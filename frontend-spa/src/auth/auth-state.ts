export function safeLocalDestination(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.includes('\\')) return '/';
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(value)) return '/';
  return value;
}
