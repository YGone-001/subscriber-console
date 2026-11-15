const STACK_SEPARATOR = '|';

/** Parses the URL cursor back-stack. Empty cursors are not retained: the first
 *  page has no cursor and needs no stack entry. */
export function parseCursorStack(value: string | null): string[] {
  if (!value) return [];
  return value.split(STACK_SEPARATOR).filter((part) => part.length > 0);
}

export function serializeCursorStack(stack: string[]): string {
  return stack.filter(Boolean).join(STACK_SEPARATOR);
}

/** Pushes the current cursor before advancing. The first page's empty cursor is
 *  intentionally not stored. */
export function pushCursorStack(stack: string[], cursor: string): string[] {
  return cursor ? [...stack, cursor] : stack;
}

/** Pops the previous cursor. An empty result means the first page. */
export function popCursorStack(stack: string[]): { stack: string[]; cursor: string } {
  if (stack.length === 0) return { stack: [], cursor: '' };
  return { stack: stack.slice(0, -1), cursor: stack[stack.length - 1] ?? '' };
}

export function pageNumberFromStack(stack: string[], hasCursor: boolean): number {
  return hasCursor ? stack.length + 2 : 1;
}