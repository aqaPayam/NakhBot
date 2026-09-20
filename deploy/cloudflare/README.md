# Private media edge

The deployable Worker entry is `packages/media-delivery/dist/worker.js`. Copy
`wrangler.example.toml` to an environment-owned Wrangler configuration only after the private R2
bucket, custom HTTPS hostname, and separate media-signing and audience-credential keys exist.

Keep `NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED=false` through initial deployment. Store
`NAKH_MEDIA_SIGNING_KEYS` and `NAKH_MEDIA_AUDIENCE_KEYS` as encrypted Worker secrets containing JSON
objects with one to three key IDs. Never put either secret in Terraform state, Wrangler variables,
GitHub Actions logs, or this repository. Enable the edge, gateway, and worker together only for the
staging fault-test window; roll all three back to `false` if verification fails.
