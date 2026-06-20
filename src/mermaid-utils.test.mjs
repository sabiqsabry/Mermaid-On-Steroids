// Run with: npm test  (Node strips the TS types from the imported module)
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseNodeId,
  parseEdgeEndpoints,
  withLayout,
  updateMermaidLabelById,
  updateMermaidLabelByText,
  ELK_FRONTMATTER,
} from "./mermaid-utils.ts";

test("parseNodeId reads Mermaid 11 prefixed node ids", () => {
  assert.equal(parseNodeId("mermaid-9b89-flowchart-ZT-9"), "ZT");
  assert.equal(parseNodeId("mermaid-abc-flowchart-L2B-12"), "L2B");
  assert.equal(parseNodeId("mermaid-abc-flowchart-L1-10"), "L1");
  assert.equal(parseNodeId(null), null);
  assert.equal(parseNodeId("mermaid-abc-L_CA_REST_0_0"), null);
});

test("parseEdgeEndpoints reads underscore-separated edge ids", () => {
  assert.deepEqual(parseEdgeEndpoints("mermaid-x-L_CA_REST_0_0"), {
    start: "CA",
    end: "REST",
  });
  assert.deepEqual(parseEdgeEndpoints("mermaid-x-L_L2_L2B_0_0"), {
    start: "L2",
    end: "L2B",
  });
  assert.equal(parseEdgeEndpoints("mermaid-x-flowchart-ZT-9"), null);
  assert.equal(parseEdgeEndpoints(undefined), null);
});

test("withLayout adds ELK frontmatter only when needed", () => {
  assert.equal(withLayout("", true), "");
  assert.equal(withLayout("flowchart TD\nA-->B", false), "flowchart TD\nA-->B");
  assert.equal(
    withLayout("flowchart TD\nA-->B", true),
    `${ELK_FRONTMATTER}\nflowchart TD\nA-->B`
  );
  // Already has frontmatter -> left untouched.
  const withFrontmatter = "---\nconfig:\n  layout: elk\n---\nflowchart TD";
  assert.equal(withLayout(withFrontmatter, true), withFrontmatter);
});

test("updateMermaidLabelById rewrites node and subgraph labels", () => {
  const src = 'flowchart TD\n  A["Old A"] --> B\n  subgraph S1["Old group"]\n  end';
  assert.match(updateMermaidLabelById(src, "A", "New A"), /A\["New A"\]/);
  assert.match(
    updateMermaidLabelById(src, "S1", "New group"),
    /subgraph S1\["New group"\]/
  );
  // Unknown id -> unchanged.
  assert.equal(updateMermaidLabelById(src, "ZZ", "x"), src);
});

test("updateMermaidLabelByText rewrites by quoted text", () => {
  const src = 'flowchart TD\n  subgraph S1["Access layer"]\n  end';
  assert.match(
    updateMermaidLabelByText(src, "Access layer", "Access tier"),
    /subgraph S1\["Access tier"\]/
  );
  assert.equal(updateMermaidLabelByText(src, "Nope", "x"), src);
});
