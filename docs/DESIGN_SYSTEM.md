# FlowPilot — Design System (UX & UI)

> The ONE canonical UX/design document. Implemented tokens live in
> `src/app/globals.css`; primitives in `src/components/ui` and
> `src/components/shared`; canonical statuses in `src/lib/status.ts`.
> Renamed from `UX.md` in the PROMPT-ARCH-01 documentation reconciliation.
> UI copy terms: `PRODUCT_GLOSSARY.md` (Arabic column).

## UX Principles (binding)

1. **Arabic-first, RTL-first** — all copy is Arabic (reads naturally, not
   translated-English); `dir="rtl" lang="ar"` is the default; every
   component works mirrored; logical CSS properties only (`ms/me`, `ps/pe`,
   `start/end`) — never physical `left/right`.
2. **Mobile-first** — base styles target phones (most owner usage); must
   work at 360px; bottom nav never covers content.
3. **One clear primary action per view/step** — content over chrome; no
   competing CTAs.
4. **Scanability** — calm hierarchy, clear section labels, status language
   via `StatusBadge`; numbers use tabular figures where alignment matters.
5. **Progressive disclosure** — later steps locked until reachable (the
   Smart Create 6-step indicator pattern: locked steps get `aria-disabled`
   - lock icon; completed steps are clickable for safe back-navigation).
6. **Operational clarity / honest states** — every screen designs empty,
   loading, and error states with actionable recovery, never fake data:
   zero-slots reasons are explicit (`BUSINESS_CLOSED` /
   `SERVICE_TOO_LONG` / `FULLY_BOOKED`), missing inputs get per-field
   "go fix it" actions, never invented fallback values; failures
   distinguish typed domain errors from transport failures (retryable).
7. **Accessibility** — keyboard navigation everywhere; visible
   `:focus-visible` ring; `aria-label` on icon-only buttons;
   `aria-current` on active nav/steps; `role="alert"` for errors,
   `role="status"` for success/live updates; contrast ≥ 4.5:1 body text;
   skip link in the root layout; `.sr-only` for structural announcements.
8. **Human-in-the-loop visible** — `NEED_HUMAN` surfaces stay visible in
   every conversational surface (DECISIONS #03).
9. **Vertical-agnostic copy** — no vertical-specific terminology anywhere
   until a winning vertical is chosen (hard product rule).
10. **Booking UX direction** — the Smart Create flow is the canonical
    booking UX: العميل → الخدمة → التاريخ → الوقت → المراجعة → التأكيد
    (6 steps); selections never reset on back-navigation; displayed times
    come ONLY from server availability results; stale slots are cleared and
    revalidated server-side. Appointments use the Agenda View (list by
    day), never calendar grids (DECISIONS #01).

## Design Philosophy

- **Responsive strategy**: mobile (< 768px) sticky top bar + bottom
  navigation with safe-area padding; desktop (`md:` 768px+) fixed right
  sidebar (inline-start in RTL) + sticky header.
- **Inspiration**: Linear (deep-neutral dark discipline, calm motion,
  keyboard focus), Stripe (typography hierarchy, restrained color, trust
  cues), Attio (clean tables, quiet chrome), Notion (friendly emptiness,
  generous whitespace).
- **Visual principles**: clean (one primary action; content over chrome),
  premium (soft low-elevation shadows, refined indigo brand, 4px spacing
  rhythm), calm (120–280ms expo ease-out transitions; no bounce/parallax/
  confetti), trustworthy (high contrast where it matters, honest empty
  states, clear status language).

## Explicitly Avoid

- Neon colors / saturated gradients
- "Futuristic AI" gimmicks (glow, robots, sparkles)
- Cluttered dashboards with vanity widgets
- Decorative animations that delay interaction
- English-first copy with Arabic as an afterthought

## Typography

- **Primary:** IBM Plex Sans Arabic (400/500/600/700) — Arabic + Latin.
- **Mono:** Geist Mono — code/tabular contexts only.
- Scale: Tailwind defaults; page titles `text-xl sm:text-2xl font-semibold`,
  section titles `text-base font-semibold`, body `text-sm`.
- Headings track tight (`tracking-tight`); body line-height relaxed for
  Arabic.

## Spacing

4px base rhythm. Component paddings: cards `p-5`, list rows `py-2.5 px-3`,
page gutters `px-4 sm:px-6`. Section vertical gap `space-y-6/8`.

## Layout Philosophy

- Content column max-width `max-w-6xl`, centered.
- Page anatomy: `PageHeader → stats grid (optional) → sections`.
- Tables scroll horizontally on small screens; identity columns stay
  visible.
- Empty states are actionable (icon + title + description + next-step
  button).

## Color Tokens

Semantic tokens only (never raw hex in components):
`background/foreground/card/popover`, `primary/secondary/muted/accent`,
`destructive`, status colors `success/warning/error/info` (+ foregrounds),
sidebar family, chart palette 1–5. Dark theme = `.dark` class overrides.

## Status System

Canonical statuses live in `src/lib/status.ts`; render via `StatusBadge`.
Tones map to token colors: success/warning/error/info/neutral. Domain
statuses (`pending, confirmed, cancelled, no-show, need-human, ai-active,
booked, incomplete, active, inactive, completed`) each have a fixed tone +
icon + Arabic label.

## Review Checklist (before shipping any screen)

- [ ] All copy in Arabic; RTL layout intact (no physical left/right)
- [ ] Works at 360px width; bottom nav doesn't cover content
- [ ] Keyboard-only pass completed; focus visible
- [ ] Empty + loading + error states designed, not just the happy path
- [ ] No neon/gradients/gimmicks introduced
- [ ] One primary action; honest status/empty copy
