import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  AuthFlowKind as LegacyAuthFlowKind,
  Pubky as LegacyPubky,
} from "legacy-pubky";
import { AuthFlowKind, AuthToken, Keypair, Pubky } from "@synonymdev/pubky";

const CAPABILITIES = "/pub/example.app/:rw";
const FLOW_TIMEOUT_MS = 10_000;

test(
  "the current signer approves an SDK 0.9.3 sign-in request",
  { timeout: 30_000 },
  async () => {
    await assertApproval({
      requester: new LegacyPubky(),
      startFlow: (requester, capabilities, relay) =>
        requester.startAuthFlow(
          capabilities,
          LegacyAuthFlowKind.signin(),
          relay,
        ),
      capabilities: CAPABILITIES,
      expectedCapabilities: [CAPABILITIES],
    });
  },
);

test(
  "the current SDK cookie requester receives a signed token with every requested capability",
  { timeout: 30_000 },
  async () => {
    await assertCurrentApproval(
      `${CAPABILITIES},/pub/another.app/file:r`,
      [CAPABILITIES, "/pub/another.app/file:r"],
    );
  },
);

test(
  "the current SDK cookie requester can authenticate without requesting capabilities",
  { timeout: 30_000 },
  async () => {
    await assertCurrentApproval("", []);
  },
);

async function assertCurrentApproval(capabilities, expectedCapabilities) {
  await assertApproval({
    requester: new Pubky(),
    startFlow: (requester, capabilities, relay) =>
      requester.startCookieAuthFlow(capabilities, AuthFlowKind.signin(), relay),
    capabilities,
    expectedCapabilities,
  });
}

async function assertApproval({
  requester,
  startFlow,
  capabilities,
  expectedCapabilities,
}) {
  const resources = [requester];
  const keep = (resource) => {
    resources.push(resource);
    return resource;
  };
  const pendingCalls = new Set();
  const waitForCall = (promise) => {
    pendingCalls.add(promise);
    const settled = () => pendingCalls.delete(promise);
    promise.then(settled, settled);
    return withTimeout(promise, FLOW_TIMEOUT_MS);
  };
  let relay;

  try {
    relay = await startRelay();
    const flow = keep(startFlow(requester, capabilities, relay.inboxUrl));
    const authorizationUrl = flow.authorizationUrl;
    assert.equal(new URL(authorizationUrl).hostname, "signin");

    const keypair = keep(Keypair.fromSecret(new Uint8Array(32).fill(7)));
    const signerClient = keep(new Pubky());
    const signer = keep(signerClient.signer(keypair));

    await waitForCall(signer.approveAuthRequest(authorizationUrl));
    const token = keep(await waitForCall(flow.awaitToken()));
    const expectedPublicKey = keep(keypair.publicKey).toString();

    assert.equal(keep(token.publicKey).toString(), expectedPublicKey);
    assert.deepEqual(Array.from(token.capabilities), expectedCapabilities);

    // Verify the real serialized signature, including tokens decoded by SDK 0.9.3.
    const bytes = token.toBytes();
    const verifiedToken = keep(AuthToken.verify(bytes));
    assert.equal(keep(verifiedToken.publicKey).toString(), expectedPublicKey);
    assert.deepEqual(Array.from(verifiedToken.capabilities), expectedCapabilities);

    const alteredBytes = bytes.slice();
    alteredBytes[0] ^= 1;
    assert.throws(() => AuthToken.verify(alteredBytes));
    assert.equal(relay.posts, 1);
    assert.equal(relay.acknowledgements, 1);
  } finally {
    await relay?.close();
    // A timed-out WASM call can still borrow its owner; let GC release it safely.
    if (pendingCalls.size === 0) {
      for (const resource of resources.reverse()) resource.free();
    }
  }
}

async function startRelay() {
  let payload;
  let posts = 0;
  let acknowledgements = 0;
  const waitingReaders = new Set();

  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (!path.startsWith("/inbox/") || path.endsWith("/ack")) {
        response.writeHead(404).end();
        return;
      }

      if (request.method === "POST") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        payload = Buffer.concat(chunks);
        posts += 1;

        for (const reader of waitingReaders) sendPayload(reader, payload);
        waitingReaders.clear();
        response.writeHead(200).end();
        return;
      }

      if (request.method === "GET") {
        if (payload) {
          sendPayload(response, payload);
        } else {
          waitingReaders.add(response);
          request.on("close", () => waitingReaders.delete(response));
        }
        return;
      }

      if (request.method === "DELETE") {
        if (!payload) {
          response.writeHead(404).end();
          return;
        }

        payload = undefined;
        acknowledgements += 1;
        response.writeHead(200).end();
        return;
      }

      response.writeHead(405).end();
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert(address && typeof address !== "string");

  return {
    get acknowledgements() {
      return acknowledgements;
    },
    async close() {
      for (const reader of waitingReaders) reader.writeHead(408).end();
      waitingReaders.clear();
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    inboxUrl: `http://127.0.0.1:${address.port}/inbox`,
    get posts() {
      return posts;
    },
  };
}

function sendPayload(response, payload) {
  response.writeHead(200, { "content-type": "application/octet-stream" });
  response.end(payload);
}

async function withTimeout(promise, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Auth flow timed out after ${milliseconds}ms`)),
      milliseconds,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
