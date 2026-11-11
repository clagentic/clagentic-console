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

### Refresh palettes (proposed, pending operator sign-off)

The values below are the proposed refresh, shown value for value in `preview-dark.html` and `preview-light.html`, where every text and boundary pair carries its computed contrast ratio. The brand spectrum above is the mark's gradient and is unchanged; the UI accent tokens below are the AA-safe values for text and controls on the new surfaces (the dark `--accent2` is lifted, the light `--accent` is deepened). Text pairs meet 4.5:1 and control boundaries 3:1. `--text-dimmer` is used only on the sidebar, page, raised and code surfaces (never on the own-message surface, the input or the selected row; those take `--text-muted`).

### Dark Theme Palette (`clagentic-dark`)

Surface tiers, darkest to lightest, with lightness (L*) and the step from the tier before: sidebar 9.7, page 14.1 (+4.4), raised 18.8 (+4.7), own-message 24.2 (+5.4), input 28.2 (+4.0). The page is 11.8 L* lighter than the old `#060810` (2.2).

| CSS var             | Value      | Role |
|---------------------|------------|------|
| `--sidebar-bg`      | `#141B28`  | Sidebar, tier 1 |
| `--bg`              | `#1C2433`  | Page, tier 2 |
| `--bg-alt`          | `#242E40`  | Raised cards and overlays, tier 3 |
| `--user-bubble`     | `#2E3A4F`  | Own-message surface, tier 4 |
| `--input-bg`        | `#374359`  | Composer input, tier 5 |
| `--code-bg`         | `#101722`  | Code blocks |
| `--sidebar-active`  | `#263245`  | Selected session row |
| `--text`            | `#EAF0F8`  | Primary text |
| `--text-secondary`  | `#C5D0DE`  | Body copy |
| `--text-muted`      | `#A7B5C8`  | Labels, secondary UI, placeholders |
| `--text-dimmer`     | `#8E9DB3`  | Timestamps and labels (page, sidebar, raised, code only) |
| `--border`          | `#364257`  | Decorative divider |
| `--border-subtle`   | `#2A3548`  | Hairline |
| `--border-strong`   | `#8294AE`  | Input, button and control boundary (3:1 or better) |
| `--accent`          | `#00CFFF`  | Primary interactive (brand-cyan) |
| `--accent2`         | `#7BA7F7`  | Links, secondary interactive |
| `--error`           | `#FF8094`  | Destructive, failure |
| `--success`         | `#29D9A8`  | Success, connected, live |
| `--warning`         | `#F59E0B`  | Caution |
| `--on-accent`       | `#0B1220`  | Text on an accent fill |
| `--on-av`           | `#0B1220`  | Initials on an avatar tint |
| `--av0` to `--av3`  | `#7FD8F0`, `#B9A3F5`, `#7FE0C2`, `#F2C879` | Avatar tints |

Base16 file (`lib/themes/clagentic-dark.json` after the build):

| Key      | Value      | Key      | Value      |
|----------|------------|----------|------------|
| `base00` | `#1C2433`  | `base08` | `#FF8094`  |
| `base01` | `#242E40`  | `base09` | `#00CFFF`  |
| `base02` | `#364257`  | `base0A` | `#7BA7F7`  |
| `base03` | `#8E9DB3`  | `base0B` | `#29D9A8`  |
| `base04` | `#A7B5C8`  | `base0C` | `#A78BFA`  |
| `base05` | `#C5D0DE`  | `base0D` | `#7BA7F7`  |
| `base06` | `#EAF0F8`  | `base0E` | `#C084FC`  |
| `base07` | `#F5F9FF`  | `base0F` | `#818CF8`  |
| `accent2`| `#7BA7F7`  |          |            |

### Light Theme Palette (`clagentic-light`)

Lightness (L*): sidebar 91.8, page 96.1, raised 100, own-message 90.8, input 100. Steps around the page: sidebar to page +4.3, page to raised +3.9, page to own-message 5.3 lower, page to input +3.9. Raised cards and the input are both white; the input is told apart by its `--border-strong` outline.

| CSS var             | Value      | Role |
|---------------------|------------|------|
| `--sidebar-bg`      | `#E2E8F1`  | Sidebar |
| `--bg`              | `#F1F4F9`  | Page, cool off-white |
| `--bg-alt`          | `#FFFFFF`  | Raised cards and overlays |
| `--user-bubble`     | `#D9E6F7`  | Own-message surface |
| `--input-bg`        | `#FFFFFF`  | Composer input, outlined |
| `--code-bg`         | `#E9EEF5`  | Code blocks |
| `--sidebar-active`  | `#D3DEEE`  | Selected session row |
| `--text`            | `#0F1724`  | Primary text |
| `--text-secondary`  | `#2B3A4F`  | Body copy |
| `--text-muted`      | `#4A5B72`  | Labels, secondary UI, placeholders |
| `--text-dimmer`     | `#566680`  | Timestamps and labels (page, sidebar, raised, code only) |
| `--border`          | `#CBD5E3`  | Decorative divider |
| `--border-subtle`   | `#DDE4EE`  | Hairline |
| `--border-strong`   | `#73849C`  | Input, button and control boundary (3:1 or better) |
| `--accent`          | `#006D94`  | Primary interactive (AA text on light; the brand cyan stays in the mark) |
| `--accent2`         | `#2D5EB8`  | Links, secondary interactive |
| `--error`           | `#B3122D`  | Destructive, failure |
| `--success`         | `#0A6B4A`  | Success, connected, live |
| `--warning`         | `#8A5300`  | Caution |
| `--on-accent`       | `#FFFFFF`  | Text on an accent fill |
| `--on-av`           | `#FFFFFF`  | Initials on an avatar fill |
| `--av0` to `--av3`  | `#0B6E8A`, `#6A3FC4`, `#0D7A55`, `#9A5B00` | Avatar fills |

Base16 file (`lib/themes/clagentic-light.json` after the build):

| Key      | Value      | Key      | Value      |
|----------|------------|----------|------------|
| `base00` | `#F1F4F9`  | `base08` | `#B3122D`  |
| `base01` | `#FFFFFF`  | `base09` | `#006D94`  |
| `base02` | `#CBD5E3`  | `base0A` | `#2D5EB8`  |
| `base03` | `#566680`  | `base0B` | `#0A6B4A`  |
| `base04` | `#4A5B72`  | `base0C` | `#6128B8`  |
| `base05` | `#2B3A4F`  | `base0D` | `#2D5EB8`  |
| `base06` | `#0F1724`  | `base0E` | `#7C3AED`  |
| `base07` | `#060A12`  | `base0F` | `#4F46E5`  |
| `accent2`| `#2D5EB8`  |          |            |

### Chat layout, as previewed

- One layout; the viewer's own messages on the right. Width steps (screens wider than 768 px): Compact 640 px, Comfortable 820 px (default, today's `--content-width`), Wide 1040 px, Full (pane width). Phone is always full width.
- Other speakers: avatar, name, label and time on one 24 px header line; the own side is the same line mirrored (time, name, avatar), right-aligned. Own header shows time only in a one-person session, avatar, name and time when two or more humans have spoken.
- Shared collapsible component options: `lines` (default 3), `size` (normal, compact), `controls` (row, inline, header). Injected message and loop: 3, normal, header. Pending scheduled card: 1, compact, inline. Expand stays reachable in every configuration; touch targets are at least 44 by 44 px.
- Avatars: 20 px in the session list, on by default, switchable in Appearance.

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
