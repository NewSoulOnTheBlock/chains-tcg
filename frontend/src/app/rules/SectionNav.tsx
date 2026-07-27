"use client";

// Horizontally scrollable section-jump chip bar for the rules page.
// Highlights the section currently in view and smooth-scrolls on tap.

import { useEffect, useState } from "react";

export type RulesSection = { id: string; label: string };

export function SectionNav({ sections }: { sections: RulesSection[] }) {
  const [active, setActive] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setActive(e.target.id);
            break;
          }
        }
      },
      // Consider a section "active" when it crosses the upper-middle band of
      // the viewport (below the sticky header, above the fold midpoint).
      { rootMargin: "-35% 0px -55% 0px" }
    );
    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav
      aria-label="Rules sections"
      className="flex gap-2 overflow-x-auto px-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {sections.map((s) => {
        const isActive = active === s.id;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() =>
              document
                .getElementById(s.id)
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors ${
              isActive
                ? "border-amber-400/60 bg-amber-400/15 text-amber-300"
                : "border-border bg-secondary/50 text-muted-foreground hover:text-foreground"
            }`}
          >
            {s.label}
          </button>
        );
      })}
    </nav>
  );
}
