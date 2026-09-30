# Running your own instance

Local setup in [README.md](README.md) is sufficient for reviewing the product. Production requires your own hosting, database, storage and OAuth configuration. This repository has no cloud-project link, deployment token, production data or automated deployment workflow.

## Production configuration

Use `.env.example` as a list of settings; put secrets in the hosting provider's private environment configuration. Do not use a local demo database in production.

| Setting | Your value |
| --- | --- |
| `APP_MODE` | `production` |
| `NODE_ENV` | `production` |
| `BASE_URL` | Your canonical public HTTPS origin, without a path |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Your Google Web application OAuth client; required by production mode |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | Optional X OAuth 2.0 confidential Web App client; set both to enable X |
| `EXTENSION_IDS` | Comma-separated IDs of your packaged extensions |
| `ADMIN_EMAILS` | Verified Google emails allowed to moderate replies and review claims |
| `ADMIN_DISPLAY_NAME` | Optional public name override for your operator |
| `SUPPORT_EMAIL` | Your public support/claims contact |
| `DATA_DIR` | Persistent directory for disk mode; `/tmp/annotated` for temporary cloud processing |

The server requires Google in production even if you also enable X. Google and X identities stay separate; X does not confer operator privileges. Register callbacks at `https://YOUR_DOMAIN/auth/google/callback` and `https://YOUR_DOMAIN/auth/x/callback`. Set provider website/privacy/terms URLs to your own instance. Google uses OpenID/email/profile; X uses `tweet.read users.read` only for identity, with no posting scope or token persistence.

The database initializes/checks the required schema on startup. Use a new development database first and verify backups before connecting an existing production database.

## Build your production extension

Keep your own stable RSA **public** key for a separately distributed extension. `scripts/package.mjs` retains the pilot's public key as a compatibility default; that public value is not a credential. Forks should explicitly override it rather than reuse the live preview's identity. Never give a private signing key to this script or commit it.

```sh
# Replace these public example values with your own origin and public key.
APP_MODE=production \
  BASE_URL=https://your-domain.example \
  EXTENSION_PUBLIC_KEY=YOUR_BASE64_DER_RSA_PUBLIC_KEY \
  npm run package
```

The script prints the derived extension ID; add it to your server's `EXTENSION_IDS`. It writes `artifacts/production-extension/` and `artifacts/production-extension.zip`. It does not install, upload or deploy anything.

For Blob storage, add `MEDIA_STORAGE=blob` when packaging. This bundles the client upload SDK and permits its exact upload API host. OAuth secrets and the storage token never belong in an extension package.

## Vercel + PostgreSQL + private Blob

In addition to the settings above, configure:

- `DATABASE_URL`: your PostgreSQL connection string, with the provider's required TLS settings.
- `MEDIA_STORAGE=blob` and `BLOB_READ_WRITE_TOKEN`: a token for your **private** Blob store.
- `CRON_SECRET`: a random value at least 32 characters long for authenticated draft cleanup.
- `DATA_DIR=/tmp/annotated` for temporary media processing.

Install dependencies with `npm ci`, run the tests, build the Blob-enabled production extension, then stage the release:

```sh
node scripts/stage-vercel.mjs
```

Only the allowlisted runtime inputs go into `artifacts/vercel-app/`. Run the Vercel CLI from that staging directory and choose **your own project**. Never link a fork to the live Annotated project. The staging script recreates its output directory; it does not deploy.

The app enforces the canonical Host. An arbitrary generated deployment URL will not behave like your configured `BASE_URL`. Verify the configured domain, sign-in, extension download and published media after deploying to your own test environment.

`vercel.json` describes a Node function and authenticated hourly cleanup. The default pilot allowance is 20 uploads/day, 200/month and 1 GiB reserved storage across an instance; these settings are not a hosting billing cap. Input files are limited to 30 MiB; normalized output to 12 MiB, 90 seconds, and 240px for video.

`scripts/cloud-smoke.mjs` is an optional integration check for a deliberately isolated PostgreSQL schema and private storage. It requires explicit cloud configuration and can consume provider resources; it is not needed for local review or the default verification workflow.

## Persistent disk alternative

`MEDIA_STORAGE=disk` with no `DATABASE_URL` uses SQLite and local media files. Run one application process with a persistent `DATA_DIR`, TLS reverse proxy, and tested backups. `Dockerfile` and `compose.yaml` describe this alternative; container execution was not verified in the source-handoff check. The Compose sample does not automatically pass optional X settings—add your own private environment mapping if needed.

## Optional legacy domain

Only set `LEGACY_BASE_URL` during an intentional migration. It keeps old API/media/extension callback access while redirecting public pages to `BASE_URL`. Leave it unset on a fresh installation. Never substitute a blanket old-domain redirect for that compatibility path while older extensions still depend on it.
