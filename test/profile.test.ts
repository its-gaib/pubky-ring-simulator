import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { ENVIRONMENTS, type EnvironmentId } from "../src/pubky.js";
import { loadIdentityProfile } from "../src/profile.js";

const OWNER = "5jsjx1o6fzu6aeeo697r3i5rx15zq41kikcye8wtwdqm4nb4tryo";
const OTHER_OWNER = "ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy";
const FILE_ID = "0034A0X7NJ52C";
const BLOB_ID = "PZBQ010FF079VVZPQG1RNFN6DR";
const FILE_URI = `pubky://${OWNER}/pub/pubky.app/files/${FILE_ID}`;
const BLOB_URI = `pubky://${OWNER}/pub/pubky.app/blobs/${BLOB_ID}`;
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jlp8AAAAASUVORK5CYII=",
    "base64",
  ),
);

function signal() {
  return new AbortController().signal;
}
function json(value: unknown, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
  });
}
function file(overrides: Record<string, unknown> = {}) {
  return {
    name: "avatar.png",
    created_at: 1777000000000000,
    src: BLOB_URI,
    content_type: "image/png",
    size: PNG.byteLength,
    ...overrides,
  };
}
function image(
  headers: HeadersInit = { "content-type": "application/octet-stream" },
) {
  return new Response(PNG, { headers });
}

interface RequestRecord {
  url: URL;
  options: RequestInit;
}
function mockFetch(
  t: TestContext,
  handler: (
    request: RequestRecord,
    index: number,
  ) => Response | Promise<Response>,
) {
  const calls: RequestRecord[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    (input: string | URL | Request, options: RequestInit = {}) => {
      const request = {
        url: new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        ),
        options,
      };
      calls.push(request);
      return Promise.resolve(handler(request, calls.length - 1));
    },
  );
  return calls;
}
function normalResponses(index: number) {
  return (
    [
      () => json({ name: "Throwaway Dev", image: FILE_URI }),
      () => json(file()),
      () => image(),
    ][index]?.() ?? new Response(null, { status: 404 })
  );
}

function jpegFrame(width: number, height: number) {
  // Minimal SOF0 dimension header; decoding remains the browser's job.
  const bytes = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 0xff, 0xd9,
  ]);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
}

function vp8(width: number, height: number) {
  const data = Uint8Array.from([
    0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 1, 0, 1, 0, 0x01, 0x40, 0x26, 0x25,
    0xa4, 0, 0x03, 0x70, 0, 0xfe, 0xdf, 0x56, 0, 0,
  ]);
  const view = new DataView(data.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return data;
}

function vp8l(width: number, height: number) {
  const packed = (width - 1) | ((height - 1) << 14);
  return Uint8Array.from([
    0x2f,
    packed & 255,
    (packed >>> 8) & 255,
    (packed >>> 16) & 255,
    (packed >>> 24) & 255,
  ]);
}

function vp8x(width: number, height: number) {
  const data = new Uint8Array(10);
  for (let byte = 0; byte < 3; byte++) {
    data[4 + byte] = ((width - 1) >>> (byte * 8)) & 255;
    data[7 + byte] = ((height - 1) >>> (byte * 8)) & 255;
  }
  return data;
}

function webp(...chunks: Array<[string, Uint8Array]>) {
  const length =
    12 +
    chunks.reduce(
      (sum, [, data]) => sum + 8 + data.length + (data.length % 2),
      0,
    );
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"));
  view.setUint32(4, length - 8, true);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  let offset = 12;
  for (const [kind, data] of chunks) {
    bytes.set(new TextEncoder().encode(kind), offset);
    view.setUint32(offset + 4, data.length, true);
    bytes.set(data, offset + 8);
    offset += 8 + data.length + (data.length % 2);
  }
  return bytes;
}

test("accepts bounded dimension headers for PNG, GIF, JPEG, and all WebP variants", async (t) => {
  let bytes: Uint8Array<ArrayBuffer> = PNG;
  let mime = "image/png";
  mockFetch(t, (_, index) =>
    index % 3 === 0
      ? json({ image: FILE_URI })
      : index % 3 === 1
        ? json(file({ size: bytes.length, content_type: mime }))
        : new Response(bytes),
  );
  const cases: Array<[string, Uint8Array<ArrayBuffer>]> = [
    ["image/png", PNG],
    [
      "image/gif",
      Uint8Array.from(
        Buffer.from(
          "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
          "base64",
        ),
      ),
    ],
    ["image/jpeg", jpegFrame(1, 1)],
    ["image/webp", webp(["VP8 ", vp8(1, 1)])],
    ["image/webp", webp(["VP8L", vp8l(1, 1)])],
    ["image/webp", webp(["VP8X", vp8x(1, 1)], ["VP8 ", vp8(1, 1)])],
  ];
  for (const fixture of cases) {
    [mime, bytes] = fixture;
    assert.equal(
      (await loadIdentityProfile(OWNER, "staging", signal())).avatar?.type,
      mime,
    );
  }
});

test("rejects oversized, zero, unknown, or truncated raster dimension headers", async (t) => {
  let bytes: Uint8Array<ArrayBuffer> = PNG;
  let mime = "image/png";
  mockFetch(t, (_, index) =>
    index % 3 === 0
      ? json({ name: "Throwaway Dev", image: FILE_URI })
      : index % 3 === 1
        ? json(file({ size: bytes.length, content_type: mime }))
        : new Response(bytes),
  );
  const pngAxis = Uint8Array.from(PNG);
  new DataView(pngAxis.buffer).setUint32(16, 8193);
  const pngPixels = Uint8Array.from(PNG);
  new DataView(pngPixels.buffer).setUint32(16, 4096);
  new DataView(pngPixels.buffer).setUint32(20, 4096);
  const pngZero = Uint8Array.from(PNG);
  new DataView(pngZero.buffer).setUint32(16, 0);
  const gif = Uint8Array.from([
    71, 73, 70, 56, 57, 97, 255, 255, 1, 0, 0, 0, 0,
  ]);
  const malformedJpeg = jpegFrame(1, 1);
  malformedJpeg[5] = 0;
  const cases: Array<[string, Uint8Array<ArrayBuffer>]> = [
    ["image/png", pngAxis],
    ["image/png", pngPixels],
    ["image/png", pngZero],
    ["image/png", PNG.slice(0, 24)],
    ["image/gif", gif],
    ["image/gif", gif.slice(0, 10)],
    ["image/jpeg", jpegFrame(8193, 1)],
    ["image/jpeg", jpegFrame(4096, 4096)],
    ["image/jpeg", jpegFrame(1, 1).slice(0, 10)],
    ["image/jpeg", malformedJpeg],
    ["image/webp", webp(["VP8 ", vp8(8193, 1)])],
    ["image/webp", webp(["VP8L", vp8l(8193, 1)])],
    ["image/webp", webp(["VP8X", vp8x(8193, 1)], ["VP8 ", vp8(1, 1)])],
    ["image/webp", webp(["VP8X", vp8x(1, 1)], ["VP8 ", vp8(8193, 1)])],
    ["image/webp", webp(["VP8 ", vp8(1, 1).slice(0, 9)])],
    ["image/webp", webp(["VP8L", vp8l(1, 1).slice(0, 4)])],
    ["image/webp", webp(["VP8X", vp8x(1, 1).slice(0, 9)])],
    ["image/webp", webp(["JUNK", new Uint8Array(4)])],
  ];
  for (const fixture of cases) {
    [mime, bytes] = fixture;
    assert.deepEqual(await loadIdentityProfile(OWNER, "staging", signal()), {
      name: "Throwaway Dev",
    });
  }
});

test("loads independently validated name and raster photo over public selected-home routes", async (t) => {
  const calls = mockFetch(t, (_, index) => normalResponses(index));
  const profile = await loadIdentityProfile(
    `pubky${OWNER}`,
    "staging",
    signal(),
  );
  assert.equal(profile.name, "Throwaway Dev");
  assert(profile.avatar instanceof Blob);
  assert.equal(profile.avatar.type, "image/png");
  assert.deepEqual(new Uint8Array(await profile.avatar.arrayBuffer()), PNG);
  assert.deepEqual(
    calls.map(({ url }) => url.pathname),
    [
      "/pub/pubky.app/profile.json",
      `/pub/pubky.app/files/${FILE_ID}`,
      `/pub/pubky.app/blobs/${BLOB_ID}`,
    ],
  );
  for (const { url, options } of calls) {
    assert.equal(url.origin, ENVIRONMENTS.staging.homeserverUrl);
    assert.deepEqual([...url.searchParams], [["pubky-host", OWNER]]);
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.referrerPolicy, "no-referrer");
    assert.equal(options.cache, "no-store");
    assert.equal(options.headers, undefined);
    assert.equal(options.body, undefined);
    assert(options.signal instanceof AbortSignal);
  }
});

test("routes bare identities to production only when production is selected", async (t) => {
  const calls = mockFetch(t, () => json({ name: "Production Dev" }));
  assert.deepEqual(await loadIdentityProfile(OWNER, "production", signal()), {
    name: "Production Dev",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url.origin, ENVIRONMENTS.production.homeserverUrl);
});

test("rejects malformed public identities and unknown environments before fetching", async (t) => {
  const calls = mockFetch(t, () => json({ name: "Unexpected" }));
  for (const owner of [
    "not-a-key",
    `${OWNER}/evil`,
    `${OWNER}?target=evil`,
    `https://${OWNER}`,
    `pubky://${OWNER}`,
    `${OWNER}@evil.example`,
    " ",
  ]) {
    assert.deepEqual(await loadIdentityProfile(owner, "staging", signal()), {});
  }
  assert.deepEqual(
    await loadIdentityProfile(OWNER, "local" as EnvironmentId, signal()),
    {},
  );
  assert.equal(calls.length, 0);
});

test("missing or invalid name retains an independently valid photo", async (t) => {
  let currentName: unknown;
  const calls = mockFetch(t, (_, index) =>
    index % 3 === 0
      ? json({ name: currentName, image: FILE_URI })
      : index % 3 === 1
        ? json(file())
        : image(),
  );
  for (const name of [undefined, null, "", "ab", 42]) {
    currentName = name;
    const profile = await loadIdentityProfile(OWNER, "staging", signal());
    assert.equal(profile.name, undefined);
    assert(profile.avatar instanceof Blob);
  }
  assert.equal(calls.length, 15);
});

test("missing or invalid image retains an independently valid name", async (t) => {
  let currentImage: unknown;
  const calls = mockFetch(t, () =>
    json({ name: "Throwaway Dev", image: currentImage }),
  );
  for (const value of [
    undefined,
    null,
    "",
    42,
    "not a URL",
    "javascript:alert(1)",
  ]) {
    currentImage = value;
    assert.deepEqual(await loadIdentityProfile(OWNER, "staging", signal()), {
      name: "Throwaway Dev",
    });
  }
  assert.equal(calls.length, 6);
});

test("missing profile, malformed JSON, non-object records, and fetch failures return fallbacks", async (t) => {
  const responses = [
    () => new Response(null, { status: 404 }),
    () => new Response("{not-json"),
    () => json([]),
    () => json(null),
    () => {
      throw new Error("Untrusted diagnostic");
    },
  ];
  mockFetch(t, (_, index) => responses[index]!());
  for (let index = 0; index < responses.length; index++) {
    assert.deepEqual(await loadIdentityProfile(OWNER, "staging", signal()), {});
  }
});

test("invalid and unrelated profile fields do not override valid display fields", async (t) => {
  mockFetch(t, () =>
    json({
      name: "  Throwaway Dev  ",
      bio: 42,
      links: "invalid",
      status: null,
    }),
  );
  assert.deepEqual(await loadIdentityProfile(OWNER, "staging", signal()), {
    name: "Throwaway Dev",
  });
});

test("rejects arbitrary, cross-owner, and noncanonical image references without fetching them", async (t) => {
  let reference = "";
  const calls = mockFetch(t, () =>
    json({ name: "Throwaway Dev", image: reference }),
  );
  for (const value of [
    "https://evil.example/avatar.png",
    "https://homeserver.staging.pubky.app/avatar.png",
    "http://127.0.0.1/avatar.png",
    "data:image/png;base64,AA==",
    "file:///avatar.png",
    FILE_URI.replace(OWNER, OTHER_OWNER),
    FILE_URI.replace("pubky://", "pubky://user@"),
    `${FILE_URI}?query=1`,
    `${FILE_URI}#fragment`,
    `${FILE_URI}/extra`,
    `${FILE_URI}/`,
    FILE_URI.replace("/files/", "/files/../files/"),
    FILE_URI.replace(FILE_ID, "%30" + FILE_ID.slice(1)),
    FILE_URI.replace(FILE_ID, "../profile.json"),
    FILE_URI.replace(FILE_ID, "000000000000I"),
    BLOB_URI,
  ]) {
    reference = value;
    const before = calls.length;
    assert.deepEqual(await loadIdentityProfile(OWNER, "staging", signal()), {
      name: "Throwaway Dev",
    });
    assert.equal(calls.length, before + 1);
  }
});

test("rejects arbitrary, cross-owner, and noncanonical blob references before blob fetch", async (t) => {
  let reference = "";
  const calls = mockFetch(t, (_, index) =>
    index % 2 === 0
      ? json({ name: "Throwaway Dev", image: FILE_URI })
      : json(file({ src: reference })),
  );
  for (const value of [
    "https://evil.example/image.png",
    BLOB_URI.replace(OWNER, OTHER_OWNER),
    `${BLOB_URI}?query=1`,
    `${BLOB_URI}#fragment`,
    `${BLOB_URI}/extra`,
    BLOB_URI.replace(BLOB_ID, "../profile.json"),
    BLOB_URI.replace("/blobs/", "/blobs/../blobs/"),
    FILE_URI,
  ]) {
    reference = value;
    const before = calls.length;
    assert.deepEqual(await loadIdentityProfile(OWNER, "staging", signal()), {
      name: "Throwaway Dev",
    });
    assert.equal(calls.length, before + 2);
  }
});

test("missing or invalid file metadata retains name without requesting blob bytes", async (t) => {
  let metadata: unknown;
  const calls = mockFetch(t, (_, index) =>
    index % 2 === 0
      ? json({ name: "Throwaway Dev", image: FILE_URI })
      : json(metadata),
  );
  for (const value of [
    {},
    null,
    file({ size: 0 }),
    file({ size: 5 * 1024 * 1024 + 1 }),
    file({ size: -1 }),
    file({ content_type: "image/svg+xml" }),
    file({ content_type: "text/html" }),
  ]) {
    metadata = value;
    const before = calls.length;
    assert.deepEqual(await loadIdentityProfile(OWNER, "staging", signal()), {
      name: "Throwaway Dev",
    });
    assert.equal(calls.length, before + 2);
  }
});

test("accepts missing, octet-stream, or matching raster HTTP MIME", async (t) => {
  let headers: HeadersInit = {};
  mockFetch(t, (_, index) =>
    index % 3 === 0
      ? json({ image: FILE_URI })
      : index % 3 === 1
        ? json(file())
        : image(headers),
  );
  const cases: HeadersInit[] = [
    {},
    { "content-type": "application/octet-stream" },
    { "content-type": "image/png" },
    { "content-type": "image/png; charset=binary" },
  ];
  for (const value of cases) {
    headers = value;
    assert(
      (await loadIdentityProfile(OWNER, "staging", signal())).avatar instanceof
        Blob,
    );
  }
});

test("rejects contradictory or executable image response MIME", async (t) => {
  let mime = "";
  mockFetch(t, (_, index) =>
    index % 3 === 0
      ? json({ name: "Throwaway Dev", image: FILE_URI })
      : index % 3 === 1
        ? json(file())
        : image({ "content-type": mime }),
  );
  for (const value of [
    "text/html",
    "application/javascript",
    "image/svg+xml",
    "image/jpeg",
  ]) {
    mime = value;
    assert.deepEqual(await loadIdentityProfile(OWNER, "staging", signal()), {
      name: "Throwaway Dev",
    });
  }
});

test("rejects misleading image signatures and mismatched metadata sizes", async (t) => {
  let bytes = new Uint8Array(PNG.byteLength);
  let declaredSize = PNG.byteLength;
  mockFetch(t, (_, index) =>
    index % 3 === 0
      ? json({ name: "Throwaway Dev", image: FILE_URI })
      : index % 3 === 1
        ? json(file({ size: declaredSize }))
        : new Response(bytes, { headers: { "content-type": "image/png" } }),
  );
  assert.deepEqual(await loadIdentityProfile(OWNER, "staging", signal()), {
    name: "Throwaway Dev",
  });
  bytes = PNG;
  declaredSize = PNG.byteLength - 1;
  assert.deepEqual(await loadIdentityProfile(OWNER, "staging", signal()), {
    name: "Throwaway Dev",
  });
});

test("bounds profile and metadata JSON using advertised lengths and streamed bytes", async (t) => {
  let response = () =>
    json(
      { name: "Throwaway Dev" },
      { "content-length": String(16 * 1024 + 1) },
    );
  mockFetch(t, () => response());
  assert.deepEqual(await loadIdentityProfile(OWNER, "staging", signal()), {});
  response = () => new Response(new Uint8Array(16 * 1024 + 1));
  assert.deepEqual(await loadIdentityProfile(OWNER, "staging", signal()), {});
  response = () =>
    json({ name: "Throwaway Dev" }, { "content-length": "invalid" });
  assert.deepEqual(await loadIdentityProfile(OWNER, "staging", signal()), {});
});

test("bounds avatar bytes despite inaccurate file and HTTP length metadata", async (t) => {
  let response = () => image({ "content-length": String(5 * 1024 * 1024 + 1) });
  mockFetch(t, (_, index) =>
    index % 3 === 0
      ? json({ name: "Throwaway Dev", image: FILE_URI })
      : index % 3 === 1
        ? json(file())
        : response(),
  );
  assert.deepEqual(await loadIdentityProfile(OWNER, "staging", signal()), {
    name: "Throwaway Dev",
  });
  response = () =>
    new Response(new Uint8Array(5 * 1024 * 1024 + 1), {
      headers: { "content-length": "1" },
    });
  assert.deepEqual(await loadIdentityProfile(OWNER, "staging", signal()), {
    name: "Throwaway Dev",
  });
});

test("already-cancelled work never fetches", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const calls = mockFetch(t, () => normalResponses(0));
  assert.deepEqual(
    await loadIdentityProfile(OWNER, "staging", controller.signal),
    {},
  );
  assert.equal(calls.length, 0);
});

test("cancelling an in-flight image load discards the name and aborts network work", async (t) => {
  const controller = new AbortController();
  let fetchSignal: AbortSignal | null | undefined;
  mockFetch(t, ({ options }, index) => {
    if (index < 2) return normalResponses(index);
    fetchSignal = options.signal;
    return new Promise<Response>((_, reject) => {
      options.signal!.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
      controller.abort();
    });
  });
  assert.deepEqual(
    await loadIdentityProfile(OWNER, "staging", controller.signal),
    {},
  );
  assert.equal(fetchSignal?.aborted, true);
});

test("a stalled profile fetch times out after the total eight-second budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fetchSignal: AbortSignal | null | undefined;
  mockFetch(t, ({ options }) => {
    fetchSignal = options.signal;
    return new Promise<Response>((_, reject) =>
      options.signal!.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      ),
    );
  });
  const pending = loadIdentityProfile(OWNER, "staging", signal());
  t.mock.timers.tick(8_000);
  assert.deepEqual(await pending, {});
  assert.equal(fetchSignal?.aborted, true);
});

test("cancelling a stalled response body releases it without returning stale display data", async (t) => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{"name":'));
    },
    cancel() {
      cancelled = true;
    },
  });
  mockFetch(t, () => new Response(body));
  const pending = loadIdentityProfile(OWNER, "staging", controller.signal);
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  assert.deepEqual(await pending, {});
  assert.equal(cancelled, true);
});
