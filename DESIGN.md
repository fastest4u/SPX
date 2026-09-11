---
version: alpha
name: SPX Quiet Authority
description: A Thai operations dashboard with dark surfaces, cream-gold actions, and restrained semantic status colors.
colors:
  background: "#1a1a1c"
  foreground: "#faf9f6"
  card: "#242426"
  popover: "#2a2a2c"
  primary: "#e8c76a"
  muted: "#2e2e30"
  muted-foreground: "#a09e97"
  border: "#3a3a3c"
  info: "#7dd3fc"
  success: "#34d399"
  warning: "#fbbf24"
  danger: "#fb7185"
typography:
  sans:
    fontFamily: '"Fira Sans", "IBM Plex Sans Thai", "Sarabun", "Noto Sans Thai", ui-sans-serif, system-ui, sans-serif'
  mono:
    fontFamily: '"Fira Code", monospace'
rounded:
  DEFAULT: "0.875rem"
omitted:
  - section: spacing
    reason: Existing CSS utilities and shared components own spacing; this feature introduces no new global scale.
components:
  button: {}
  card: {}
  input: {}
  dialog: {}
---

# SPX Design System

## Overview

### Creative North Star

The existing stylesheet calls this identity **Quiet Authority**: an operations console that makes team state easy to scan through layered charcoal surfaces, warm primary actions, and compact information. Preserve it when adding account management.

### Product context and register

SPX serves operators and administrators managing teams and bidding/polling work. The current request and Thai dashboard copy establish Thai language use; this document makes no additional geographic or regulatory claim. This is a product dashboard used at desktop and narrow widths. Account settings should fit the existing page hierarchy and leave operational controls recognizable.

`src/frontend/index.css` is the canonical runtime token source. Its `:root` tokens feed Tailwind's theme adapter in the same file and shared `src/frontend/components/ui` primitives. Frontmatter records the existing values for discovery; it does not generate CSS. Change tokens in the canonical source and reconcile this document in the same change. Check the concrete values and browser rendering when either changes. No token changes are needed for provider authentication.

## Colors

Use background, card, popover, and muted surfaces for hierarchy. Cream-gold primary identifies the principal action. Success, warning, danger, and info convey state with accompanying text. Use existing semantic utilities rather than repeating palette literals in a screen. The maintained application is dark-only; no new light theme is implied.

## Typography

Keep the existing font loading in `index.html` and the CSS Thai-capable fallback stack. The runtime body size is 14px; section headings use the existing 16/20/24px hierarchy. Monospace is for technical values, not Thai prose. Dates and status labels must remain legible without truncated critical content.

## Layout

Reuse sibling dashboard/team layouts and shared control sizing. Keep forms in normal document flow; dialogs may own a bounded internal scroll area. At narrow widths, stack account actions and allow long email addresses to wrap. Do not introduce a new viewport-height constraint on the dashboard or Teams page. Reserve stable button geometry during asynchronous work.

## Elevation & Depth

Tonal layers and subtle borders establish depth. Reuse the shared dialog's overlay and blur. Keep operational content quiet; account settings need no hero treatment, decorative gradients, or new ornamental surfaces.

## Shapes

The canonical default radius is 14px. Shared primitives own their deliberate radius and density variants, including the existing dialog container. Do not copy a separate radius scale into the account panel.

## Components

### Foundational visual states

Reuse Button, Input, Label, Card, and Dialog primitives. Preserve visible keyboard focus, pointer hover, disabled and busy states. Status needs text as well as color. A small app-owned spinner communicates unmeasured waiting; never invent a progress percentage.

### Buttons and actions

The existing Button default has a 44px minimum-height target, with small and large variants. Use the primary treatment for connecting an account, and lower emphasis for reconnecting or cancelling. Keep the label space stable while busy.

### Navigation and data display

Account management is available from the own-team dashboard and the administrator's selected team. Use the same shared panel for both contexts. Retain the existing team table and operational navigation.

### Forms and overlays

Use Thai labels and inline recovery guidance, connected labels/descriptions, masked password input, and an accessible visibility toggle. Use the shared Radix-based Dialog for modal behavior and the existing global Sonner provider for transient feedback. Persistent connection errors also remain inline. Passwords are never status text or toast content.

### Iconography

Reuse the application's Lucide icons. Icons supplement Thai action labels; icon-only controls require a Thai accessible name.

### Motion

The CSS owns 150/200/280ms motion tokens and reduced-motion behavior. Motion should indicate feedback or overlay transitions, with no decorative animation for the account workflow.

### Content and data visualization

Use direct Thai instructions distinguishing the provider account from the SPX dashboard account. Display saved-password presence without a recoverable password value. Connection status and team running state remain separate concepts.

## Do's and Don'ts

- Reuse runtime tokens and shared primitives; verify the actual browser result.
- Preserve existing team settings and provide clear recovery from a failed connection.
- Keep secrets out of URLs, browser persistence, logs, cached request variables, and feedback text.
- Avoid a visual redesign, fake progress, or success messaging before the server confirms completion.
