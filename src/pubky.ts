import {
  Keypair,
  Pubky,
  SigninDeepLink,
  SigninGrantDeepLink,
  type Session,
  type XCallbackParams,
} from "@synonymdev/pubky";
import { keypairFromRecoveryPhrase } from "./recovery.js";

export type EnvironmentId = "staging" | "production";

export const ENVIRONMENTS = {
  staging: {
    label: "Staging",
    homeserver: "pubkyufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy",
    homeserverUrl: "https://homeserver.staging.pubky.app",
    relayUrl: "https://httprelay.staging.pubky.app/inbox",
  },
  production: {
    label: "Production",
    homeserver: "pubky8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty",
    homeserverUrl: "https://homeserver.pubky.app",
    relayUrl: "https://httprelay.pubky.app/inbox",
  },
} as const;

export interface SignerIdentity {
  createdAt: string;
  environment: EnvironmentId;
  homeserver: string;
  id: string;
  keypair: Keypair;
  publicKey: string;
}

export type AuthRequestKind = "signin";
export type AuthMode = "cookie" | "grant";
export type AuthCallbackOutcome = "success" | "error" | "cancel";

export interface AuthCallbacks {
  xCancel?: string;
  xError?: string;
  xSource?: string;
  xSuccess?: string;
}

export interface AuthRequestPreview {
  authMode: AuthMode;
  capabilities: string[];
  clientId?: string;
  kind: AuthRequestKind;
  relay: string;
  url: string;
  xCallback?: AuthCallbacks;
}

// Both hosted environments use public PKARR; the switch selects a homeserver
// and relay, not a separate local DHT or testnet client.
export const pubky = new Pubky();
const disposedIdentities = new WeakSet<SignerIdentity>();
const INVALID_REQUEST = "This is not a valid Pubky sign-in request.";
const SIGNUP_UNSUPPORTED =
  "Account creation is not supported. Use a sign-in request for an existing identity.";
const CANCELLED = "Approval was cancelled. Review a fresh request to continue.";
const UNVERIFIED =
  "Could not verify an existing account on this homeserver. Check your connection and the selected environment, then try again.";

export async function importIdentity(
  phrase: string,
  environment: EnvironmentId,
): Promise<SignerIdentity> {
  const config = environmentConfig(environment);
  const keypair = await keypairFromRecoveryPhrase(phrase);
  let accepted = false;

  try {
    await assertRegistered(keypair, environment);
    const publicKeyObject = keypair.publicKey;
    let publicKey: string;
    try {
      publicKey = publicKeyObject.toString();
    } finally {
      publicKeyObject.free();
    }

    const identity: SignerIdentity = {
      createdAt: new Date().toISOString(),
      environment,
      homeserver: config.homeserver,
      id: publicKey,
      keypair,
      publicKey,
    };
    accepted = true;
    return identity;
  } finally {
    if (!accepted) keypair.free();
  }
}

export function disposeIdentity(identity: SignerIdentity): void {
  if (disposedIdentities.has(identity)) return;
  disposedIdentities.add(identity);
  identity.keypair.free();
}

export async function approveAuthRequest(
  identity: SignerIdentity,
  input: string,
  environment: EnvironmentId,
  isCurrent: () => boolean = () => true,
): Promise<AuthRequestPreview> {
  const config = environmentConfig(environment);
  const request = parseAuthRequest(input, environment);
  if (
    identity.environment !== environment ||
    identity.homeserver !== config.homeserver
  ) {
    throw new Error(
      "This identity belongs to a different environment. Import it in the matching environment.",
    );
  }
  const checkCurrent = () => assertCurrent(identity, isCurrent);
  checkCurrent();
  await assertRegistered(identity.keypair, environment, checkCurrent);
  // Registration checks can finish after a removal or environment change.
  // Never create a signer for an obsolete approval operation.
  checkCurrent();

  const signer = pubky.signer(identity.keypair);
  try {
    await signer.approveAuthRequest(request.url);
  } catch {
    throw new Error(
      "Could not deliver approval. Check the request is still active and try again.",
    );
  } finally {
    signer.free();
  }

  return request;
}

export function callbackUrlFor(
  request: AuthRequestPreview,
  outcome: AuthCallbackOutcome,
): string | undefined {
  const value =
    outcome === "success"
      ? request.xCallback?.xSuccess
      : outcome === "error"
        ? request.xCallback?.xError
        : request.xCallback?.xCancel;
  if (!value) return undefined;

  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseAuthRequest(
  input: string,
  environment: EnvironmentId,
): AuthRequestPreview {
  const config = environmentConfig(environment);
  if (typeof input !== "string" || input.length > 16_384) {
    throw new Error(INVALID_REQUEST);
  }
  const link = input.trim();
  if (!link) throw new Error("Paste or scan a Pubky sign-in link first.");
  if (/[\u0000-\u0020\u007f]/.test(link)) throw new Error(INVALID_REQUEST);

  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error(INVALID_REQUEST);
  }
  if (/signup/i.test(url.hostname)) throw new Error(SIGNUP_UNSUPPORTED);
  if (
    url.protocol !== "pubkyauth:" ||
    !["signin", "signin_grant"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname ||
    url.hash
  ) {
    throw new Error(INVALID_REQUEST);
  }

  const grant = url.hostname === "signin_grant";
  const allowedParams = new Set([
    "caps",
    "relay",
    "secret",
    "x-source",
    "x-success",
    "x-error",
    "x-cancel",
    ...(grant ? ["cid", "cpk"] : []),
  ]);
  const seen = new Set<string>();
  for (const [name, value] of url.searchParams.entries()) {
    if (
      !allowedParams.has(name) ||
      seen.has(name) ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new Error(INVALID_REQUEST);
    }
    seen.add(name);
  }
  const relay = url.searchParams.get("relay");
  if (relay !== config.relayUrl) {
    const otherEnvironment =
      environment === "staging" ? "production" : "staging";
    if (relay === ENVIRONMENTS[otherEnvironment].relayUrl) {
      throw new Error(
        `This request uses ${ENVIRONMENTS[otherEnvironment].label}. Switch environments before approving it.`,
      );
    }
    throw new Error(
      `Only the official ${config.label} HTTPS approval relay is supported.`,
    );
  }

  let parsed: SigninDeepLink | SigninGrantDeepLink | undefined;
  try {
    parsed = grant
      ? SigninGrantDeepLink.parse(link)
      : SigninDeepLink.parse(link);
    if (parsed.baseRelayUrl !== config.relayUrl)
      throw new Error(INVALID_REQUEST);
    return {
      authMode: grant ? "grant" : "cookie",
      capabilities: parsed.capabilities
        ? parsed.capabilities.split(",").filter(Boolean)
        : [],
      clientId:
        parsed instanceof SigninGrantDeepLink ? parsed.clientId : undefined,
      kind: "signin",
      relay: parsed.baseRelayUrl,
      url: parsed.toString(),
      xCallback: normalizeCallbacks(parsed.xCallback),
    };
  } catch {
    // SDK diagnostics can contain the auth URL and its temporary relay secret.
    throw new Error(INVALID_REQUEST);
  } finally {
    parsed?.free();
  }
}

function normalizeCallbacks(
  callbacks: XCallbackParams,
): AuthCallbacks | undefined {
  const normalized: AuthCallbacks = {
    xCancel: callbacks.xCancel || undefined,
    xError: callbacks.xError || undefined,
    xSource: callbacks.xSource || undefined,
    xSuccess: callbacks.xSuccess || undefined,
  };
  return Object.values(normalized).some(Boolean) ? normalized : undefined;
}

function environmentConfig(environment: EnvironmentId) {
  if (environment !== "staging" && environment !== "production") {
    throw new Error("Choose Staging or Production first.");
  }
  return ENVIRONMENTS[environment];
}

function assertCurrent(identity: SignerIdentity, isCurrent: () => boolean) {
  if (disposedIdentities.has(identity) || !isCurrent())
    throw new Error(CANCELLED);
}

async function assertRegistered(
  keypair: Keypair,
  environment: EnvironmentId,
  checkCurrent: () => void = () => {},
) {
  const config = environmentConfig(environment);
  const publicKey = keypair.publicKey;
  const expectedPublicKey = publicKey.toString();
  let homeserver: Awaited<ReturnType<Pubky["getHomeserverOf"]>>;
  try {
    homeserver = await pubky.getHomeserverOf(publicKey);
  } catch {
    throw new Error(
      "Could not check this identity's homeserver. Check your connection and try again.",
    );
  } finally {
    publicKey.free();
  }

  let resolved: string | undefined;
  try {
    resolved = homeserver?.toString();
  } finally {
    homeserver?.free();
  }
  if (!resolved) {
    throw new Error(
      "This recovery phrase has no published homeserver. Import an existing registered identity.",
    );
  }
  if (resolved !== config.homeserver) {
    const otherEnvironment =
      environment === "staging" ? "production" : "staging";
    if (resolved === ENVIRONMENTS[otherEnvironment].homeserver) {
      throw new Error(
        `This identity belongs to ${ENVIRONMENTS[otherEnvironment].label}. Switch environments and import it there.`,
      );
    }
    throw new Error(
      "This identity uses a homeserver outside the supported Staging and Production environments.",
    );
  }

  // A published PKDNS pointer alone does not prove an account exists. SDK
  // sign-in authenticates an existing account; it never creates one. Revoke
  // this temporary validation grant before accepting the identity.
  checkCurrent();
  const signer = pubky.signer(keypair);
  let session: Session | undefined;
  let failed = false;
  try {
    session = await signer.signin("pubky-ring-simulator.validation");
    const sessionInfo = session.info;
    const sessionPublicKey = sessionInfo.publicKey;
    try {
      if (sessionPublicKey.toString() !== expectedPublicKey)
        throw new Error(UNVERIFIED);
    } finally {
      sessionPublicKey.free();
      sessionInfo.free();
    }
    const grant = session.grant;
    if (!grant) throw new Error(UNVERIFIED);
    try {
      const grantInfo = await grant.sessionInfo();
      const grantHomeserver = grantInfo.homeserver;
      const grantPublicKey = grantInfo.publicKey;
      try {
        if (
          grantHomeserver.toString() !== config.homeserver ||
          grantPublicKey.toString() !== expectedPublicKey
        )
          throw new Error(UNVERIFIED);
      } finally {
        grantHomeserver.free();
        grantPublicKey.free();
        grantInfo.free();
      }
    } finally {
      grant.free();
    }
  } catch {
    failed = true;
  } finally {
    if (session) {
      try {
        await session.signout();
      } catch {
        failed = true;
      } finally {
        session.free();
      }
    }
    signer.free();
  }
  if (failed) throw new Error(UNVERIFIED);
}
