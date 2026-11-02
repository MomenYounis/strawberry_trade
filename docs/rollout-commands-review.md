# Review-only rollout commands

These commands are artifacts for review, **not authorization to deploy/install/publish**. Read `commercial-release-readiness.md`; all four production verdicts are NO-GO. No production archive storage, scheduler or cleanup enable command is configured in the current candidate. Exact tenant/year/storage/key decisions remain unresolved.

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

Synthetic storage acceptance now uses a separately owned offline API35 AVD, scoped serial emulator-5580, and the guarded tools/annual-review/native-v11-upgrade-check.py phases. It verifies signed representative schema2 seed8→actual v10→v11→schema4 and reboot. Only explicit adb install -r is used after seed; Flutter installer fallback can uninstall and is avoided. Never reuse an owner device/AVD or clear persistent seeded data. Exact results are in verification/annual-2026-11-02/native/. Broader business/account acceptance remains untested.

Only after real storage/key/copy acceptance and synthetic staging should a concrete named tenant/year dry-run/close plan be produced for approval. A conditional manager-feed-only pruner and scoped snapshot installer are implemented and default disabled. Production cleanup remains blocked by storage/copy/key acceptance, fleet proof, scale and full recovery; no proposed shell command bypasses those gates. Original financial documents and employee feed remain retained.
