/** Walks one parsed file and collects the function-level AGENTS.md findings. */
import ts from 'typescript-compiler-api';
import {
  AUDIT_FUNCTION_LINE_LIMIT,
  auditBlockCodeLineCount,
  auditDocumentationGap,
  auditDocumentationRequired,
  auditFunctionName,
  auditFunctionNodeIs,
  auditGroupingCallbackIs,
  auditLineOf,
  type AuditFunctionFindings,
} from './audit_function_rules.ts';
import type { AuditSourceFile } from './audit_source_files.ts';

/**
 * Parses one audited file into a syntax tree.
 *
 * @param file Loaded file.
 * @returns Parsed source file with parent pointers.
 */
export function auditSourceParse(file: AuditSourceFile): ts.SourceFile {
  return ts.createSourceFile(file.repositoryPath, file.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * Creates an empty findings record.
 *
 * @returns Findings with empty lists.
 */
export function auditFindingsEmpty(): AuditFunctionFindings {
  return { longFunctions: [], undocumentedFunctions: [], inlineComments: [], nonNullAssertions: [] };
}

/**
 * Records length and documentation findings for one function node.
 *
 * @param file Loaded file.
 * @param sourceFile Parsed file.
 * @param node Function-like node.
 * @param findings Findings to append to.
 */
export function auditFunctionInspect(
  file: AuditSourceFile,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  findings: AuditFunctionFindings,
): void {
  if (!auditFunctionNodeIs(node)) {
    return;
  }
  const line = auditLineOf(sourceFile, node.getStart(sourceFile));
  const name = auditFunctionName(node);
  if (node.body && ts.isBlock(node.body) && !auditGroupingCallbackIs(node)) {
    const codeLines = auditBlockCodeLineCount(sourceFile, node.body);
    if (codeLines > AUDIT_FUNCTION_LINE_LIMIT) {
      findings.longFunctions.push({ repositoryPath: file.repositoryPath, line, detail: `${codeLines}\t${name}` });
    }
  }
  const gap = auditDocumentationRequired(node) ? auditDocumentationGap(node) : null;
  if (gap) {
    findings.undocumentedFunctions.push({ repositoryPath: file.repositoryPath, line, detail: `${name}: ${gap}` });
  }
}

/**
 * Lists the leading and trailing comment ranges around one node or token.
 *
 * @param text File content.
 * @param node Node or token.
 * @returns Comment ranges touching the node.
 */
export function auditCommentRangesAround(text: string, node: ts.Node): ts.CommentRange[] {
  const leading = ts.getLeadingCommentRanges(text, node.pos) ?? [];
  const trailing = ts.getTrailingCommentRanges(text, node.end) ?? [];
  return [...leading, ...trailing];
}

/**
 * Records every comment that is not a `/**` documentation comment.
 *
 * @param file Loaded file.
 * @param sourceFile Parsed file.
 * @param findings Findings to append to.
 */
export function auditInlineCommentsCollect(
  file: AuditSourceFile,
  sourceFile: ts.SourceFile,
  findings: AuditFunctionFindings,
): void {
  auditInlineCommentsVisit(file, sourceFile, sourceFile, findings, new Set<number>());
}

/**
 * Records the inline comments around one node and recurses into its tokens.
 *
 * @param file Loaded file.
 * @param sourceFile Parsed file.
 * @param node Node to inspect.
 * @param findings Findings to append to.
 * @param seen Comment start offsets already recorded.
 */
function auditInlineCommentsVisit(
  file: AuditSourceFile,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  findings: AuditFunctionFindings,
  seen: Set<number>,
): void {
  for (const range of auditCommentRangesAround(file.text, node)) {
    const comment = file.text.slice(range.pos, range.end);
    if (seen.has(range.pos) || comment.startsWith('/**')) {
      continue;
    }
    seen.add(range.pos);
    const line = auditLineOf(sourceFile, range.pos);
    findings.inlineComments.push({ repositoryPath: file.repositoryPath, line, detail: comment.split('\n')[0] ?? '' });
  }
  for (const child of node.getChildren(sourceFile)) {
    auditInlineCommentsVisit(file, sourceFile, child, findings, seen);
  }
}

/**
 * Collects every function-level finding of one file.
 *
 * @param file Loaded file.
 * @returns Findings grouped by rule.
 */
export function auditFunctionFindingsCollect(file: AuditSourceFile): AuditFunctionFindings {
  const sourceFile = auditSourceParse(file);
  const findings = auditFindingsEmpty();
  auditNodeVisit(file, sourceFile, sourceFile, findings);
  auditInlineCommentsCollect(file, sourceFile, findings);
  return findings;
}

/**
 * Inspects one node for function and non-null assertion findings and recurses
 * into its children.
 *
 * @param file Loaded file.
 * @param sourceFile Parsed file.
 * @param node Node to inspect.
 * @param findings Findings to append to.
 */
function auditNodeVisit(
  file: AuditSourceFile,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  findings: AuditFunctionFindings,
): void {
  auditFunctionInspect(file, sourceFile, node, findings);
  if (ts.isNonNullExpression(node)) {
    const line = auditLineOf(sourceFile, node.getStart(sourceFile));
    findings.nonNullAssertions.push({ repositoryPath: file.repositoryPath, line, detail: node.getText(sourceFile) });
  }
  ts.forEachChild(node, (child) => auditNodeVisit(file, sourceFile, child, findings));
}
