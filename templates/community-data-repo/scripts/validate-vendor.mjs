import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXPECTED_ARCHIVES = [
  'mosga-contracts-0.1.0.tgz',
  'mosga-publisher-0.1.0.tgz',
  'mosga-sanitizer-0.1.0.tgz',
  'mosga-session-readers-0.1.0.tgz',
];

const WINDOWS_USERS_ROOT = '/users/';
const KNOWN_PRIVATE_WORKSPACE = [
  'ai/chatai/agents/vibecodingprojects',
  'make-deepseek-great-again-github-publication',
];

function normalizeTextualPathSeparators(contents) {
  return contents.replace(/[\\/]+/g, '/');
}

function isAsciiLetter(character) {
  return (
    character !== undefined &&
    ((character >= 'A' && character <= 'Z') ||
      (character >= 'a' && character <= 'z'))
  );
}

function findAsciiUsersRoot(contents, searchFrom) {
  for (
    let index = searchFrom;
    index <= contents.length - WINDOWS_USERS_ROOT.length;
    index += 1
  ) {
    let matches = true;
    for (let offset = 0; offset < WINDOWS_USERS_ROOT.length; offset += 1) {
      const expected = WINDOWS_USERS_ROOT[offset];
      const actual = contents[index + offset];
      if (actual !== expected && actual !== expected.toUpperCase()) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
}

function hasUnicodeWordImmediatelyBefore(contents, index) {
  if (index <= 0) return false;
  const low = contents.charCodeAt(index - 1);
  const start =
    low >= 0xdc00 &&
    low <= 0xdfff &&
    index >= 2 &&
    contents.charCodeAt(index - 2) >= 0xd800 &&
    contents.charCodeAt(index - 2) <= 0xdbff
      ? index - 2
      : index - 1;
  return /[\p{L}\p{N}_]/u.test(contents.slice(start, index));
}

function containsBoundedWindowsUsersRoot(contents) {
  let searchFrom = 0;

  while (searchFrom < contents.length) {
    const usersRoot = findAsciiUsersRoot(contents, searchFrom);
    if (usersRoot < 0) return false;
    searchFrom = usersRoot + WINDOWS_USERS_ROOT.length;

    const driveIndex = usersRoot - 2;
    if (
      driveIndex >= 0 &&
      contents[driveIndex + 1] === ':' &&
      isAsciiLetter(contents[driveIndex]) &&
      !hasUnicodeWordImmediatelyBefore(contents, driveIndex)
    ) {
      return true;
    }
  }

  return false;
}

function invalid() {
  throw new Error('A vendored engine archive contains a private machine path.');
}

export function assertPortableArchiveContents(contents) {
  if (typeof contents !== 'string' || contents.includes('\0')) {
    invalid();
  }

  const normalized = normalizeTextualPathSeparators(contents);
  const lower = normalized.toLowerCase();
  if (
    containsBoundedWindowsUsersRoot(normalized) ||
    KNOWN_PRIVATE_WORKSPACE.some((workspace) => lower.includes(workspace))
  ) {
    invalid();
  }
}

function archiveEntries(archive) {
  const tar = gunzipSync(archive);
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header
      .subarray(0, 100)
      .toString('utf8')
      .replace(/\0.*$/s, '');
    const sizeText = header
      .subarray(124, 136)
      .toString('ascii')
      .replace(/\0.*$/s, '')
      .trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) invalid();
    const start = offset + 512;
    const end = start + size;
    if (end > tar.length) invalid();
    entries.push({ name, contents: tar.subarray(start, end) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export async function validateVendorArchives(
  vendorDirectory = fileURLToPath(new URL('../vendor/', import.meta.url)),
) {
  const names = (await fs.readdir(vendorDirectory))
    .filter((name) => name.endsWith('.tgz'))
    .sort();
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_ARCHIVES)) invalid();

  for (const name of names) {
    const archive = await fs.readFile(path.join(vendorDirectory, name));
    for (const entry of archiveEntries(archive)) {
      if (entry.contents.includes(0)) invalid();
      assertPortableArchiveContents(entry.contents.toString('utf8'));
    }
  }
}

async function main() {
  await validateVendorArchives();
  process.stdout.write('Vendored engine archives contain no private machine paths.\n');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch(() => {
    process.stderr.write('Vendored engine archive validation failed.\n');
    process.exitCode = 1;
  });
}
