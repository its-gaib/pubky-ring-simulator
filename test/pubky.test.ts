import { strict as assert } from "node:assert";
import { pbkdf2Sync } from "node:crypto";
import { test, type TestContext } from "node:test";
import {
  Keypair,
  PublicKey,
  type Session,
  type Signer,
} from "@synonymdev/pubky";
import {
  approveAuthRequest,
  callbackUrlFor,
  disposeIdentity,
  ENVIRONMENTS,
  importIdentity,
  parseAuthRequest,
  pubky,
  type EnvironmentId,
  type SignerIdentity,
} from "../src/pubky.js";
import { keypairFromRecoveryPhrase } from "../src/recovery.js";

// Public BIP39 test vector, never a real user's recovery phrase.
const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER_HOMESERVER =
  "pubky5jsjx1o6fzu6aeeo697r3i5rx15zq41kikcye8wtwdqm4nb4tryo";
const SECRET = "kqnceEMgrNQM_xi06oQXjA3cJHX_RQmw1BY6JE1bse8";
const CLIENT_PUBLIC_KEY =
  "5jsjx1o6fzu6aeeo697r3i5rx15zq41kikcye8wtwdqm4nb4tryo";

function authUrl(
  intent = "signin_grant",
  environment: EnvironmentId = "staging",
  overrides: Record<string, string> = {},
) {
  const params = new URLSearchParams({
    caps: "/pub/example.app/:rw",
    relay: ENVIRONMENTS[environment].relayUrl,
    secret: SECRET,
    ...(intent.endsWith("_grant")
      ? { cid: "example.app", cpk: CLIENT_PUBLIC_KEY }
      : {}),
    ...overrides,
  });
  const query = [...params]
    .map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    )
    .join("&");
  return `pubkyauth://${intent}?${query}`;
}

function safeError(error: unknown): error is Error {
  assert(error instanceof Error);
  assert(!error.message.includes(PHRASE));
  assert(!error.message.includes(SECRET));
  assert(!error.message.includes("pubkyauth://"));
  assert.equal(error.cause, undefined);
  return true;
}

test("derives exactly the Ring BIP39 empty-passphrase key", async () => {
  const keypair = await keypairFromRecoveryPhrase(PHRASE);
  // Independent Node crypto calculation of the Ring Rust BIP39 recipe.
  const seed = pbkdf2Sync(
    PHRASE.normalize("NFKD"),
    "mnemonic",
    2048,
    64,
    "sha512",
  );
  try {
    assert.equal(
      Buffer.from(keypair.secret()).toString("hex"),
      "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1",
    );
    assert.deepEqual(Buffer.from(keypair.secret()), seed.subarray(0, 32));
  } finally {
    keypair.free();
    seed.fill(0);
  }
});

test("normalizes harmless recovery phrase whitespace and capitalization", async () => {
  const clean = await keypairFromRecoveryPhrase(PHRASE);
  const pasted = await keypairFromRecoveryPhrase(
    `  ${PHRASE.toUpperCase().replaceAll(" ", "\n ")}  `,
  );
  try {
    assert.deepEqual(pasted.secret(), clean.secret());
  } finally {
    clean.free();
    pasted.free();
  }
});

test("rejects short seeds, invalid words, and invalid mnemonic checksums before resolution", async (t) => {
  const state = mockNetwork(t);
  for (const phrase of [
    "seed",
    "abandon ".repeat(12),
    "invalid ".repeat(24),
    " ",
    "x".repeat(513),
  ]) {
    await assert.rejects(importIdentity(phrase, "staging"), safeError);
  }
  assert.equal(state.resolutions, 0);
  assert.equal(state.signins, 0);
});

test("parses cookie signin with safe explicit HTTPS callbacks", () => {
  const success = "https://example.com/auth/success?state=ready";
  const request = parseAuthRequest(
    authUrl("signin", "staging", {
      "x-source": "Example App",
      "x-success": success,
    }),
    "staging",
  );
  assert.equal(request.authMode, "cookie");
  assert.equal(request.kind, "signin");
  assert.deepEqual(request.capabilities, ["/pub/example.app/:rw"]);
  assert.equal(request.xCallback?.xSource, "Example App");
  assert.equal(callbackUrlFor(request, "success"), success);
});

test("parses grant signin metadata for both environments", () => {
  for (const environment of ["staging", "production"] as const) {
    const request = parseAuthRequest(
      authUrl("signin_grant", environment, {
        caps: "/pub/example.app/:rw,/priv/example.app/settings:r",
        "x-success": "https://example.com/success",
        "x-error": "https://example.com/error",
        "x-cancel": "https://example.com/cancel",
      }),
      environment,
    );
    assert.equal(request.authMode, "grant");
    assert.equal(request.clientId, "example.app");
    assert.deepEqual(request.capabilities, [
      "/pub/example.app/:rw",
      "/priv/example.app/settings:r",
    ]);
    assert.equal(request.relay, ENVIRONMENTS[environment].relayUrl);
    for (const outcome of ["success", "error", "cancel"] as const) {
      assert.equal(
        callbackUrlFor(request, outcome),
        `https://example.com/${outcome}`,
      );
    }
  }
});

test("omits unsafe, credentialed, and non-HTTPS callback actions", () => {
  for (const callback of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "example://auth",
    "http://example.com",
    "https://user:password@example.com",
    "not-a-url",
  ]) {
    const request = parseAuthRequest(
      authUrl("signin", "staging", { "x-success": callback }),
      "staging",
    );
    assert.equal(callbackUrlFor(request, "success"), undefined);
  }
});

test("rejects every signup route before constructing a signer", async (t) => {
  const state = mockNetwork(t);
  const identity = fixtureIdentity(t);
  for (const intent of [
    "signup",
    "signup_grant",
    "direct_signup",
    "SIGNUP",
    "signup/",
    "signin/signup",
  ]) {
    const input = authUrl(intent, "staging", {
      hs: ENVIRONMENTS.staging.homeserver.slice(5),
    });
    assert.throws(() => parseAuthRequest(input, "staging"), safeError);
    await assert.rejects(
      approveAuthRequest(identity, input, "staging"),
      safeError,
    );
  }
  assert.equal(state.resolutions, 0);
  assert.equal(state.signers, 0);
  assert.equal(state.approvals.length, 0);
});

test("rejects cross-environment relays with an actionable switch message", () => {
  assert.throws(
    () => parseAuthRequest(authUrl("signin_grant", "production"), "staging"),
    /uses Production.*Switch/,
  );
  assert.throws(
    () => parseAuthRequest(authUrl("signin_grant", "staging"), "production"),
    /uses Staging.*Switch/,
  );
});

test("rejects spoofed and nonstandard relay destinations", () => {
  const relay = ENVIRONMENTS.staging.relayUrl;
  for (const value of [
    "http://localhost:15412/inbox",
    "http://httprelay.staging.pubky.app/inbox",
    `${relay}/`,
    `${relay}?redirect=evil`,
    `${relay}#secret`,
    `${relay}/../inbox`,
    "https://user@httprelay.staging.pubky.app/inbox",
    "https://httprelay.staging.pubky.app.evil.example/inbox",
    "https://httprelay.staging.pubky.app:443/inbox",
    "https://httprelay.staging.pubky.app/%69nbox",
    "https://httprelay.staging.pubky.app/extra/inbox",
  ]) {
    assert.throws(
      () =>
        parseAuthRequest(
          authUrl("signin_grant", "staging", { relay: value }),
          "staging",
        ),
      safeError,
    );
  }
});

test("rejects hostile auth routes, duplicate fields, unsupported fields, and control characters", () => {
  const valid = authUrl();
  for (const input of [
    valid.replace("pubkyauth:", "https:"),
    valid.replace("pubkyauth:", "pubkyring:"),
    valid.replace("signin_grant?", "signin_grant/?"),
    valid.replace("signin_grant?", "user@signin_grant?"),
    `${valid}#fragment`,
    `${valid}&relay=${encodeURIComponent(ENVIRONMENTS.staging.relayUrl)}`,
    `${valid}&caps=/:rw`,
    `${valid}&hs=${OTHER_HOMESERVER}`,
    `${valid}&st=signup-token`,
    authUrl("signin", "staging", { cid: "ignored-client" }),
    "x".repeat(16_385),
    "not an auth request",
    "",
    valid.replace("signin_grant", "signin_\ngrant"),
    authUrl("signin_grant", "staging", { cid: "Example\nApp" }),
  ])
    assert.throws(() => parseAuthRequest(input, "staging"), safeError);
});

test("SDK rejects malformed capabilities and grant material without leaking request secrets", () => {
  const cases: Record<string, string>[] = [
    { caps: "/pub/example.app/:rw,relative:r" },
    { secret: "invalid-secret" },
    { cpk: "not-a-public-key" },
    { cid: "" },
  ];
  for (const overrides of cases) {
    assert.throws(
      () =>
        parseAuthRequest(
          authUrl("signin_grant", "staging", overrides),
          "staging",
        ),
      safeError,
    );
  }
});

test("imports only an account authenticated on the selected homeserver and revokes validation", async (t) => {
  const state = mockNetwork(t);
  const identity = await importIdentity(PHRASE, "staging");
  t.after(() => disposeIdentity(identity));
  assert.equal(identity.environment, "staging");
  assert.equal(identity.homeserver, ENVIRONMENTS.staging.homeserver);
  assert.equal(identity.publicKey, identity.id);
  assert.equal(state.resolutions, 1);
  assert.equal(state.signins, 1);
  assert.equal(state.signouts, 1);
  assert.deepEqual(state.clientIds, ["pubky-ring-simulator.validation"]);
  assert.equal(state.sessionsFreed, 1);
  assert.equal(state.signersFreed, 1);
  assert.equal(state.approvals.length, 0);
});

test("production import checks production homeserver", async (t) => {
  const state = mockNetwork(t, { environment: "production" });
  const identity = await importIdentity(PHRASE, "production");
  t.after(() => disposeIdentity(identity));
  assert.equal(identity.homeserver, ENVIRONMENTS.production.homeserver);
  assert.equal(state.signouts, 1);
});

test("rejects an identity without a published homeserver and frees its key", async (t) => {
  const state = mockNetwork(t, { resolvedHomeserver: null });
  const free = t.mock.method(Keypair.prototype, "free");
  await assert.rejects(
    importIdentity(PHRASE, "staging"),
    /no published homeserver/,
  );
  assert.equal(state.signins, 0);
  assert.equal(free.mock.callCount(), 1);
});

test("rejects the wrong selected environment before attempting signin", async (t) => {
  const state = mockNetwork(t, {
    resolvedHomeserver: ENVIRONMENTS.production.homeserver,
  });
  await assert.rejects(
    importIdentity(PHRASE, "staging"),
    /belongs to Production.*Switch/,
  );
  assert.equal(state.signers, 0);
});

test("rejects unsupported homeservers before attempting signin", async (t) => {
  const state = mockNetwork(t, { resolvedHomeserver: OTHER_HOMESERVER });
  await assert.rejects(
    importIdentity(PHRASE, "staging"),
    /outside the supported/,
  );
  assert.equal(state.signers, 0);
});

test("registration lookup failures fail closed and sanitize diagnostics", async (t) => {
  const state = mockNetwork(t, {
    resolveError: new Error(`${PHRASE} ${SECRET}`),
  });
  await assert.rejects(importIdentity(PHRASE, "staging"), safeError);
  assert.equal(state.signins, 0);
});

test("a published pointer is insufficient when homeserver authentication fails", async (t) => {
  const state = mockNetwork(t, {
    signinError: new Error(`404 ${PHRASE} ${SECRET}`),
  });
  const free = t.mock.method(Keypair.prototype, "free");
  await assert.rejects(
    importIdentity(PHRASE, "staging"),
    (error) => safeError(error) && /Could not verify/.test(error.message),
  );
  assert.equal(state.signins, 1);
  assert.equal(state.signersFreed, 1);
  assert.equal(free.mock.callCount(), 1);
});

test("mismatched authenticated session identity is rejected and signed out", async (t) => {
  const state = mockNetwork(t, { sessionPublicKey: OTHER_HOMESERVER });
  await assert.rejects(importIdentity(PHRASE, "staging"), /Could not verify/);
  assert.equal(state.signouts, 1);
  assert.equal(state.sessionsFreed, 1);
});

test("mismatched grant homeserver is rejected and signed out", async (t) => {
  const state = mockNetwork(t, {
    grantHomeserver: ENVIRONMENTS.production.homeserver,
  });
  await assert.rejects(importIdentity(PHRASE, "staging"), /Could not verify/);
  assert.equal(state.signouts, 1);
});

test("validation metadata errors still revoke and free the temporary session", async (t) => {
  const state = mockNetwork(t, { grantInfoError: new Error(`${SECRET}`) });
  await assert.rejects(importIdentity(PHRASE, "staging"), safeError);
  assert.equal(state.signouts, 1);
  assert.equal(state.sessionsFreed, 1);
});

test("validation cleanup failure rejects import instead of accepting an unrevoked validation", async (t) => {
  const state = mockNetwork(t, { signoutError: new Error(`${SECRET}`) });
  await assert.rejects(importIdentity(PHRASE, "staging"), /Could not verify/);
  assert.equal(state.signouts, 1);
  assert.equal(state.sessionsFreed, 1);
});

test("approval rechecks and revokes registration validation before SDK grant approval", async (t) => {
  const state = mockNetwork(t);
  const identity = fixtureIdentity(t);
  const preview = await approveAuthRequest(identity, authUrl(), "staging");
  assert.equal(preview.authMode, "grant");
  assert.equal(state.resolutions, 1);
  assert.deepEqual(state.events, ["resolve", "signin", "signout", "approve"]);
  assert.equal(state.approvals.length, 1);
  assert.equal(new URL(state.approvals[0]!).hostname, "signin_grant");
  assert.equal(state.signersFreed, 2);
});

test("approval rejects an environment mismatch before network or signing", async (t) => {
  const state = mockNetwork(t);
  await assert.rejects(
    approveAuthRequest(
      fixtureIdentity(t),
      authUrl("signin_grant", "production"),
      "production",
    ),
    /different environment/,
  );
  assert.equal(state.resolutions, 0);
  assert.equal(state.signers, 0);
});

test("approval fails if the previously accepted identity has moved or disappeared", async (t) => {
  const state = mockNetwork(t, { resolvedHomeserver: null });
  await assert.rejects(
    approveAuthRequest(fixtureIdentity(t), authUrl(), "staging"),
    /no published homeserver/,
  );
  assert.equal(state.approvals.length, 0);
});

test("approval cancellation during resolution prevents any signing", async (t) => {
  let current = true;
  const state = mockNetwork(t, {
    onResolve: async () => {
      current = false;
    },
  });
  await assert.rejects(
    approveAuthRequest(fixtureIdentity(t), authUrl(), "staging", () => current),
    /cancelled/,
  );
  assert.equal(state.signins, 0);
  assert.equal(state.approvals.length, 0);
});

test("approval cancellation during validation still signs out and never approves", async (t) => {
  let current = true;
  const state = mockNetwork(t, {
    onSignout: async () => {
      current = false;
    },
  });
  await assert.rejects(
    approveAuthRequest(fixtureIdentity(t), authUrl(), "staging", () => current),
    /cancelled/,
  );
  assert.equal(state.signouts, 1);
  assert.equal(state.approvals.length, 0);
});

test("deleted identities cannot approve and disposal is idempotent", async (t) => {
  const state = mockNetwork(t);
  const identity = fixtureIdentity(t);
  const free = t.mock.method(identity.keypair, "free");
  disposeIdentity(identity);
  disposeIdentity(identity);
  await assert.rejects(
    approveAuthRequest(identity, authUrl(), "staging"),
    /cancelled/,
  );
  assert.equal(free.mock.callCount(), 1);
  assert.equal(state.resolutions, 0);
});

test("approval transport failures free the signer and conceal auth secrets", async (t) => {
  const state = mockNetwork(t, { approveError: new Error(authUrl()) });
  await assert.rejects(
    approveAuthRequest(fixtureIdentity(t), authUrl(), "staging"),
    safeError,
  );
  assert.equal(state.signersFreed, 2);
});

test("invalid environment identifiers fail closed", async () => {
  const invalid = "local" as EnvironmentId;
  assert.throws(
    () => parseAuthRequest(authUrl(), invalid),
    /Choose Staging or Production/,
  );
  await assert.rejects(
    importIdentity(PHRASE, invalid),
    /Choose Staging or Production/,
  );
});

function fixtureIdentity(t: TestContext): SignerIdentity {
  const keypair = Keypair.fromSecret(new Uint8Array(32).fill(7));
  const publicKey = keypair.publicKey;
  const identity: SignerIdentity = {
    createdAt: new Date(0).toISOString(),
    environment: "staging",
    homeserver: ENVIRONMENTS.staging.homeserver,
    publicKey: publicKey.toString(),
    id: publicKey.toString(),
    keypair,
  };
  publicKey.free();
  t.after(() => disposeIdentity(identity));
  return identity;
}

interface NetworkOptions {
  environment?: EnvironmentId;
  resolvedHomeserver?: string | null;
  resolveError?: Error;
  signinError?: Error;
  grantInfoError?: Error;
  signoutError?: Error;
  approveError?: Error;
  sessionPublicKey?: string;
  grantHomeserver?: string;
  onResolve?: () => Promise<void>;
  onSignout?: () => Promise<void>;
}

function mockNetwork(t: TestContext, options: NetworkOptions = {}) {
  const environment = options.environment ?? "staging";
  const state = {
    resolutions: 0,
    signers: 0,
    signins: 0,
    signouts: 0,
    sessionsFreed: 0,
    signersFreed: 0,
    approvals: [] as string[],
    clientIds: [] as string[],
    events: [] as string[],
  };
  t.mock.method(pubky, "getHomeserverOf", async () => {
    state.resolutions += 1;
    state.events.push("resolve");
    await options.onResolve?.();
    if (options.resolveError) throw options.resolveError;
    if (options.resolvedHomeserver === null) return undefined;
    return PublicKey.from(
      options.resolvedHomeserver ?? ENVIRONMENTS[environment].homeserver,
    );
  });
  t.mock.method(pubky, "signer", (keypair: Keypair) => {
    state.signers += 1;
    const publicKey = keypair.publicKey;
    const expectedPublicKey = publicKey.toString();
    publicKey.free();
    return {
      free() {
        state.signersFreed += 1;
      },
      async signin(clientId: string) {
        state.signins += 1;
        state.clientIds.push(clientId);
        state.events.push("signin");
        if (options.signinError) throw options.signinError;
        return {
          free() {
            state.sessionsFreed += 1;
          },
          get info() {
            return {
              publicKey: PublicKey.from(
                options.sessionPublicKey ?? expectedPublicKey,
              ),
              free() {},
            };
          },
          get grant() {
            return {
              free() {},
              async sessionInfo() {
                if (options.grantInfoError) throw options.grantInfoError;
                return {
                  publicKey: PublicKey.from(
                    options.sessionPublicKey ?? expectedPublicKey,
                  ),
                  homeserver: PublicKey.from(
                    options.grantHomeserver ??
                      ENVIRONMENTS[environment].homeserver,
                  ),
                  free() {},
                };
              },
            };
          },
          async signout() {
            state.signouts += 1;
            state.events.push("signout");
            await options.onSignout?.();
            if (options.signoutError) throw options.signoutError;
          },
        } as unknown as Session;
      },
      async approveAuthRequest(url: string) {
        state.events.push("approve");
        state.approvals.push(url);
        if (options.approveError) throw options.approveError;
      },
    } as unknown as Signer;
  });
  return state;
}
