export function splitTagInput(raw: string): string[] {
  return raw.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
}

export function mergeTags(
  current: string[],
  incoming: string[],
  maxTags: number,
  maxTagLength: number,
): string[] {
  const result = [...current];
  const seen = new Set(result.map((tag) => tag.toLowerCase()));
  for (const raw of incoming) {
    const tag = raw.trim();
    if (!tag || tag.length > maxTagLength) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    if (result.length >= maxTags) break;
    result.push(tag);
    seen.add(key);
  }
  return result;
}
