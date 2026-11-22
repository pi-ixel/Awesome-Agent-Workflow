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
  /** 主题描边色：观感对齐 ZCode 文件图标（docker 红、yaml 橙、md 蓝、图绿）。 */
  color: string;
}

/** 图标名 → 形状 + 颜色。中性 document 兜底 = 灰线稿。 */
export const ICON_VARIANTS: Record<string, FileIconVariant> = {
  audio: { glyph: "audio", color: "var(--color-file-audio)" },
  babel: { glyph: "code", color: "var(--color-file-javascript)" },
  console: { glyph: "code", color: "var(--color-file-console)" },
  css: { glyph: "code", color: "var(--color-file-css)" },
  database: { glyph: "database", color: "var(--color-file-database)" },
  docker: { glyph: "docker", color: "var(--color-file-docker)" },
  document: { glyph: "text", color: "var(--color-file-document)" },
  editorconfig: { glyph: "config", color: "var(--color-file-config-orange)" },
  eslint: { glyph: "code", color: "var(--color-file-eslint)" },
  gemfile: { glyph: "code", color: "var(--color-file-gemfile)" },
  git: { glyph: "git", color: "var(--color-file-git)" },
  go: { glyph: "code", color: "var(--color-file-go)" },
  html: { glyph: "code", color: "var(--color-file-html)" },
  image: { glyph: "image", color: "var(--color-file-image)" },
  java: { glyph: "code", color: "var(--color-file-java)" },
  javascript: { glyph: "code", color: "var(--color-file-javascript)" },
  jest: { glyph: "code", color: "var(--color-file-jest)" },
  json: { glyph: "config", color: "var(--color-file-json)" },
  lock: { glyph: "lock", color: "var(--color-file-document)" },
  makefile: { glyph: "code", color: "var(--color-file-makefile)" },
  markdown: { glyph: "markdown", color: "var(--color-file-markdown)" },
  nodejs_alt: { glyph: "code", color: "var(--color-file-nodejs-alt)" },
  npm: { glyph: "config", color: "var(--color-file-npm)" },
  pdf: { glyph: "text", color: "var(--color-file-pdf)" },
  php: { glyph: "code", color: "var(--color-file-php)" },
  powerpoint: { glyph: "text", color: "var(--color-file-powerpoint)" },
  prettier: { glyph: "code", color: "var(--color-file-prettier)" },
  python: { glyph: "code", color: "var(--color-file-python)" },
  react: { glyph: "code", color: "var(--color-file-react)" },
  react_ts: { glyph: "code", color: "var(--color-file-typescript)" },
  readme: { glyph: "markdown", color: "var(--color-file-markdown)" },
  rust: { glyph: "code", color: "var(--color-file-rust)" },
  settings: { glyph: "config", color: "var(--color-file-document)" },
  snapcraft: { glyph: "code", color: "var(--color-file-snapcraft)" },
  sql: { glyph: "database", color: "var(--color-file-database)" },
  storybook: { glyph: "code", color: "var(--color-file-storybook)" },
  svg: { glyph: "image", color: "var(--color-file-svg)" },
  table: { glyph: "text", color: "var(--color-file-table)" },
  toml: { glyph: "config", color: "var(--color-file-config-orange)" },
  tsconfig: { glyph: "config", color: "var(--color-file-typescript)" },
  typescript: { glyph: "code", color: "var(--color-file-typescript)" },
  vitest: { glyph: "code", color: "var(--color-file-vitest)" },
  word: { glyph: "text", color: "var(--color-file-word)" },
  yaml: { glyph: "config", color: "var(--color-file-config-orange)" },
  yarn: { glyph: "config", color: "var(--color-file-yarn)" },
  video: { glyph: "video", color: "var(--color-file-video)" },
};

/** 图标名（resolveIconName 的返回）→ 形状 + 颜色；未知名回退中性文档。 */
export function fileIconVariantFor(iconName: string): FileIconVariant {
  return ICON_VARIANTS[Object.hasOwn(ICON_VARIANTS, iconName) ? iconName : DEFAULT_FILE_ICON_NAME]!;
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
