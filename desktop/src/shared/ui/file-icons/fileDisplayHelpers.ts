/**
 * 纯工具：文件名/扩展名 → 图标变体（glyph 形状 + 品牌色）。
 * 名称/扩展名映射沿用原 material 图标名表（对齐 ZCode
 * lib/fileDisplayHelpers.ts:42-172 的覆盖面）；展示改为内联 SVG
 * （fileDisplay.tsx），不再请求 material-icons/*.svg——此前 document.svg
 * 兜底 404 的链路整体移除。从 fileDisplay.tsx 拆出以满足 react-refresh
 * 组件文件纯度。
 */

export const DEFAULT_FILE_ICON_NAME = "document";

const FILE_NAME_ICON_ALIASES: Record<string, string> = {
  ".editorconfig": "editorconfig",
  ".env": "settings",
  ".gitattributes": "git",
  ".gitignore": "git",
  ".npmrc": "npm",
  ".nvmrc": "nodejs_alt",
  ".prettierrc": "prettier",
  ".yarnrc": "yarn",
  "babel.config": "babel",
  bun: "lock",
  "bun.lock": "lock",
  cargo: "rust",
  "cargo.lock": "lock",
  dockerfile: "docker",
  eslint: "eslint",
  "eslint.config": "eslint",
  gemfile: "gemfile",
  jest: "jest",
  "jest.config": "jest",
  makefile: "makefile",
  "package-lock": "lock",
  "pnpm-lock": "lock",
  readme: "readme",
  tsconfig: "tsconfig",
  vitest: "vitest",
  "vitest.config": "vitest",
  yarn: "yarn",
};

const EXTENSION_ICON_ALIASES: Record<string, string> = {
  backup: "document",
  bash: "console",
  bz2: "archive",
  cjs: "javascript",
  css: "css",
  cts: "typescript",
  doc: "word",
  docx: "word",
  gz: "archive",
  go: "go",
  html: "html",
  java: "java",
  jar: "archive",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  json: "json",
  jsonl: "json",
  mjs: "javascript",
  md: "markdown",
  m4a: "audio",
  m4v: "video",
  flac: "audio",
  mov: "video",
  mp3: "audio",
  mp4: "video",
  mts: "typescript",
  ogg: "audio",
  opus: "audio",
  pdf: "pdf",
  php: "php",
  png: "image",
  pptx: "powerpoint",
  py: "python",
  rar: "archive",
  responses: "json",
  rs: "rust",
  sb: "storybook",
  sh: "console",
  snap: "snapcraft",
  sql: "database",
  svg: "svg",
  tar: "archive",
  tgz: "archive",
  toml: "toml",
  ts: "typescript",
  tsx: "react_ts",
  txt: "document",
  wav: "audio",
  weba: "audio",
  webm: "video",
  xlsx: "table",
  yaml: "yaml",
  yml: "yaml",
  zsh: "console",
  zip: "archive",
  "7z": "archive",
};

/** 图标形状（fileDisplay.tsx 的 16 viewBox 内联 SVG motif）。 */
export type FileIconGlyph =
  | "code"
  | "config"
  | "markdown"
  | "text"
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "lock"
  | "docker"
  | "git"
  | "database";

export interface FileIconVariant {
  glyph: FileIconGlyph;
  /** 品牌色 hex：观感对齐 ZCode 文件图标（docker 红、yaml 橙、md 蓝、图绿）。 */
  color: string;
}

/** 图标名 → 形状 + 颜色。中性 document 兜底 = 灰线稿。 */
const ICON_VARIANTS: Record<string, FileIconVariant> = {
  audio: { glyph: "audio", color: "#8b7cf6" },
  babel: { glyph: "code", color: "#d4a017" },
  console: { glyph: "code", color: "#5fa04e" },
  css: { glyph: "code", color: "#663399" },
  database: { glyph: "database", color: "#c96442" },
  docker: { glyph: "docker", color: "#dd4b39" },
  document: { glyph: "text", color: "#8a8f98" },
  editorconfig: { glyph: "config", color: "#f57d00" },
  eslint: { glyph: "code", color: "#4b32c3" },
  gemfile: { glyph: "code", color: "#cc342d" },
  git: { glyph: "git", color: "#f05133" },
  go: { glyph: "code", color: "#00a3c4" },
  html: { glyph: "code", color: "#d2691e" },
  image: { glyph: "image", color: "#46bf72" },
  java: { glyph: "code", color: "#b07219" },
  javascript: { glyph: "code", color: "#d4a017" },
  jest: { glyph: "code", color: "#99424f" },
  json: { glyph: "config", color: "#bf9c00" },
  lock: { glyph: "lock", color: "#8a8f98" },
  makefile: { glyph: "code", color: "#6a9e58" },
  markdown: { glyph: "markdown", color: "#4099ff" },
  nodejs_alt: { glyph: "code", color: "#43853d" },
  npm: { glyph: "config", color: "#cb3837" },
  pdf: { glyph: "text", color: "#e03131" },
  php: { glyph: "code", color: "#7377ad" },
  powerpoint: { glyph: "text", color: "#d24726" },
  prettier: { glyph: "code", color: "#b96bc6" },
  python: { glyph: "code", color: "#3572a5" },
  react: { glyph: "code", color: "#2f9ee0" },
  react_ts: { glyph: "code", color: "#3178c6" },
  readme: { glyph: "markdown", color: "#4099ff" },
  rust: { glyph: "code", color: "#c1542b" },
  settings: { glyph: "config", color: "#8a8f98" },
  snapcraft: { glyph: "code", color: "#5a9e6f" },
  sql: { glyph: "database", color: "#c96442" },
  storybook: { glyph: "code", color: "#d94474" },
  svg: { glyph: "image", color: "#a071c9" },
  table: { glyph: "text", color: "#1e7145" },
  toml: { glyph: "config", color: "#f57d00" },
  tsconfig: { glyph: "config", color: "#3178c6" },
  typescript: { glyph: "code", color: "#3178c6" },
  vitest: { glyph: "code", color: "#729b1b" },
  word: { glyph: "text", color: "#2b569a" },
  yaml: { glyph: "config", color: "#f57d00" },
  yarn: { glyph: "config", color: "#2c8ebb" },
  video: { glyph: "video", color: "#e06c75" },
};

const DEFAULT_VARIANT: FileIconVariant = {
  glyph: "text",
  color: "#8a8f98",
};

/** 图标名（resolveIconName 的返回）→ 形状 + 颜色；未知名回退中性文档。 */
export function fileIconVariantFor(iconName: string): FileIconVariant {
  return ICON_VARIANTS[iconName] ?? DEFAULT_VARIANT;
}

/** 文件名/扩展名 → 图标名（含逐段 stem 回退，fileDisplayHelpers.ts:42-172）。 */
export function resolveIconName(fileName: string): string {
  const leaf = fileName.replace(/\\/g, "/").split("/").at(-1) ?? fileName;
  const normalizedLeaf = leaf.toLowerCase();
  const lastDot = leaf.lastIndexOf(".");
  const withoutExtension =
    lastDot === -1 ? normalizedLeaf : normalizedLeaf.slice(0, lastDot);

  const candidates = new Set<string>([normalizedLeaf, withoutExtension]);
  let stem = withoutExtension;
  while (stem.includes(".")) {
    stem = stem.slice(0, stem.lastIndexOf("."));
    if (stem) candidates.add(stem);
  }

  for (const candidate of candidates) {
    const aliased = FILE_NAME_ICON_ALIASES[candidate];
    if (aliased) return aliased;
  }

  if (lastDot === -1) return DEFAULT_FILE_ICON_NAME;
  const extension = leaf.slice(lastDot + 1).toLowerCase();
  return EXTENSION_ICON_ALIASES[extension] ?? extension;
}

/** 文件路径 → 图标变体（树行/面包屑共用）。 */
export function resolveFileIconVariant(path: string): FileIconVariant {
  const leaf = path.replace(/\\/g, "/").split("/").at(-1) ?? path;
  return fileIconVariantFor(resolveIconName(leaf));
}
