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

Version 1 established the core tool:

- Mermaid editor with live preview
- ELK toggle
- inline preview label editing that writes back to Mermaid code
- high-quality SVG, PNG, and PDF export
- faithful Excalidraw handoff that preserves the rendered look

Version 2 pushes further:

- interactive preview hover highlighting to make flows feel more alive
- editable ELK-oriented Excalidraw export as a beta path

## Export modes

### SVG

Exports the rendered Mermaid diagram as a single-page vector SVG.

### PNG

Exports a higher-resolution raster image based on the rendered SVG, not just the scaled browser preview.

### PDF

Exports a single-page PDF using an SVG-to-PDF path for better quality than a basic screenshot export.

### Excalidraw handoff

Preserves the exact Mermaid render by embedding the rendered SVG into an Excalidraw scene.

This is the best choice when visual fidelity matters most.

### Excalidraw editable ELK

Exports native Excalidraw elements using the Mermaid plus ELK-positioned graph as the source.

This is the current experimental path toward editable diagrams that still respect the cleaner ELK layout.

## Current limitation

Exact ELK fidelity and full Excalidraw-native editability are still not perfectly the same thing.

Right now, the project supports two different strengths:

- exact look preservation via Excalidraw handoff
- editable Excalidraw structure via Excalidraw editable ELK

The long-term goal is to get these closer together by carrying more layout and graph metadata across the export boundary.

## Longer-term direction

The broader approach this repo is exploring:

1. Keep Mermaid as the source of truth
2. Use ELK as the layout engine
3. Export to high-quality visual formats cleanly
4. Build a stronger Mermaid-to-Excalidraw translation layer
5. Eventually support re-layout or ELK-aware editing workflows inside Excalidraw-style environments

## Stack

- React
- Vite
- Mermaid
- `@mermaid-js/layout-elk`
- jsPDF
- svg2pdf.js
- Excalidraw packages

## Repo milestones

- `v1.0.0`: first stable baseline pushed as the initial save point
- `main`: active iteration with Version 2 work
