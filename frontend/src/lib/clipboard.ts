/**
 * Copies text through the Clipboard API when the origin is secure, and falls
 * back to a selection copy because that API is unavailable on plain-HTTP
 * origins (the console is also served that way on LAN addresses).
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* Permission or focus failures still get the selection fallback. */
    }
  }
  return copyWithSelection(text);
}

function copyWithSelection(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  document.body.removeChild(textarea);
  return copied;
}
