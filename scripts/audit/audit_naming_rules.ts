/**
 * Path naming checks from AGENTS.md: snake_case segments and category-first
 * file names.
 */

/** Suffixes that suggest a file name places its category last. */
export const AUDIT_CATEGORY_LAST_SUFFIXES = [
  'command',
  'handler',
  'controller',
  'manager',
  'coordinator',
  'error',
  'factory',
  'builder',
  'helpers',
  'utils',
] as const;

/**
 * Returns true when one folder name or file base name is snake_case.
 *
 * @param segment Folder name or file base name.
 * @returns Whether the segment matches snake_case.
 */
export function auditSnakeCaseSegment(segment: string): boolean {
  return /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(segment);
}

/**
 * Strips the `.ts`, `.test.ts` or `.d.ts` extension from a file name.
 *
 * @param fileName File name with extension.
 * @returns File base name.
 */
export function auditFileBaseName(fileName: string): string {
  return fileName.replace(/(?:\.test|\.d)?\.ts$/u, '');
}

/**
 * Returns true when every folder and the file base name of a path are
 * snake_case.
 *
 * @param repositoryPath Repository-relative path.
 * @returns Whether the path complies.
 */
export function auditSnakeCasePath(repositoryPath: string): boolean {
  const segments = repositoryPath.split('/');
  const fileName = segments.pop() ?? '';
  return segments.every(auditSnakeCaseSegment) && auditSnakeCaseSegment(auditFileBaseName(fileName));
}

/**
 * Returns true when a file base name ends with a known category word but starts
 * with neither that kind of word nor its folder name, for example
 * `room_handler` instead of `handler_room` unless the folder is `rooms/`.
 *
 * @param repositoryPath Repository-relative path.
 * @returns Whether the name looks category-last.
 */
export function auditCategoryLastName(repositoryPath: string): boolean {
  const segments = repositoryPath.split('/');
  const words = auditFileBaseName(segments[segments.length - 1] ?? '').split('_');
  const categoryWords = AUDIT_CATEGORY_LAST_SUFFIXES as readonly string[];
  const firstWord = words[0] ?? '';
  const lastWord = words[words.length - 1] ?? '';
  const folderNames = segments.slice(0, -1);
  const startsWithFolder = folderNames.includes(firstWord) || folderNames.includes(`${firstWord}s`);
  const startsWithCategory = categoryWords.includes(firstWord) || startsWithFolder;
  return words.length > 1 && categoryWords.includes(lastWord) && !startsWithCategory;
}
