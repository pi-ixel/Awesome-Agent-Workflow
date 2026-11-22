import ts from "typescript";

const selectionTypes = new Set(["checkbox", "radio"]);
const styles = new Set([
  "fieldSurfaceClass",
  "embeddedFieldClass",
  "composerFieldClass",
  "settingsInputClass",
  "settingsNumberInputClass",
  "settingsTextareaClass",
]);

function isEditable(value: ts.Expression | undefined): boolean {
  if (!value) return true;
  if (
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  )
    return false;
  if (ts.isIdentifier(value) && value.text === "undefined") return false;
  return (
    !ts.isStringLiteralLike(value) || !["false", "inherit"].includes(value.text)
  );
}

export function inspectTextFields(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
) {
  const fields: { location: string; approved: boolean; styles: string[] }[] =
    [];
  function approvedStyles(node: ts.Expression, seen: Set<ts.Symbol>): string[] {
    if (ts.isTemplateExpression(node))
      return node.templateSpans.flatMap((span) =>
        approvedStyles(span.expression, new Set(seen)),
      );
    if (ts.isConditionalExpression(node)) {
      const whenTrue = approvedStyles(node.whenTrue, new Set(seen));
      const whenFalse = approvedStyles(node.whenFalse, new Set(seen));
      return whenTrue.length && whenFalse.length
        ? [...whenTrue, ...whenFalse]
        : [];
    }
    if (ts.isParenthesizedExpression(node))
      return approvedStyles(node.expression, seen);
    if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node))
      return [];
    let symbol = checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(node) ? node.name : node,
    );
    if (symbol && symbol.flags & ts.SymbolFlags.Alias)
      symbol = checker.getAliasedSymbol(symbol);
    if (!symbol || seen.has(symbol)) return [];
    seen.add(symbol);
    const declaration = symbol.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration)) return [];
    if (
      declaration
        .getSourceFile()
        .fileName.replaceAll("\\", "/")
        .endsWith("/src/shared/ui/inputStyles.ts")
    )
      return styles.has(symbol.getName()) ? [symbol.getName()] : [];
    return declaration.initializer
      ? approvedStyles(declaration.initializer, seen)
      : [];
  }
  function record(node: ts.Node, type?: ts.Expression, style?: ts.Expression) {
    if (type && ts.isStringLiteralLike(type) && selectionTypes.has(type.text))
      return;
    const matchedStyles = style
      ? [...new Set(approvedStyles(style, new Set()))].sort()
      : [];
    fields.push({
      location:
        source.fileName +
        ":" +
        (source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1),
      approved: matchedStyles.length > 0,
      styles: matchedStyles,
    });
  }
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const find = (name: string) =>
        attributes.find((attr) => attr.name.getText(source) === name);
      const editable = find("contentEditable");
      const value = editable?.initializer;
      if (
        editable &&
        isEditable(
          value && ts.isJsxExpression(value) ? value.expression : value,
        )
      ) {
        record(node);
      } else if (["input", "textarea"].includes(node.tagName.getText(source))) {
        const type = find("type")?.initializer;
        const style = find("className")?.initializer;
        record(
          node,
          type && ts.isJsxExpression(type) ? type.expression : type,
          style && ts.isJsxExpression(style) ? style.expression : undefined,
        );
      }
    } else if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const fn = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name
        : node.expression;
      let symbol = checker.getSymbolAtLocation(fn);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias)
        symbol = checker.getAliasedSymbol(symbol);
      if (symbol?.getName() === "createElement") {
        const props = node.arguments[1];
        const prop = (key: string) => {
          if (!props || !ts.isObjectLiteralExpression(props)) return undefined;
          for (const assignment of props.properties) {
            if (
              ts.isShorthandPropertyAssignment(assignment) &&
              assignment.name.text === key
            )
              return assignment.name;
            if (
              ts.isPropertyAssignment(assignment) &&
              (ts.isIdentifier(assignment.name) ||
                ts.isStringLiteralLike(assignment.name)) &&
              assignment.name.text === key
            )
              return assignment.initializer;
          }
          return undefined;
        };
        const editability = prop("contentEditable");
        if (editability && isEditable(editability)) record(node);
        else if (["input", "textarea"].includes(node.arguments[0].text))
          record(node, prop("type"), prop("className"));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return fields;
}
