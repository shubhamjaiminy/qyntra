/**
 * Minimal zip reader for Playwright trace archives.
 *
 * Traces are plain zip files of NDJSON event logs. Node ships inflate
 * but not zip parsing, and a dependency is a poor trade for ~80 lines:
 * Qyntra installs into customer repositories, where every transitive
 * package is one more thing their security review has to approve.
 *
 * Supports what Playwright writes: stored and deflated entries, no
 * encryption, no zip64. Anything else is skipped, never guessed at.
 */

import zlib from 'zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Refuse to inflate anything larger; a trace event log never is. */
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

/**
 * Read the entries whose names pass `include`, as UTF-8 text.
 * Returns an empty map for anything that is not a readable zip.
 */
export function readZipTextEntries(
  archive: Buffer,
  include: (name: string) => boolean
): Map<string, string> {
  const entries = new Map<string, string>();

  const eocd = findEndOfCentralDirectory(archive);

  if (eocd < 0) {
    return entries;
  }

  const entryCount = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);

  for (let index = 0; index < entryCount; index++) {
    if (
      offset + 46 > archive.length ||
      archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY
    ) {
      break;
    }

    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);

    const name = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf-8');

    offset += 46 + nameLength + extraLength + commentLength;

    if (!include(name) || uncompressedSize > MAX_ENTRY_BYTES) {
      continue;
    }

    const data = readEntryData(
      archive,
      localHeaderOffset,
      method,
      compressedSize
    );

    if (data !== undefined) {
      entries.set(name, data.toString('utf-8'));
    }
  }

  return entries;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  // The record is 22 bytes plus an optional comment of up to 64 KiB.
  const earliest = Math.max(0, archive.length - 22 - 0xffff);

  for (let offset = archive.length - 22; offset >= earliest; offset--) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }

  return -1;
}

function readEntryData(
  archive: Buffer,
  localHeaderOffset: number,
  method: number,
  compressedSize: number
): Buffer | undefined {
  if (
    localHeaderOffset + 30 > archive.length ||
    archive.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER
  ) {
    return undefined;
  }

  // Local name and extra lengths can differ from the central copy.
  const start =
    localHeaderOffset +
    30 +
    archive.readUInt16LE(localHeaderOffset + 26) +
    archive.readUInt16LE(localHeaderOffset + 28);

  const raw = archive.subarray(start, start + compressedSize);

  try {
    if (method === METHOD_STORED) {
      return raw;
    }

    if (method === METHOD_DEFLATE) {
      return zlib.inflateRawSync(raw, {
        maxOutputLength: MAX_ENTRY_BYTES,
      });
    }
  } catch {
    // A corrupt entry is skipped; the rest of the trace is still useful.
  }

  return undefined;
}
