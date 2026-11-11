# Themes

Clagentic: Console ships two themes, Dark and Light. You can add your own.

## Choosing a theme

Open **User Settings, Appearance** (on a phone, the **More** sheet, under the same Appearance rows). The Theme choice offers:

- **Dark**: the built-in dark theme.
- **Light**: the built-in light theme.
- **Follow system**: Dark or Light to match the system setting. It tracks the system live, including a change while the console is open.
- **Each custom theme** you have installed, by its name.

The choice is saved on the server with your account, so it applies on your other devices too. Choosing Dark, Light or Follow system replaces a custom theme. The sun and moon button in the user island is a quick Dark or Light switch and does the same.

If a saved theme is not available (a custom theme file you deleted, an id that matches nothing), the console shows the Dark or Light theme for your mode. It never falls back to any other palette.

## Adding a custom theme

Put a JSON file in the `themes` folder of the console home:

```
~/.clagentic/console/themes/<id>.json
```

The console home is `~/.clagentic/console/`, or the directory named by `CLAGENTIC_CONSOLE_HOME`. Create the `themes` folder if it does not exist. The file name without `.json` is the theme id: 1 to 64 characters, letters, digits, `.`, `_` and `-`, starting with a letter or digit. Reload the console, then open Appearance: the theme is listed by its `name`. Pick it to apply it.

The list is read each time the console loads. There is no restart.

### File format

```json
{
  "name": "Harbor",
  "variant": "dark",
  "base00": "0B1620", "base01": "12202D", "base02": "1F3345", "base03": "4A6378",
  "base04": "7F97AB", "base05": "C5D3DE", "base06": "E4EDF4", "base07": "F5FAFD",
  "base08": "F2677C", "base09": "3DC9E0", "base0A": "E6B85C", "base0B": "5CCFA0",
  "base0C": "6FB7E9", "base0D": "5B8DEF", "base0E": "B58CF2", "base0F": "C98A6B",
  "accent2": "5B8DEF"
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | The label shown in Appearance. Up to 60 characters. |
| `base00` to `base0F` | yes | A base16 palette: six hex digits each, no leading `#`. |
| `variant` | no | `dark` or `light`. When absent it is derived from the brightness of `base00`. It decides whether the console draws light or dark chrome around the palette. |
| `accent2` | no | A second accent, six hex digits. Defaults to `base0D`. |
| `tokens` | no | Exact colours for the surface and state tokens listed below. Any token you leave out is derived from the sixteen colours. |

The base16 roles the console uses: `base00` page background, `base01` raised surfaces, `base02` borders, `base03` timestamps, labels and comments, `base04` secondary text, `base05` body text, `base06` headings, `base07` brightest text, `base08` errors and variables, `base09` the main accent and numbers, `base0A` types (and warnings, unless you state a `warning` token), `base0B` success and strings, `base0C` regular expressions, `base0D` functions, `base0E` keywords, `base0F` meta. The same palette drives the terminal and diagram colours.

### Derivation: one file, every variable

A file with only the sixteen colours is fully styled: the console derives every CSS variable from them, in one place (`lib/public/theme-core.js`), for the page, the terminal, diagrams and code highlighting alike. Nothing else in the console holds a colour for a theme. The page is also painted from your files before any script runs, so Dark and Light show no flash.

`tokens` is for exact control. Each key is a token name, each value six hex digits. Anything you state is used as written, and the colours that depend on it (for example the sidebar hover row) follow it. Unknown keys are ignored; a value that is not six hex digits skips the file.

| Token | Role | Derived from the sixteen colours when you leave it out |
|---|---|---|
| `sidebar-bg` | Sidebar | the page colour, darkened (by 30% in Dark, 3% in Light) |
| `sidebar-active` | Selected session row | `base01` mixed toward `base02` |
| `user-bubble` | Your own messages | `base01` mixed toward `base02` |
| `input-bg` | Composer input | `base01` mixed toward `base02` (Light: the page colour, darkened) |
| `code-bg` | Code blocks and the terminal | the page colour, darkened |
| `border-subtle` | Hairlines | `base00` mixed toward `base02` |
| `border-strong` | Input, button and control outlines | `base04` mixed with `base00` |
| `warning` | Caution | `base0A` |
| `on-accent` | Text on an accent fill | `base00` or `base06`, whichever reads better on `base09` |
| `on-av` | Initials on an avatar | `base00` or `base06`, whichever reads better on `av0` |
| `av0` to `av3` | Avatar tints | `base09`, `base0E`, `base0B`, `base0A`, lightened (Dark) or darkened (Light) |

Dark and Light themselves are written this way: their files state the approved values in `tokens`. If you state tokens, keep text on its surface at 4.5:1 and control outlines at 3:1 (WCAG AA); the console does not adjust a colour you state.

### Files that are skipped

A file is left out of the list, and the rest still load, when:

- it is not valid JSON, cannot be read, is not a regular file, or is larger than 16 KiB;
- `name` is missing, empty or too long, or any of `base00` to `base0F` is missing or not six hex digits, or `variant`, `accent2` or a `tokens` value is present and invalid;
- its id is not a legal id, or is `clagentic-dark` or `clagentic-light` (the ids of the two built-in themes cannot be replaced).

## Upgrading from earlier versions

Earlier versions shipped twenty more themes and a Brand setting (Clagentic or Classic). They are gone. The first time a browser loads the console after the update, its stored theme moves to the Dark or Light theme of the same variant, and the server drops the stored brand the first time it starts:

| Stored | Becomes |
|---|---|
| a retired dark theme (`dracula`, `monokai`, `nord`, `one-dark`, `tokyo-night`, `rose-pine`, `everforest`, `catppuccin-mocha`, `gruvbox-dark`, `solarized-dark`), `clay`, `claude`, or the Classic brand in dark | Dark |
| a retired light theme (`ayu-light`, `github-light`, `solarized-light`, `everforest-light`, `one-light`, `rose-pine-dawn`, `tokyo-night-light`, `nord-light`, `catppuccin-latte`, `gruvbox-light`), `clay-light`, `claude-light`, or the Classic brand in light | Light |

If you had a custom file with one of those ids in your themes folder, the stored choice still moves to Dark or Light once; pick the custom theme again in Appearance to keep it.
