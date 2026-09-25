# DESIGN.md — OpenCode Session Hub panel

Replacement world (2026-09-23, code-led, roll `9ea12a84` superseded by user-pinned direction). Applies to `src/dashboardView.ts` (sidebar webview) and `src/previewPanel.ts` (preview webview).

## Tokens (all inherited — no fixed palette; light/dark follow the editor)
- Ground/text: `foreground`, `panel-border`, `input-background/foreground/border`, `descriptionForeground` (idle star only).
- Accent (one): `textLink-foreground` — session titles (resume affordance), Browse-all link, Retry link-button.
- Status (dot + word, never color alone): `charts-green` synced/ok, `charts-blue` syncing, `errorForeground` error, `charts-orange` conflict, `descriptionForeground` unconfigured. `charts-yellow` = starred.
- Type: `font-family` for UI, `editor-font-family` for IDs/inputs. Section headings 11px/600. Body 12–13px.

## Components
- Status card: 1px `panel-border`, 6px radius, `aria-live="polite"`. Line 1: 8px dot + state word. Below: branch · ahead/behind, last sync, outcome lines (green ok / red error), error + Retry (retries push when ahead > 0, else pull).
- Primary row: Push Now (default button) / Pull Now / Refresh — disabled while syncing or unconfigured. Conflict row hidden unless conflict.
- Session row: star toggle (inline SVG, single 2px stroke, `aria-pressed`) → `saveFavorite`/`removeFavorite` with the row's own id; title is the resume button; meta one line with ellipsis + full tooltip; Preview (small secondary) + Delete (plain red text).
- Favorites: same card, label + mono session id + Preview/Resume/Remove. Manual-ID form lives collapsed in `<details>`.
- Setup: Connection / Schedule / Security / Advanced as `<details>`; Connection auto-opens while unconfigured, Security while the gate blocks sync. Security uses `fieldset` + per-box hints. Inputs are never overwritten while focused.
- Preview: 1px bordered 6px message cards; role shown by word + 8px dot (blue user, green assistant).

## Copy voice
Plain English verbs. Errors name the problem and the recovery ("Save a connection below to start syncing"). No jargon (debounce → "Wait before auto-push"), no scolding, one language.

## Non-goals
No motion, no custom scrollbars/selection (native editor chrome wins), no display type, no imagery — Operate surface in a 300px sidebar.

## Session manager (`src/sessionManagerPanel.ts`)
Full-page checklist sharing the panel's row grammar (three-line info, 1px cards): live text filter, select-all covering only visible rows, running selection count, one modal confirmation naming session and message totals, progress notification with per-session failure tolerance. Same red danger button as the panel's Delete row would shout; here it is the primary action, so it carries the fill.

## Activity icon (`media/activity-icon.svg`)
Lucide `history` verbatim (ISC): clock + rewind arrow = session history you can return to. Rationale: image icons render as foreground-colored masks, so only the silhouette survives — a professionally-hinted 24-grid library glyph beats any hand-drawn ring. Verified against alternatives in headless renders at 16/24/48px.

## Extension icon (`media/extension-icon.svg` → `.png`, 256px)
Same Lucide glyph at tile scale on a dark rounded tile. The SVG is the artwork of record; the PNG is painted from it by SDF rendering (headless screenshots cannot preserve alpha, which left white corners) with verified transparent corners.
