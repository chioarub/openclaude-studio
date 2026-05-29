import { useState, useCallback, useEffect, useRef, type MouseEvent } from 'react';
import { Copy, Check } from 'lucide-react';

import { cn } from '../lib/cn.js';

type CopyablePathProps = {
  value: string;
  display?: string;
  copyLabel?: string;
  truncate?: boolean;
  breakAll?: boolean;
  className?: string;
  textClassName?: string;
  buttonClassName?: string;
};

export function CopyablePath({
  value,
  display,
  copyLabel = 'Copy path',
  truncate = false,
  breakAll = false,
  className,
  textClassName,
  buttonClassName,
}: CopyablePathProps) {
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = display ?? value;
  const hasClipboard = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const button = event.currentTarget;
    if (!hasClipboard) return;
    navigator.clipboard.writeText(value).then(() => {
      if (!mountedRef.current) return;
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
      setCopied(true);
      button.blur();
      resetTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setCopied(false);
        }
        resetTimerRef.current = null;
      }, 2000);
    }).catch(() => {
      button.blur();
    });
  }, [hasClipboard, value]);

  return (
    <div className={cn('flex min-w-0 items-center gap-1 group', className)}>
      <span
        className={cn(
          'min-w-0 font-mono text-[12px] text-ink',
          truncate && 'truncate',
          breakAll && 'break-all',
          textClassName,
        )}
        title={value}
      >
        {shown}
      </span>
      {hasClipboard ? (
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copyLabel}
          title={copied ? 'Copied!' : copyLabel}
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded transition-all',
            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
            'text-muted-soft hover:text-primary hover:bg-primary/5',
            copied && '!text-success',
            buttonClassName ?? 'h-5 w-5',
          )}
        >
          {copied ? (
            <Check className="h-3 w-3" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </button>
      ) : null}
    </div>
  );
}
