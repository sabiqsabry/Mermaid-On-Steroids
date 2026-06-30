import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import elkLayouts from "@mermaid-js/layout-elk";
import { jsPDF } from "jspdf";
import { buildExcalidrawSkeletons } from "./excalidrawExport";
import {
  NODE_ID_RE,
  EDGE_ID_RE,
  withLayout,
  updateMermaidLabelById,
  updateMermaidLabelByText,
  parseEdgeEndpoints,
} from "./mermaid-utils";
import {
  IconReset,
  IconSample,
  IconCopy,
  IconLayout,
  IconGlow,
  IconSvg,
  IconPng,
  IconPdf,
  IconShapes,
  IconFullscreen,
  IconFullscreenExit,
  IconMoon,
  IconSun,
} from "./icons";

const SAMPLE_CODE = `flowchart TD
  %% ---------- Enterprise Client ----------
  subgraph CLIENT["ENTERPRISE CLIENT: keeps its own apps, sends only data and requests"]
    CA["Client apps, agents, frontend"]
    EA["Enterprise admins"]
    CD[("Client data / datasets")]
  end

  %% ---------- SaintSal Platform ----------
  subgraph PLATFORM["SAINTSAL PLATFORM: HACP hosted on our infra, models, keys, KMS, tenant isolation"]

    subgraph ACCESS["Access layer: how their apps reach hosted HACP"]
      REST["REST API endpoints"]
      MCP["MCP server (for their AI agents)"]
      SDK["SDKs (Next.js, React, ...)"]
    end

    subgraph CONSOLE["Enterprise console / dashboard: config, separate from runtime"]
      CON["Toggle layers and features, set budgets and domain floors, view governance and usage"]
    end

    subgraph INGEST["Onboarding and ingestion: per tenant"]
      ING["Ingest, embed and index client data"]
      RAG[("Per-tenant RAG / retrieval store")]
    end

    subgraph CONTROL["HACP control layer: isolated per tenant"]
      ZT["Tenant boundary + zero-trust gate"]
      L1["LAYER 1: Intent and complexity classifier"]
      L2["LAYER 2: Safety guardrail, deterministic identical response"]
      L2B["LAYER 2b: RAG guardrail vs tenant data and policy"]
      L3["LAYER 3: Crisis classification, fixed resources"]
      L4["LAYER 4: Routing cache, Bayesian similarity"]
      L5["LAYER 5: 3-tier cascade router (mini, base, flagship)"]
      L5B["LAYER 5b: RAG answer grounding, retrieve tenant context and inject into prompt"]
      L6["LAYER 6: Token budget governor, per-tenant and domain floors"]
      L7["LAYER 7: Token cost forecasting"]
      L8["LAYER 8: Memory and context threading"]
      L9["LAYER 9: Governance trace and telemetry"]
    end

    PROV["Managed providers via Portkey: our keys, 5 providers x 3 tiers"]
    OUT["Grounded, safe answer + full governance trace"]
    OOS["Out of scope: refuse or hand back"]
  end

  %% ---------- Request path ----------
  CA --> REST & MCP & SDK
  REST & MCP & SDK --> ZT
  ZT --> L1 --> L2 --> L2B --> L3 --> L4 --> L5 --> L5B --> L6 --> L7 --> PROV --> OUT

  %% ---------- Dual-use per-tenant RAG (the refresh) ----------
  CD --> ING --> RAG
  RAG -->|"guard-railing"| L2B
  RAG -->|"answer grounding"| L5B

  %% ---------- Memory and governance ----------
  L8 -.->|"context"| L5B
  L1 & L2 & L3 & L5 & L7 & PROV -.->|"trace"| L9

  %% ---------- Config and admins ----------
  EA --> CON
  CON -.->|"config applies to"| CONTROL

  %% ---------- Out of scope ----------
  L2 -->|"unsafe"| OOS
  L2B -->|"out of scope"| OOS

  %% ---------- styling ----------
  classDef safety fill:#ffd9d9,stroke:#c0392b,color:#000;
  classDef rag fill:#ffe9b3,stroke:#d68910,color:#000;
  classDef infra fill:#d6e4ff,stroke:#2e6bd6,color:#000;
  classDef store fill:#e8d9ff,stroke:#7d3cc9,color:#000;
  classDef io fill:#ededed,stroke:#555,color:#000;

  class L2,L3 safety;
  class L2B,L5B,RAG rag;
  class ZT,L1,L4,L5,L6,L7,L8,L9 infra;
  class CD store;
  class PROV,OUT,OOS io;`;

type ExportFormat =
  | "svg"
  | "png"
  | "pdf"
  | "excalidraw-editable-elk";

type ExcalidrawModule = typeof import("@excalidraw/excalidraw");

type PreviewEditorState = {
  // Mermaid node id when editing a node, or null for a subgraph (whose DOM id is
  // not usable in Mermaid 11 — those are matched back to the source by text).
  id: string | null;
  matchText: string;
  value: string;
  x: number;
  y: number;
};
type HoverContext = {
  nodeIds: string[];
  edgeIds: string[];
};

let mermaidReady: Promise<void> | null = null;
let excalidrawModuleReady: Promise<ExcalidrawModule> | null = null;

// Loaded on demand so the heavy Excalidraw bundle never blocks first paint.
async function loadExcalidrawModule() {
  if (!excalidrawModuleReady) {
    excalidrawModuleReady = import("@excalidraw/excalidraw");
  }
  return excalidrawModuleReady;
}

const MERMAID_BASE_CONFIG = {
  startOnLoad: false,
  securityLevel: "loose" as const,
  theme: "base" as const,
  flowchart: {
    curve: "linear" as const,
  },
  themeVariables: {
    fontFamily: '"Atkinson Hyperlegible", "Inter", "Segoe UI", sans-serif',
  },
};

async function ensureMermaidReady() {
  if (!mermaidReady) {
    mermaidReady = (async () => {
      mermaid.registerLayoutLoaders(elkLayouts);
      mermaid.initialize(MERMAID_BASE_CONFIG);
    })();
  }

  await mermaidReady;
}

// Mermaid draws on-screen labels as HTML wrapped in <foreignObject>, which is
// great for the live preview but breaks exports in two ways:
//   - the SVG renders blank in non-browser viewers (Preview, Illustrator, ...)
//   - rasterizing it onto a <canvas> taints the canvas, so toBlob/toDataURL
//     throw "Tainted canvases may not be exported" — killing PNG and PDF.
// Re-rendering the same diagram with htmlLabels disabled yields native SVG
// <text> labels, so the exported SVG is portable and the PNG/PDF canvas stays
// clean. The global config is restored afterwards so the preview keeps its
// nicer HTML labels.
async function renderExportSvg(code: string) {
  await ensureMermaidReady();
  // Mermaid resolves labels as `config.htmlLabels ?? flowchart.htmlLabels`, and
  // several internal paths read only the top-level flag — so disable both.
  mermaid.initialize({
    ...MERMAID_BASE_CONFIG,
    htmlLabels: false,
    flowchart: { ...MERMAID_BASE_CONFIG.flowchart, htmlLabels: false },
  });
  try {
    const id = `mermaid-export-${crypto.randomUUID()}`;
    const { svg } = await mermaid.render(id, code);
    return svg;
  } finally {
    mermaid.initialize(MERMAID_BASE_CONFIG);
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noreferrer";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function svgToBlob(svgMarkup: string) {
  return new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
}

function getOptimalRasterScale(width: number, height: number) {
  const area = width * height;
  const longestSide = Math.max(width, height);

  if (area <= 400_000 && longestSide <= 1200) {
    return 6;
  }

  if (area <= 1_600_000 && longestSide <= 2400) {
    return 4;
  }

  return 3;
}

function getSvgBounds(svgElement: SVGSVGElement) {
  const viewBox = svgElement.viewBox.baseVal;
  if (viewBox && viewBox.width && viewBox.height) {
    return { width: viewBox.width, height: viewBox.height };
  }

  const width = Number(svgElement.getAttribute("width")) || 1200;
  const height = Number(svgElement.getAttribute("height")) || 800;
  return { width, height };
}

function getPreparedSvgMarkup(svgMarkup: string) {
  const temp = document.createElement("div");
  temp.innerHTML = svgMarkup;
  const svgElement = temp.querySelector("svg");
  if (!svgElement) {
    throw new Error("SVG element not found");
  }

  const { width, height } = getSvgBounds(svgElement);
  svgElement.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svgElement.setAttribute("width", `${width}`);
  svgElement.setAttribute("height", `${height}`);
  if (!svgElement.getAttribute("viewBox")) {
    svgElement.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }

  return {
    svgMarkup: svgElement.outerHTML,
    width,
    height,
  };
}

function extractMermaidNodeIdFromElement(element: Element | null) {
  let current: Element | null = element;

  while (current) {
    const id = current.getAttribute("id");
    const match = id?.match(NODE_ID_RE);
    if (match?.[1]) {
      return match[1];
    }
    current = current.parentElement;
  }

  return null;
}

function extractEdgeRelationship(element: Element | null) {
  let current: Element | null = element;

  while (current) {
    const id = current.getAttribute("id");
    const edgeMatch = id?.match(EDGE_ID_RE);
    if (id && edgeMatch?.[1] && edgeMatch?.[2]) {
      return {
        edgeId: id,
        startId: edgeMatch[1],
        endId: edgeMatch[2],
      };
    }

    current = current.parentElement;
  }

  return null;
}

function findConnectedEdgeIds(container: HTMLElement, nodeId: string) {
  const connectedEdges = new Set<string>();

  container
    .querySelectorAll<HTMLElement>("path.flowchart-link")
    .forEach((element) => {
      const id = element.getAttribute("id");
      const edgeMatch = id?.match(EDGE_ID_RE);
      if (!id || !edgeMatch) {
        return;
      }

      if (edgeMatch[1] === nodeId || edgeMatch[2] === nodeId) {
        connectedEdges.add(id);
      }
    });

  return [...connectedEdges];
}

function clearHoverClasses(container: HTMLElement) {
  container
    .querySelectorAll(".mos-highlight, .mos-dimmed")
    .forEach((element) => {
      element.classList.remove("mos-highlight", "mos-dimmed");
    });
}

function applyHoverContext(container: HTMLElement, context: HoverContext | null) {
  clearHoverClasses(container);

  const interactiveElements = container.querySelectorAll<HTMLElement>(
    ".node, .cluster, path.flowchart-link, g.edgeLabel"
  );

  if (!context) {
    return;
  }

  interactiveElements.forEach((element) => {
    element.classList.add("mos-dimmed");
  });

  // Node group ids are prefixed (mermaid-<uuid>-flowchart-<id>-<n>), so match by
  // "contains" rather than "starts with". Edge ids are already full matches.
  const highlightSelectors = [
    ...context.nodeIds.flatMap((id) => [
      `[id='${id}']`,
      `[id*='flowchart-${id}-']`,
    ]),
    ...context.edgeIds.map((id) => `[id='${id}']`),
  ];

  if (!highlightSelectors.length) {
    return;
  }

  container
    .querySelectorAll<HTMLElement>(highlightSelectors.join(", "))
    .forEach((element) => {
      element.classList.remove("mos-dimmed");
      element.classList.add("mos-highlight");
    });
}

function resolveHoverContext(container: HTMLElement, element: Element | null) {
  const edgeRelationship = extractEdgeRelationship(element);
  if (edgeRelationship) {
    return {
      nodeIds: [edgeRelationship.startId, edgeRelationship.endId],
      edgeIds: [edgeRelationship.edgeId],
    };
  }

  const nodeId = extractMermaidNodeIdFromElement(element);
  if (!nodeId) {
    return null;
  }

  // Light up the hovered node, its edges, and the neighbours on the far end of
  // those edges so the local flow reads as one connected group.
  const edgeIds = findConnectedEdgeIds(container, nodeId);
  const nodeIds = new Set<string>([nodeId]);
  edgeIds.forEach((edgeId) => {
    const endpoints = parseEdgeEndpoints(edgeId);
    if (endpoints) {
      nodeIds.add(endpoints.start);
      nodeIds.add(endpoints.end);
    }
  });

  return { nodeIds: [...nodeIds], edgeIds };
}

function findMermaidLabelText(element: Element | null) {
  if (!element) {
    return null;
  }

  const textContainer = element.closest("text, .nodeLabel, .cluster-label");
  const text = textContainer?.textContent?.trim() ?? element.textContent?.trim();
  return text || null;
}

async function renderSvgMarkupToCanvas(
  svgMarkup: string,
  width: number,
  height: number,
  scale = getOptimalRasterScale(width, height)
) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Canvas context is not available.");
  }

  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const svgBlob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
  const objectUrl = URL.createObjectURL(svgBlob);

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Failed to load SVG for high-resolution export."));
    };
    img.src = objectUrl;
  });

  ctx.drawImage(image, 0, 0, width, height);
  return canvas;
}

async function canvasToBlob(canvas: HTMLCanvasElement, type: string) {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, type);
  });

  if (!blob) {
    throw new Error(`Failed to create ${type} blob.`);
  }

  return blob;
}

// Mermaid's raw parser errors ("Syntax error in text...", "No diagram type
// detected...") are cryptic for someone who just typed prose. Translate the
// common ones into a plain-language hint.
function friendlyRenderError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause ?? "");
  if (
    /syntax error|parse error|no diagram type|expecting|lexical error|unrecognized|invalid/i.test(
      raw
    )
  ) {
    return "That doesn't look like valid Mermaid yet. Start with a diagram type — for example `flowchart TD` — then add your nodes and arrows. Use Load sample to see a working example.";
  }
  return raw || "Failed to render diagram.";
}

type Theme = "light" | "dark";

// Default to light; only switch when the user explicitly chooses (and remember
// that choice). The OS preference is intentionally ignored.
function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const saved = window.localStorage.getItem("mos-theme");
  return saved === "dark" ? "dark" : "light";
}

// Pan/zoom viewport limits. The lower bound is small so very large diagrams can
// shrink to fit; the upper bound keeps zoom-in sensible.
const MIN_SCALE = 0.05;
const MAX_SCALE = 4;

type PreviewView = { scale: number; tx: number; ty: number };

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

type DockButtonProps = {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
};

// Icon-only dock button with an accessible label and a hover/focus tooltip.
function DockButton({
  label,
  onClick,
  children,
  active = false,
  disabled = false,
}: DockButtonProps) {
  return (
    <button
      type="button"
      className={`dock-btn${active ? " is-active" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      data-tooltip={label}
    >
      {children}
    </button>
  );
}

export default function App() {
  const [code, setCode] = useState("");
  const [useElk, setUseElk] = useState(true);
  const [hoverGlowEnabled, setHoverGlowEnabled] = useState(false);
  const [baseName, setBaseName] = useState("diagram");
  const [view, setViewState] = useState<PreviewView>({ scale: 1, tx: 0, ty: 0 });
  // Animate transform changes for button/fit zooms, but follow drag and wheel
  // input instantly so panning never lags behind the cursor.
  const [animateView, setAnimateView] = useState(true);
  const [isPanning, setIsPanning] = useState(false);
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
  const [previewEditor, setPreviewEditor] = useState<PreviewEditorState | null>(
    null
  );
  const [status, setStatus] = useState("Ready.");
  const [error, setError] = useState<string | null>(null);
  const [renderedSvg, setRenderedSvg] = useState("");
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const previewPanelRef = useRef<HTMLElement | null>(null);
  const previewInputRef = useRef<HTMLInputElement | null>(null);
  // Avoids recomputing the hover highlight on every mouse move while the cursor
  // stays within the same node or edge.
  const lastHoverKeyRef = useRef<string | null>(null);
  // Live mirror of `view` so pointer/wheel handlers read the latest transform
  // without stale closures, plus the in-flight drag gesture state.
  const viewRef = useRef(view);
  const panStateRef = useRef<{
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
    moved: boolean;
    target: EventTarget | null;
  } | null>(null);
  const draggingRef = useRef(false);
  // Fit the next freshly rendered diagram to the viewport (set on first render,
  // load sample, and reset); cleared so edits keep the user's current zoom/pan.
  const pendingFitRef = useRef(true);

  const codeWithLayout = useMemo(() => withLayout(code, useElk), [code, useElk]);

  // Writes a new transform, clamping the pan so the diagram can't drift off the
  // sides: smaller-than-viewport content stays fully inside, larger content
  // always keeps the viewport covered.
  const applyView = useCallback((next: PreviewView, animate = false) => {
    const scale = clampNumber(next.scale, MIN_SCALE, MAX_SCALE);
    const frame = previewFrameRef.current;
    const canvas = previewRef.current;
    let { tx, ty } = next;
    if (frame && canvas) {
      const contentW = canvas.offsetWidth * scale;
      const contentH = canvas.offsetHeight * scale;
      const fw = frame.clientWidth;
      const fh = frame.clientHeight;
      // On an axis where the whole diagram fits, keep it centred so it never
      // drifts off to one side; otherwise allow free panning but never expose a
      // gap past the edges.
      tx =
        contentW <= fw
          ? (fw - contentW) / 2
          : clampNumber(tx, fw - contentW, 0);
      ty =
        contentH <= fh
          ? (fh - contentH) / 2
          : clampNumber(ty, fh - contentH, 0);
    }
    const resolved = { scale, tx, ty };
    viewRef.current = resolved;
    setAnimateView(animate);
    setViewState(resolved);
  }, []);

  // Centres the whole diagram in the viewport, scaled down to fit with a small
  // margin but never enlarged past its natural size.
  const fitView = useCallback(
    (animate = true) => {
      const frame = previewFrameRef.current;
      const canvas = previewRef.current;
      if (!frame || !canvas) return;
      const cw = canvas.offsetWidth;
      const ch = canvas.offsetHeight;
      if (!cw || !ch) return;
      const fw = frame.clientWidth;
      const fh = frame.clientHeight;
      const scale = clampNumber(
        Math.min((fw / cw) * 0.94, (fh / ch) * 0.94, 1),
        MIN_SCALE,
        MAX_SCALE
      );
      applyView(
        { scale, tx: (fw - cw * scale) / 2, ty: (fh - ch * scale) / 2 },
        animate
      );
    },
    [applyView]
  );

  // Zooms by `factor` while keeping the point at (cx, cy) — in viewport
  // coordinates — pinned under the cursor, so nothing jumps.
  const zoomAround = useCallback(
    (factor: number, cx: number, cy: number, animate: boolean) => {
      const v = viewRef.current;
      const scale = clampNumber(v.scale * factor, MIN_SCALE, MAX_SCALE);
      const k = scale / v.scale;
      applyView(
        { scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k },
        animate
      );
    },
    [applyView]
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("mos-theme", theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      if (!codeWithLayout.trim()) {
        setRenderedSvg("");
        setPreviewEditor(null);
        setError(null);
        if (previewRef.current) {
          previewRef.current.innerHTML = "";
        }
        // Next diagram to appear should fit the viewport fresh.
        pendingFitRef.current = true;
        setStatus("Paste Mermaid code to render your diagram.");
        return;
      }

      setStatus("Rendering...");
      setError(null);
      const id = `mermaid-${crypto.randomUUID()}`;
      try {
        await ensureMermaidReady();
        const { svg } = await mermaid.render(id, codeWithLayout);
        if (cancelled) return;
        setRenderedSvg(svg);
        setPreviewEditor(null);
        if (previewRef.current) {
          previewRef.current.innerHTML = svg;
          // Mermaid renders the SVG with width="100%", which collapses inside
          // the max-content stage. Pin it to its natural pixel size so the
          // pan/zoom transform has real dimensions to work with.
          const svgEl = previewRef.current.querySelector("svg");
          const viewBox = svgEl?.viewBox?.baseVal;
          if (svgEl && viewBox && viewBox.width && viewBox.height) {
            svgEl.setAttribute("width", String(viewBox.width));
            svgEl.setAttribute("height", String(viewBox.height));
            svgEl.style.maxWidth = "none";
          }
        }
        // Fit a brand-new diagram to the viewport once; preserve the user's
        // zoom/pan across subsequent edits.
        if (pendingFitRef.current) {
          pendingFitRef.current = false;
          requestAnimationFrame(() => fitView(true));
        }
        setStatus(useElk ? "Rendered with ELK layout." : "Rendered with default layout.");
      } catch (cause) {
        if (cancelled) return;
        // Mermaid can leave a temporary error diagram in the DOM on failure.
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
        setError(friendlyRenderError(cause));
        setStatus("Couldn't render — check your Mermaid syntax.");
        setRenderedSvg("");
        if (previewRef.current) previewRef.current.innerHTML = "";
      }
    }

    renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [codeWithLayout, useElk]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsPreviewFullscreen(document.fullscreenElement === previewPanelRef.current);
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, []);

  // Wheel (and trackpad pinch) zooms toward the cursor. Registered natively so
  // it can be non-passive and stop the page from scrolling.
  useEffect(() => {
    const frame = previewFrameRef.current;
    if (!frame) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = frame.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0015);
      zoomAround(
        factor,
        event.clientX - rect.left,
        event.clientY - rect.top,
        false
      );
    };

    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [zoomAround]);

  // Re-fit the diagram whenever the viewport size changes shape — entering or
  // leaving fullscreen — once the new layout has settled.
  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => fitView(true))
    );
    return () => cancelAnimationFrame(raf);
  }, [isPreviewFullscreen, fitView]);

  useEffect(() => {
    if (previewEditor && previewInputRef.current) {
      previewInputRef.current.focus();
      previewInputRef.current.select();
    }
  }, [previewEditor]);

  useEffect(() => {
    if (!hoverGlowEnabled && previewRef.current) {
      clearHoverClasses(previewRef.current);
    }
  }, [hoverGlowEnabled]);

  async function exportEditableElkScene() {
    const liveSvg = previewRef.current?.querySelector("svg");
    if (!liveSvg) {
      throw new Error("Render the diagram before exporting to Excalidraw.");
    }

    // The converter only understands flowchart geometry. Mermaid tags the SVG
    // with the diagram type, so reject other types with a clear message.
    if (!liveSvg.classList.contains("flowchart")) {
      throw new Error(
        "Editable Excalidraw export currently supports flowchart diagrams only. SVG, PNG, and PDF work for every diagram type."
      );
    }

    const skeletons = buildExcalidrawSkeletons(liveSvg as SVGSVGElement);
    if (!skeletons.length) {
      throw new Error(
        "No editable shapes were found in this diagram. Excalidraw export supports flowchart diagrams."
      );
    }

    const { convertToExcalidrawElements, serializeAsJSON } =
      await loadExcalidrawModule();
    const elements = convertToExcalidrawElements(skeletons as never, {
      regenerateIds: false,
    });

    return serializeAsJSON(
      elements,
      {
        name: `${baseName}-editable-elk`,
        viewBackgroundColor: "#ffffff",
      },
      {},
      "local"
    );
  }

  async function handleExport(format: ExportFormat) {
    if (!renderedSvg) {
      setError("Render a diagram first.");
      setStatus("Render a diagram first.");
      return;
    }

    try {
      setError(null);

      if (format === "excalidraw-editable-elk") {
        setStatus("Building editable Excalidraw scene...");
        const scene = await exportEditableElkScene();
        downloadBlob(
          new Blob([scene], { type: "application/json;charset=utf-8" }),
          `${baseName}.excalidraw`
        );
        setStatus(
          "Exported an editable Excalidraw scene from the ELK-positioned graph."
        );
        return;
      }

      // Render a foreignObject-free copy so the exported file is portable and
      // the PNG/PDF canvas doesn't get tainted by HTML labels.
      const exportSvg = await renderExportSvg(codeWithLayout);
      const { svgMarkup, width, height } = getPreparedSvgMarkup(exportSvg);

      if (format === "svg") {
        downloadBlob(svgToBlob(svgMarkup), `${baseName}.svg`);
        setStatus("Exported a single-page SVG.");
        return;
      }

      if (format === "png") {
        const canvas = await renderSvgMarkupToCanvas(svgMarkup, width, height);
        const pngBlob = await canvasToBlob(canvas, "image/png");
        downloadBlob(pngBlob, `${baseName}.png`);
        setStatus("Exported a high-resolution single-page PNG.");
        return;
      }

      if (format === "pdf") {
        const pdf = new jsPDF({
          orientation: width >= height ? "landscape" : "portrait",
          unit: "pt",
          format: [width, height],
          compress: true,
        });
        const canvas = await renderSvgMarkupToCanvas(svgMarkup, width, height);
        const pngDataUrl = canvas.toDataURL("image/png");
        // Deflate the embedded raster — without compression jsPDF stores the
        // high-resolution bitmap almost raw, producing 100 MB+ files.
        pdf.addImage(pngDataUrl, "PNG", 0, 0, width, height, undefined, "FAST");
        const pdfBlob = pdf.output("blob");
        downloadBlob(pdfBlob, `${baseName}.pdf`);
        setStatus("Exported a high-quality single-page PDF download.");
        return;
      }
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Export failed.";
      setError(message);
      setStatus("Export failed.");
    }
  }

  async function copyMermaid() {
    await navigator.clipboard.writeText(codeWithLayout);
    setStatus("Copied Mermaid text.");
  }

  function resetWorkspace() {
    setCode("");
    setUseElk(true);
    setBaseName("diagram");
    setPreviewEditor(null);
    setRenderedSvg("");
    pendingFitRef.current = true;
    applyView({ scale: 1, tx: 0, ty: 0 }, false);
    if (previewRef.current) {
      previewRef.current.innerHTML = "";
    }
    setStatus("Reset everything. Paste fresh Mermaid code to render.");
    setError(null);
  }

  function loadSample() {
    setCode(SAMPLE_CODE);
    setUseElk(true);
    setPreviewEditor(null);
    pendingFitRef.current = true;
    setStatus("Loaded the sample diagram.");
    setError(null);
  }

  function zoomByButton(factor: number) {
    const frame = previewFrameRef.current;
    if (!frame) return;
    zoomAround(factor, frame.clientWidth / 2, frame.clientHeight / 2, true);
  }

  function zoomIn() {
    zoomByButton(1.25);
  }

  function zoomOut() {
    zoomByButton(0.8);
  }

  function resetZoom() {
    fitView(true);
  }

  // Switching layout engine re-lays out the whole graph, so refit it.
  function toggleElk() {
    pendingFitRef.current = true;
    setUseElk((value) => !value);
  }

  async function togglePreviewFullscreen() {
    if (!previewPanelRef.current) {
      return;
    }

    if (document.fullscreenElement === previewPanelRef.current) {
      await document.exitFullscreen();
      return;
    }

    await previewPanelRef.current.requestFullscreen();
  }

  function commitPreviewEdit() {
    if (!previewEditor) {
      return;
    }

    const nextValue = previewEditor.value.trim();
    if (!nextValue) {
      setPreviewEditor(null);
      return;
    }

    const { id, matchText } = previewEditor;
    setCode((previous) =>
      id
        ? updateMermaidLabelById(previous, id, nextValue)
        : updateMermaidLabelByText(previous, matchText, nextValue)
    );
    setPreviewEditor(null);
    setStatus(
      id
        ? `Updated ${id} in Mermaid code from the preview.`
        : "Updated the subgraph label in Mermaid code from the preview."
    );
  }

  // Opens the inline label editor for a click that resolved to a node or
  // subgraph label. Runs on pointer-up only when the gesture wasn't a pan.
  function openEditorAt(
    rawTarget: EventTarget | null,
    clientX: number,
    clientY: number
  ) {
    const target = rawTarget as HTMLElement | null;
    if (!target) {
      return;
    }

    // Don't gate on the clicked tag — Mermaid 11 wraps label text in <p>/<span>
    // inside a <foreignObject>. Instead, resolve a label from the click target
    // and only open the editor when one is actually found.
    const text = findMermaidLabelText(target);
    if (!text || !previewFrameRef.current) {
      return;
    }

    // A node resolves to a Mermaid id; a subgraph label does not (its DOM id is
    // unusable in Mermaid 11), so fall back to matching by its text.
    const id = extractMermaidNodeIdFromElement(target);
    const isSubgraph = !id && !!target.closest("g.cluster, .cluster-label");
    if (!id && !isSubgraph) {
      return;
    }

    const frameRect = previewFrameRef.current.getBoundingClientRect();
    setPreviewEditor({
      id,
      matchText: text,
      value: text,
      x: clientX - frameRect.left + 12,
      y: clientY - frameRect.top + 12,
    });
  }

  // Click-and-drag panning. We capture the pointer on the frame and only treat
  // movement past a small threshold as a pan, so a plain click still edits a
  // label.
  function handleFramePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    // Leave the inline editor's own pointer handling alone.
    if (target?.closest(".preview-editor")) return;
    const frame = previewFrameRef.current;
    if (!frame) return;

    panStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startTx: viewRef.current.tx,
      startTy: viewRef.current.ty,
      moved: false,
      target: event.target,
    };
    frame.setPointerCapture(event.pointerId);
  }

  function handleFramePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const pan = panStateRef.current;
    if (!pan) return;

    const dx = event.clientX - pan.startX;
    const dy = event.clientY - pan.startY;
    if (!pan.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      pan.moved = true;
      draggingRef.current = true;
      setIsPanning(true);
      if (previewRef.current) clearHoverClasses(previewRef.current);
    }

    applyView(
      {
        scale: viewRef.current.scale,
        tx: pan.startTx + dx,
        ty: pan.startTy + dy,
      },
      false
    );
  }

  function handleFramePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const pan = panStateRef.current;
    const frame = previewFrameRef.current;
    if (frame?.hasPointerCapture(event.pointerId)) {
      frame.releasePointerCapture(event.pointerId);
    }
    panStateRef.current = null;
    draggingRef.current = false;
    setIsPanning(false);

    if (pan && !pan.moved) {
      openEditorAt(pan.target, event.clientX, event.clientY);
    }
  }

  function handlePreviewHover(event: React.MouseEvent<HTMLDivElement>) {
    if (draggingRef.current) {
      return;
    }
    if (!hoverGlowEnabled || !previewRef.current) {
      return;
    }

    const target = event.target as HTMLElement | null;
    const key =
      extractEdgeRelationship(target)?.edgeId ??
      extractMermaidNodeIdFromElement(target) ??
      "";
    if (key === lastHoverKeyRef.current) {
      return;
    }
    lastHoverKeyRef.current = key;

    const context = resolveHoverContext(previewRef.current, target);
    applyHoverContext(previewRef.current, context);
  }

  function handlePreviewLeave() {
    lastHoverKeyRef.current = null;
    if (!previewRef.current) {
      return;
    }

    clearHoverClasses(previewRef.current);
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <p className="eyebrow">Mermaid by Sabiq</p>
          <h1>Mermaid on Steroids</h1>
        </div>
        <label className="export-name">
          <span>Export name</span>
          <input
            value={baseName}
            onChange={(event) => setBaseName(event.target.value || "diagram")}
            aria-label="Export base name"
          />
        </label>
      </header>

      <main className="workspace">
        <section className="panel editor-panel">
          <div className="panel-header">
            <h2>Mermaid input</h2>
            <span>{status}</span>
          </div>
          <textarea
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder={SAMPLE_CODE}
            spellCheck={false}
            aria-label="Mermaid code editor"
          />
          {error ? <p className="error">{error}</p> : null}
        </section>

        <section className="panel preview-panel" ref={previewPanelRef}>
          <div className="panel-header">
            <h2>Preview</h2>
            <div className="preview-toolbar">
              <span className="render-chip">{useElk ? "ELK" : "Default"}</span>
              <div className="zoom-control" role="group" aria-label="Zoom">
                <button onClick={zoomOut} aria-label="Zoom out">
                  −
                </button>
                <button onClick={resetZoom} aria-label="Fit to view">
                  {Math.round(view.scale * 100)}%
                </button>
                <button onClick={zoomIn} aria-label="Zoom in">
                  +
                </button>
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={togglePreviewFullscreen}
                aria-label={
                  isPreviewFullscreen ? "Exit full screen" : "Full screen"
                }
                data-tooltip={
                  isPreviewFullscreen ? "Exit full screen" : "Full screen"
                }
              >
                {isPreviewFullscreen ? <IconFullscreenExit /> : <IconFullscreen />}
              </button>
            </div>
          </div>
          <div
            className={`preview-frame${isPanning ? " is-panning" : ""}`}
            ref={previewFrameRef}
            onPointerDown={handleFramePointerDown}
            onPointerMove={handleFramePointerMove}
            onPointerUp={handleFramePointerUp}
            onPointerCancel={handleFramePointerUp}
          >
            <div
              className="preview-stage"
              style={{
                transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
                transition: animateView ? "transform 0.18s ease" : "none",
              }}
              data-hover-glow={hoverGlowEnabled ? "enabled" : "disabled"}
            >
              <div
                ref={previewRef}
                className="preview-canvas"
                onMouseMove={handlePreviewHover}
                onMouseLeave={handlePreviewLeave}
              />
            </div>
            {!renderedSvg ? (
              <div className="preview-empty-state">
                Your rendered diagram will appear here.
              </div>
            ) : null}
            {previewEditor ? (
              <form
                className="preview-editor"
                style={{ left: previewEditor.x, top: previewEditor.y }}
                onSubmit={(event) => {
                  event.preventDefault();
                  commitPreviewEdit();
                }}
              >
                <input
                  ref={previewInputRef}
                  value={previewEditor.value}
                  onChange={(event) =>
                    setPreviewEditor((current) =>
                      current
                        ? { ...current, value: event.target.value }
                        : current
                    )
                  }
                  onBlur={commitPreviewEdit}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setPreviewEditor(null);
                    }
                  }}
                />
              </form>
            ) : null}
          </div>
        </section>

        <aside className="dock" aria-label="Tools">
          <div className="dock-group">
            <DockButton
              label={theme === "dark" ? "Light mode" : "Dark mode"}
              onClick={() =>
                setTheme((value) => (value === "dark" ? "light" : "dark"))
              }
            >
              {theme === "dark" ? <IconSun /> : <IconMoon />}
            </DockButton>
          </div>

          <div className="dock-divider" />

          <div className="dock-group">
            <DockButton label="Reset workspace" onClick={resetWorkspace}>
              <IconReset />
            </DockButton>
            <DockButton label="Load sample" onClick={loadSample}>
              <IconSample />
            </DockButton>
            <DockButton label="Copy Mermaid" onClick={copyMermaid}>
              <IconCopy />
            </DockButton>
          </div>

          <div className="dock-divider" />

          <div className="dock-group">
            <DockButton
              label={`ELK layout: ${useElk ? "on" : "off"}`}
              active={useElk}
              onClick={toggleElk}
            >
              <IconLayout />
            </DockButton>
            <DockButton
              label={`Hover glow: ${hoverGlowEnabled ? "on" : "off"} (beta)`}
              active={hoverGlowEnabled}
              onClick={() => setHoverGlowEnabled((value) => !value)}
            >
              <IconGlow />
            </DockButton>
          </div>

          <div className="dock-divider" />

          <div className="dock-group">
            <DockButton label="Export SVG" onClick={() => handleExport("svg")}>
              <IconSvg />
            </DockButton>
            <DockButton label="Export PNG" onClick={() => handleExport("png")}>
              <IconPng />
            </DockButton>
            <DockButton label="Export PDF" onClick={() => handleExport("pdf")}>
              <IconPdf />
            </DockButton>
            <DockButton
              label="Export editable Excalidraw (ELK)"
              onClick={() => handleExport("excalidraw-editable-elk")}
            >
              <IconShapes />
            </DockButton>
          </div>
        </aside>
      </main>
      <footer className="footer">
        Developed by{" "}
        <a href="https://sabiq.dev" target="_blank" rel="noreferrer">
          Sabiq Sabry
        </a>
      </footer>
    </div>
  );
}
