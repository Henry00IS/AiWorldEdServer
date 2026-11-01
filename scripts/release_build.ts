/**
 * Builds standalone relay executables for every release platform into
 * dist/release, plus a SHA-256 checksum file. Usage: `bun run build:release`.
 * Each executable embeds the pinned Bun runtime, so the target machine needs
 * nothing else installed.
 */
import { $ } from 'bun';

/** Bun compile targets and the file name suffix of each output. */
export const RELEASE_TARGETS: readonly (readonly [target: string, suffix: string])[] = [
  ['bun-linux-x64', 'linux-x64'],
  ['bun-linux-arm64', 'linux-arm64'],
  ['bun-darwin-x64', 'macos-x64'],
  ['bun-darwin-arm64', 'macos-arm64'],
  ['bun-windows-x64', 'windows-x64.exe'],
];

/** Output directory of the release files. */
const RELEASE_DIRECTORY = 'dist/release';

/**
 * Compiles one executable.
 *
 * @param target Bun compile target.
 * @param suffix Output file name suffix.
 * @returns Output file name inside the release directory.
 */
async function releaseBuildTarget(target: string, suffix: string): Promise<string> {
  const name = `aiworlded-relay-${suffix}`;
  await $`bun build src/main.ts --compile --minify --target=${target} --outfile ${RELEASE_DIRECTORY}/${name}`.quiet();
  console.log(`built ${RELEASE_DIRECTORY}/${name}`);
  return name;
}

/**
 * Refuses to build with a Bun other than the pinned one, because every
 * executable embeds the runtime that built it.
 *
 * @returns Promise settled when the version matches.
 */
async function releaseBunVersionCheck(): Promise<void> {
  const manifest = (await Bun.file('package.json').json()) as { packageManager?: string };
  const pinned = manifest.packageManager?.replace(/^bun@/, '') ?? '';
  if (pinned === Bun.version) return;
  throw new Error(`Bun ${Bun.version} is running but package.json pins bun@${pinned}; install that version first`);
}

/**
 * Builds every target one after another and writes SHA256SUMS.
 *
 * @returns Promise settled when every file is written.
 */
async function releaseBuild(): Promise<void> {
  await releaseBunVersionCheck();
  await $`rm -rf ${RELEASE_DIRECTORY}`;
  const names: string[] = [];
  for (const [target, suffix] of RELEASE_TARGETS) names.push(await releaseBuildTarget(target, suffix));
  await $`sha256sum ${names}`
    .cwd(RELEASE_DIRECTORY)
    .quiet()
    .then((result) => Bun.write(`${RELEASE_DIRECTORY}/SHA256SUMS`, result.stdout));
  console.log(`wrote ${RELEASE_DIRECTORY}/SHA256SUMS`);
}

if (import.meta.main) await releaseBuild();
