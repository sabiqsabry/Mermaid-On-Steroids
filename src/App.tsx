import { useEffect, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import elkLayouts from "@mermaid-js/layout-elk";
import { jsPDF } from "jspdf";
import "svg2pdf.js";

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
  | "pdf";

type PreviewEditorState = {
  id: string;
  value: string;
  x: number;
  y: number;
};
type HoverContext = {
  nodeIds: string[];
  edgeIds: string[];
};

const ELK_FRONTMATTER = `---
config:
  layout: elk
---`;

let mermaidReady: Promise<void> | null = null;

async function ensureMermaidReady() {
  if (!mermaidReady) {
    mermaidReady = (async () => {
      mermaid.registerLayoutLoaders(elkLayouts);
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: "base",
        flowchart: {
          curve: "linear",
        },
        themeVariables: {
          fontFamily:
            '"Atkinson Hyperlegible", "Inter", "Segoe UI", sans-serif',
        },
      });
    })();
  }

  await mermaidReady;
}

function withLayout(code: string, useElk: boolean) {
  if (!code.trim()) return "";
  if (!useElk) return code;
  const trimmed = code.trimStart();
  if (trimmed.startsWith("---")) return code;
  return `${ELK_FRONTMATTER}\n${code}`;
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMermaidLabelTarget(element: Element | null) {
  let current: Element | null = element;

  while (current) {
    const id = current.getAttribute("id");
    if (id) {
      if (/^flowchart-([A-Za-z0-9_:.]+)-\d+$/.test(id)) {
        const match = id.match(/^flowchart-([A-Za-z0-9_:.]+)-\d+$/);
        if (match?.[1]) {
          return match[1];
        }
      }

      if (/^[A-Za-z][A-Za-z0-9_:.]*$/.test(id)) {
        return id;
      }
    }

    current = current.parentElement;
  }

  return null;
}

function extractMermaidNodeIdFromElement(element: Element | null) {
  let current: Element | null = element;

  while (current) {
    const id = current.getAttribute("id");
    if (id) {
      const flowchartNodeMatch = id.match(/^flowchart-([A-Za-z0-9_:.]+)-\d+$/);
      if (flowchartNodeMatch?.[1]) {
        return flowchartNodeMatch[1];
      }

      if (!id.startsWith("L-") && /^[A-Za-z][A-Za-z0-9_:.]*$/.test(id)) {
        return id;
      }
    }

    current = current.parentElement;
  }

  return null;
}

function extractEdgeRelationship(element: Element | null) {
  let current: Element | null = element;

  while (current) {
    const id = current.getAttribute("id");
    if (id) {
      const edgeMatch = id.match(/^L-([A-Za-z0-9_:.]+)-([A-Za-z0-9_:.]+)-\d+$/);
      if (edgeMatch?.[1] && edgeMatch?.[2]) {
        return {
          edgeId: id,
          startId: edgeMatch[1],
          endId: edgeMatch[2],
        };
      }
    }

    current = current.parentElement;
  }

  return null;
}

function findConnectedEdgeIds(container: HTMLElement, nodeId: string) {
  const connectedEdges = new Set<string>();

  container.querySelectorAll<HTMLElement>("[id^='L-']").forEach((element) => {
    const id = element.getAttribute("id");
    if (!id) {
      return;
    }

    const edgeMatch = id.match(/^L-([A-Za-z0-9_:.]+)-([A-Za-z0-9_:.]+)-\d+$/);
    if (!edgeMatch) {
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
    ".node, .cluster, .edgePath"
  );

  if (!context) {
    return;
  }

  interactiveElements.forEach((element) => {
    element.classList.add("mos-dimmed");
  });

  const highlightSelectors = [
    ...context.nodeIds.flatMap((id) => [`[id='${id}']`, `[id^='flowchart-${id}-']`]),
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

  return {
    nodeIds: [nodeId],
    edgeIds: findConnectedEdgeIds(container, nodeId),
  };
}

function updateMermaidLabelById(source: string, id: string, nextLabel: string) {
  const escapedId = escapeRegExp(id);
  const lines = source.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nodePattern = new RegExp(`^\\s*${escapedId}\\s*[\\[(]`);
    const subgraphPattern = new RegExp(`^\\s*subgraph\\s+${escapedId}\\s*[\\[(]`);

    if (!nodePattern.test(line) && !subgraphPattern.test(line)) {
      continue;
    }

    if (!/"[^"]*"/.test(line)) {
      continue;
    }

    lines[index] = line.replace(/"[^"]*"/, `"${nextLabel.replace(/"/g, '\\"')}"`);
    return lines.join("\n");
  }

  return source;
}

function findMermaidLabelText(element: Element | null) {
  if (!element) {
    return null;
  }

  const textContainer = element.closest("text, .nodeLabel, .cluster-label");
  const text = textContainer?.textContent?.trim() ?? element.textContent?.trim();
  return text || null;
}

async function renderPreviewToCanvas(container: HTMLDivElement) {
  const canvas = document.createElement("canvas");
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Canvas context is not available.");
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  return canvas;
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

function createSvgElement(svgMarkup: string) {
  const parser = new DOMParser();
  const svgDocument = parser.parseFromString(svgMarkup, "image/svg+xml");
  const svgElement = svgDocument.documentElement as unknown as SVGSVGElement;

  if (!svgElement || svgElement.nodeName.toLowerCase() !== "svg") {
    throw new Error("Failed to prepare SVG for PDF export.");
  }

  return svgElement;
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

export default function App() {
  const [code, setCode] = useState("");
  const [useElk, setUseElk] = useState(true);
  const [hoverGlowEnabled, setHoverGlowEnabled] = useState(false);
  const [baseName, setBaseName] = useState("diagram");
  const [previewZoom, setPreviewZoom] = useState(1);
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
  const [previewEditor, setPreviewEditor] = useState<PreviewEditorState | null>(
    null
  );
  const [status, setStatus] = useState("Ready.");
  const [error, setError] = useState<string | null>(null);
  const [renderedSvg, setRenderedSvg] = useState("");
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const previewPanelRef = useRef<HTMLElement | null>(null);
  const previewInputRef = useRef<HTMLInputElement | null>(null);

  const codeWithLayout = useMemo(() => withLayout(code, useElk), [code, useElk]);

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
        setStatus("Paste Mermaid code to render your diagram.");
        return;
      }

      setStatus("Rendering...");
      setError(null);
      try {
        await ensureMermaidReady();
        const id = `mermaid-${crypto.randomUUID()}`;
        const { svg } = await mermaid.render(id, codeWithLayout);
        if (cancelled) return;
        setRenderedSvg(svg);
        setPreviewEditor(null);
        if (previewRef.current) {
          previewRef.current.innerHTML = svg;
        }
        setStatus(useElk ? "Rendered with ELK layout." : "Rendered with default layout.");
      } catch (cause) {
        if (cancelled) return;
        const message =
          cause instanceof Error ? cause.message : "Failed to render diagram.";
        setError(message);
        setStatus("Render failed.");
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

  async function handleExport(format: ExportFormat) {
    if (!renderedSvg) {
      setError("Render a diagram first.");
      setStatus("Render a diagram first.");
      return;
    }

    try {
      setError(null);
      const { svgMarkup, width, height } = getPreparedSvgMarkup(renderedSvg);

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
        });
        const svgElement = createSvgElement(svgMarkup);
        await pdf.svg(svgElement, {
          x: 0,
          y: 0,
          width,
          height,
        });
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

  function resetToSample() {
    setCode("");
    setUseElk(true);
    setBaseName("diagram");
    setPreviewZoom(1);
    setPreviewEditor(null);
    setRenderedSvg("");
    if (previewRef.current) {
      previewRef.current.innerHTML = "";
    }
    setStatus("Reset everything. Paste fresh Mermaid code to render.");
    setError(null);
  }

  function zoomIn() {
    setPreviewZoom((value) => Math.min(3, Number((value + 0.2).toFixed(2))));
  }

  function zoomOut() {
    setPreviewZoom((value) => Math.max(0.4, Number((value - 0.2).toFixed(2))));
  }

  function resetZoom() {
    setPreviewZoom(1);
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

    setCode((previous) =>
      updateMermaidLabelById(previous, previewEditor.id, nextValue)
    );
    setPreviewEditor(null);
    setStatus(`Updated ${previewEditor.id} in Mermaid code from the preview.`);
  }

  function handlePreviewClick(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }

    const tagName = target.tagName.toLowerCase();
    const isTextTarget =
      tagName === "text" ||
      tagName === "tspan" ||
      tagName === "span" ||
      tagName === "div";

    if (!isTextTarget) {
      return;
    }

    const id = extractMermaidLabelTarget(target);
    const text = findMermaidLabelText(target);
    if (!id || !text || !previewFrameRef.current) {
      return;
    }

    const frameRect = previewFrameRef.current.getBoundingClientRect();
    setPreviewEditor({
      id,
      value: text,
      x:
        event.clientX -
        frameRect.left +
        previewFrameRef.current.scrollLeft +
        12,
      y:
        event.clientY -
        frameRect.top +
        previewFrameRef.current.scrollTop +
        12,
    });
  }

  function handlePreviewHover(event: React.MouseEvent<HTMLDivElement>) {
    if (!hoverGlowEnabled || !previewRef.current) {
      return;
    }

    const target = event.target as HTMLElement | null;
    const context = resolveHoverContext(previewRef.current, target);
    applyHoverContext(previewRef.current, context);
  }

  function handlePreviewLeave() {
    if (!previewRef.current) {
      return;
    }

    clearHoverClasses(previewRef.current);
  }

  return (
    <div className="shell">
      <div className="announcement-bar">
        Mermaid on Steroids is just getting started. More layout tools, export
        controls, and editing options are coming soon.
      </div>
      <header className="hero">
        <div>
          <p className="eyebrow">Mermaid by Sabiq</p>
          <h1>Mermaid on Steroids</h1>
          <p className="lede">
            Mermaid with ELK-first rendering, cleaner exports, and room to keep
            evolving the editable diagram workflow.
          </p>
        </div>
        <div className="hero-actions">
          <label className="filename-field">
            <span>Export name</span>
            <input
              value={baseName}
              onChange={(event) => setBaseName(event.target.value || "diagram")}
              aria-label="Export base name"
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={useElk}
              onChange={(event) => setUseElk(event.target.checked)}
            />
            <span>Use ELK layout</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={hoverGlowEnabled}
              onChange={(event) => setHoverGlowEnabled(event.target.checked)}
            />
            <span>Enable hover glow beta</span>
          </label>
          <div className="button-row">
            <button onClick={resetToSample}>Reset</button>
            <button onClick={copyMermaid}>Copy Mermaid</button>
            <button onClick={() => handleExport("svg")}>SVG</button>
            <button onClick={() => handleExport("png")}>PNG</button>
            <button onClick={() => handleExport("pdf")}>PDF</button>
            <button disabled title="Coming soon">
              Excalidraw editable ELK
            </button>
          </div>
          <p className="hint">
            Click a node or subgraph label in the preview to edit it inline and
            push the change back into the Mermaid code. `Excalidraw editable
            ELK` is temporarily paused while we keep working on the editable
            export path.
          </p>
        </div>
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
              <span>{useElk ? "ELK" : "Default"} render</span>
              <button onClick={zoomOut}>-</button>
              <button onClick={resetZoom}>{Math.round(previewZoom * 100)}%</button>
              <button onClick={zoomIn}>+</button>
              <button onClick={togglePreviewFullscreen}>
                {isPreviewFullscreen ? "Exit full screen" : "Full screen"}
              </button>
            </div>
          </div>
          <div className="preview-frame" ref={previewFrameRef}>
            <div
              className="preview-stage"
              style={{ transform: `scale(${previewZoom})` }}
              data-hover-glow={hoverGlowEnabled ? "enabled" : "disabled"}
            >
              <div
                ref={previewRef}
                className="preview-canvas"
                onClick={handlePreviewClick}
                onMouseMove={handlePreviewHover}
                onMouseLeave={handlePreviewLeave}
              />
              {!renderedSvg ? (
                <div className="preview-empty-state">
                  Your rendered diagram will appear here.
                </div>
              ) : null}
            </div>
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
