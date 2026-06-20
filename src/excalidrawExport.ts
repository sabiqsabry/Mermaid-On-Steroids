// Converts a live, ELK-rendered Mermaid SVG (the exact diagram shown in the
// preview) into native, fully-editable Excalidraw element skeletons.
//
// Why read the rendered SVG instead of re-parsing Mermaid?
// `@excalidraw/mermaid-to-excalidraw` re-parses Mermaid through internal
// `diagram.parser.yy` APIs that drift across Mermaid major versions and do not
// register the ELK layout loader, so the ELK geometry is lost. By walking the
// SVG we already rendered, the export keeps the exact ELK positions and routing
// and stays independent of Mermaid internals.

import { parseNodeId, parseEdgeEndpoints } from "./mermaid-utils";

// Loose skeleton type so this module never needs to statically import the heavy
// `@excalidraw/excalidraw` types (which would force it into the main bundle).
export type ExcalidrawSkeleton = Record<string, unknown>;

type AbsRect = { x: number; y: number; width: number; height: number };

function toDOMMatrix(matrix: DOMMatrix | SVGMatrix | null): DOMMatrix | null {
  if (!matrix) return null;
  return new DOMMatrix([
    matrix.a,
    matrix.b,
    matrix.c,
    matrix.d,
    matrix.e,
    matrix.f,
  ]);
}

// Maps any coordinate from an element's local space into the root SVG's user
// (viewBox) coordinate system. CSS transforms on ancestors (preview zoom,
// fullscreen) cancel out because both screen CTMs include them.
function createSpaceMapper(svg: SVGSVGElement) {
  const svgScreenCTM = toDOMMatrix(svg.getScreenCTM());
  if (!svgScreenCTM) {
    throw new Error(
      "Render the diagram before exporting — the preview SVG has no layout geometry yet."
    );
  }
  const svgInverse = svgScreenCTM.inverse();

  function matrixFor(el: SVGGraphicsElement): DOMMatrix | null {
    // Some Mermaid labels are HTML elements inside <foreignObject>; those have
    // no CTM and cannot be mapped into SVG user space.
    if (typeof el.getScreenCTM !== "function") return null;
    const ctm = toDOMMatrix(el.getScreenCTM());
    if (!ctm) return null;
    return svgInverse.multiply(ctm);
  }

  function rectOf(el: SVGGraphicsElement): AbsRect | null {
    const matrix = matrixFor(el);
    if (!matrix) return null;
    const box = el.getBBox();
    if (!box.width && !box.height) return null;

    const corners = [
      new DOMPoint(box.x, box.y),
      new DOMPoint(box.x + box.width, box.y),
      new DOMPoint(box.x, box.y + box.height),
      new DOMPoint(box.x + box.width, box.y + box.height),
    ].map((point) => point.matrixTransform(matrix));

    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      x: minX,
      y: minY,
      width: Math.max(...xs) - minX,
      height: Math.max(...ys) - minY,
    };
  }

  function pointOnPath(path: SVGPathElement, length: number) {
    const matrix = matrixFor(path);
    if (!matrix) return null;
    const local = path.getPointAtLength(length);
    return new DOMPoint(local.x, local.y).matrixTransform(matrix);
  }

  return { rectOf, pointOnPath };
}

// Excalidraw stores colors as hex; getComputedStyle hands back rgb()/rgba().
function normalizeColor(color: string | null | undefined, fallback: string) {
  if (!color) return fallback;
  const value = color.trim().toLowerCase();
  if (value === "none" || value === "transparent") return "transparent";
  if (value.startsWith("#")) return value;

  const match = value.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/
  );
  if (!match) return fallback;

  const [, r, g, b, a] = match;
  if (a !== undefined && Number(a) === 0) return "transparent";

  const hex = [r, g, b]
    .map((channel) => {
      const clamped = Math.max(0, Math.min(255, Math.round(Number(channel))));
      return clamped.toString(16).padStart(2, "0");
    })
    .join("");
  return `#${hex}`;
}

function cleanLabel(raw: string | null | undefined) {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

function nodeShapeOf(node: Element): SVGGraphicsElement | null {
  return node.querySelector<SVGGraphicsElement>(
    "rect, polygon, ellipse, circle, path"
  );
}

// Excalidraw only has rectangle / diamond / ellipse, so every Mermaid shape maps
// to the closest of those. Stadiums, cylinders, subroutines and hexagons all
// become (rounded) rectangles; circles become ellipses; decision rhombi become
// diamonds — but slanted 4-point shapes (parallelograms) stay rectangles.
function shapeKind(shape: SVGGraphicsElement | null): {
  type: "rectangle" | "ellipse" | "diamond";
  rounded: boolean;
} {
  if (!shape) return { type: "rectangle", rounded: true };
  const tag = shape.tagName.toLowerCase();

  if (tag === "circle" || tag === "ellipse") {
    return { type: "ellipse", rounded: false };
  }

  if (tag === "polygon") {
    return { type: classifyPolygon(shape), rounded: false };
  }

  if (tag === "rect") {
    const rx = Number((shape as SVGRectElement).getAttribute("rx")) || 0;
    return { type: "rectangle", rounded: rx > 0 };
  }

  // Stadium and cylinder nodes render as <path>; treat them as rounded boxes.
  return { type: "rectangle", rounded: true };
}

function classifyPolygon(shape: SVGGraphicsElement): "diamond" | "rectangle" {
  const points = (shape.getAttribute("points") ?? "")
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number))
    .filter((pair) => pair.length === 2 && pair.every(Number.isFinite));

  if (points.length !== 4) return "rectangle";

  const ys = points.map((p) => p[1]!);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const topVertices = ys.filter((y) => Math.abs(y - minY) < 1).length;
  const bottomVertices = ys.filter((y) => Math.abs(y - maxY) < 1).length;

  // A rhombus has a single apex at the top and bottom; a parallelogram has two
  // vertices sharing the top (and bottom) edge.
  return topVertices === 1 && bottomVertices === 1 ? "diamond" : "rectangle";
}

export function buildExcalidrawSkeletons(svg: SVGSVGElement): ExcalidrawSkeleton[] {
  const { rectOf, pointOnPath } = createSpaceMapper(svg);
  const skeletons: ExcalidrawSkeleton[] = [];
  const nodeIds = new Set<string>();

  // 1) Subgraph containers first so they sit behind the nodes.
  svg.querySelectorAll<SVGGElement>("g.cluster").forEach((cluster) => {
    const shape = cluster.querySelector<SVGGraphicsElement>("rect");
    const rect = rectOf(shape ?? cluster);
    if (!rect) return;

    const fill = normalizeColor(
      shape ? getComputedStyle(shape).fill : undefined,
      "transparent"
    );
    const stroke = normalizeColor(
      shape ? getComputedStyle(shape).stroke : undefined,
      "#1e1e1e"
    );
    const label = cleanLabel(
      cluster.querySelector(".cluster-label")?.textContent
    );

    skeletons.push({
      type: "rectangle",
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      strokeColor: stroke,
      backgroundColor: fill,
      fillStyle: "solid",
      strokeWidth: 1,
      roundness: { type: 3 },
      ...(label
        ? { label: { text: label, verticalAlign: "top", fontSize: 16 } }
        : {}),
    });
  });

  // 2) Nodes as native rectangles / diamonds / ellipses, keyed by Mermaid id so
  //    edges can bind to them.
  svg.querySelectorAll<SVGGElement>("g.node").forEach((node) => {
    const id = parseNodeId(node.getAttribute("id"));
    if (!id) return;

    const shape = nodeShapeOf(node);
    const rect = rectOf(shape ?? node);
    if (!rect) return;

    const computed = shape ? getComputedStyle(shape) : null;
    const { type, rounded } = shapeKind(shape);
    const label = cleanLabel(
      node.querySelector(".nodeLabel, .label")?.textContent ??
        node.textContent
    );

    nodeIds.add(id);
    skeletons.push({
      type,
      id,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      strokeColor: normalizeColor(computed?.stroke, "#1e1e1e"),
      backgroundColor: normalizeColor(computed?.fill, "#ffffff"),
      fillStyle: "solid",
      strokeWidth: Math.max(1, Math.round(Number(computed?.strokeWidth) || 1)),
      ...(type === "rectangle" && rounded ? { roundness: { type: 3 } } : {}),
      ...(type !== "rectangle" ? { roundness: null } : {}),
      ...(label ? { label: { text: label, fontSize: 16 } } : {}),
    });
  });

  // 3) Edges as arrows that follow the ELK routing and bind to their endpoints.
  type EdgeArrow = { skeleton: ExcalidrawSkeleton; midpoint: DOMPoint };
  const edgeArrows: EdgeArrow[] = [];

  const pathEls = [
    ...svg.querySelectorAll<SVGPathElement>("path.flowchart-link"),
  ];
  // Mermaid renders one g.edgeLabel per edge, in the same order as the edge
  // paths, so labels can be matched to arrows by index. If the counts ever
  // diverge we fall back to nearest-midpoint matching below.
  const labelEls = [...svg.querySelectorAll<SVGGElement>("g.edgeLabel")];
  const matchByIndex = labelEls.length === pathEls.length;

  pathEls.forEach((path, pathIndex) => {
    const endpoints = parseEdgeEndpoints(path.getAttribute("id"));

    let total = 0;
    try {
      total = path.getTotalLength();
    } catch {
      return;
    }
    if (!total) return;

    const sampleCount = Math.max(2, Math.min(64, Math.ceil(total / 12)));
    const points: Array<{ x: number; y: number }> = [];
    for (let step = 0; step <= sampleCount; step += 1) {
      const mapped = pointOnPath(path, (total * step) / sampleCount);
      if (mapped) points.push({ x: mapped.x, y: mapped.y });
    }
    if (points.length < 2) return;

    const origin = points[0]!;
    const relativePoints = points.map((point) => [
      point.x - origin.x,
      point.y - origin.y,
    ]);

    const stroke = normalizeColor(getComputedStyle(path).stroke, "#1e1e1e");
    const start = endpoints?.start;
    const end = endpoints?.end;

    const skeleton: ExcalidrawSkeleton = {
      type: "arrow",
      x: origin.x,
      y: origin.y,
      points: relativePoints,
      strokeColor: stroke,
      strokeWidth: 1,
      roundness: null,
      endArrowhead: "arrow",
      ...(start && nodeIds.has(start) ? { start: { id: start } } : {}),
      ...(end && nodeIds.has(end) ? { end: { id: end } } : {}),
    };

    if (matchByIndex) {
      const text = cleanLabel(labelEls[pathIndex]?.textContent);
      if (text) skeleton.label = { text, fontSize: 14 };
    }

    const mid = pointOnPath(path, total / 2);
    edgeArrows.push({
      skeleton,
      midpoint: mid ?? new DOMPoint(origin.x, origin.y),
    });
  });

  // 4) Fallback: if labels and edges did not line up by index, attach each
  //    non-empty label to the nearest unused arrow midpoint.
  if (!matchByIndex) {
    const labels: Array<{ text: string; cx: number; cy: number }> = [];
    const seenLabels = new Set<string>();
    labelEls.forEach((labelEl) => {
      const text = cleanLabel(labelEl.textContent);
      if (!text) return;
      const rect = rectOf(labelEl);
      if (!rect || (!rect.width && !rect.height)) return;
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const key = `${text}@${Math.round(cx)},${Math.round(cy)}`;
      if (seenLabels.has(key)) return;
      seenLabels.add(key);
      labels.push({ text, cx, cy });
    });

    const usedArrows = new Set<number>();
    labels.forEach((label) => {
      let bestIndex = -1;
      let bestDistance = Infinity;
      edgeArrows.forEach((arrow, index) => {
        if (usedArrows.has(index)) return;
        const dx = arrow.midpoint.x - label.cx;
        const dy = arrow.midpoint.y - label.cy;
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      if (bestIndex >= 0) {
        usedArrows.add(bestIndex);
        edgeArrows[bestIndex]!.skeleton.label = {
          text: label.text,
          fontSize: 14,
        };
      }
    });
  }

  edgeArrows.forEach((arrow) => skeletons.push(arrow.skeleton));

  return skeletons;
}
