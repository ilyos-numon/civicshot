import type { ButtonHTMLAttributes, ReactNode } from 'react';
import '../styles/base.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant: 'primary' | 'secondary' | 'danger';
  size: 'lg' | 'md';
  loading?: boolean;
  full?: boolean;
  children?: ReactNode;
}

export function buttonClass(variant: ButtonProps['variant'], size: ButtonProps['size'], full?: boolean): string {
  return `cs-btn cs-btn--${variant} cs-btn--${size}${full ? ' cs-btn--full' : ''}`;
}

export function Button({ variant, size, loading, full, children, disabled, className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={`${buttonClass(variant, size, full)}${className ? ` ${className}` : ''}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="cs-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
