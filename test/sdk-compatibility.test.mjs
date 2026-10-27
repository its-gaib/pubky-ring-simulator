import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { AuthToken, Keypair, PublicKey } from "@synonymdev/pubky";
import {
  approveAuthRequest,
  disposeIdentity,
  ENVIRONMENTS,
  parseAuthRequest,
  pubky,
} from "../.test-dist/src/pubky.js";

// CI supplies an isolated historical SDK; local runs use the installed SDK.
const require = createRequire(import.meta.url);
const requesterModule = process.env.PUBKY_REQUESTER_MODULE ?? "@synonymdev/pubky";
const requesterSdk = require(requesterModule);
const { version } = JSON.parse(
  await readFile(join(dirname(require.resolve(requesterModule)), "package.json"), "utf8"),
);
if (process.env.PUBKY_REQUESTER_VERSION) {
  assert.equal(version, process.env.PUBKY_REQUESTER_VERSION);
}

const CAPABILITIES = "/pub/example.app/:rw";
const environment = "staging";
const relay = ENVIRONMENTS[environment].relayUrl;

for (const [description, capabilities, approved, expected] of [
  ["all requested permissions", CAPABILITIES, undefined, [CAPABILITIES]],
  ["reduced permissions", CAPABILITIES, "/pub/example.app/:r", ["/pub/example.app/:r"]],
  ["no permissions", CAPABILITIES, "", []],
  ["an identity-only request", "", undefined, []],
]) {
  test(`hosted approval serves SDK ${version} cookie sign-in with ${description}`, { timeout: 15_000 }, async (t) => {
    const boundary = mockHostedBoundary(t);
    const identity = fixtureIdentity(t);
    const requester = new requesterSdk.Pubky();
    const startFlow = requester.startCookieAuthFlow ?? requester.startAuthFlow;
    const flow = startFlow.call(requester, capabilities, requesterSdk.AuthFlowKind.signin(), relay);
    try {
      const preview = parseAuthRequest(flow.authorizationUrl, environment);
      assert.equal(preview.kind, "signin");
      assert.equal(preview.authMode, "cookie");
      assert.equal(preview.relay, relay);
      assert.deepEqual(preview.capabilities, capabilities ? [capabilities] : []);
      const result = await approveAuthRequest(identity, preview.url, environment, () => true, approved);
      assert.deepEqual(result.capabilities, expected);
      const token = await flow.awaitToken();
      try {
        const key = token.publicKey;
        try { assert.equal(key.toString(), identity.publicKey); } finally { key.free(); }
        assert.deepEqual(Array.from(token.capabilities), expected);
        const verified = AuthToken.verify(token.toBytes());
        try { assert.deepEqual(Array.from(verified.capabilities), expected); } finally { verified.free(); }
      } finally { token.free(); }
      assert.equal(boundary.validations, 1);
      assert.equal(boundary.revocations, 1);
      assert.equal(boundary.posts, 1);
    } finally {
      flow.free();
      requester.free();
    }
  });
}

test(`hosted approval rejects SDK ${version} cookie permission escalation before relay delivery`, async (t) => {
  const boundary = mockHostedBoundary(t);
  const identity = fixtureIdentity(t);
  const requester = new requesterSdk.Pubky();
  const startFlow = requester.startCookieAuthFlow ?? requester.startAuthFlow;
  const flow = startFlow.call(requester, "/pub/example.app/file:r", requesterSdk.AuthFlowKind.signin(), relay);
  try {
    for (const selected of ["/pub/example.app/file:rw", "/pub/example.app/:r", "/pub/another.app/:r"]) {
      await assert.rejects(approveAuthRequest(identity, flow.authorizationUrl, environment, () => true, selected));
      assert.equal(boundary.posts, 0);
    }
  } finally {
    flow.free();
    requester.free();
  }
});

if (requesterSdk.GrantAuthFlow) {
  const [, minor] = version.split(".").map(Number);
  const formats = minor >= 16 ? ["bareGrant", "signedApprovalV1"] : ["bareGrant"];
  for (const approvalFormat of formats) {
    test(`hosted preview accepts SDK ${version} ${approvalFormat} grant sign-in`, () => {
      const capabilities = approvalFormat === "signedApprovalV1" ? "/priv/example.app/:rwe" : CAPABILITIES;
      const flow = requesterSdk.GrantAuthFlow.start(capabilities, requesterSdk.AuthFlowKind.signin(), {
        clientId: "example.app", relay, approvalFormat,
      });
      try {
        const preview = parseAuthRequest(flow.authorizationUrl, environment);
        assert.equal(preview.authMode, "grant");
        assert.equal(preview.clientId, "example.app");
        assert.equal(preview.relay, relay);
        assert.deepEqual(preview.capabilities, [capabilities]);
        if (approvalFormat === "signedApprovalV1") {
          const url = new URL(preview.url);
          assert.equal(url.searchParams.get("af"), "v1");
          assert(url.searchParams.has("epk"));
        }
      } finally { flow.free(); }
    });
  }
}

// Substitute only account verification and the official relay's HTTP transport.
// The application's environment policy, parsers and SDK signer remain real.
function mockHostedBoundary(t) {
  const state = { validations: 0, revocations: 0, posts: 0 };
  const payloads = new Map();
  const readers = new Map();
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, new URL(relay).origin);
    assert(url.pathname.startsWith("/inbox/"));
    const response = (body = null, options = {}) => {
      const result = new Response(body, options);
      Object.defineProperty(result, "url", { value: request.url });
      return result;
    };
    if (request.method === "POST") {
      payloads.set(url.pathname, await request.arrayBuffer());
      state.posts += 1;
      readers.get(url.pathname)?.();
      readers.delete(url.pathname);
      return response(null, { status: 200 });
    }
    if (request.method === "GET") {
      if (!payloads.has(url.pathname)) {
        await new Promise((resolve) => {
          readers.set(url.pathname, resolve);
          request.signal.addEventListener("abort", resolve, { once: true });
        });
      }
      return response(payloads.get(url.pathname), { headers: { "content-type": "application/octet-stream" } });
    }
    assert.equal(request.method, "DELETE");
    payloads.delete(url.pathname);
    return response(null, { status: 200 });
  });
  t.mock.method(pubky, "getHomeserverOf", async () => PublicKey.from(ENVIRONMENTS[environment].homeserver));
  const realSigner = pubky.signer.bind(pubky);
  t.mock.method(pubky, "signer", (keypair) => {
    const signer = realSigner(keypair);
    t.mock.method(signer, "signin", async () => {
      state.validations += 1;
      return {
        get info() { return { publicKey: keypair.publicKey, free() {} }; },
        get grant() {
          return {
            async sessionInfo() {
              return { publicKey: keypair.publicKey, homeserver: PublicKey.from(ENVIRONMENTS[environment].homeserver), free() {} };
            },
            free() {},
          };
        },
        async signout() { state.revocations += 1; },
        free() {},
      };
    });
    return signer;
  });
  return state;
}

function fixtureIdentity(t) {
  const keypair = Keypair.fromSecret(new Uint8Array(32).fill(7));
  const key = keypair.publicKey;
  const publicKey = key.toString();
  key.free();
  const identity = { createdAt: new Date(0).toISOString(), environment, homeserver: ENVIRONMENTS[environment].homeserver, id: publicKey, publicKey, keypair };
  t.after(() => disposeIdentity(identity));
  return identity;
}
