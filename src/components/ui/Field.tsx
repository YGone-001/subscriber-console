import type { ReactNode } from "react";

interface FieldProps {
  htmlFor: string;
  label: ReactNode;
  className?: string;
  labelClassName?: string;
  children: ReactNode;
}

export function Field({ htmlFor, label, className, labelClassName, children }: FieldProps) {
  return (
    <div className={className}>
      <label className={labelClassName} htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}
