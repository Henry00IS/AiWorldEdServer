/**
 * Reports AGENTS.md compliance for src/, tests/ and scripts/.
 *
 * Usage: `bun scripts/audit_agents_compliance.ts [--strict]`. With `--strict`
 * the exit code is 1 when any hard violation is found.
 */
import { auditFindingsEmpty, auditFunctionFindingsCollect } from './audit/audit_function_scan.ts';
import type { AuditFunctionFindings } from './audit/audit_function_rules.ts';
import { auditCategoryLastName, auditSnakeCasePath } from './audit/audit_naming_rules.ts';
import { auditReportFindingRows, auditReportSection } from './audit/audit_report.ts';
import { auditSourceFilesLoad, type AuditSourceFile } from './audit/audit_source_files.ts';

/** Line count above which a file should be split soon. */
export const AUDIT_FILE_LINE_WARN = 800;

/** Hard AGENTS.md file length limit. */
export const AUDIT_FILE_LINE_FAIL = 1000;

/** Every finding of one audit run. */
interface AuditResult {
  readonly files: AuditSourceFile[];
  readonly oversizedFiles: string[];
  readonly largeFiles: string[];
  readonly nonSnakeCasePaths: string[];
  readonly categoryLastPaths: string[];
  readonly functions: AuditFunctionFindings;
}

/**
 * Merges the function findings of every file into one record.
 *
 * @param files Loaded files.
 * @returns Combined findings.
 */
function auditFunctionFindingsMerge(files: readonly AuditSourceFile[]): AuditFunctionFindings {
  const merged = auditFindingsEmpty();
  for (const file of files) {
    const findings = auditFunctionFindingsCollect(file);
    merged.longFunctions.push(...findings.longFunctions);
    merged.undocumentedFunctions.push(...findings.undocumentedFunctions);
    merged.inlineComments.push(...findings.inlineComments);
    merged.nonNullAssertions.push(...findings.nonNullAssertions);
  }
  return merged;
}

/**
 * Formats one file as a size report row.
 *
 * @param file Loaded file.
 * @returns Line count and path separated by a tab.
 */
function auditSizeRow(file: AuditSourceFile): string {
  return `${file.lineCount}\t${file.repositoryPath}`;
}

/**
 * Runs every check over the repository in the current directory.
 *
 * @returns Audit result.
 */
function auditRun(): AuditResult {
  const files = auditSourceFilesLoad(process.cwd());
  const paths = files.map((file) => file.repositoryPath);
  return {
    files,
    oversizedFiles: files.filter((file) => file.lineCount > AUDIT_FILE_LINE_FAIL).map(auditSizeRow),
    largeFiles: files
      .filter((file) => file.lineCount > AUDIT_FILE_LINE_WARN && file.lineCount <= AUDIT_FILE_LINE_FAIL)
      .map(auditSizeRow),
    nonSnakeCasePaths: paths.filter((path) => !auditSnakeCasePath(path)),
    categoryLastPaths: paths.filter(auditCategoryLastName),
    functions: auditFunctionFindingsMerge(files),
  };
}

/**
 * Counts the findings that fail `--strict`.
 *
 * @param result Audit result.
 * @returns Number of hard violations.
 */
function auditHardViolationCount(result: AuditResult): number {
  const functions = result.functions;
  return (
    result.oversizedFiles.length +
    result.nonSnakeCasePaths.length +
    functions.longFunctions.length +
    functions.undocumentedFunctions.length +
    functions.inlineComments.length +
    functions.nonNullAssertions.length
  );
}

/**
 * Prints the summary counts and every non-empty section.
 *
 * @param result Audit result.
 */
function auditPrint(result: AuditResult): void {
  const functions = result.functions;
  console.log('# AGENTS compliance audit');
  console.log(`files: ${result.files.length}, hard violations: ${auditHardViolationCount(result)}`);
  auditReportSection(`Files over ${AUDIT_FILE_LINE_FAIL} lines (hard limit)`, result.oversizedFiles);
  auditReportSection(`Files over ${AUDIT_FILE_LINE_WARN} lines (warning)`, result.largeFiles);
  auditReportSection('Non-snake_case paths', result.nonSnakeCasePaths);
  auditReportSection('Category-last file names (warning)', result.categoryLastPaths);
  auditReportSection('Functions over 20 lines', auditReportFindingRows(functions.longFunctions));
  auditReportSection('Incomplete documentation comments', auditReportFindingRows(functions.undocumentedFunctions));
  auditReportSection('Inline comments', auditReportFindingRows(functions.inlineComments));
  auditReportSection('Non-null assertions', auditReportFindingRows(functions.nonNullAssertions));
}

/** Entry point: prints the audit and fails in strict mode on hard violations. */
function auditMain(): void {
  const result = auditRun();
  auditPrint(result);
  const violations = auditHardViolationCount(result);
  if (process.argv.includes('--strict') && violations > 0) {
    console.error(`\nStrict mode failed with ${violations} hard violation(s).`);
    process.exit(1);
  }
}

auditMain();
