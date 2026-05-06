# Clagentic:Console — Brand Document

**Status:** canonical  
**Scope:** all Clagentic:Console UI surfaces (web app, PWA, any future native shell)  
**Last updated:** 2026-05-06

---

## Identity

**Product name:** Clagentic:Console  
**Short form:** Clagentic (for prose), Console (for UI chrome when space is limited)  
**Wordmark rendering:** `CLAGENTIC:CONSOLE` — all caps, weight 300, letter-spacing 0.18em  
**Tagline:** AI tooling. Built for builders.

---

## Mark

The C-arc. A single open arc with two terminal dots, rendered as a gradient from cyan to violet.

**SVG definition (canonical):**
```svg
<svg viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="cg" gradientUnits="userSpaceOnUse" x1="36" y1="4" x2="36" y2="68">
      <stop offset="0%"   stop-color="#00CFFF"/>
      <stop offset="50%"  stop-color="#4A7FE8"/>
      <stop offset="100%" stop-color="#7B3FE4"/>
    </linearGradient>
  </defs>
  <path d="M 58.98 16.71 A 30 30 0 1 0 58.98 55.29"
        stroke="url(#cg)" stroke-width="5" stroke-linecap="round" fill="none"/>
  <circle cx="58.98" cy="16.71" r="2.8" fill="#00CFFF"/>
  <circle cx="58.98" cy="55.29" r="2.8" fill="#7B3FE4"/>
</svg>
```

Rules:
- Never fill the arc. It is always stroke-only.
- Never apply a solid color. The gradient is the mark.
- Minimum render size: 20px. Below this, use wordmark only.
- The mark may spin slowly (0.007 deg/ms) as a motion treatment on splash screens. In UI chrome, it is static.

---

## Color System

### Brand Spectrum

Three stops. Always used as a set — never cherry-pick individual stops.

| Token              | Dark mode  | Light mode | Role |
|--------------------|------------|------------|------|
| `--brand-cyan`     | `#00CFFF`  | `#0099CC`  | Primary accent, interactive, live indicators |
| `--brand-blue`     | `#4A7FE8`  | `#2D5EB8`  | Secondary accent, links, accent2 |
| `--brand-violet`   | `#7B3FE4`  | `#6128B8`  | Tertiary, gradient terminus, keywords |

Light mode values are shifted for WCAG AA contrast on light backgrounds. The perceptual identity is the same.

### Dark Theme Palette (`clagentic-dark`)

| CSS var             | Value      | Role |
|---------------------|------------|------|
| `--bg`              | `#080A0F`  | Main canvas — near void |
| `--bg-alt`          | `#0D1017`  | Sidebar, secondary surfaces |
| `--bg-surface`      | `#111827`  | Cards, overlays, code block headers |
| `--bg-surface-2`    | `#1A2233`  | Input fields, code body, deep cards |
| `--border`          | `#1A2233`  | Standard border |
| `--border-subtle`   | `#111827`  | Dividers, hairlines |
| `--border-bright`   | `#2A3A52`  | Hover states, focus rings |
| `--text`            | `#E0EAF4`  | Primary text |
| `--text-secondary`  | `#C8D4E0`  | Body copy, assistant messages |
| `--text-muted`      | `#7A8FA6`  | Labels, secondary UI |
| `--text-dimmer`     | `#3A4A5C`  | Captions, placeholders, idle icons |
| `--accent`          | `#00CFFF`  | Primary interactive (brand-cyan) |
| `--accent2`         | `#4A7FE8`  | Secondary interactive (brand-blue) |
| `--error`           | `#FF4D6A`  | Destructive, failure |
| `--success`         | `#29D9A8`  | Success, connected, live |
| `--warning`         | `#F59E0B`  | Caution |

### Light Theme Palette (`clagentic-light`)

Same structure. Key surface values:

| CSS var           | Value      |
|-------------------|------------|
| `--bg`            | `#F4F7FB`  |
| `--bg-alt`        | `#EBF0F7`  |
| `--bg-surface`    | `#FFFFFF`  |
| `--bg-surface-2`  | `#E4ECF5`  |
| `--text`          | `#0D1421`  |
| `--accent`        | `#0099CC`  |
| `--accent2`       | `#2D5EB8`  |

All other vars follow the dark structure with adjusted values (see `clagentic-light.json`).

---

## Typography

### Fonts

| Role | Family | Source |
|------|--------|--------|
| UI sans | DM Sans | Google Fonts |
| Code / mono / chrome | DM Mono | Google Fonts |

```css
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&family=DM+Mono:wght@300;400;500&display=swap');
```

**Never substitute:** Inter, Roboto, Arial, or system-ui as the primary face. DM Sans is load-critical — preconnect to `fonts.googleapis.com` and `fonts.gstatic.com`.

### Scale

| Use | Family | Weight | Size | Tracking |
|-----|--------|--------|------|----------|
| Wordmark | DM Sans | 300 | responsive (clamp) | 0.18em |
| Body / prose | DM Sans | 400 | 14px | default |
| UI labels, nav | DM Sans | 400 | 13px | default |
| Section headers | DM Mono | 400 | 9–9.5px | 0.16–0.18em, uppercase |
| Code inline | DM Mono | 400 | 12.5px | default |
| Code block | DM Mono | 300 | 12.5px | default |
| Timestamps, metadata | DM Mono | 300 | 9–10px | 0.06–0.10em |
| Chips / badges | DM Mono | 400 | 9.5px | 0.10em, uppercase |

DM Mono at small sizes in uppercase with generous tracking is the "console voice" of the UI. Use it for section labels, model indicators, tool names, status lines.

---

## Motion

- **Accent pulse:** `opacity 1 → 0.3 → 1` over 2.6s ease-in-out. Used for live session dots, connected status indicators.
- **Mark spin (splash only):** 0.007 deg/ms continuous rotation. Not used in app chrome.
- **Orbit ring (splash only):** opacity 0 → 1 over 2.5s, delayed 1s.
- **Page load reveals:** `translateY(12px) → 0, opacity 0 → 1`, cubic-bezier(0.16,1,0.3,1), 1s, staggered by 0.15s.
- **Input focus ring:** `box-shadow` expand over 0.15s ease.
- **Hover transitions:** 0.12–0.15s linear or ease. No bounce, no spring, no overshoot.

---

## Rules

1. **One accent, used sparingly.** Cyan (`--accent`) is reserved for the most interactive/live element on screen at any time: the active session dot, the send button, the active chip. Don't scatter it.
2. **Borders are implied, not asserted.** `--border-subtle` for most dividers. `--border` only where the separation must register visually.
3. **No warm colors in UI chrome.** Orange, yellow, amber don't appear in the brand spectrum. They exist only in semantic warning states, and even then subdued.
4. **Mono for all labels and chrome.** Any text that is metadata — timestamps, model names, tool names, section headers — uses DM Mono. Prose uses DM Sans.
5. **No gradients in UI chrome.** The gradient appears only in the C-mark and the wordmark. Backgrounds are flat. The spectrum is a signature, not a paint bucket.
6. **Light mode is not an afterthought.** The light palette must be validated every time dark changes. Light gets the same care: cool off-white bg, not paper-white.
7. **The colon is load-bearing.** `Clagentic:Console` — the colon is always present in the full product name. It signals the console layer. Never write `Clagentic Console` without the colon.

---

## File Locations

| File | Purpose |
|------|---------|
| `lib/themes/clagentic-dark.json` | Base16 palette, dark |
| `lib/themes/clagentic-light.json` | Base16 palette, light |
| `lib/public/css/base.css` | Font imports, CSS variable seeds, global reset |
| `lib/public/modules/theme.js` | `computeVars()` — derives all CSS vars from palette |
| `docs/brand/BRAND.md` | This document |
| `docs/brand/preview-dark.html` | Standalone dark theme preview |
| `docs/brand/preview-light.html` | Standalone light theme preview |
