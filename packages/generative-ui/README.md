# PiBot generative-ui vocabulary

The renderer uses the 35 components from `@assistant-ui/generative-ui` 0.0.12 without adopting assistant-ui's chat runtime. PiBot's A2UI adapter retains persisted state, bounded calculations and server-validated actions.

- `src/catalog.generated.ts`: browser-free JSON schemas generated from the pinned package; consumed by the Zod 3 A2UI catalog.
- `src/temporal.ts`: MIT upstream helpers for local display, original offsets, precision and round-trip date/time values.
- `src/widgets.tsx`: renderer, controlled input adapters, sanitized Markdown, artifact image previews, local diagrams and fixed-source maps.
- `src/upstream.css`: MIT assistant-ui generative-ui-style registry snapshot from 2026-11-24, scoped to `.pi-a2ui`.
- `src/leaflet.css`: Leaflet 1.9.4 CSS with unused default PNG icons removed; custom markers need no image assets.
- `src/style.css`: PiBot theme mapping and responsive component styles. The surface stays transparent; individual cards supply their own grouping.

Run `npm run generate -w @pi-bot/generative-ui` after reviewing an upstream upgrade. `node packages/generative-ui/scripts/generate-catalog.mjs --check` verifies the snapshot. See `docs/generative-ui.md` for the host and model-facing contracts. Preserve `UPSTREAM-LICENSE` and the third-party notices when distributing the renderer.
