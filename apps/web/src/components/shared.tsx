import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function PageHeader({
  aside,
  icon: Icon,
  status,
  title,
}: {
  aside?: ReactNode;
  icon: LucideIcon;
  status: string;
  title: string;
}) {
  return (
    <header className="page-header">
      <div className="page-header-title">
        <div className="icon-frame">
          <Icon className="h-6 w-6" aria-hidden="true" focusable="false" />
        </div>
        <div className="min-w-0">
          <h1 className="font-display text-[34px] leading-none text-ink md:text-[40px]">{title}</h1>
          <div className="mt-2 flex min-w-0 items-center gap-2">
            <span className="status-dot" />
            <span className="truncate text-xs font-medium uppercase leading-none tracking-widest text-muted-soft">
              {status}
            </span>
          </div>
        </div>
      </div>
      {aside ? <div className="page-header-aside">{aside}</div> : null}
    </header>
  );
}

export function QuickStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="quick-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function SectionHeading({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="section-heading">
      <Icon className="h-4 w-4" aria-hidden="true" />
      {label}
    </div>
  );
}

export function Badge({ label, tone }: { label: string; tone: 'danger' | 'muted' | 'success' | 'warning' }) {
  return <span className={`badge badge-${tone}`}>{label}</span>;
}

export function EmptyState({ label }: { label: string }) {
  return <div className="empty-state">{label}</div>;
}

export function PageStack({ children }: { children: ReactNode }) {
  return <div className="space-y-5">{children}</div>;
}
