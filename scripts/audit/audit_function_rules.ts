/**
 * Function-level checks from AGENTS.md: body length, documentation comments,
 * inline comments and non-null assertions.
 */
import ts from 'typescript-compiler-api';

/** Maximum lines of code inside one function body. */
export const AUDIT_FUNCTION_LINE_LIMIT = 20;

/** Call names whose callback arguments only group tests and are not measured. */
export const AUDIT_GROUPING_CALL_NAMES = ['describe'] as const;

/** One rule violation at a source location. */
export interface AuditFinding {
  readonly repositoryPath: string;
  readonly line: number;
  readonly detail: string;
}

/** Findings for one file, grouped by rule. */
export interface AuditFunctionFindings {
  readonly longFunctions: AuditFinding[];
  readonly undocumentedFunctions: AuditFinding[];
  readonly inlineComments: AuditFinding[];
  readonly nonNullAssertions: AuditFinding[];
}

type AuditFunctionNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;

/**
 * Returns true when a node is any kind of function with parameters and a
 * possible body.
 *
 * @param node Syntax node.
 * @returns Whether the node is a function-like declaration or expression.
 */
export function auditFunctionNodeIs(node: ts.Node): node is AuditFunctionNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

/**
 * Returns the one-based line of a source position.
 *
 * @param sourceFile Parsed file.
 * @param position Character offset.
 * @returns One-based line number.
 */
export function auditLineOf(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

/**
 * Counts non-blank lines strictly between the opening and closing brace of a
 * block.
 *
 * @param sourceFile Parsed file.
 * @param body Function body block.
 * @returns Lines of code inside the block.
 */
export function auditBlockCodeLineCount(sourceFile: ts.SourceFile, body: ts.Block): number {
  const firstLine = auditLineOf(sourceFile, body.getStart(sourceFile));
  const lastLine = auditLineOf(sourceFile, body.end);
  const lines = sourceFile.text.split('\n').slice(firstLine, lastLine - 1);
  return lines.filter((line) => line.trim().length > 0).length;
}

/**
 * Returns true when a function is the callback of a grouping call such as
 * `describe`.
 *
 * @param node Function node.
 * @returns Whether the function only groups tests.
 */
export function auditGroupingCallbackIs(node: AuditFunctionNode): boolean {
  const parent = node.parent;
  if (!ts.isCallExpression(parent) || !ts.isIdentifier(parent.expression)) {
    return false;
  }
  return (AUDIT_GROUPING_CALL_NAMES as readonly string[]).includes(parent.expression.text);
}

/**
 * Returns true when a function is a named declaration that needs its own
 * documentation comment: declarations, members and functions bound to a
 * variable or class property.
 *
 * @param node Function node.
 * @returns Whether a documentation comment is required.
 */
export function auditDocumentationRequired(node: AuditFunctionNode): boolean {
  if (!ts.isFunctionExpression(node) && !ts.isArrowFunction(node)) {
    return true;
  }
  return ts.isVariableDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent);
}

/**
 * Returns the node that carries the documentation comment of a function.
 *
 * @param node Function node.
 * @returns Function node, or its variable statement or property.
 */
export function auditDocumentationHost(node: AuditFunctionNode): ts.Node {
  if (ts.isVariableDeclaration(node.parent)) {
    return node.parent.parent.parent;
  }
  return ts.isPropertyDeclaration(node.parent) ? node.parent : node;
}

/**
 * Collects the parameter names documented by `@param` tags.
 *
 * @param doc Documentation comment.
 * @returns Documented parameter names without object path prefixes.
 */
export function auditDocumentedParameterNames(doc: ts.JSDoc): Set<string> {
  const names = new Set<string>();
  for (const tag of doc.tags ?? []) {
    if (ts.isJSDocParameterTag(tag)) {
      names.add(tag.name.getText().replace(/^.*\./u, ''));
    }
  }
  return names;
}

/**
 * Describes what is missing from the documentation comment of a function.
 *
 * @param node Function node.
 * @returns Missing parts, or null when the comment is complete.
 */
export function auditDocumentationGap(node: AuditFunctionNode): string | null {
  const docs = ts.getJSDocCommentsAndTags(auditDocumentationHost(node)).filter(ts.isJSDoc);
  const doc = docs[docs.length - 1];
  if (!doc) {
    return 'missing documentation comment';
  }
  if (!ts.getTextOfJSDocComment(doc.comment)?.trim()) {
    return 'documentation comment has no description';
  }
  const documented = auditDocumentedParameterNames(doc);
  const missing = node.parameters
    .filter((parameter) => ts.isIdentifier(parameter.name) && !documented.has(parameter.name.text))
    .map((parameter) => parameter.name.getText());
  return missing.length > 0 ? `undocumented parameters: ${missing.join(', ')}` : null;
}

/**
 * Returns a readable name for a function node.
 *
 * @param node Function node.
 * @returns Function name or a placeholder.
 */
export function auditFunctionName(node: AuditFunctionNode): string {
  if (ts.isConstructorDeclaration(node)) {
    return 'constructor';
  }
  if (node.name) {
    return node.name.getText();
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) {
    return parent.name.getText();
  }
  return '(anonymous)';
}
