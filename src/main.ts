import pubkyPackage from "@synonymdev/pubky/package.json";
import { toSvg } from "jdenticon/browser";
import "./style.css";
import {
  RECOVERY_WORD_COUNT,
  RECOVERY_WORDS,
  isRecoveryWord,
  normalizeRecoveryWord,
  recoveryWordPaste,
} from "./recovery-input";
import {
  ENVIRONMENTS,
  approveAuthRequest,
  callbackUrlFor,
  disposeIdentity,
  importIdentity,
  parseAuthRequest,
  type AuthRequestPreview,
  type EnvironmentId,
  type SignerIdentity,
} from "./pubky";

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorConstructor;
  }
}

type Route = "identities" | "import" | "identity" | "rename" | "authorize";

interface Feedback {
  kind: "success" | "error" | "notice";
  message: string;
  action?: { label: string; url: string };
}

interface State {
  activeIdentityId?: string;
  authRequest?: AuthRequestPreview;
  busy?: string;
  environment: EnvironmentId;
  feedback?: Feedback;
  identities: SignerIdentity[];
  identityNames: Record<string, string>;
  route: Route;
  scanActive: boolean;
}

const PUBKY_SDK_URL = "https://www.npmjs.com/package/@synonymdev/pubky";
const PROJECT_URL = "https://github.com/its-gaib/pubky-ring-simulator";
const MAX_AUTH_LINK_LENGTH = 16_384;
const app = getAppElement();
const htmlEscapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
};
const state: State = {
  environment: "staging",
  identities: [],
  identityNames: {},
  route: "identities",
  scanActive: false,
};

// Neither recovery phrases nor unparsed auth links belong in application state.
// Every async completion must still belong to this in-memory session.
let sessionEpoch = 0;
let scanEpoch = 0;
let scanStream: MediaStream | undefined;
let scanDetector: BarcodeDetectorLike | undefined;
let scanTimer: number | undefined;
let scanCanvas: HTMLCanvasElement | undefined;

app.addEventListener("click", handleClick);
app.addEventListener("submit", handleSubmit);
app.addEventListener("paste", handleRecoveryPaste);
app.addEventListener("input", handleRecoveryInput);
app.addEventListener("focusout", handleRecoveryBlur);
app.addEventListener("keydown", handleRecoveryKeydown);
window.addEventListener("pagehide", () => clearSession());
window.addEventListener("pageshow", () => render());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && state.scanActive) {
    stopScanCapture();
    render();
  }
});

render();

function render() {
  app.innerHTML = `
    <main class="site-shell">
      <aside class="developer-banner">
        <span class="banner-icon" aria-hidden="true">${codeIcon()}</span>
        <div>
          <strong>Ring simulator · hosted edition</strong>
          <p>Approve requests with an existing identity on staging or production. Your recovery phrase gives this page control of that identity.</p>
        </div>
      </aside>

      <div class="simulator-layout">
        ${environmentSwitcher()}
        <section class="phone-stage" aria-label="Pubky Ring Simulator">
          <div class="phone">
            <span class="phone-button phone-button-volume-up" aria-hidden="true"></span>
            <span class="phone-button phone-button-volume-down" aria-hidden="true"></span>
            <span class="phone-button phone-button-power" aria-hidden="true"></span>
            <div class="phone-screen">
              <div class="phone-island" aria-hidden="true"><span></span></div>
              <div class="app-surface">
                ${appHeader()}
                <div class="screen-content">
                  ${feedbackView()}
                  ${pageForRoute()}
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <footer class="site-footer">
        <span>Keys stay in this tab and are cleared on reload.</span>
        <span class="sdk-version"><a href="${PUBKY_SDK_URL}" target="_blank" rel="noreferrer noopener">Pubky SDK</a> v${escapeHtml(pubkyPackage.version)}</span>
        <a href="${PROJECT_URL}" target="_blank" rel="noreferrer noopener">${githubIcon()} Fork source ${externalIcon()}</a>
      </footer>
    </main>
  `;
  attachScanVideo();
}

function environmentSwitcher() {
  const environment = ENVIRONMENTS[state.environment];
  return `
    <aside class="environment-panel" aria-label="Environment settings">
      <div class="environment-switcher" role="group" aria-label="Choose environment">
        <span class="side-panel-label">Environment</span>
        ${(["staging", "production"] as const)
          .map(
            (id) => `
          <button type="button" data-environment="${id}" class="environment-option ${state.environment === id ? "active" : ""}" aria-pressed="${String(state.environment === id)}" ${disabledAttr()}>
            <span class="mode-icon" aria-hidden="true">${keyringIcon()}</span>
            <strong>${escapeHtml(ENVIRONMENTS[id].label)}</strong>
          </button>
        `,
          )
          .join("")}
      </div>
      <div class="environment-detail">
        <span class="side-panel-label">Selected homeserver</span>
        <a href="${escapeHtml(environment.homeserverUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(new URL(environment.homeserverUrl).hostname)} ${externalIcon()}</a>
        <p>Switching environments clears imported keys and pending requests.</p>
        <button id="reset-session" class="text-button" type="button" ${disabledAttr()}>${trashIcon()} Clear this session</button>
      </div>
    </aside>
  `;
}

function appHeader() {
  return `
    <header class="app-header">
      ${state.route !== "identities" ? `<button id="go-back" class="app-back" type="button" aria-label="Go back" ${disabledAttr()}>${arrowLeftIcon()}</button>` : ""}
      <button id="go-home" class="brand" type="button" aria-label="Pubky Ring Simulator home" ${disabledAttr()}>
        <img src="/pubky-ring-logo.svg" alt="Pubky Ring" width="221" height="48">
        <span>SIMULATOR</span>
      </button>
      <span class="environment-badge ${state.environment}">${escapeHtml(ENVIRONMENTS[state.environment].label)}</span>
    </header>
  `;
}

function feedbackView() {
  if (state.busy)
    return `<div class="feedback progress" role="status"><span class="spinner" aria-hidden="true"></span><span>${escapeHtml(state.busy)}</span></div>`;
  const feedback = state.feedback;
  if (!feedback) return "";
  return `
    <div class="feedback ${feedback.kind}" role="${feedback.kind === "error" ? "alert" : "status"}">
      <span>${escapeHtml(feedback.message)}</span>
      ${feedback.action ? `<a href="${escapeHtml(feedback.action.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(feedback.action.label)} ${externalIcon()}</a>` : ""}
    </div>
  `;
}

function pageForRoute() {
  if (state.route === "import") return importPage();
  const identity = activeIdentity();
  if (identity) {
    if (state.route === "identity") return identityDetailPage(identity);
    if (state.route === "rename") return renamePage(identity);
    if (state.route === "authorize") return authorizePage(identity);
  }
  return identitiesPage();
}

function identitiesPage() {
  return `
    <section class="screen-section identity-screen">
      <div class="section-heading"><p class="eyebrow">${escapeHtml(ENVIRONMENTS[state.environment].label)}</p><h1>Your identities</h1></div>
      ${
        state.identities.length
          ? `<div class="identity-list">${state.identities.map(identityCard).join("")}</div>`
          : `
        <div class="empty-state">
          <span class="empty-icon" aria-hidden="true">${keyringIcon()}</span>
          <h2>Bring an existing pubky</h2>
          <p>Import its recovery phrase to approve sign-in requests. The identity must already be registered on the selected homeserver.</p>
        </div>
      `
      }
      <button id="show-import" class="button accent wide" type="button" ${disabledAttr()}>${plusIcon()} Import recovery phrase</button>
      <p class="helper">Imported keys are held in memory only.</p>
    </section>
  `;
}

function importPage() {
  return `
    <section class="screen-section import-screen">
      <div class="section-heading"><p class="eyebrow">${escapeHtml(ENVIRONMENTS[state.environment].label)}</p><h1>Import an identity</h1></div>
      <p class="intro">Enter the 12 recovery words for an existing identity, in order. We briefly sign in to ${escapeHtml(new URL(ENVIRONMENTS[state.environment].homeserverUrl).hostname)} to confirm the account exists, then sign out.</p>
      <form id="import-identity-form" class="stacked-form" autocomplete="off">
        <fieldset class="recovery-words" aria-describedby="recovery-word-help recovery-word-status" ${disabledAttr()}>
          <legend>Recovery phrase · 12 words</legend>
          <div class="recovery-word-grid">
            ${Array.from(
              { length: RECOVERY_WORD_COUNT },
              (_, index) => `
              <div class="recovery-word-field">
                <label for="recovery-word-${index + 1}" aria-hidden="true">${index + 1}.</label>
                <input id="recovery-word-${index + 1}" data-recovery-word="${index}" name="recovery-word-${index + 1}" aria-label="Word ${index + 1}" aria-describedby="recovery-word-status" type="text" list="bip39-words" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" maxlength="512" placeholder="word" required ${disabledAttr()}>
              </div>
            `,
            ).join("")}
          </div>
        </fieldset>
        <datalist id="bip39-words">${RECOVERY_WORDS.map((word) => `<option value="${word}"></option>`).join("")}</datalist>
        <p id="recovery-word-help" class="helper field-helper">Paste all 12 words into any field, or type one word at a time. Press Space or Tab to move forward.</p>
        <p id="recovery-word-status" class="recovery-word-status" role="status" aria-live="polite">0 of 12 words entered.</p>
        <p class="helper field-helper">All word fields are cleared as soon as you submit the phrase.</p>
        <button class="button accent wide" type="submit" ${disabledAttr()}>${checkIcon()} Verify and import</button>
      </form>
    </section>
  `;
}

function identityCard(identity: SignerIdentity, index: number) {
  return `
    <article class="identity-card">
      <button class="identity-summary" type="button" data-identity-id="${escapeHtml(identity.id)}" ${disabledAttr()}>
        ${identityAvatar(identity)}
        <span class="identity-copy"><strong>${escapeHtml(identityName(identity))}</strong><small>${escapeHtml(shortPubky(identity.publicKey))}</small></span>
        <span class="identity-chevron" aria-hidden="true">&gt;</span>
      </button>
      <button class="identity-authorize" type="button" data-authorize-identity-id="${escapeHtml(identity.id)}" ${disabledAttr()}>${scanIcon()} Authorize</button>
      <span class="identity-number" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
    </article>
  `;
}

function identityDetailPage(identity: SignerIdentity) {
  return `
    <section class="screen-section identity-detail-screen">
      <div class="identity-detail-card">
        ${identityAvatar(identity)}
        <h1>${escapeHtml(identityName(identity))}</h1>
        <p class="public-key">${escapeHtml(identity.publicKey)}</p>
        <span class="verified">${checkIcon()} Registered on ${escapeHtml(ENVIRONMENTS[state.environment].label)}</span>
        <dl class="request-details"><div><dt>Homeserver</dt><dd><code>${escapeHtml(identity.homeserver)}</code></dd></div></dl>
        <button class="button accent wide" type="button" data-authorize-identity-id="${escapeHtml(identity.id)}" ${disabledAttr()}>${scanIcon()} Authorize a request</button>
      </div>
      <div class="identity-secondary-actions">
        <button id="rename-identity" class="text-button" type="button" ${disabledAttr()}>${pencilIcon()} Rename</button>
        <button id="delete-identity" class="text-button destructive" type="button" ${disabledAttr()}>${trashIcon()} Remove key</button>
      </div>
    </section>
  `;
}

function renamePage(identity: SignerIdentity) {
  return `
    <section class="screen-section rename-screen">
      <div class="section-heading"><h1>Rename identity</h1></div>
      ${identityAvatar(identity)}
      <form id="rename-form" class="stacked-form">
        <label for="identity-name">Identity name</label>
        <input id="identity-name" name="name" type="text" value="${escapeHtml(identityName(identity))}" maxlength="40" autocomplete="off" required ${disabledAttr()}>
        <button class="button accent wide" type="submit" ${disabledAttr()}>Save</button>
      </form>
    </section>
  `;
}

function authorizePage(identity: SignerIdentity) {
  return `
    <section class="screen-section regular-authorize-screen">
      <div class="section-heading"><h1>${state.authRequest ? "Review sign-in" : "Authorize"}</h1></div>
      <div class="authorize-identity">${identityAvatar(identity)}<div><strong>${escapeHtml(identityName(identity))}</strong><small>${escapeHtml(identity.publicKey)}</small></div></div>
      ${state.authRequest ? authRequestPreview(state.authRequest) : authorizeSources()}
    </section>
  `;
}

function authorizeSources() {
  const cameraAvailable = Boolean(
    window.BarcodeDetector && navigator.mediaDevices?.getUserMedia,
  );
  return `
    <form id="preview-auth-form" class="stacked-form">
      <label for="auth-link">Approval link</label>
      <textarea id="auth-link" name="auth" rows="4" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="${MAX_AUTH_LINK_LENGTH}" placeholder="Paste the pubkyauth:// link from your app" required ${disabledAttr()}></textarea>
      <button class="button accent wide" type="submit" ${disabledAttr()}>Preview request</button>
      <button id="paste-authorize-link" class="button secondary wide" type="button" ${disabledAttr()}>${clipboardIcon()} Paste from clipboard</button>
    </form>
    <p class="helper">Preview the pasted link or scan a QR code to review permissions. Approval requires a separate click.</p>
    ${
      state.scanActive
        ? `
      <div class="capture-view"><video id="scan-video" autoplay muted playsinline aria-label="Camera QR scanner"></video><span>Looking for an approval QR code</span></div>
      <button id="stop-scan" class="button secondary wide" type="button">${closeIcon()} Stop camera</button>
    `
        : `
      <button id="start-scan" class="button secondary wide" type="button" ${disabledAttr(!cameraAvailable)}>${scanIcon()} Scan with camera</button>
      ${!cameraAvailable ? '<p class="helper">Camera QR scanning is unavailable in this browser. Paste the approval link above.</p>' : ""}
    `
    }
  `;
}

function authRequestPreview(request: AuthRequestPreview) {
  const source = request.xCallback?.xSource;
  return `
    <div class="request-preview">
      <p class="eyebrow">${request.authMode === "grant" ? "Grant-based sign-in" : "Cookie-based sign-in"}</p>
      <dl class="request-details">
        <div><dt>Environment</dt><dd>${escapeHtml(ENVIRONMENTS[state.environment].label)}</dd></div>
        <div><dt>App label <small>(provided by app)</small></dt><dd>${source ? escapeHtml(source) : "Not provided"}</dd></div>
        <div><dt>Client ID</dt><dd><code>${request.clientId ? escapeHtml(request.clientId) : "Not provided by this request"}</code></dd></div>
        <div><dt>Approval relay</dt><dd>${escapeHtml(request.relay)}</dd></div>
      </dl>
      <div class="permission-list"><h2>Requested access</h2>${request.capabilities.length ? request.capabilities.map(permissionPreview).join("") : '<p class="muted">No storage permissions requested.</p>'}</div>
      <div class="request-actions">
        <button id="approve-auth-request" class="button accent wide" type="button" ${disabledAttr()}>${checkIcon()} Approve sign-in</button>
        <button id="cancel-auth-request" class="button secondary wide" type="button" ${disabledAttr()}>Cancel</button>
      </div>
    </div>
  `;
}

function permissionPreview(capability: string) {
  const separator = capability.lastIndexOf(":");
  const scope = separator >= 0 ? capability.slice(0, separator) : capability;
  const actions = separator >= 0 ? capability.slice(separator + 1) : "";
  const access =
    actions === "rw"
      ? "Read and write"
      : actions === "r"
        ? "Read"
        : actions === "w"
          ? "Write"
          : actions || "Unspecified";
  return `<div class="permission"><span aria-hidden="true">${folderIcon()}</span><code>${escapeHtml(scope)}</code><small>${scope.endsWith("/") ? "Directory" : "Exact path"} · ${escapeHtml(access)}</small></div>`;
}

function handleClick(event: MouseEvent) {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>("button");
  if (!button || button.disabled || state.busy) return;

  const environment = button.dataset.environment;
  if (environment === "staging" || environment === "production") {
    if (environment !== state.environment) {
      clearSession();
      state.environment = environment;
      state.feedback = {
        kind: "notice",
        message: `Switched to ${ENVIRONMENTS[environment].label}. Import an identity to continue.`,
      };
      render();
    }
    return;
  }
  if (button.dataset.authorizeIdentityId) {
    navigate("authorize", button.dataset.authorizeIdentityId);
    return;
  }
  if (button.dataset.identityId) {
    navigate("identity", button.dataset.identityId);
    return;
  }
  switch (button.id) {
    case "go-home":
      navigate("identities");
      break;
    case "go-back":
      navigate(
        state.route === "authorize" || state.route === "rename"
          ? "identity"
          : "identities",
      );
      break;
    case "show-import":
      navigate("import");
      break;
    case "rename-identity":
      navigate("rename");
      break;
    case "delete-identity":
      deleteActiveIdentity();
      break;
    case "reset-session":
      clearSession();
      state.feedback = {
        kind: "notice",
        message: "Session cleared. All imported keys have been removed.",
      };
      render();
      break;
    case "paste-authorize-link":
      void handlePasteAuthorizeLink();
      break;
    case "approve-auth-request":
      void handleApproveAuthRequest();
      break;
    case "cancel-auth-request":
      handleCancelAuthRequest();
      break;
    case "start-scan":
      void handleStartScan();
      break;
    case "stop-scan":
      stopScanCapture();
      render();
      break;
  }
}

function handleSubmit(event: SubmitEvent) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (state.busy) return;
  if (form.id === "import-identity-form") void handleImportIdentity(form);
  if (form.id === "rename-form") handleRename(form);
  if (form.id === "preview-auth-form") {
    const input = form.querySelector<HTMLTextAreaElement>("#auth-link");
    if (!input) return;
    let value = input.value;
    input.value = "";
    previewAuthInput(value);
    value = "";
  }
}

async function handleImportIdentity(form: HTMLFormElement) {
  const inputs = recoveryWordInputs(form);
  if (inputs.length !== RECOVERY_WORD_COUNT) return;
  inputs.forEach(validateRecoveryWord);
  const invalid = inputs.find(
    (input) => !input.value || !isRecoveryWord(input.value),
  );
  if (invalid) {
    updateRecoveryWordStatus();
    invalid.reportValidity();
    invalid.focus();
    return;
  }
  let phrase = inputs
    .map((input) => normalizeRecoveryWord(input.value))
    .join(" ");
  clearSensitiveFields();
  const epoch = sessionEpoch;
  const environment = state.environment;
  state.feedback = undefined;
  state.busy = `Checking registration on ${ENVIRONMENTS[environment].label}…`;
  render();
  try {
    const pending = importIdentity(phrase, environment);
    phrase = "";
    const identity = await pending;
    if (sessionEpoch !== epoch || state.environment !== environment) {
      disposeIdentity(identity);
      return;
    }
    const existing = state.identities.find((item) => item.id === identity.id);
    if (existing) {
      disposeIdentity(identity);
      state.activeIdentityId = existing.id;
      state.feedback = {
        kind: "notice",
        message: "This identity is already imported.",
      };
    } else {
      state.identities.push(identity);
      state.activeIdentityId = identity.id;
      state.feedback = {
        kind: "success",
        message: `Identity verified on ${ENVIRONMENTS[environment].label}.`,
      };
    }
    state.route = "identity";
  } catch (error) {
    if (sessionEpoch === epoch)
      setCoreError(error, "Could not verify this recovery phrase. Try again.");
  } finally {
    phrase = "";
    if (sessionEpoch === epoch) {
      state.busy = undefined;
      render();
    }
  }
}

function handleRename(form: HTMLFormElement) {
  const identity = activeIdentity();
  const input = form.querySelector<HTMLInputElement>("#identity-name");
  const name = input?.value.trim().slice(0, 40);
  if (!identity || !name) return;
  state.identityNames[identity.id] = name;
  navigate("identity");
}

async function handlePasteAuthorizeLink() {
  const input = app.querySelector<HTMLTextAreaElement>("#auth-link");
  if (!input) return;
  if (!navigator.clipboard?.readText) {
    state.feedback = {
      kind: "notice",
      message:
        "Use your browser’s Paste command in the approval link field, then choose Preview request.",
    };
    render();
    return;
  }
  const epoch = sessionEpoch;
  try {
    let value = await navigator.clipboard.readText();
    if (sessionEpoch !== epoch || !input.isConnected || state.busy) return;
    if (!value.trim() || value.length > MAX_AUTH_LINK_LENGTH) {
      value = "";
      state.feedback = {
        kind: "error",
        message:
          "The clipboard does not contain a supported approval link. Paste a fresh link into the field.",
      };
      render();
      return;
    }
    input.value = value;
    value = "";
    input.focus();
  } catch {
    if (sessionEpoch !== epoch || !input.isConnected) return;
    state.feedback = {
      kind: "notice",
      message:
        "Clipboard access was unavailable. Paste into the approval link field, then choose Preview request.",
    };
    render();
  }
}

function previewAuthInput(input: string) {
  if (state.busy || state.route !== "authorize" || !activeIdentity()) return;
  stopScanCapture();
  clearSensitiveFields();
  state.feedback = undefined;
  state.authRequest = undefined;
  try {
    state.authRequest = parseAuthRequest(input, state.environment);
  } catch (error) {
    setCoreError(
      error,
      "This approval link is invalid for the selected environment.",
    );
  } finally {
    input = "";
  }
  render();
}

async function handleApproveAuthRequest() {
  const identity = activeIdentity();
  const request = state.authRequest;
  if (!identity || !request || state.busy) return;
  const epoch = sessionEpoch;
  const environment = state.environment;
  const isCurrent = () =>
    sessionEpoch === epoch &&
    state.environment === environment &&
    activeIdentity() === identity &&
    state.authRequest === request;
  state.busy = "Approving sign-in…";
  state.feedback = undefined;
  render();
  try {
    await approveAuthRequest(identity, request.url, environment, isCurrent);
    if (!isCurrent()) return;
    state.feedback = {
      kind: "success",
      message: `Sign-in approved with ${identityName(identity)}.`,
      action: feedbackAction(request, "success"),
    };
    state.route = "identity";
  } catch (error) {
    if (!isCurrent()) return;
    setCoreError(
      error,
      "Could not approve this request. Paste a fresh link to try again.",
    );
    if (state.feedback)
      state.feedback.action = feedbackAction(request, "error");
  } finally {
    if (sessionEpoch === epoch) {
      state.authRequest = undefined;
      state.busy = undefined;
      clearSensitiveFields();
      render();
    }
  }
}

function handleCancelAuthRequest() {
  const request = state.authRequest;
  if (!request || state.busy) return;
  const action = feedbackAction(request, "cancel");
  navigate("identity");
  state.feedback = {
    kind: "notice",
    message: "Authorization cancelled.",
    action,
  };
  render();
}

async function handleStartScan() {
  if (!window.BarcodeDetector || !navigator.mediaDevices?.getUserMedia) return;
  const epoch = sessionEpoch;
  const captureEpoch = ++scanEpoch;
  state.feedback = undefined;
  state.busy = "Waiting for camera access…";
  render();
  try {
    const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
    if (
      sessionEpoch !== epoch ||
      scanEpoch !== captureEpoch ||
      state.route !== "authorize" ||
      document.visibilityState === "hidden"
    ) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    scanDetector = detector;
    scanStream = stream;
    state.scanActive = true;
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (scanStream !== stream) return;
        stopScanCapture();
        render();
      });
    });
  } catch {
    if (sessionEpoch === epoch)
      state.feedback = {
        kind: "error",
        message:
          "Could not open the camera. Paste the approval link to continue.",
      };
  } finally {
    if (sessionEpoch === epoch) {
      state.busy = undefined;
      render();
      if (state.scanActive) queueScan(captureEpoch);
    }
  }
}

function attachScanVideo() {
  const video = app.querySelector<HTMLVideoElement>("#scan-video");
  const stream = scanStream;
  if (!video || !stream) return;
  video.srcObject = stream;
  void video.play().catch(() => {
    if (scanStream !== stream) return;
    stopScanCapture();
    state.feedback = {
      kind: "error",
      message: "Camera playback failed. Paste the approval link to continue.",
    };
    render();
  });
}

function queueScan(epoch: number) {
  window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => void scanCameraFrame(epoch), 250);
}

async function scanCameraFrame(epoch: number) {
  const detector = scanDetector;
  if (!state.scanActive || !detector || epoch !== scanEpoch) return;
  const video = app.querySelector<HTMLVideoElement>("#scan-video");
  if (
    !video ||
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    !video.videoWidth
  ) {
    queueScan(epoch);
    return;
  }
  try {
    const canvas = scanCanvas || document.createElement("canvas");
    scanCanvas = canvas;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No canvas context");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const barcodes = await detector.detect(canvas);
    if (!state.scanActive || epoch !== scanEpoch) return;
    const value = barcodes.find((barcode) => barcode.rawValue)?.rawValue;
    if (value) {
      previewAuthInput(value);
      return;
    }
    queueScan(epoch);
  } catch {
    if (!state.scanActive || epoch !== scanEpoch) return;
    stopScanCapture();
    state.feedback = {
      kind: "error",
      message:
        "Could not read this QR code. Paste the approval link to continue.",
    };
    render();
  }
}

function stopScanCapture() {
  ++scanEpoch;
  window.clearTimeout(scanTimer);
  scanTimer = undefined;
  const video = app.querySelector<HTMLVideoElement>("#scan-video");
  if (video) {
    video.pause();
    video.srcObject = null;
  }
  scanStream?.getTracks().forEach((track) => track.stop());
  scanStream = undefined;
  scanDetector = undefined;
  if (scanCanvas) {
    scanCanvas.width = 0;
    scanCanvas.height = 0;
    scanCanvas = undefined;
  }
  state.scanActive = false;
}

function navigate(route: Route, identityId = state.activeIdentityId) {
  if (state.busy) return;
  ++sessionEpoch;
  stopScanCapture();
  clearSensitiveFields();
  state.authRequest = undefined;
  state.feedback = undefined;
  state.route = route;
  state.activeIdentityId = identityId;
  render();
}

function clearSession() {
  ++sessionEpoch;
  stopScanCapture();
  clearSensitiveFields();
  for (const identity of state.identities) disposeIdentity(identity);
  state.identities = [];
  state.identityNames = {};
  state.activeIdentityId = undefined;
  state.authRequest = undefined;
  state.feedback = undefined;
  state.busy = undefined;
  state.route = "identities";
}

function clearSensitiveFields() {
  app
    .querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement
    >("[data-recovery-word], #auth-link")
    .forEach((input) => {
      input.value = "";
    });
}

function recoveryWordInputs(root: ParentNode = app): HTMLInputElement[] {
  return Array.from(
    root.querySelectorAll<HTMLInputElement>("[data-recovery-word]"),
  );
}

function recoveryWordTarget(event: Event): HTMLInputElement | undefined {
  const input = event.target;
  return input instanceof HTMLInputElement &&
    input.matches("[data-recovery-word]")
    ? input
    : undefined;
}

function validateRecoveryWord(input: HTMLInputElement) {
  input.value = normalizeRecoveryWord(input.value);
  const invalid = Boolean(input.value) && !isRecoveryWord(input.value);
  input.setCustomValidity(
    invalid ? "Enter one English BIP39 recovery word." : "",
  );
  if (invalid) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

function updateRecoveryWordStatus(message?: string) {
  const status = app.querySelector<HTMLElement>("#recovery-word-status");
  if (!status) return;
  const inputs = recoveryWordInputs();
  const invalid = inputs.filter(
    (input) => input.getAttribute("aria-invalid") === "true",
  );
  status.textContent =
    message ||
    (invalid.length
      ? `Check word ${invalid.map((input) => Number(input.dataset.recoveryWord) + 1).join(", ")}. Use English BIP39 words.`
      : `${inputs.filter((input) => input.value.trim()).length} of 12 words entered.`);
  status.classList.toggle("error", Boolean(message) || invalid.length > 0);
}

function handleRecoveryInput(event: Event) {
  const input = recoveryWordTarget(event);
  if (!input || state.busy) return;
  // Clear stale validation while the word is being corrected. Validate on blur.
  input.setCustomValidity("");
  input.removeAttribute("aria-invalid");
  updateRecoveryWordStatus();
}

function handleRecoveryBlur(event: FocusEvent) {
  const input = recoveryWordTarget(event);
  if (!input || state.busy) return;
  validateRecoveryWord(input);
  updateRecoveryWordStatus();
}

function handleRecoveryPaste(event: ClipboardEvent) {
  const input = recoveryWordTarget(event);
  if (!input || state.busy || !event.clipboardData) return;
  event.preventDefault();
  let pasted = event.clipboardData.getData("text/plain");
  let words: string[] = [];
  try {
    const plan = recoveryWordPaste(pasted, Number(input.dataset.recoveryWord));
    words = plan.words;
    if (!words.length) return;
    const inputs = recoveryWordInputs();
    if (words.length === 1) {
      input.setRangeText(
        words[0],
        input.selectionStart ?? 0,
        input.selectionEnd ?? input.value.length,
        "end",
      );
      validateRecoveryWord(input);
    } else {
      words.forEach((word, offset) => {
        const field = inputs[plan.startIndex + offset];
        field.value = word;
        validateRecoveryWord(field);
      });
      const next =
        inputs[
          Math.min(plan.startIndex + words.length, RECOVERY_WORD_COUNT - 1)
        ];
      next.focus();
      next.select();
    }
    updateRecoveryWordStatus();
  } catch {
    updateRecoveryWordStatus(
      "That paste does not fit. Use a 12-word phrase or fewer words in the remaining fields.",
    );
  } finally {
    pasted = "";
    words.fill("");
  }
}

function handleRecoveryKeydown(event: KeyboardEvent) {
  const input = recoveryWordTarget(event);
  if (
    !input ||
    state.busy ||
    event.isComposing ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  )
    return;
  const inputs = recoveryWordInputs();
  const index = Number(input.dataset.recoveryWord);
  if (event.key === " " && input.value.trim()) {
    event.preventDefault();
    validateRecoveryWord(input);
    updateRecoveryWordStatus();
    if (isRecoveryWord(input.value) && index < RECOVERY_WORD_COUNT - 1) {
      inputs[index + 1].focus();
      inputs[index + 1].select();
    }
  } else if (event.key === "Backspace" && !input.value && index > 0) {
    event.preventDefault();
    inputs[index - 1].focus();
  }
}

function deleteActiveIdentity() {
  const identity = activeIdentity();
  if (!identity || state.busy) return;
  disposeIdentity(identity);
  state.identities = state.identities.filter((item) => item !== identity);
  delete state.identityNames[identity.id];
  navigate("identities", state.identities[0]?.id);
}

function activeIdentity() {
  return state.identities.find(
    (identity) =>
      identity.id === state.activeIdentityId &&
      identity.environment === state.environment,
  );
}

function identityName(identity: SignerIdentity) {
  return (
    state.identityNames[identity.id] ||
    `Identity ${String(state.identities.indexOf(identity) + 1).padStart(2, "0")}`
  );
}

function identityAvatar(identity: SignerIdentity) {
  return `<span class="identity-avatar" aria-hidden="true">${toSvg(identity.publicKey, 48)}</span>`;
}

function feedbackAction(
  request: AuthRequestPreview,
  outcome: "success" | "error" | "cancel",
) {
  const url = callbackUrlFor(request, outcome);
  if (!url) return undefined;
  return { label: `Return to ${new URL(url).hostname}`, url };
}

function setCoreError(error: unknown, fallback: string) {
  state.feedback = {
    kind: "error",
    message: error instanceof Error ? error.message : fallback,
  };
}

function shortPubky(value: string) {
  return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

function disabledAttr(disabled = false) {
  return state.busy || disabled ? "disabled" : "";
}

function getAppElement() {
  const element = document.querySelector<HTMLDivElement>("#app");
  if (!element) throw new Error("Missing #app element");
  return element;
}

function escapeHtml(value: unknown) {
  return String(value).replace(
    /[&<>"']/g,
    (character) => htmlEscapes[character],
  );
}

function svgIcon(path: string) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}
function checkIcon() {
  return svgIcon('<path d="m5 12 4 4L19 6"/>');
}
function closeIcon() {
  return svgIcon('<path d="m6 6 12 12M18 6 6 18"/>');
}
function clipboardIcon() {
  return svgIcon(
    '<path d="M9 5H7a2 2 0 0 0-2 2v12h14V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/>',
  );
}
function folderIcon() {
  return svgIcon(
    '<path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"/>',
  );
}
function pencilIcon() {
  return svgIcon(
    '<path d="m4 20 4.2-1 10.4-10.4a2 2 0 0 0-2.8-2.8L5.4 16.2 4 20Z"/><path d="m14.5 7.1 2.8 2.8"/>',
  );
}
function arrowLeftIcon() {
  return svgIcon('<path d="m15 18-6-6 6-6"/>');
}
function plusIcon() {
  return svgIcon('<path d="M12 5v14M5 12h14"/>');
}
function keyringIcon() {
  return svgIcon(
    '<circle cx="9" cy="14" r="4"/><path d="m12 11 7-7m-3 3 2 2M5 5l2 2"/>',
  );
}
function codeIcon() {
  return svgIcon('<path d="m8 9-3 3 3 3m8-6 3 3-3 3m-2-9-4 12"/>');
}
function trashIcon() {
  return svgIcon(
    '<path d="M4 7h16m-10 4v5m4-5v5M9 7l1-3h4l1 3m3 0-1 13H7L6 7"/>',
  );
}
function scanIcon() {
  return svgIcon(
    '<path d="M4 8V5a1 1 0 0 1 1-1h3m8 0h3a1 1 0 0 1 1 1v3m0 8v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/>',
  );
}
function externalIcon() {
  return svgIcon(
    '<path d="M14 5h5v5m0-5-8 8"/><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  );
}
function githubIcon() {
  return svgIcon(
    '<path d="M15 22v-3.9c0-1 .1-1.5-.5-2.1 2.8-.3 5.7-1.4 5.7-6.2 0-1.3-.5-2.4-1.3-3.3.1-.3.6-1.6-.1-3.3 0 0-1.1-.3-3.5 1.3a12 12 0 0 0-6.3 0C6.6 2.9 5.5 3.2 5.5 3.2c-.7 1.7-.2 3-.1 3.3-.8.9-1.3 2-1.3 3.3 0 4.8 2.9 5.9 5.7 6.2-.5.5-.6 1.1-.6 2.1V22"/><path d="M9.2 19c-2.8.9-2.8-1.5-4-2"/>',
  );
}
