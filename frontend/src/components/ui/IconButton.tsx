/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ui/IconButton.tsx
 * Adaptations: "use client" dropped; CSS-module import repointed to ../../styles/modules/.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
  label: string;
  children: ReactNode;
}

export function IconButton({ label, title, type = "button", children, ...props }: IconButtonProps) {
  return (
    <button type={type} aria-label={label} title={title || label} {...props}>
      {children}
    </button>
  );
}
