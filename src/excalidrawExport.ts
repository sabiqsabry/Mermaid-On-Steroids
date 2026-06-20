// Converts a live, ELK-rendered Mermaid SVG (the exact diagram shown in the
// preview) into native, fully-editable Excalidraw element skeletons.
//
// Why read the rendered SVG instead of re-parsing Mermaid?
// `@excalidraw/mermaid-to-excalidraw` re-parses Mermaid through internal
// `diagram.parser.yy` APIs that drift across Mermaid major versions and do not
// register the ELK layout loader, so the ELK geometry is lost. By walking the
// SVG we already rendered, the export keeps the exact ELK positions and routing
// and stays independent of Mermaid internals.

// Loose skeleton type so this module never needs to statically import the heavy
// `@excalidraw/excalidraw` types (which would force it into the main bundle).
export type ExcalidrawSkeleton = Record<string, unknown>;

// Mermaid 11 prefixes DOM ids with the render id, e.g.
//   nodes:  "mermaid-<uuid>-flowchart-ZT-9"
//   edges:  "mermaid-<uuid>-L_CA_REST_0_0"  (underscore-separated)
// so these patterns are matched anywhere in the id, not anchored at the start.
const NODE_ID_RE = /flowchart-(.+)-\d+$/;
const EDGE_ID_RE = /L_([A-Za-z0-9.:]+)_([A-Za-z0-9.:]+)_\d+_\d+$/;

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
    const points = (shape.getAttribute("points") ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    // A rhombus/decision node has four points.
    return { type: points.length === 4 ? "diamond" : "rectangle", rounded: false };
  }
  if (tag === "rect") {
    const rx = Number((shape as SVGRectElement).getAttribute("rx")) || 0;
    return { type: "rectangle", rounded: rx > 0 };
  }
  return { type: "rectangle", rounded: true };
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
    const idAttr = node.getAttribute("id") ?? "";
    const match = idAttr.match(NODE_ID_RE);
    if (!match?.[1]) return;
    const id = match[1];

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

  svg.querySelectorAll<SVGPathElement>("path.flowchart-link").forEach((path) => {
    const idAttr = path.getAttribute("id") ?? "";
    const match = idAttr.match(EDGE_ID_RE);

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
    const start = match?.[1];
    const end = match?.[2];

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

    const mid = pointOnPath(path, total / 2);
    edgeArrows.push({
      skeleton,
      midpoint: mid ?? new DOMPoint(origin.x, origin.y),
    });
  });

  // 4) Attach edge labels by matching each label to the nearest arrow midpoint.
  const labels: Array<{ text: string; cx: number; cy: number }> = [];
  const seenLabels = new Set<string>();
  svg.querySelectorAll<SVGGElement>("g.edgeLabel").forEach((labelEl) => {
    const text = cleanLabel(labelEl.textContent);
    if (!text) return;
    const rect = rectOf(labelEl);
    if (!rect || (!rect.width && !rect.height)) return;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    // Mermaid renders each edge label twice (background + foreground); collapse
    // duplicates by text and rounded position so one arrow gets one label.
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
      edgeArrows[bestIndex]!.skeleton.label = { text: label.text, fontSize: 14 };
    }
  });

  edgeArrows.forEach((arrow) => skeletons.push(arrow.skeleton));

  return skeletons;
}
