/** Console output for the AGENTS.md compliance audit. */
import type { AuditFinding } from './audit_function_rules.ts';

/** Maximum rows printed per report section. */
export const AUDIT_REPORT_ROW_LIMIT = 60;

/**
 * Prints a titled list of rows, truncated after the row limit.
 *
 * @param title Section title.
 * @param rows Display rows.
 */
export function auditReportSection(title: string, rows: readonly string[]): void {
  if (rows.length === 0) {
    return;
  }
  console.log(`\n## ${title} (${rows.length})`);
  for (const row of rows.slice(0, AUDIT_REPORT_ROW_LIMIT)) {
    console.log(`  ${row}`);
  }
  if (rows.length > AUDIT_REPORT_ROW_LIMIT) {
    console.log(`  … and ${rows.length - AUDIT_REPORT_ROW_LIMIT} more`);
  }
}

/**
 * Formats findings as `path:line detail` rows.
 *
 * @param findings Findings to format.
 * @returns Display rows.
 */
export function auditReportFindingRows(findings: readonly AuditFinding[]): string[] {
  return findings.map((finding) => `${finding.repositoryPath}:${finding.line}\t${finding.detail}`);
}
