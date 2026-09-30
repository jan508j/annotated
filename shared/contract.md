# Product contract

Local base URL: `http://127.0.0.1:4317`. Node 24, SQLite locally or Neon Postgres in the cloud, and FFmpeg; install locked dependencies with `npm ci`. UI static files under `web/`; extension under `extension/`. Local mode binds loopback and clearly labels demo identities/content. Production uses a separate clean database and private media storage, canonical HTTPS origin, Google web-client credentials, extension-ID allowlist and operator-email allowlist. See `.env.example` and README for deployment configuration. Provider-mocked tests establish implementation behavior, not live Google/Chrome verification.

## Objects

User: `{id,name,handle,color,isDemo,isAdmin}`.
Source: `{id,key,url,title,kind,author}`; kind `video|audio|article`. Canonicalization helpers in `shared/source.mjs`, shared with frontend and copied into extension by packaging. `sourceKey` hashes generic URLs locally for lookup privacy.
Annotation: `{id,source,author,excerpt,excerpts,start,end,commentary,mediaUrl,voiceUrl,createdAt,commentCount,isDemo}`. `excerpts` contains separate article passages (up to five, 100 words/2000 characters combined); legacy `excerpt` joins them with an explicit omission marker. Existing rows fall back to a single passage. Each annotation has one source. Times are seconds or null for articles. `mediaUrl`/`voiceUrl` are relative `/media/:id` paths. Comments `{id,author,text,createdAt}`. IDs are opaque strings. Dates ISO strings.
Errors: HTTP 4xx/5xx `{error: 'readable message'}`. No stack traces/secrets. Lists may use simple `limit` with bounded defaults; do not invent complicated pagination for initial slice.

Unpublished media retention: files without any annotation reference become eligible for deletion 24 hours after upload. On local disk a sweep runs at service startup and every 15 minutes, with up to 100 database rows and 100 old generated files per storage directory per pass. Recent files, unrelated files, symlinks and all annotation references (including hidden/deleted annotations) are preserved. Old crash-orphaned final/temp files are removed; deletion failures keep retryable state. Publication with a missing/expired upload returns 410 and asks for re-recording; an unchanged successfully published retry still returns the original annotation. Cloud cleanup runs hourly through an authenticated cron endpoint, up to 50 expired raw uploads and 50 unreferenced normalized files per pass. Raw uploads remain private until cleanup; their path-scoped tokens expire after ten minutes. Postgres row locks protect publication against concurrent deletion. Backups and permanent erasure of published records are outside this draft-retention rule.

## API

- `GET /api/health` → `{ok:true,mode:'local'|'production',oauthConfigured:boolean}`
- `GET /api/session` → `{user:null|User,mode:'local'|'production',oauthConfigured:boolean,extensionAvailable:boolean,mediaStorage:'disk'|'blob',supportEmail:string}`. Production download availability requires a packaged origin and key-derived Chrome ID matching server configuration.
- `POST /api/dev/session` `{persona:'mira'|'leo'}` → `{user,token}`; set HttpOnly same-site session cookie for web. Bearer token also works for extension. Endpoint strictly local development only; enforce loopback host and expected Origin. Extension local origin allowed only with explicit development restrictions. Mira is local operator.
- `POST /api/logout` → `{ok:true}` revoke session, clear cookie.
- `GET /auth/google/start?returnTo=/local/path` starts website Google sign-in; rejects external redirects. For extension sign-in use `extensionId` and `codeChallenge` (S256), without `returnTo`.
- `GET /auth/google/callback` verifies browser-bound state, nonce, provider PKCE and Google ID-token claims. State expires after 10 minutes and is consumed once. Web flow sets a Secure, HttpOnly, SameSite=Lax cookie; extension flow redirects to exactly `https://<allowed-id>.chromiumapp.org/annotated?code=<grant>`.
- `POST /api/auth/extension/exchange` `{code,codeVerifier}` → `{token,user}`. Requires the matching allowlisted extension Origin and PKCE verifier; grant expires after 2 minutes and is consumed once. Sessions expire after 7 days in production or 24 hours locally; only token hashes are stored. Google client secrets stay server-side, and public user objects omit email/provider subject.
- `GET /api/feed?following=1` → `{annotations:[Annotation]}`; optional following filter needs auth.
- `POST /api/sources/lookup` `{key}` → `{source:null|Source,annotations:[]}`. No raw URL required in this endpoint.
- `GET /api/sources/:id` → `{source,annotations:[]}`.
- `POST /api/media/uploads` (cloud only) `{role,contentType,size}` → `{id,pathname,clientToken,contentType,expiresAt}`. Authenticate and reserve daily/monthly/storage capacity atomically. The short-lived token permits one exact private upload. Client uses bundled Vercel `put` with that token.
- `POST /api/media/uploads/:id/complete` (cloud only) → `{id,url,duration,width,height}`. Owner-only one-time processing; retries after success return the same media. Download, inspect, normalize and persist before returning. Raw/final store URLs are never exposed as public access paths.
- `GET /api/cron/media-cleanup` requires the secret cron Bearer authorization; processes a bounded cleanup batch.
- `POST /api/media` (disk only) raw body with `Content-Type` and `X-Media-Role: source-video|source-audio|voice` → `{id,url,duration,width,height}`. Authenticate, bound bytes, ffprobe, FFmpeg normalize to <=240p video/<=90 sec media, no shell interpolation/network protocols. Reject oversized/invalid media. Input duration permits only 20ms of container packet padding; normalization cuts at 89.98 seconds to keep published files strictly <=90. Source ranges remain strictly <=90 and must match measured clip duration within 350ms. Audio and voice normalize to AAC/M4A, video to H.264/AAC MP4.
- `POST /api/annotations` `{clientId,source:{url,title,kind,author},excerpt,excerpts?,start,end,commentary,mediaId,voiceMediaId,isDemo?}` → `{annotation}`. Auth; idempotent `clientId`; validate source URL and canonical key; 1–5 separate article passages, <=100 words and <=2000 chars combined; legacy excerpt-only clients remain accepted; <=2000 chars commentary; at least text or voice commentary. Media must belong to user, source-video/audio needs corresponding valid media. Server enforces demo=true for local development publications.
- `GET /api/annotations/:id` → `{annotation,comments:[]}`.
- `GET|HEAD /api/annotations/:id/share-card.png` → genuine 1200×630 PNG for a public annotation. `?download=1` requests an attachment. Author/take, distinct source evidence, attribution and local-demo labeling use bundled Bracket fonts. Hidden/deleted/missing annotations return 404; hidden media must not appear. Anonymous requests never fetch remote images.
- `DELETE /api/annotations/:id` → `{ok:true}` owner only; hide media with post.
- `POST /api/annotations/:id/comments` `{text}` → `{comment}` auth; 1–1000 chars.
- `DELETE /api/comments/:id` → `{ok:true}` owner/operator.
- `GET /api/users/:id` → `{user,annotations:[],isFollowing:false,followerCount:0}`.
- `POST /api/users/:id/follow` `{following:boolean}` → `{following}` auth.
- `POST /api/claims` `{annotationId,name,email,reason,details}` → `{reference}` public intake, no contact details in public APIs.
- `GET /api/admin/claims` → `{claims:[]}` operator-only.
- `POST /api/admin/claims/:id` `{action:'hide'|'reject'|'restore',scope:'annotation'|'media',note}` → `{ok:true}` operator-only. Feed/source counts and media access reflect hidden state.

## Pages and fixtures

Server serves the SPA for `/`, `/a/:id`, `/s/:id`, `/u/:id`, `/install`, `/privacy`, `/terms`, `/admin/claims`. Public receipts lead with the author and take, then a distinct source block; their escaped metadata includes the canonical share-card image. Hidden/deleted/missing receipts return 404. `/extension.zip` serves the matching local or production artifact. `/fixtures/article.html`, `/fixtures/video.html`, `/fixtures/audio.html` and generated media are original illustrative local content; production refuses fixture routes and demo-contaminated databases.

Local DB seed may contain two explicitly marked demo article annotations and one demo response using the local article URL. Production never seeds them. Seed is UI evidence only, never real-use evidence. No guessed external source quotes, endorsements, real user identities or copyright media in fixtures.

## Extension

Native MV3, sidebar, activeTab, scripting, storage, tabCapture, offscreen. Local package permits loopback; production adds identity permission and exactly one configured HTTPS API origin. `config.mjs` configures panel, worker and offscreen requests. Production login uses Chrome identity with PKCE; stored sessions are scoped to API origin. Production packaging has a stable public pilot manifest key, overridable with an official public store key; no private key is packaged.

Action opens sidebar and activates source discovery. Worker stream ID -> offscreen recorder; canvas crop player area before encoding, audio relay, explicit range replay and recording progress. Article path uses selected text; podcast uses native HTML audio; source discussion lookup and timestamp jump. Test identities are visibly local-only. Actual installed Chrome capture, permissions and OAuth remain manual release gates.

The author/take leads the composer; text can be edited during source recording, while microphone recording remains disabled. Both range sliders span the full finite media duration. Editing one endpoint preserves the other timestamp and thumb; visible precise times and ±1-second controls support fine adjustment. Temporary reversed or >90-second ranges disable Record without moving either endpoint. Server and capture constraints remain <=90 seconds. A successful publication holds its returned annotation and share URL until explicit New annotation or account cleanup; it does not reset on a timer. X links open an explicit draft, never automatically post.

Article highlights support explicit Add, Replace and Remove within one source; separate passages remain separate in receipts/feed/share cards. Feed and My annotations reuse the existing web feed/profile. Publisher/author identity is derived from the source URL and captured metadata; no remote avatar/logo fetching. X selection must belong to the post identified by the URL.
