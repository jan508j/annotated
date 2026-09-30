# Annotated

**Make your point. Keep the evidence attached.**

Annotated is a Chrome side-panel extension and web app for discussing an exact passage or moment. Select text, capture a short video or podcast excerpt, add your own take, and share a public page where the source and discussion stay together.

[Live preview](https://annotated.beer) · [Public feed](https://annotated.beer/feed) · [Install the live extension](https://annotated.beer/install)

This is the source handoff for version **0.1.24**. It contains the application, extension, tests and original local fixtures. The code does not contain production accounts, credentials or user recordings. The home-page video in this repository is clearly labeled generated test footage; the live demonstration uses a different clip. The source and take examples on the home page are illustrative, not evidence of independent users.

## What you can try

- Article annotations with up to five passages from one source, within 100 words total.
- Explicit video or audio capture, up to 90 seconds; published video is limited to 240 pixels high.
- Typed takes, speech-to-text dictation, and separately labeled optional audio notes.
- Public receipts, replies, source discussions, profiles, follows, and Text/Video/Audio feed filters.
- Wide and Tall PNG cards; Post to X opens an editable draft for the user to send.
- Responsive reading and an article editor on phones. Video/audio source capture requires desktop Chrome.
- Google/X sign-in in production, with clearly labeled test identities for local development.

No LLM service or API key is needed. People supply the commentary. Chrome's dictation service has its own microphone/network requirements.

## Run locally

Use **Node.js 24.x**, **FFmpeg/ffprobe**, **zip**, and desktop **Chrome 116+** (current stable recommended). The commands below target macOS/Linux. Windows contributors can use a Linux development environment for the server; native Windows packaging is not verified. The package script currently invokes `/usr/bin/zip`.

```sh
npm ci
node scripts/fixtures.mjs
npm run package
npm start
```

Open **http://127.0.0.1:4317**. No `.env` file or cloud account is needed. Local mode uses SQLite and disk files in ignored `.data/`; keep it bound to loopback. Start in a shell without production environment variables. `.env.example` documents optional configuration; never commit filled credentials.

Use the **Mira** and **Leo** local test accounts in the navigation to exercise replies, follows and ownership. They are synthetic test identities and are disabled in production.

### Try the local extension

1. Open `chrome://extensions`, enable Developer mode, then choose **Load unpacked**.
2. Select `artifacts/extension/` from this checkout. Pin Annotated.
3. Open the [original test article](http://127.0.0.1:4317/fixtures/article.html), [video fixture](http://127.0.0.1:4317/fixtures/video.html), or [audio fixture](http://127.0.0.1:4317/fixtures/audio.html).
4. Click the toolbar icon to grant temporary access to that tab. Choose a local test account in the panel, select a passage or interval, and publish.

The generated local ZIP is `artifacts/annotated-extension.zip`. It connects only to your local service; use the live install page if you want to use annotated.beer. The local extension has no production account session. After changing extension files, rebuild the package, reload its Chrome card, and refresh the source tab.

**Dictate** converts speech to editable text. **Attach an audio note** records a separate audio attachment. Chrome may require a permission-recovery tab for the first microphone grant; the UI explains this after an actual failure.

## Verify

```sh
npm test
npm run check
```

With the local server running in a second terminal:

```sh
node scripts/smoke.mjs
```

The smoke check uses generated video/audio, publishes labeled local examples, adds a second-account reply, follows an author, verifies byte-range playback, and checks ownership and private claim access. It refuses a non-loopback target. Results are written to ignored `artifacts/smoke/`.

This source handoff passes **192 tests** and **82 JavaScript syntax checks** (including its generated-preview script). These cover capture state, cancellation, stale source updates, dictation, auth/ownership, filtering, profiles, sharing, uploads and media limits. They complement real Chrome capture and microphone testing; they do not replace it. The optional manual GitHub workflow runs the same tests without deployment credentials.

Tests rebuild package fixtures. Run `npm run package` again after testing before loading a local extension; rebuild a production package last if deploying your own instance.

## How it fits together

| Directory | Responsibility |
| --- | --- |
| `extension/` | Manifest V3 panel, source discovery, explicit tab capture, dictation, and shared visual tokens/fonts |
| `web/` | Web UI, profiles, feeds, phone article editor, public receipts and original fixtures |
| `server/` | Node HTTP API, auth, database/storage adapters, media processing and PNG rendering |
| `shared/` | Source identity, ranges/passages, article drafts and reusable share UI |
| `api/` | Vercel HTTP adapter |
| `scripts/` | Fixture generation, packaging, verification and optional deployment staging |
| `test/` | Node's built-in test runner and local test fixtures |

The web app uses native JavaScript/CSS, and the extension stays plain HTML/CSS/JS. Local storage is SQLite/disk; the hosted configuration supports PostgreSQL and private Vercel Blob. FFprobe validates actual media, and FFmpeg normalizes recordings before publication. Public share metadata is rendered by the server.

See [the API contract](shared/contract.md) and [deployment configuration](DEPLOYMENT.md) for the details. Importing this repository into GitHub does not connect it to the live service or trigger a deployment.

## Boundaries worth knowing

- Recording starts only after an explicit action. Cancellation/source loss stops capture tracks. Unsupported or protected players may refuse capture.
- Passage links use source timestamps or browser text fragments; highlighting depends on the source page and browser.
- X's web composer accepts the text/link draft. It does not accept an automatically attached local PNG; use **Share as image** for image download/copy.
- iPhone article entry uses copied links/text; Android installed-web-app sharing depends on browser/OS support. There is no phone video recorder or App Store app here.
- New installations require unpacked-extension setup. This preview is not a Chrome Web Store listing.
- Deleting/hiding published material removes it from public access; it is not permanent storage erasure. Unreferenced draft cleanup is separate. Broader deployment needs an operator's backup/restore and retention plan.

## License and assets

The application code is available under the [MIT License](LICENSE). Third-party assets and dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The bundled fonts retain their OFL license files. This license does not grant rights to third-party articles, videos or other source material that users annotate.

The original generated media in this source handoff can be regenerated with `node scripts/source-preview.mjs`. It contains no downloaded videos, user uploads, or people.
