# Pubky Ring Simulator

**How this fork differs from upstream:** This version works with the public **staging and
production** environments, selected in the interface. It imports an existing identity from its
recovery phrase and verifies that the identity is registered with the selected homeserver.
**Account creation, generated identities, local testnet setup, and Quick Mode are removed.**

**Live simulator:** [pubky-ring-simulator.vercel.app](https://pubky-ring-simulator.vercel.app/)

**Dev tooling — NOT SAFE. Only use with throwaway identities!**

Fork of [pubky/pubky-ring-simulator](https://github.com/pubky/pubky-ring-simulator).
The original simulator is designed to create disposable identities on a local testnet.

## Use the simulator

1. Select **Staging** or **Production**. Staging is selected initially.
2. Enter the existing identity's 12-word English BIP39 recovery phrase in the numbered, visible
   fields, or paste the complete phrase into any field. Local word suggestions help with spelling;
   Space and Tab move between fields. Invalid phrases, identities
   without a published homeserver, and identities registered in the other environment are
   rejected. A network or server failure is reported as an inability to verify the identity.
   After verification, the simulator reads the public profile using `pubky-app-specs` and
   displays its name and photo. Missing or unavailable names fall back to `Identity 01`,
   `Identity 02`, and so on; unavailable photos fall back to the generated avatar.
3. Paste a `pubkyauth://` sign-in request into the approval form and preview it. Camera scanning
   is also available when the browser supports QR detection; pasting works in Firefox.
4. Review the selected identity, environment, requesting application, relay, and permissions,
   then explicitly approve or decline. Pasting or scanning never approves automatically.

Both grant-based and legacy cookie sign-in requests are supported. Signup and direct-signup
requests are rejected in the signing code. Approval links must use the selected environment's
official HTTPS relay. HTTPS callback links, when provided, are opened only by an explicit click.

## Environments

| Environment | Homeserver | Approval relay |
|---|---|---|
| Staging | `https://homeserver.staging.pubky.app` | `https://httprelay.staging.pubky.app/inbox` |
| Production | `https://homeserver.pubky.app` | `https://httprelay.pubky.app/inbox` |

Both environments use the public PKARR network. The selector checks that the imported Pubky
identity resolves to the official homeserver for that environment; it does not migrate accounts.
Custom homeservers, custom relays, and local testnets are outside this fork's supported profiles.

Registration is verified by resolving the identity's signed homeserver record and authenticating
an existing account with a temporary SDK session. The session's identity and homeserver must
match, and its validation grant is revoked immediately. If verification or revocation fails,
the import is rejected. This check runs again before approving an application request.
SDK sign-in can refresh an existing PKARR record; it does not create an account.

## Keys stay in the current tab

The phrase is used locally to derive the same key as Pubky Ring: English BIP39 with an empty
passphrase, using the first 32 bytes of the derived seed. All word fields are cleared on submission.
Loaded keys, names, and profile pictures are held in memory. They are not saved to localStorage,
IndexedDB, or a backend. Reloading, closing the page, or switching environments forgets them.
Removing an identity from this tab leaves its homeserver account intact.

Profile data is read without credentials from the selected homeserver. Supported photos use
the identity's Pubky file and blob records; invalid or unavailable image data keeps the generated
avatar. PNG, JPEG, WebP, and GIF images are limited to 5 MiB, 8192 pixels per side, and 16 million
pixels. Profile loading times out after eight seconds. Renaming an identity overrides its profile
name in this tab. The verified public key stays visible when reviewing approvals.

This is an experimental browser signing tool, not the native Pubky Ring application. Importing a
phrase gives the code served by this origin access to its signing key. The hosted site and its
operator must be trusted with that access. Memory cleanup is not a guarantee of forensic erasure.
There are no analytics, session recordings, or third-party scripts. Authorization secrets and
recovery phrases are not included in logs or diagnostic messages.

## Development

Use Node.js 22.12 or newer.

```bash
npm ci
npm run dev
```

The development server uses the same staging/production profiles. No local Pubky Docker stack
or homeserver admin credentials are needed.

```bash
npm test
npm run check
npm run build
npm run audit
```

The automated tests cover the import/registration policy, mnemonic derivation, environment
isolation, sign-in parsing, signup rejection, and approval consent boundaries. Testing approval
against a real account requires its owner to import and approve personally.

## Deployment

Deploy the static `dist/` output with the included `vercel.json`. It sets a restrictive Content
Security Policy, disables framing, suppresses referrers, and limits network connections to the
official PKARR, homeserver, and approval relay origins. Dependencies and the logo are bundled
locally. The inherited GitHub Pages deployment workflow is removed because this deployment uses
Vercel's response headers.

```bash
vercel --prod
```

Use equivalent response headers when deploying with another host. Do not add analytics or
session replay to a page that handles recovery phrases.
