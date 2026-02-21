# VoiceCC Dashboard Design Principles

This document outlines the design decisions, visual language, and structural CSS systems used in the VoiceCC dashboard.

## 1. Qualitative & Aesthetic Direction

### Functional Minimalism
VoiceCC is designed as a focused utility dashboard. It favors clean, utilitarian aesthetics mirroring IDE environments (such as VS Code or Claude Web) over heavily embellished designs. Interface elements should remain flat, unobtrusive, and highly legible.

### High-Contrast Readability
Whether viewing in Light or Dark mode, the contrast between structural blocks (like the sidebar vs main content) and text is prioritized. Backgrounds rely on extremely subtle shades of gray to denote depth and hierarchy, ensuring that primary content stands out sharply.

### Monochromatic with Occasional Green
The fundamental color palette is strictly monochromatic (blacks, whites, and neutral grays). Color is applied intentionally to immediately draw user focus to states—like the "2ea043" GitHub-style green indicating an active server or running voice process. Use color exclusively for semantic status or active states, never for decoration.

### Sharp Edges
To maintain a technical, tool-like feel, `borderRadius` across components, modal dialogs, and panels is strictly set to `0`. Sharp corners help reinforce the structured, block-level environment.

## 2. Quantitative & Structural Guidelines

### Typography
- **Global Typography**: Fonts default to system UI stacks (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto...`) to integrate seamlessly with the user's OS.
- **Brand Title**: The main VoiceCC logo mark uses `"IBM Plex Serif", serif` for a sophisticated, editorial contrast to the sans-serif UI.
- **Hierarchy sizes**:
  - Logo: `28px`
  - Modal/Page Titles: `15px` to `16px` with `600` weight
  - Panel Headers/Labels: `13px` with `500/600` weight
  - Form Fields/Descriptions: `12px` to `13px`

### Layout & Spacing Defaults
Always rely on multiples of 4 or 8 to ensure visual rhythm.

- **Main Navigation/Sidebar Width**: `260px`, firmly anchored on the left side of the viewport.
- **Section Pacing (Page Headers)**: The standard empty space above dynamic content tabs (like "Integrations & MCP") should have `padding: 48px 64px 24px`.
- **Content Blocks (Settings Panels)**: Use `padding: 24px` inside panels and separate blocks by `margin-bottom: 24px`.

### Theming & CSS Variables

The app supports dynamic theme toggling class names (`.dark` and `.light`) attached to the `body` tag. Components should explicitly utilize the semantic variables rather than raw HEX codes to ensure safe inversions.

#### Color Variables
**Dark Theme (Default)**
- `--bg-main`: `#1e1e1e` (App background, inputs)
- `--bg-sidebar`: `#181818` (Left app pane)
- `--bg-surface`: `#252526` (Floating elements and active Settings tabs)
- `--border-color`: `#333` (Dividers)
- `--text-primary`: `#fff`
- `--text-secondary`: `#999`
- `--btn-primary-bg`: `#fff`
- `--btn-primary-text`: `#000`

**Light Theme**
- `--bg-main`: `#ffffff`
- `--bg-sidebar`: `#fbfbfc`
- `--bg-surface`: `#ffffff`
- `--border-color`: `#e5e5e5`
- `--text-primary`: `#111827`
- `--text-secondary`: `#6b7280`
- `--btn-primary-bg`: `#111827`
- `--btn-primary-text`: `#ffffff`

### State Management & Interactions
- Button **hover states** gently inverse or raise background tones. Example: An active tab button applies `var(--btn-primary-bg)`.
- **Transitions** are kept extremely swift (e.g. `transition: all 0.1s ease` or `0.15s`) to feel responsive and instantaneous. 
- Form elements, like inputs, should emphasize interaction securely, utilizing `var(--btn-primary-bg)` to outline the `border-color` upon focus.
