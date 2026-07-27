import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  validateManifestFile,
  validateManifestText,
} from '../scripts/validate-manifest.mjs';
import { assertPortableArchiveContents } from '../scripts/validate-vendor.mjs';

const valid = {
  kind: 'mosga-community-data',
  contractVersion: 1,
  acceptedSchemaVersions: ['0.1.0'],
  license: 'CC-BY-4.0',
};

test('accepts the committed manifest contract', () => {
  assert.deepEqual(validateManifestText(JSON.stringify(valid)), valid);
});

test('rejects a missing manifest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mosga-manifest-'));
  try {
    await assert.rejects(validateManifestFile(path.join(root, 'missing.json')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects malformed, unsupported, duplicate, empty, and placeholder values', () => {
  const fixtures = [
    '{',
    JSON.stringify({ ...valid, kind: 'other' }),
    JSON.stringify({ ...valid, contractVersion: 2 }),
    JSON.stringify({
      ...valid,
      acceptedSchemaVersions: ['0.1.0', '0.1.0'],
    }),
    JSON.stringify({ ...valid, acceptedSchemaVersions: [] }),
    JSON.stringify({ ...valid, license: 'TBD' }),
    JSON.stringify({ ...valid, extra: true }),
  ];
  for (const fixture of fixtures) {
    assert.throws(() => validateManifestText(fixture));
  }
});

test('vendor archive scan rejects real Windows users and private workspace roots', () => {
  const portableExamples = [
    String.raw`Example: %USERPROFILE%\AppData\Roaming\mosga`,
    String.raw`Example: %USERPROFILE%`,
    JSON.stringify(String.raw`%USERPROFILE%\AppData\Roaming\mosga`),
    'Set the cache under %USERPROFILE%.',
    String.raw`C:\User\ActualDeveloper\AppData`,
    String.raw`C:\Users`,
    '/Users/ActualDeveloper/AppData',
    'Ordinary text about Windows Users and developer workspaces.',
  ];
  for (const contents of portableExamples) {
    assert.doesNotThrow(() => assertPortableArchiveContents(contents));
  }

  const privateExamples = [
    String.raw`C:\Users\ActualDeveloper\AppData\Roaming\mosga`,
    String.raw`C:\Users\ActualDeveloper`,
    'C:/Users/ActualDeveloper/AppData/Roaming/mosga',
    String.raw`C:\\Users/ActualDeveloper\\AppData`,
    JSON.stringify({
      home: String.raw`C:\Users\ActualDeveloper\AppData\Roaming`,
    }),
    String.raw`C:\Users\ExampleUser\AppData`,
    String.raw`C:\Users\ExampleUser2\AppData`,
    'C:\\Users\\',
    String.raw`E:\AI\ChatAI\Agents\VibeCodingProjects\project`,
    'E:/AI/ChatAI/Agents/VibeCodingProjects/project',
    'make-deepseek-great-again-github-publication',
  ];
  for (const contents of privateExamples) {
    assert.throws(() => assertPortableArchiveContents(contents));
  }
});

test('vendor archive scan rejects every bounded drive-rooted Users occurrence', () => {
  const separators = [
    '\\',
    '\\\\',
    '/',
    '//',
    '\\/',
    '/\\',
    '\\\\//',
    '/\\\\/',
  ];
  const profileSuffixes = [
    '',
    String.raw`\AppData`,
    '/AppData',
    '"',
    "'",
    '`',
    ' ',
    '\t',
    '\n',
    ',',
    '.',
    ':',
    ';',
    ']',
    '}',
    ')',
  ];
  const profiles = [
    'ActualDeveloper',
    'ExampleUser',
    'ExampleUser2',
    'ExampleUser.evil',
    'exampleuser',
    'ExampleUser evil',
    "ExampleUser'evil",
    'ExampleUser`evil',
    'ExampleUser,evil',
    'ExampleUser;evil',
    'ExampleUser]evil',
    'ExampleUser}evil',
    'ExampleUser)evil',
    'ExampleUser. evil',
  ];

  for (const drive of ['C', 'c', 'Z']) {
    for (const users of ['Users', 'users', 'USERS']) {
      for (const separator of separators) {
        const root = `${drive}:${separator}${users}${separator}`;
        for (const profile of profiles) {
          for (const suffix of profileSuffixes) {
            assert.throws(
              () =>
                assertPortableArchiveContents(
                  `prefix ${root}${profile}${suffix}`,
                ),
              `${root}${profile}${JSON.stringify(suffix)}`,
            );
          }
        }
      }
    }
  }

  for (const contents of [
    JSON.stringify(String.raw`C:\Users\ActualDeveloper`),
    JSON.stringify({ home: String.raw`C:\Users\ActualDeveloper` }),
    String.raw`const home = "C:\\Users\\ActualDeveloper";`,
    String.raw`C:\Users\ExampleUser C:\Users\ActualDeveloper`,
    '\u0130 prefix C:/Users/ActualDeveloper',
    '\ufeffC:/Users/ActualDeveloper',
    String.raw`C:\Users\First C:\Users\Second`,
  ]) {
    assert.throws(() => assertPortableArchiveContents(contents), contents);
  }

  for (const contents of [
    String.raw`%USERPROFILE%\AppData\Roaming\@waifuoid\elftia\clawia`,
    '%USERPROFILE%',
    JSON.stringify(String.raw`%USERPROFILE%\AppData`),
    JSON.stringify({ home: String.raw`%USERPROFILE%\AppData` }),
    String.raw`const home = "%USERPROFILE%\\AppData";`,
    'Use %USERPROFILE% in prose.',
    String.raw`C:\User\ActualDeveloper`,
    String.raw`C:\Users`,
    String.raw`\Users\ActualDeveloper`,
    '/Users/ActualDeveloper',
    'Users/ActualDeveloper',
    'prefixC:/Users/ActualDeveloper',
    'ordinary text mentioning C: and Users but no rooted profile',
  ]) {
    assert.doesNotThrow(() => assertPortableArchiveContents(contents), contents);
  }
});

test('vendor archive scan rejects NUL in every representation', () => {
  const utf16le = Buffer.from(
    String.raw`C:\Users\ActualDeveloper\AppData`,
    'utf16le',
  ).toString('utf8');
  const utf16leWithBom = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(String.raw`C:\Users\ActualDeveloper\AppData`, 'utf16le'),
  ]).toString('utf8');

  for (const contents of [
    '\0',
    'ordinary\0text',
    'ordinary text\0',
    utf16le,
    utf16leWithBom,
  ]) {
    assert.throws(() => assertPortableArchiveContents(contents));
  }

  for (const contents of [
    '',
    '\ufeffordinary NUL-free text',
    '\ufeff%USERPROFILE%\\AppData',
  ]) {
    assert.doesNotThrow(() => assertPortableArchiveContents(contents));
  }
});
