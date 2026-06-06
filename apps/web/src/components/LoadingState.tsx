import { Loader2 } from 'lucide-react';

import { cn } from '../lib/cn.js';

type LoadingSize = 'xs' | 'sm' | 'md' | 'lg';

const spinnerSizes: Record<LoadingSize, string> = {
  xs: 'h-3.5 w-3.5',
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-8 w-8',
};

type LoadingSpinnerProps = {
  className?: string;
  decorative?: boolean;
  label: string;
  size?: LoadingSize;
};

export function LoadingSpinner({
  className,
  decorative = false,
  label,
  size = 'md',
}: LoadingSpinnerProps) {
  const accessibilityProps = decorative
    ? { 'aria-hidden': true }
    : { 'aria-label': label, role: 'progressbar' as const };

  return (
    <Loader2
      {...accessibilityProps}
      className={cn('shrink-0 animate-spin motion-reduce:animate-none', spinnerSizes[size], className)}
    />
  );
}

type LoadingStateProps = {
  className?: string;
  compact?: boolean;
  label: string;
};

export function LoadingState({ className, compact = false, label }: LoadingStateProps) {
  return (
    <div
      aria-live="polite"
      className={cn(
        'flex items-center justify-center text-muted',
        compact ? 'gap-2 py-3 text-sm font-medium' : 'gap-3 py-16 text-sm font-semibold',
        className,
      )}
    >
      <LoadingSpinner decorative label={label} size={compact ? 'sm' : 'md'} />
      <span>{label}</span>
    </div>
  );
}

type LoadingOverlayProps = {
  className?: string;
  label: string;
  tone?: 'surface' | 'code';
};

export function LoadingOverlay({ className, label, tone = 'surface' }: LoadingOverlayProps) {
  return (
    <div className={cn('loading-overlay', tone === 'code' && 'loading-overlay-code', className)}>
      <div className="loading-overlay-card">
        <LoadingState compact className="loading-overlay-state" label={label} />
      </div>
    </div>
  );
}
