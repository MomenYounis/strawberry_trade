# Review-only rollout commands

These commands are artifacts for review, **not authorization to deploy/install/publish**. Read `commercial-release-readiness.md`; all four production verdicts are NO-GO. No archive storage, scheduler or cleanup enable command exists in the current candidate. Exact tenant/year/storage/key decisions remain unresolved.

The reviewed existing Worker config is `config/wrangler.production.json`, name `strawberry-tenant-gateway`, entry `../backend/worker/index.mjs`, compatibility date2026-10-19. It has no R2 archive binding or enabled archive cron. Deployment of this additive gateway support is distinct from accepting financial close or cleanup.

Local review commands (safe; already executed in this mission):

```sh
cd /home/younis/strawberry-trade-annual-review
flutter analyze --no-pub
flutter test --no-pub
npm --prefix backend test
npm --prefix backend run test:archive
npm --prefix backend run test:integration
npm --prefix backend run test:invitations
npm --prefix backend/worker test
npm --prefix backend/worker run dry-run
python3 tools/annual-review/build-release.py
```

The release helper uses the existing signing identity/password and approved external public definitions; it does not create credentials, install the APK or deploy. It will refuse missing configuration rather than replace the production identity. Do not run emulator wrappers against live projects or reuse occupied endpoints.

After engineering resolves the relevant release blockers, the exact **production gateway deployment command for separate owner approval** is:

```sh
cd /home/younis/strawberry-trade-annual-review/backend/worker
# REVIEW ONLY — DO NOT EXECUTE without approval of this exact source/config/account.
./node_modules/.bin/wrangler deploy --env= --config ../../config/wrangler.production.json
```

Before approving, verify the intended existing account, protected runtime secret bindings, deployed identity/roles, exact reviewed source and local bundle. Confirm this config still contains no unintended R2/cron/cleanup change. Source baseline rejects the new `syncProtocolVersion` field; compatible server support must precede client distribution. This command has **not** been executed. No production account or secret was queried to turn historical deployment reports into current acceptance.

Synthetic device acceptance, once an explicitly disposable target is identified, uses the repository native fixtures and signed v9->v10 installation sequence. Select that serial explicitly; never substitute an owner phone or run uninstall/clear-data. A fresh install and an upgrade are separate tests. The exact install serial/action is intentionally not fabricated while no target is attached.

Only after real storage/key/copy acceptance and synthetic staging should a concrete named tenant/year dry-run/close plan be produced for approval. Destructive cleanup remains technically unavailable until the snapshot/pruner/recovery implementation is completed and tested; no proposed shell command can bypass that boundary.
