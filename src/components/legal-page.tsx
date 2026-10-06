import type { ReactNode } from "react";
import { SITE } from "@/lib/site";

/** Shared layout for terms / privacy pages. */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="card mx-auto max-w-3xl p-6 sm:p-8">
      <h1 className="font-display text-2xl font-bold">{title}</h1>
      <p className="mt-1 text-xs text-ink-2">制定日：{SITE.legalEffectiveDate}</p>
      <div className="legal mt-6 space-y-6 text-sm leading-relaxed">{children}</div>
    </article>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-display text-base font-bold">{title}</h2>
      {children}
    </section>
  );
}

export function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

export function Contact() {
  return (
    <a href={SITE.contactUrl} target="_blank" rel="noopener noreferrer" className="font-bold text-accent underline">
      {SITE.contactLabel}
    </a>
  );
}
