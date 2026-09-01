# Official Implementation References

These primary references were checked while selecting the technical baseline on 2026-08-31. They guide implementation details but do not override Nakh's canonical domain rules or this blueprint.

## Runtime and framework

- [Node.js release schedule and LTS status](https://nodejs.org/en/about/previous-releases)
- [Node.js end-of-life policy](https://nodejs.org/en/about/eol)
- [NestJS techniques documentation](https://docs.nestjs.com/techniques)
- [NestJS queue documentation](https://docs.nestjs.com/techniques/queues)
- [NestJS configuration documentation](https://docs.nestjs.com/techniques/configuration)

Before the first code commit, pin the current Node.js 24 LTS patch and compatible NestJS/Fastify package versions. Renovation upgrades require tests and review; a new major is not adopted merely because it exists.

## PostgreSQL

- [PostgreSQL data-definition documentation](https://www.postgresql.org/docs/current/ddl.html)
- [PostgreSQL transaction-isolation documentation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL declarative partitioning documentation](https://www.postgresql.org/docs/current/ddl-partitioning.html)

Implementation must target the exact managed-provider PostgreSQL major selected for production and test migrations against that major. `current` documentation links are convenient indexes; migration code review links to the pinned major's page.

## Telegram and Telegram Stars

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Telegram Stars payments for bots](https://core.telegram.org/bots/payments-stars)
- [Telegram Bot API change log](https://core.telegram.org/bots/api-changelog)

The provider adapter must be checked against the live Bot API immediately before integration. Digital goods use Telegram Stars (`XTR`); grant only after a verified `successful_payment`, and use Telegram's refund method for an approved automatic Stars correction.

## Cloudflare R2

- [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 object lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

Presigned URLs are treated as bearer credentials. R2 presigned operations use the S3 API endpoint rather than a custom domain, so Nakh's private user-facing CDN delivery uses a separately authenticated edge route. Lifecycle cleanup supplements but does not replace the deletion workflow.

## Reference maintenance

At each runtime/provider major upgrade:

1. recheck the official release/support status;
2. diff provider/API behavior affecting security, idempotency, limits, refunds, signing, and retention;
3. update contract fixtures and integration tests;
4. record the decision and rollout/rollback plan;
5. update this page when a link or relevant policy changes.
