import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 32 * 1024;
const EXPECTED_KEYS = [
  'acceptedSchemaVersions',
  'contractVersion',
  'kind',
  'license',
];
const PLACEHOLDER_LICENSE =
  /^(?:tbd|todo|unknown|none|n\/a|open question\b)/i;

function invalid() {
  throw new Error('The dataset compatibility manifest is invalid.');
}

export function validateManifestText(contents) {
  if (
    typeof contents !== 'string' ||
    Buffer.byteLength(contents, 'utf8') > MAX_BYTES
  ) {
    invalid();
  }
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    invalid();
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(EXPECTED_KEYS) ||
    value.kind !== 'mosga-community-data' ||
    value.contractVersion !== 1 ||
    !Array.isArray(value.acceptedSchemaVersions) ||
    value.acceptedSchemaVersions.length < 1 ||
    value.acceptedSchemaVersions.length > 100 ||
    value.acceptedSchemaVersions.some(
      (schema) =>
        typeof schema !== 'string' ||
        schema.length < 1 ||
        schema.length > 100,
    ) ||
    new Set(value.acceptedSchemaVersions).size !==
      value.acceptedSchemaVersions.length ||
    typeof value.license !== 'string' ||
    value.license.length < 1 ||
    value.license.length > 200 ||
    value.license.trim() !== value.license ||
    PLACEHOLDER_LICENSE.test(value.license)
  ) {
    invalid();
  }
  return {
    kind: value.kind,
    contractVersion: value.contractVersion,
    acceptedSchemaVersions: [...value.acceptedSchemaVersions],
    license: value.license,
  };
}

export async function validateManifestFile(filePath) {
  let contents;
  try {
    contents = await fs.readFile(filePath, 'utf8');
  } catch {
    invalid();
  }
  return validateManifestText(contents);
}

async function main() {
  const manifestPath = path.resolve(
    process.argv[2] ?? '.mosga-dataset.json',
  );
  await validateManifestFile(manifestPath);
  process.stdout.write('Dataset compatibility manifest is valid.\n');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch(() => {
    process.stderr.write('Dataset compatibility manifest validation failed.\n');
    process.exitCode = 1;
  });
}
