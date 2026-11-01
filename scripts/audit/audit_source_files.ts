/** Collects the TypeScript sources an AGENTS.md compliance audit inspects. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** One TypeScript file loaded for auditing. */
export interface AuditSourceFile {
  readonly absolutePath: string;
  readonly repositoryPath: string;
  readonly text: string;
  readonly lineCount: number;
}

/** Top-level folders whose TypeScript files are audited. */
export const AUDIT_SOURCE_ROOTS = ['src', 'tests', 'scripts'] as const;

/**
 * Walks a directory tree and returns every `.ts` file path below it.
 *
 * @param directory Absolute directory to walk.
 * @returns Absolute paths of TypeScript files.
 */
export function auditTypeScriptPathsCollect(directory: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...auditTypeScriptPathsCollect(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Counts physical lines in a text, treating a trailing newline as the end of
 * the last line.
 *
 * @param text File content.
 * @returns Line count.
 */
export function auditLineCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const lines = text.split(/\r?\n/);
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/**
 * Converts an absolute path to a repository-relative posix path.
 *
 * @param repositoryRoot Absolute repository root.
 * @param absolutePath Absolute file path.
 * @returns Repository-relative path using forward slashes.
 */
export function auditRepositoryPath(repositoryRoot: string, absolutePath: string): string {
  return relative(repositoryRoot, absolutePath).split(sep).join('/');
}

/**
 * Loads every audited TypeScript file below the configured roots.
 *
 * @param repositoryRoot Absolute repository root.
 * @returns Loaded files sorted by repository path.
 */
export function auditSourceFilesLoad(repositoryRoot: string): AuditSourceFile[] {
  const files: AuditSourceFile[] = [];
  for (const root of AUDIT_SOURCE_ROOTS) {
    const rootPath = join(repositoryRoot, root);
    if (!statSync(rootPath, { throwIfNoEntry: false })?.isDirectory()) {
      continue;
    }
    for (const absolutePath of auditTypeScriptPathsCollect(rootPath)) {
      const text = readFileSync(absolutePath, 'utf8');
      const repositoryPath = auditRepositoryPath(repositoryRoot, absolutePath);
      files.push({ absolutePath, repositoryPath, text, lineCount: auditLineCount(text) });
    }
  }
  return files.sort((left, right) => left.repositoryPath.localeCompare(right.repositoryPath));
}
