// Reading input documents: raw bytes, the size limit before decoding, and
// strict UTF-8. Shared by `plan` and the live commands.

import * as fs from "node:fs";
import { errorCode } from "./errors";
import { InputError, LIMITS } from "./schema";

export class UsageError extends Error {}

export class NoInputError extends Error {}

// Filesystem failures are a missing input (66); everything about the bytes
// themselves is an input error of that document (65).
export function readBytes(file: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    throw new NoInputError(`${file}: ${errorCode(e) ?? "unreadable"}`);
  }
}

// Strict UTF-8: invalid bytes are refused, never repaired into U+FFFD (a
// repaired document is not the one that was written). ignoreBOM keeps a
// leading BOM in the text, so the strict JSON reader rejects it as before
// instead of the decoder silently dropping it. A literal U+FFFD (valid
// bytes) is an ordinary character.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function decodeUtf8(doc: string, bytes: Buffer): string {
  if (bytes.length > LIMITS.fileBytes)
    throw new InputError(doc, "(file)", `larger than ${LIMITS.fileBytes} bytes`);

  try {
    return UTF8.decode(bytes);
  } catch {
    throw new InputError(doc, "(encoding)", "not valid UTF-8");
  }
}
