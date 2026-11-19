import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface BrowserDependencyEdge {
  from: string;
  to: string;
}

export interface BrowserDependencyReport {
  cycles: string[][];
  forbiddenEdges: BrowserDependencyEdge[];
}

const forbidden = new Set([
  "mcp->acp",
  "mcp->ui",
  "ui->mcp",
  "ui->cdp",
  "ui->agents",
  "runtime->mcp",
  "runtime->acp",
  "runtime->ui",
  "runtime->diagnostics",
  "diagnostics->runtime",
  "diagnostics->host",
]);

export function validateBrowserDependencies(
  edges: readonly BrowserDependencyEdge[],
): BrowserDependencyReport {
  const forbiddenEdges = edges.filter((edge) =>
    forbidden.has(`${edge.from}->${edge.to}`),
  );
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  const visit = (node: string): void => {
    if (active.has(node)) {
      const start = path.indexOf(node);
      cycles.push([...path.slice(start), node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    active.add(node);
    path.push(node);
    for (const target of adjacency.get(node) ?? []) visit(target);
    path.pop();
    active.delete(node);
  };
  for (const node of adjacency.keys()) visit(node);
  return { cycles, forbiddenEdges };
}

export function classifyBrowserContractChange(change: {
  requiredFieldAdded: boolean;
  requiredFieldRemoved: boolean;
  enumChanged: boolean;
  toolRemoved: boolean;
}): { compatibility: "compatible" | "breaking" } {
  return {
    compatibility:
      change.requiredFieldAdded ||
      change.requiredFieldRemoved ||
      change.enumChanged ||
      change.toolRemoved
        ? "breaking"
        : "compatible",
  };
}

export interface BrowserTraceInput {
  designs: readonly string[];
  tests: readonly string[];
  acceptance: readonly string[];
  deferred?: readonly string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function validateBrowserTraceability(input: BrowserTraceInput): {
  missingDesign: string[];
  missingTests: string[];
  missingAcceptance: string[];
  unknownTestCases: string[];
  deferred: string[];
} {
  const designs = new Set(input.designs);
  const tests = new Set(input.tests);
  const acceptance = new Set(input.acceptance);
  return {
    missingDesign: input.tests.filter((item) => !designs.has(item)),
    missingTests: input.designs.filter((item) => !tests.has(item)),
    missingAcceptance: input.designs.filter((item) => !acceptance.has(item)),
    unknownTestCases: input.tests.filter((item) => !designs.has(item)),
    deferred: unique(input.deferred ?? []),
  };
}

function prefix(fileName: string): string {
  return fileName.slice(0, 2);
}

export function validateBrowserDocumentPairing(
  designs: readonly string[],
  tests: readonly string[],
): {
  missingTestDocuments: string[];
  missingDesignDocuments: string[];
  duplicatePairs: string[];
} {
  const designPrefixes = designs.map(prefix);
  const testPrefixes = tests.map(prefix);
  const designSet = new Set(designPrefixes);
  const testSet = new Set(testPrefixes);
  return {
    missingTestDocuments: unique(
      designPrefixes.filter((item) => !testSet.has(item)),
    ),
    missingDesignDocuments: unique(
      testPrefixes.filter((item) => !designSet.has(item)),
    ),
    duplicatePairs: unique(
      [...designPrefixes, ...testPrefixes].filter(
        (item, index, all) =>
          all.indexOf(item) !== index &&
          (designPrefixes.filter((value) => value === item).length > 1 ||
            testPrefixes.filter((value) => value === item).length > 1),
      ),
    ),
  };
}

export function validateBrowserCrossSurfaceCoverage(input: {
  required: readonly string[];
  covered: readonly string[];
  exemptions?: readonly string[];
}): { uncoveredCombinations: string[]; unreviewedExemptions: string[] } {
  const covered = new Set(input.covered);
  return {
    uncoveredCombinations: input.required.filter((item) => !covered.has(item)),
    unreviewedExemptions: unique(input.exemptions ?? []),
  };
}

export function verifyBrowserDesignBaseline(root: string): {
  missingDesignLinks: string[];
  missingTestLinks: string[];
  designDocumentCount: number;
  testDesignDocumentCount: number;
} {
  const files = readdirSync(root).filter((file) => file.endsWith(".md"));
  const tests = files.filter((file) => file.endsWith("测试设计.md"));
  const designs = files.filter((file) => !file.endsWith("测试设计.md"));
  const missingDesignLinks: string[] = [];
  const missingTestLinks: string[] = [];
  for (const design of designs) {
    const test = tests.find(
      (candidate) => prefix(candidate) === prefix(design),
    );
    if (!test || !readFileSync(join(root, design), "utf8").includes(test)) {
      missingTestLinks.push(prefix(design));
    }
  }
  for (const test of tests) {
    const design = designs.find(
      (candidate) => prefix(candidate) === prefix(test),
    );
    if (!design || !readFileSync(join(root, test), "utf8").includes(design)) {
      missingDesignLinks.push(prefix(test));
    }
  }
  return {
    missingDesignLinks,
    missingTestLinks,
    designDocumentCount: designs.length,
    testDesignDocumentCount: tests.length,
  };
}
