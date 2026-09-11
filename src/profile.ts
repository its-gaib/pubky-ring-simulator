import {
  PubkyAppFile,
  PubkyAppUser,
  blobUriBuilder,
  fileUriBuilder,
  parse_uri,
  userUriBuilder,
} from "pubky-app-specs";
import { ENVIRONMENTS, type EnvironmentId } from "./pubky.js";

export interface IdentityProfile {
  name?: string;
  avatar?: Blob;
}

const MAX_JSON_BYTES = 16 * 1024;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const PROFILE_TIMEOUT_MS = 8_000;
const MAX_IMAGE_AXIS = 8_192;
const MAX_IMAGE_PIXELS = 16_000_000;
const RASTER_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const FILE_ID = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{13}$/;
const BLOB_ID = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/** Public display metadata for an identity whose registration was verified. */
export async function loadIdentityProfile(
  publicKey: string,
  environment: EnvironmentId,
  signal: AbortSignal,
): Promise<IdentityProfile> {
  if (
    signal.aborted ||
    (environment !== "staging" && environment !== "production")
  )
    return {};

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, PROFILE_TIMEOUT_MS);
  const result: IdentityProfile = {};

  try {
    // SDK public keys have a five-character prefix; specs validates the bare
    // identity when building and parsing its canonical profile URI.
    const bareKey =
      publicKey.length === 57 && publicKey.startsWith("pubky")
        ? publicKey.slice(5)
        : publicKey;
    const profileUri = userUriBuilder(bareKey);
    const parsed = parse_uri(profileUri);
    let owner: string;
    try {
      owner = parsed.user_id;
      if (parsed.resource !== "profile.json" || owner !== bareKey) return {};
    } finally {
      parsed.free();
    }

    const origin = ENVIRONMENTS[environment].homeserverUrl;
    const raw = await readJson(
      publicResourceUrl(origin, profileUri, owner),
      controller.signal,
    );
    if (!isRecord(raw)) return {};

    // Validate the two display fields independently. A missing/bad name must
    // not suppress a valid picture, and a bad picture must not suppress a name.
    if (typeof raw.name === "string") {
      let user: PubkyAppUser | undefined;
      try {
        user = PubkyAppUser.fromJson({ name: raw.name });
        result.name = user.name;
      } catch {
        // Keep the numbered identity name.
      } finally {
        user?.free();
      }
    }

    if (typeof raw.image === "string" && raw.image) {
      let user: PubkyAppUser | undefined;
      try {
        // This fixed name only validates the independent image projection.
        user = PubkyAppUser.fromJson({ name: "Identity", image: raw.image });
        const imageUri = user.image;
        if (imageUri) {
          if (imageUri !== raw.image)
            throw new Error("Noncanonical profile image reference.");
          const fileUri = ownResourceUri(imageUri, owner, "files");
          result.avatar = await readAvatar(
            origin,
            fileUri,
            owner,
            controller.signal,
          );
        }
      } catch {
        // Keep the generated avatar without discarding a valid display name.
      } finally {
        user?.free();
      }
    }
  } catch {
    // Profile availability never determines whether an identity is imported.
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }

  return signal.aborted ? {} : result;
}

async function readAvatar(
  origin: string,
  fileUri: string,
  owner: string,
  signal: AbortSignal,
): Promise<Blob> {
  const raw = await readJson(publicResourceUrl(origin, fileUri, owner), signal);
  let file: PubkyAppFile | undefined;
  let blobUri: string;
  let mime: string;
  let size: number;
  try {
    file = PubkyAppFile.fromJson(raw);
    if (!isRecord(raw) || raw.src !== file.src)
      throw new Error("Noncanonical avatar blob reference.");
    mime = file.content_type;
    size = file.size;
    if (
      !RASTER_TYPES.has(mime) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_AVATAR_BYTES
    ) {
      throw new Error("Unsupported avatar.");
    }
    blobUri = ownResourceUri(file.src, owner, "blobs");
  } finally {
    file?.free();
  }

  const response = await publicFetch(
    publicResourceUrl(origin, blobUri, owner),
    signal,
  );
  const responseMime = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  // Uploaded blob bytes may be served as octet-stream; the separately
  // validated file metadata supplies their MIME type.
  if (
    responseMime &&
    responseMime !== "application/octet-stream" &&
    responseMime !== mime
  ) {
    await response.body?.cancel();
    throw new Error("Unsupported avatar response.");
  }
  const bytes = await readBoundedBytes(response, MAX_AVATAR_BYTES, signal);
  if (bytes.byteLength !== size || !matchesRaster(bytes, mime))
    throw new Error("Invalid avatar bytes.");
  return new Blob([bytes], { type: mime });
}

function ownResourceUri(
  uri: string,
  owner: string,
  kind: "files" | "blobs",
): string {
  const parsed = parse_uri(uri);
  try {
    const id = parsed.resource_id;
    if (
      parsed.user_id !== owner ||
      parsed.resource !== kind ||
      !id ||
      !(kind === "files" ? FILE_ID : BLOB_ID).test(id)
    ) {
      throw new Error("Unsupported profile image reference.");
    }
    const canonical =
      kind === "files" ? fileUriBuilder(owner, id) : blobUriBuilder(owner, id);
    // The specs parser alone tolerates extra segments, queries, and fragments.
    if (uri !== canonical)
      throw new Error("Noncanonical profile image reference.");
    return canonical;
  } finally {
    parsed.free();
  }
}

function publicResourceUrl(origin: string, uri: string, owner: string): string {
  const url = new URL(new URL(uri).pathname, origin);
  url.searchParams.set("pubky-host", owner);
  return url.href;
}

async function publicFetch(
  url: string,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  const response = await fetch(url, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Public profile unavailable.");
  }
  return response;
}

async function readJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await publicFetch(url, signal);
  const bytes = await readBoundedBytes(response, MAX_JSON_BYTES, signal);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function readBoundedBytes(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel();
    throw new Error("Public profile response too large.");
  }
  if (!response.body) throw new Error("Empty public profile response.");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let lengthRead = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      lengthRead += value.byteLength;
      if (lengthRead > limit) {
        await reader.cancel();
        throw new Error("Public profile response too large.");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(lengthRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function matchesRaster(bytes: Uint8Array, mime: string): boolean {
  const startsWith = (signature: number[]) =>
    signature.every((value, index) => bytes[index] === value);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png")
    return (
      bytes.length >= 33 &&
      startsWith([137, 80, 78, 71, 13, 10, 26, 10]) &&
      view.getUint32(8) === 13 &&
      chunkName(bytes, 12) === "IHDR" &&
      boundedDimensions(view.getUint32(16), view.getUint32(20))
    );
  if (mime === "image/jpeg")
    return startsWith([255, 216, 255]) && boundedJpeg(bytes, view);
  if (mime === "image/gif")
    return (
      bytes.length >= 13 &&
      (startsWith([71, 73, 70, 56, 55, 97]) ||
        startsWith([71, 73, 70, 56, 57, 97])) &&
      boundedDimensions(view.getUint16(6, true), view.getUint16(8, true))
    );
  if (mime === "image/webp") return boundedWebp(bytes, view);
  return false;
}

function boundedDimensions(width: number, height: number): boolean {
  return (
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_AXIS &&
    height <= MAX_IMAGE_AXIS &&
    width * height <= MAX_IMAGE_PIXELS
  );
}

function chunkName(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

function boundedJpeg(bytes: Uint8Array, view: DataView): boolean {
  const frameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++]!;
    if (marker === 0xda || marker === 0xd9 || marker === 0) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (frameMarkers.has(marker)) {
      if (
        length < 8 ||
        bytes[offset + 7] === 0 ||
        length < 8 + 3 * bytes[offset + 7]!
      )
        return false;
      return boundedDimensions(
        view.getUint16(offset + 5),
        view.getUint16(offset + 3),
      );
    }
    offset += length;
  }
  return false;
}

function boundedWebp(bytes: Uint8Array, view: DataView): boolean {
  if (
    bytes.length < 20 ||
    chunkName(bytes, 0) !== "RIFF" ||
    chunkName(bytes, 8) !== "WEBP" ||
    view.getUint32(4, true) + 8 !== bytes.length
  )
    return false;
  const uint24 = (offset: number) =>
    bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
  let canvas: { width: number; height: number } | undefined;

  function chunks(
    start: number,
    end: number,
    frame?: { width: number; height: number },
  ): boolean {
    let hasImage = false;
    let offset = start;
    while (offset < end) {
      if (offset + 8 > end) return false;
      const kind = chunkName(bytes, offset);
      const size = view.getUint32(offset + 4, true);
      const data = offset + 8;
      const next = data + size + (size % 2);
      if (next > end) return false;
      let width: number | undefined;
      let height: number | undefined;
      if (kind === "VP8X") {
        if (frame || size !== 10 || canvas) return false;
        width = uint24(data + 4) + 1;
        height = uint24(data + 7) + 1;
        canvas = { width, height };
      } else if (kind === "VP8 ") {
        if (
          size < 10 ||
          (bytes[data]! & 1) !== 0 ||
          bytes[data + 3] !== 0x9d ||
          bytes[data + 4] !== 0x01 ||
          bytes[data + 5] !== 0x2a
        )
          return false;
        width = view.getUint16(data + 6, true) & 0x3fff;
        height = view.getUint16(data + 8, true) & 0x3fff;
        hasImage = true;
      } else if (kind === "VP8L") {
        if (size < 5 || bytes[data] !== 0x2f || (bytes[data + 4]! & 0xe0) !== 0)
          return false;
        width = 1 + (bytes[data + 1]! | ((bytes[data + 2]! & 0x3f) << 8));
        height =
          1 +
          ((bytes[data + 2]! >> 6) |
            (bytes[data + 3]! << 2) |
            ((bytes[data + 4]! & 0x0f) << 10));
        hasImage = true;
      } else if (kind === "ANMF") {
        if (frame || !canvas || size < 16) return false;
        const frameWidth = uint24(data + 6) + 1;
        const frameHeight = uint24(data + 9) + 1;
        if (
          !boundedDimensions(frameWidth, frameHeight) ||
          uint24(data) * 2 + frameWidth > canvas.width ||
          uint24(data + 3) * 2 + frameHeight > canvas.height ||
          !chunks(data + 16, data + size, {
            width: frameWidth,
            height: frameHeight,
          })
        )
          return false;
        hasImage = true;
      }
      if (width !== undefined && height !== undefined) {
        if (!boundedDimensions(width, height)) return false;
        const container = frame ?? canvas;
        if (container && (width > container.width || height > container.height))
          return false;
      }
      offset = next;
    }
    return hasImage;
  }

  return chunks(12, bytes.length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
