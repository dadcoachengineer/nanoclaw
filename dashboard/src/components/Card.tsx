"use client";

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-[var(--surface)] border border-[var(--border)] rounded-lg ${className || ""}`}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  right,
}: {
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
      <h2 className="text-sm font-semibold text-[var(--text-bright)]">
        {title}
      </h2>
      {right}
    </div>
  );
}

export function StatCard({
  value,
  label,
  color,
}: {
  value: string | number;
  label: string;
  color?: string;
}) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-4 py-3.5">
      <div
        className="text-[28px] font-bold text-[var(--text-bright)]"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      <div className="text-[11px] text-[var(--text-dim)] uppercase tracking-wider">
        {label}
      </div>
    </div>
  );
}

export function GroupHeader({ title }: { title: string }) {
  return (
    <div className="px-4 py-2 text-xs font-semibold text-[var(--text-dim)] uppercase tracking-wider bg-[var(--bg)] border-b border-[var(--border)]">
      {title}
    </div>
  );
}
