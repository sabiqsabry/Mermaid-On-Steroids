# Mermaid on Steroids

Mermaid on Steroids is a local-first Mermaid workspace focused on one practical goal:

- take Mermaid code
- render it with ELK for cleaner layout
- export it at high quality
- explore a path toward editable Excalidraw output without losing structure

## Why this exists

Standard Mermaid rendering is often fine for small diagrams, but larger system flows benefit a lot from ELK-based layout. At the same time, Excalidraw is useful when you want to keep editing visually.

The tension is that:

- Mermaid plus ELK gives a cleaner graph layout
- Excalidraw gives a more flexible editing surface
- the two do not naturally preserve the exact same result

This project is an attempt to bridge that gap.

## What the app does today

The core tool:

- Mermaid editor with live preview
- ELK layout toggle
- a one-click sample diagram to start from
- inline preview label editing (nodes and subgraphs) that writes back to the Mermaid code
- interactive preview hover highlighting that focuses a node or edge and its connections
- high-quality SVG, PNG, and PDF export
- native, editable Excalidraw export from the ELK-positioned graph

## Export modes

### SVG

Exports the rendered Mermaid diagram as a single-page vector SVG.

### PNG

Exports a higher-resolution raster image based on the rendered SVG, not just the scaled browser preview.

### PDF

Exports a single-page PDF by rasterizing the rendered SVG at high resolution and embedding it, which avoids the font and clipping issues of a direct SVG-to-PDF conversion.

### Excalidraw editable ELK

Exports native Excalidraw elements — rectangles, diamonds, ellipses, bound arrows, and text — directly from the ELK-positioned graph shown in the preview.

It reads geometry from the exact SVG that was rendered, so the Excalidraw scene keeps the ELK positions and edge routing while remaining fully editable. Open the downloaded `.excalidraw` file at [excalidraw.com](https://excalidraw.com) to keep editing.

Because the export reads the rendered SVG rather than re-parsing Mermaid internals, it stays independent of Mermaid version changes and does not lose the ELK layout.

## Current limitation

Excalidraw does not model every Mermaid shape exactly. Stadium and rounded nodes export as rounded rectangles, and edges that point at a subgraph container bind only at the node end. Node fills, strokes, labels, and ELK routing are preserved.

## Longer-term direction

The broader approach this repo is exploring:

1. Keep Mermaid as the source of truth
2. Use ELK as the layout engine
3. Export to high-quality visual formats cleanly
4. Build a stronger Mermaid-to-Excalidraw translation layer
5. Eventually support re-layout or ELK-aware editing workflows inside Excalidraw-style environments

## Development

```bash
npm install
npm run dev      # start the dev server (it redirects / to the app)
npm test         # run the pure-logic unit tests (node:test, no extra deps)
npm run build    # type-check and build for production
npm run preview  # serve the production build
```

The app is served under `/tools/mermaid-on-steroids/`; both `npm run dev` and `npm run preview` redirect the root path there.

## Stack

- React
- Vite
- Mermaid
- `@mermaid-js/layout-elk`
- jsPDF
- `@excalidraw/excalidraw`

## Repo milestones

- `v1.0.0`: first stable baseline pushed as the initial save point
- `main`: active iteration with Version 2 work
