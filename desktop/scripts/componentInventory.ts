import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

type FileInventory = { definitions: string[]; targets: string[] };
export type ComponentInventory = Record<string, FileInventory>;
type RecordUse = (file: string, owner: string, target: string) => void;

const renderSlots = new Set([
  "View",
  "Icon",
  "Value",
  "Overview",
  "Panel",
  "Header",
  "Footer",
  "Banner",
  "WorkArea",
  "HeaderAction",
  "BlockingScreen",
]);
const nativePath = (file: string) =>
  relative(resolve("src"), file).replaceAll("\\", "/");

export function inventorySource(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  recordUse?: RecordUse,
): FileInventory {
  const definitions: string[] = [];
  const targets: string[] = [];
  function target(node: ts.Node): string {
    let symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias)
      symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol?.valueDeclaration;
    if (decl && !decl.getSourceFile().isDeclarationFile) {
      const parts = [symbol!.getName()];
      for (let parent = decl.parent; parent; parent = parent.parent) {
        if (
          (ts.isFunctionDeclaration(parent) ||
            ts.isClassDeclaration(parent) ||
            (ts.isVariableDeclaration(parent) &&
              parent.initializer &&
              ts.isArrowFunction(parent.initializer))) &&
          parent.name
        )
          parts.unshift(parent.name.getText(decl.getSourceFile()));
      }
      return nativePath(decl.getSourceFile().fileName) + "#" + parts.join("/");
    }
    return node.getText(source);
  }
  function renders(type: ts.Type, seen = new Set<ts.Type>()): boolean {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.isUnion())
      return type.types.some((member) => renders(member, seen));
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const item = type.getNumberIndexType();
      return !!item && renders(item, seen);
    }
    return !!(
      type.getProperty("props") &&
      type.getProperty("type") &&
      type.getProperty("key")
    );
  }
  function visit(node: ts.Node, scope: string[]) {
    if (recordUse) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName;
        if (!/^[a-z][\w-]*$/.test(tag.getText(source)))
          recordUse(nativePath(source.fileName), scope.join("/"), target(tag));
      } else if (ts.isCallExpression(node) && node.arguments[0]) {
        const callee = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name
          : node.expression;
        let symbol = checker.getSymbolAtLocation(callee);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias)
          symbol = checker.getAliasedSymbol(symbol);
        if (
          symbol?.getName() === "createElement" &&
          symbol.declarations?.some((decl) =>
            /[\\/]@types[\\/]react[\\/]/.test(decl.getSourceFile().fileName),
          ) &&
          !ts.isStringLiteralLike(node.arguments[0])
        )
          recordUse(
            nativePath(source.fileName),
            scope.join("/"),
            target(node.arguments[0]),
          );
      }
    }
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      (ts.isFunctionExpression(node.expression) ||
        ts.isArrowFunction(node.expression)) &&
      checker
        .getTypeAtLocation(node.expression)
        .getCallSignatures()
        .some((s) => renders(s.getReturnType()))
    ) {
      scope = [...scope, node.expression.name?.getText(source) ?? "(returned)"];
      definitions.push(scope.join("/"));
    }
    if (
      ts.isJsxAttribute(node) &&
      !/^[a-z]/.test(node.parent.parent.tagName.getText(source)) &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      const expression = node.initializer.expression;
      const name = node.name.getText(source);
      const inline =
        ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
      if (
        checker
          .getTypeAtLocation(expression)
          .getCallSignatures()
          .some((s) => renders(s.getReturnType()))
      ) {
        const slot = [
          ...scope,
          target(node.parent.parent.tagName) + "@" + name,
        ].join("/");
        targets.push(slot + " → " + (inline ? "(inline)" : target(expression)));
        if (inline) definitions.push(slot);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "register" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      scope = [...scope, node.arguments[0].text];
      const entry = node.arguments[1];
      if (entry && !ts.isObjectLiteralExpression(entry)) {
        const binding = ts.isCallExpression(entry) ? entry.expression : entry;
        targets.push(scope.join("/") + " → " + target(binding));
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const result = checker.getTypeAtLocation(node);
      const module = checker.getAwaitedType(result);
      if (
        module?.getProperties().some((symbol) => {
          const type = checker.getTypeOfSymbolAtLocation(symbol, node);
          return type
            .getCallSignatures()
            .some((s) => renders(s.getReturnType()));
        })
      )
        targets.push(
          [...scope, "import"].join("/") + " → " + node.arguments[0].text,
        );
    }
    if (ts.isObjectLiteralExpression(node)) {
      const id = node.properties.find(
        (p) => ts.isPropertyAssignment(p) && p.name.getText(source) === "id",
      );
      if (id && ts.isPropertyAssignment(id))
        scope = [...scope, id.initializer.getText(source)];
    }
    if (
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node)
    ) {
      const name = node.name.getText(source);
      const valueType = checker.getTypeAtLocation(node.name);
      if (
        renderSlots.has(name) ||
        valueType.getCallSignatures().some((s) => renders(s.getReturnType()))
      ) {
        const value = ts.isPropertyAssignment(node)
          ? node.initializer
          : node.name;
        const inline =
          ts.isArrowFunction(value) || ts.isFunctionExpression(value);
        const slot = [...scope, name].join("/");
        targets.push(slot + " → " + (inline ? "(inline)" : target(value)));
        if (inline) definitions.push(slot);
      }
    }
    if (ts.isExportAssignment(node)) {
      const expr = node.expression;
      if (
        (ts.isArrowFunction(expr) ||
          ts.isFunctionExpression(expr) ||
          ts.isCallExpression(expr)) &&
        checker
          .getTypeAtLocation(expr)
          .getCallSignatures()
          .some((s) => renders(s.getReturnType()))
      ) {
        definitions.push([...scope, "default"].join("/"));
        scope = [...scope, "default"];
      }
    }
    if (
      ts.isMethodDeclaration(node) &&
      ts.isObjectLiteralExpression(node.parent) &&
      node.body
    ) {
      const signature = checker.getSignatureFromDeclaration(node);
      if (signature && renders(signature.getReturnType())) {
        const slot = [...scope, node.name.getText(source)].join("/");
        definitions.push(slot);
        targets.push(slot + " → (inline)");
      }
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      (!node.name || ts.isIdentifier(node.name))
    ) {
      const name = node.name?.getText(source) ?? "default";
      const isFactory =
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isCallExpression(node.initializer);
      const body = ts.isFunctionDeclaration(node)
        ? node.body
        : ts.isVariableDeclaration(node)
          ? node.initializer
          : undefined;
      if (body || ts.isClassDeclaration(node)) {
        const type = checker.getTypeAtLocation(node.name ?? node);
        const signatures = type.getCallSignatures();
        const component =
          signatures.some((s) => renders(s.getReturnType())) ||
          (ts.isClassDeclaration(node) && !!type.getProperty("render")) ||
          (/^[A-Z]/.test(name) &&
            signatures.length > 0 &&
            (isFactory ||
              signatures.some(
                (s) => s.getReturnType().flags === ts.TypeFlags.Null,
              )));
        if (
          component &&
          (ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            (body &&
              (ts.isArrowFunction(body) ||
                ts.isFunctionExpression(body) ||
                isFactory)))
        ) {
          definitions.push([...scope, name].join("/"));
        }
      }
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        (body && ts.isArrowFunction(body))
      )
        scope = [...scope, name];
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  }
  visit(source, []);
  return { definitions: definitions.sort(), targets: targets.sort() };
}

export function visitUiSources(
  visit: (source: ts.SourceFile, checker: ts.TypeChecker) => void,
  sourceRoot = resolve("src"),
) {
  const config = ts.parseJsonConfigFileContent(
    ts.parseConfigFileTextToJson(
      "tsconfig.json",
      readFileSync("tsconfig.json", "utf8"),
    ).config,
    ts.sys,
    resolve("."),
    {},
    "tsconfig.json",
  );
  // tsconfig 的文件发现会在同名 .ts 与 .tsx 之间选择一个；控件盘点需要读取两份。
  const rootNames = ts.sys.readDirectory(sourceRoot, [".ts", ".tsx"]);
  const program = ts.createProgram(rootNames, config.options);
  const checker = program.getTypeChecker();
  for (const file of rootNames.sort()) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error("无法扫描生产源文件 " + file);
    if (source.isDeclarationFile) continue;
    visit(source, checker);
  }
}

export function scanComponentInventory(
  recordUse?: RecordUse,
  inspect?: Parameters<typeof visitUiSources>[0],
): ComponentInventory {
  const result: ComponentInventory = {};
  visitUiSources((source, checker) => {
    inspect?.(source, checker);
    const inventory = inventorySource(source, checker, recordUse);
    if (inventory.definitions.length || inventory.targets.length)
      result[nativePath(source.fileName)] = inventory;
  });
  return result;
}
