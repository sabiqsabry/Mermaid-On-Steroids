// Pure helpers shared by the app and the Excalidraw exporter. Kept free of DOM
// and React so they can be unit-tested with `node --test` (see the .test.mjs).

export const ELK_FRONTMATTER = `---
config:
  layout: elk
---`;

// Mermaid 11 prefixes DOM ids with the render id and uses underscores for edges:
//   nodes:  "mermaid-<uuid>-flowchart-ZT-9"
//   edges:  "mermaid-<uuid>-L_CA_REST_0_0"
// so these patterns are matched anywhere in the id rather than anchored.
export const NODE_ID_RE = /flowchart-(.+)-\d+$/;
export const EDGE_ID_RE = /L_([A-Za-z0-9.:]+)_([A-Za-z0-9.:]+)_\d+_\d+$/;

export function parseNodeId(domId: string | null | undefined): string | null {
  return domId?.match(NODE_ID_RE)?.[1] ?? null;
}

export function parseEdgeEndpoints(
  domId: string | null | undefined
): { start: string; end: string } | null {
  const match = domId?.match(EDGE_ID_RE);
  if (!match?.[1] || !match?.[2]) return null;
  return { start: match[1], end: match[2] };
}

export function withLayout(code: string, useElk: boolean) {
  if (!code.trim()) return "";
  if (!useElk) return code;
  const trimmed = code.trimStart();
  if (trimmed.startsWith("---")) return code;
  return `${ELK_FRONTMATTER}\n${code}`;
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Rewrites a node or subgraph label by its Mermaid id, preserving the rest of
// the line. Returns the source unchanged if no matching declaration is found.
export function updateMermaidLabelById(
  source: string,
  id: string,
  nextLabel: string
) {
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

// Fallback for subgraph labels: the cluster DOM id is not the Mermaid id in
// Mermaid 11, so locate the source line by its current quoted label text.
export function updateMermaidLabelByText(
  source: string,
  matchText: string,
  nextLabel: string
) {
  const quoted = `"${matchText}"`;
  const lines = source.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.includes(quoted)) {
      continue;
    }
    lines[index] = line.replace(quoted, `"${nextLabel.replace(/"/g, '\\"')}"`);
    return lines.join("\n");
  }

  return source;
}
