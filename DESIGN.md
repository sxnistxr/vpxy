---
name: VibeProxy console
description: A precise operator console for pooled AI subscriptions.
colors:
  canvas: "#000000"
  rail: "#0a0a0a"
  surface: "#0c0c0d"
  raised: "#151516"
  border: "#232325"
  foreground: "#ededed"
  secondary: "#a1a1a6"
  muted: "#808087"
  accent: "#4d8dff"
  success: "#3ecf8e"
  warning: "#f5a524"
  danger: "#f2555a"
typography:
  body:
    fontFamily: Geist
    fontSize: 13px
    lineHeight: 20px
  title:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: 600
    lineHeight: 32px
    letterSpacing: -0.02em
  code:
    fontFamily: Geist Mono
    fontSize: 12px
rounded:
  control: 6px
  panel: 8px
  dialog: 12px
spacing:
  small: 8px
  medium: 16px
  section: 24px
  page: 32px
---

## Overview

One operator checks routing and quota beside a terminal or on a phone over Tailscale.
The chosen direction is the restrained developer console represented by Vercel, Linear,
and Raycast. Brand comes from the supplied orbit-and-sparkle VP monogram and italic
VibeProxy wordmark. Use the SVG assets in `dashboard/public/assets/`.

## Colors

The default theme is true black with neutral surfaces and hairline borders. White primary
buttons carry the main action. Blue marks interaction; green, amber, and red describe state,
always accompanied by text. Light mode uses a white canvas, #fafafa rail, #f4f4f5 raised
surfaces, #e6e6e8 borders, #111113 foreground, #56565e secondary, and #6b6b73 muted text.
Its blue/green/amber/red equivalents are #2563eb, #15803d, #b45309, and #dc2626.
Inline links in paragraphs are underlined. Tokens live in `dashboard/app/styles.css`.

## Typography

Geist is self-hosted by the optz export. Geist Mono is reserved for IDs, code, JSON,
YAML, and logs. Use 12px metadata, 13px body, 14px section headings, 24px page titles,
and 28px numeric readouts. Numerals are tabular. Sentence case throughout.

## Layout

The desktop rail is 232px wide. A 56px top bar locates the current page. Main content has
32px desktop padding and a 1280px outer maximum; mobile padding is 16px. Monitor, Manage,
and System group the 13 routes. At widths below 1024px the rail becomes a dismissible drawer.
Tables scroll inside their own containers. Page actions wrap. Overview leads with the
next eligible account for each provider, then activity, resets, attention, and account detail.

## Elevation & Depth

Panels use borders without shadows. Only dialogs and toasts have a soft offset shadow.
Native modal dialogs supply focus containment, Escape behavior, and an opaque scrim.

## Shapes

Controls use 6px corners, panels 8px, and dialogs 12px. Pills are fully rounded. Icons
come from Lucide, with official provider marks in the asset directory.

## Components

Shared primitives are in `dashboard/app/components/ui.tsx`. Fields pair labels and hint IDs;
errors are announced; switches expose their checked state. Tabs and segmented filters
support arrow keys, Home, and End. Motion animates meter updates, selection, routing-order
changes, switches, and toast lifecycle. A root MotionConfig honors reduced-motion settings.
Use 150–200ms state transitions and zero-bounce springs. No decorative animation.

## Do's and Don'ts

- Lead with a real task or routing answer. Keep missing and stale data explicit.
- Mask account identities by default and keep management keys in memory only.
- Show counters as "since proxy started"; never invent daily totals or trend data.
- Preserve unknown settings, check concurrent edits, and confirm destructive operations.
- Track banked subscription resets without claiming or spending them.
- Keep provider response secrets out of quota state and visible output.
