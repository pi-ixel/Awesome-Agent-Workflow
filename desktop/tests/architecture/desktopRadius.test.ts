import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import ts from "typescript";
import { expect, it } from "vitest";

const themeFile = "shared/styles/radii.css";
const radii = {
  flat: "0px",
  control: "8px",
  popover: "12px",
  panel: "16px",
  pill: "9999px",
};
const roles = Object.keys(radii).join("|");
const radiusUtility = new RegExp(
  `^rounded-(?:(?:[steblr]|[tb][lr]|[se][se])-)?(?:${roles})$`,
);
const token = `var\\(--radius-(?:${roles})\\)`;
const radiusValue = new RegExp(`^(?:inherit|${token})$`);
const clipRadius = new RegExp(`^${token}\\s*\\)`);
const radiusProperty = /^border(?:-[a-z]+)*-radius$/i;
const morphFile = "plugins/project/conversation/ui/useSendMorph.ts";
const workflowMorphFile = "plugins/workflow/ui/flowMotion.ts";

function findRadiusViolations(file: string, source: string) {
  const violations: string[] = [];
  if (!/rounded|radius|Radius|clipPath|clip-path/.test(source))
    return violations;
  const reject = (line: number, value: string) => {
    violations.push(`${file}:${line} ${value}`);
  };

  function checkUtilities(value: string, line: number) {
    const utilities = value.matchAll(
      /(?<![\w-])rounded(?:-(?:\[[^\]]*\]|\([^)]*\)|[\w-]*))?|\[(?:border(?:-[a-z]+)*-radius|--radius-[\w-]+):[^\]]+\]/g,
    );
    for (const [utility] of utilities) {
      if (!radiusUtility.test(utility)) reject(line, utility);
    }
  }

  function checkClip(value: string, line: number) {
    const radius = /\bround\s+(.+)/s.exec(value)?.[1];
    if (radius && !clipRadius.test(radius)) reject(line, value);
  }

  if (file.endsWith(".css")) {
    const css = postcss.parse(source, { from: file });
    css.walkDecls(({ prop, value, source: location }) => {
      const line = location?.start?.line ?? 1;
      if (radiusProperty.test(prop) && !radiusValue.test(value))
        reject(line, `${prop}: ${value}`);
      if (prop.startsWith("--radius-") && file !== themeFile)
        reject(line, `${prop}: ${value}`);
      if (prop === "clip-path") checkClip(value, line);
    });
    css.walkAtRules((rule) => {
      const line = rule.source?.start?.line ?? 1;
      if (rule.name === "apply") checkUtilities(rule.params, line);
      if (rule.name === "utility" && rule.params.startsWith("rounded"))
        reject(line, `@utility ${rule.params}`);
      if (rule.name === "property" && rule.params.startsWith("--radius-"))
        reject(line, `@property ${rule.params}`);
    });
    return violations;
  }

  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node))
      checkUtilities(node.text, line);

    if (ts.isPropertyAssignment(node) || ts.isBinaryExpression(node)) {
      const assignment = ts.isBinaryExpression(node);
      if (
        !assignment ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const key = assignment
          ? node.left.getText(ast).split(".").at(-1)
          : node.name.getText(ast);
        const property = key
          ?.replace(/["']/g, "")
          .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        const expression = assignment ? node.right : node.initializer;
        if (property?.startsWith("--radius-")) reject(line, property);
        const value = ts.isStringLiteralLike(expression)
          ? expression.text
          : expression.getText(ast);
        if (
          property &&
          radiusProperty.test(property) &&
          !radiusValue.test(value)
        ) {
          // 发送变形逐帧插值，终点取自实际消息气泡的共享圆角。
          if (!(
            file === morphFile &&
            property === "border-radius" &&
            value === "`${frame.radius}px`"
          ))
            reject(line, `${property}: ${value}`);
        }
        if (property === "clip-path") {
          // 工作流胶囊以实际高度为圆角上限，卡片终点使用控件变量。
          if (!(
            file === workflowMorphFile &&
            value.endsWith(
              "round min(var(--radius-pill), ${pill.height / 2}px))`",
            )
          ))
            checkClip(value, line);
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "setProperty"
    ) {
      const [property, value] = node.arguments;
      if (
        property &&
        ts.isStringLiteralLike(property) &&
        (property.text.startsWith("--radius-") ||
          (radiusProperty.test(property.text) &&
            !(
              value &&
              ts.isStringLiteralLike(value) &&
              radiusValue.test(value.text)
            )))
      )
        reject(line, node.getText(ast));
    }
    ts.forEachChild(node, visit);
  }

  visit(ast);
  return violations;
}

it("从共享主题声明五档圆角且没有重复定义", () => {
  const tokens: [string, string][] = [];
  const theme = postcss.parse(readFileSync(join("src", themeFile), "utf8"));
  theme.walkDecls(/^--radius-/, (decl) => {
    expect(decl.parent).toMatchObject({
      type: "atrule",
      name: "theme",
      params: "static",
    });
    tokens.push([decl.prop, decl.value]);
  });
  expect(tokens).toEqual(
    Object.entries(radii).map(([role, value]) => [`--radius-${role}`, value]),
  );
});

it("应用内圆角全部使用共享变量，新增文件自动纳入检查", () => {
  const violations = readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(?:css|tsx?)$/.test(file))
    .flatMap((file) =>
      findRadiusViolations(
        file.replaceAll("\\", "/"),
        readFileSync(join("src", file), "utf8"),
      ),
    );
  expect(violations).toEqual([]);
}, 15000);

function nativeRadiusViolations(source: string) {
  return [
    ...source.matchAll(
      /\bborder(?:[A-Z][a-z]*)*Radius\s*=\s*(['"])([^'"\n]*)\1|\bborder(?:-[a-z]+)*-radius\s*:\s*([^;\s'"}]+)/g,
    ),
  ]
    .filter(
      ([, , styleValue, cssValue]) =>
        !radiusValue.test(styleValue ?? cssValue ?? ""),
    )
    .map(([value]) => value);
}

it("站点 WebView 内注入的控件也使用共享圆角", () => {
  const browser = "src-tauri/src/browser";
  const violations = readdirSync(browser, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".rs") && file !== "tests.rs")
    .flatMap((file) =>
      nativeRadiusViolations(readFileSync(join(browser, file), "utf8")).map(
        (value) => `${file} ${value}`,
      ),
    );
  expect(violations).toEqual([]);
  expect(
    nativeRadiusViolations(
      "button.style.borderRadius='4px'; label.style.cssText='border-radius:3px;'",
    ),
  ).toEqual(["borderRadius='4px'", "border-radius:3px"]);
});

it("拦截自定义圆角、动态拼接、CSS 声明和行内覆盖", () => {
  expect(
    findRadiusViolations(
      "example.tsx",
      `
    <div className="hover:rounded-lg! sm:rounded-tl-[7px] [&_button]:[border-radius:3px]" />;
    <div className={\`md:rounded-\${size}\`} />;
    <div style={{ borderStartStartRadius: 4 }} />;
    node.style.borderRadius = "4px";
    node.style.setProperty("border-end-end-radius", "6px");
  `,
    ),
  ).toHaveLength(7);
  expect(
    findRadiusViolations(
      "example.css",
      `
    .popup { @apply rounded-2xl; border-radius: 17px; clip-path: inset(0 round 10px); }
    .panel { border-end-end-radius: var(--radius-lg); --radius-popover: 9px; }
    @utility rounded-overlay { border-radius: var(--radius-popover); }
  `,
    ),
  ).toHaveLength(6);
});

it("允许共享圆角、方向变体和从父表面继承的裁剪圆角", () => {
  expect(
    findRadiusViolations(
      "example.tsx",
      `
    <div className="rounded-panel md:hover:rounded-bl-control!" style={{ borderRadius: "var(--radius-flat)" }} />;
  `,
    ),
  ).toEqual([]);
  expect(
    findRadiusViolations(
      "example.css",
      `
    .menu { @apply rounded-popover; border-top-left-radius: var(--radius-control); }
    .clip { border-radius: inherit; clip-path: inset(0 round var(--radius-panel)); }
  `,
    ),
  ).toEqual([]);
});
