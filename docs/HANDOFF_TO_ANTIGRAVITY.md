# تسليم Strawberry Trade إلى Antigravity

فحص ملفات وGit يوم **8 نوفمبر 2026، نحو 10:15 بتوقيت Africa/Cairo**. توثيق للاستمرار، لا موافقة إصدار. لم تُعد الاختبارات أو البناء ولم تتغير بيانات الإنتاج.

## 1. المكان الصحيح وحالة المستودع

المصدر الأحدث هو **`/home/younis/strawberry-trade-annual-review`**، ويشار إليه أدناه بـ`R`. إنه **clone مستقل** له مجلد `.git`، وليس Git worktree مرتبطًا بالأصل. فيه أحدث commits وتعديلات المصدر، لا أحدث APK فقط.

```bash
cd /home/younis/strawberry-trade-annual-review
```

الفرع `codex/annual-archive-safety`؛ HEAD:
`7058f24b2a85218fb96d88e435e0d3c5fce0e1c8`.

`origin` لهذا clone هو `/home/younis/Downloads/strawberry_trade`، الذي يحل إلى `/mnt/data/LinuxHome/Downloads/strawberry_trade`. الأصل عند `main`/`e246f436a092616ef2799bb04f969a19fd19ffcc`، وremote الخاص به `https://github.com/MomenYounis/strawberry_trade.git`. احتفظ بالأصل للرجوع وAPK v9. لا upstream لفرع التطوير، ولا نسخته في refs للأصل المحلي؛ العمل الأحدث محلي بحسب الأدلة المتاحة. حالة GitHub الآنية **UNKNOWN**؛ لم يحدث fetch أو تحقق شبكي لهذا التسليم.

بيانات المحاكيات والـbackend الاصطناعية في `/home/younis/.local/share/strawberry-trade-test-runtime`، خصوصًا `backend-native-20261102` و`private-campaign-20261107`. `strawberry-commercial-native-i3mha9r1` للترقية. patches تحت `/home/younis` احتياطيات أقدم.

## 2. ما لم يُحفظ في commits

قبل الوثيقة: **0 staged، 340 tracked unstaged، 886 untracked**. الفحص بمقارنة blob أثبت **325 تغيير أذونات فقط و15 تغيير محتوى**؛ لا تستخدم chmod/reset/clean شاملًا. لا conflicts أو migration مفتوحة مثبتة؛ schema4 وترقية schema2 مختبرة.

تغييرات المحتوى المهمة:

- `backend/package.json` وربط اختبارات الاستعادة؛ `backend/src/recovery-dependency-plan.mjs` لتمييز service principals عن Auth UIDs؛ `backend/scripts/native-commercial-host.mjs` لاختيار سجل الحملة.
- الملفات الجديدة غير المتتبعة `backend/src/recovery-authority-{package,demo,transport,binding}.mjs` و`recovery-object-{copy,journal,local-storage}.mjs`، اختباراتُها، و`backend/scripts/test-recovery-authority-emulators.mjs`.
- **مسودة غير مختبرة:** `backend/src/recovery-coordinator.mjs` و`backend/test/recovery-coordinator-fixture.mjs`؛ لا coordinator execution tests أو وثيقة أو npm registration.
- `integration_test/commercial_business_test.dart` و`tools/annual-review/{native-commercial-device.py,native_device_guards.test.py,checkpoint-native-backend.py}`: استئناف اختبار offline؛ التعديلات الأخيرة لم تُبنَ أو تُقبل native.
- ثماني وثائق معدلة، وأربع جديدة تحت `docs`؛ بعض التقارير ما زال يقول إن الترقية pending رغم نجاحها لاحقًا. يوجد 857 ملف evidence غير متتبع، منها APKs كبيرة، و10 ملفات `__pycache__`؛ لا تعمل `git add .`.

commits المحورية: `2ad243a` snapshots/عرض الأرشيف؛ `9f52501` نسخ pending وحدود التخزين؛ `b0f3a8d` سلطة الاستيراد وحدود التصدير؛ `6346cee` محرك الإقفال والالتقاط؛ `eb6854f` استعادة صورة موثقة إلى quarantine؛ `1f03cd5` دفعات snapshot؛ `1f6ffad` dependencies وحزمة backend؛ `7058f24` إثبات مصادر بناء fixtures.

## 3. التنفيذ الموجود فعليًا

الحالات محلية؛ المسارات النسبية تحت `R`.

| المجال | الحالة والمصدر/الاختبار |
|---|---|
| السنة والإقفال | **IMPLEMENTED AND TESTED** محليًا: `backend/src/{archive-calendar,archive-state,annual-engine,annual-scheduler}.mjs`؛ tests `annual-*` و`archive-state-activity`. checkpoint وlease fencing واستئناف دون معاملة سنوية غير محدودة. |
| الافتتاح والترحيل | **PARTIAL**: `opening-date-policy.mjs` و`archive-accounting.mjs`؛ اختبارات `opening-date-policy` و`archive-failure`. خطة `dated-openings` تربط المبلغ/الطرف/السنة/checkpoint؛ ترفض المفقود أو المبلغ داخل الفترة. الإقرارات الفعلية غير متاحة. |
| المتأخر والتصحيحات | **IMPLEMENTED AND TESTED** محليًا في `gateway.mjs` و`ledger_store.dart`: الأصل يحفظ في `lateOperations` بحالة `needs_review`؛ المدير ينشئ تعديلًا مرتبطًا بالفترة المفتوحة مرة واحدة. receipt النقل ليس قبولًا ماليًا. |
| الرواتب | **IMPLEMENTED AND TESTED** محليًا: تصحيح salary term المتأخر بالشهر الحالي بالقاهرة، نفس المعدل وسبب صريح، دون إعادة كتابة التاريخ؛ اختبارات `backend/test/integration.test.mjs` وfinancial integration evidence. |
| حزمة الأرشيف | **IMPLEMENTED AND TESTED** محليًا: `archive-{format,projection,source-preparation,prepared-job}.mjs`؛ chunks مشفرة وmanifest موثق، readback واستعادة مستقلة وcross-year references؛ اختبارات `archive-*`. |
| التخزين والمفاتيح | **BLOCKED** إنتاجيًا: adapters في `archive-storage.mjs` و`backend/private-archive-runtime/r2-storage.mjs`، و11 اختبار SDK/HTTP؛ ليست bucket حقيقية. لا قبول لنسخة مستقلة إداريًا أو escrow مفاتيح أو scratch مشفر. |
| العرض والاستعادة | **PARTIAL**: `lib/presentation/archive_screen.dart` و`lib/services/archive_{reader,statement}.dart` عرض/PDF/CSV للمدير بلا posting؛ اختبارات `test/archive_*`. طبقات recovery المعطلة تمر؛ المنسق الكامل مسودة، وتفعيل الإنتاج **NOT IMPLEMENTED**. |
| المزامنة والازدواج | **IMPLEMENTED AND TESTED** محليًا: `gateway.mjs`، `lib/services/sync_protocol.dart`، `ledger_store.dart`؛ IDs/receipts ثابتة، cursor ذري، floor صريح؛ `sync_protocol_test` و`remote_batch_test` وHTTP95. |
| snapshots الكبيرة | **IMPLEMENTED AND TESTED** ضمن القياس: `active-snapshot-*.mjs` و`lib/services/active_snapshot.dart`؛ 500,000 سجل/256MiB/4096 صفحة سقوف رفض، والمجموع مليون/512MiB؛ 16 سجلًا للدفعة. ليست شهادة قدرة عند السقف. |
| العزل والدعوات والترخيص | **IMPLEMENTED AND TESTED** محليًا في `enrollment.mjs` و`gateway.mjs` و`lib/security/*`؛ منع cross-tenant، employee filtering، revocation؛ اختبارات integration/invitations/controller/licensing. الإنتاج غير مقبول بعد. |
| عيوب مؤكدة أصلحت | **IMPLEMENTED AND TESTED**: رفض protocol، تطبيق تعطيل/دور مستورد فورًا، حدود PDF/CSV وعدم توسيع تاريخ غير صالح، Worker body lifecycle، ميزانية reservation، وربط Auth artifacts بالصورة وتمييز service audit labels. التفاصيل في [مراجعة الاستعادة](/home/younis/strawberry-trade-annual-review/verification/continuation-2026-11-02/final-review/recovery-integration-independent-review-final-nov7.json). |

## 4. القرارات والسياسات

مؤكد: نحو خمس منشآت بمديرين وموظفين؛ الأرشفة ما زالت مطلوبة. التنفيذ الفعلي Firebase project واحد وقاعدة Firestore مشتركة بمسارات `tenants/{tenantId}`، وليس خمس قواعد ذات quotas مستقلة؛ لكل جهاز SQLite/SQLCipher محلية.

السنة `[2026-09-01,2027-09-01)` بتوقيت `Africa/Cairo`، وأول استحقاق **1 سبتمبر 2027**. الاقتراح المنفذ trigger كل ساعة `17 * * * *` UTC مع بوابة Cairo، واستئناف durable؛ backlog السنوات الفائتة يحتاج اختيارًا إداريًا، لا إقفال جماعي تلقائي. cron غير منشور.

`dated-openings` هو اختيار الكود الحالي، لكن إثبات اختيار المالك الشخصي لهذه السياسة **UNKNOWN**؛ تعليق «Owner-selected» وحده ليس موافقة. لا تختلق تواريخ. سياسة المتأخر المنفذة تصحيح حالي مرتبط، بلا reopening افتراضي؛ قبولها الإنتاجي لم يثبت. لا billing أو موارد مدفوعة أو نشر/حذف/إقفال إنتاج دون موافقة منفصلة.

## 5. backlog مرتب للتنفيذ (تحديث الإنجاز 8 نوفمبر 2026)

| الأولوية والنوع | الأثر، الخطوة ومعيار القبول |
|---|---|
| 1 — عيب مؤكد في harness (**PASS**) | تم إصلاح `native-commercial-device.py` و`commercial_business_test.dart` للتحقق من الاتصال على `10.0.2.2:8788` و`10.0.2.2:9099`، ورفض مخارج `nc` (`2`/`126`/`127`) وأخطاء ADB، وتبديل قواعد الجدار الناري عبر `STRAWBERRY_LOCAL_STAGE` بدون نافذة تعرض، وانتظار انتهاء مجموعة العمليات بعد `am force-stop`. اختبارات `native_device_guards.test.py`: **PASS 22/22**. |
| 2 — اختبار مالي ناقص (**PASS**) | تم استئناف حملة R4 من العملية المعلقة المحفوظة (`6fd7827c…`) وcheckpoint الخادم (`checkpoint-r4-nov7-replacement`) بدون إعادة seed أو مسح الطابور. اكتملت مراحل الانقطاع، إعادة التشغيل (`bootCount` 6→7)، استعادة الاتصال، القبول مرة واحدة، وإعادة إرسال النسخ المكررة بنفس الإيصال: [`business-recovery-r4-offline-complete-progress.json`](../verification/continuation-2026-11-02/native-durable/business-recovery-r4-offline-complete-progress.json) و[`oracle-offline.json`](../verification/continuation-2026-11-02/native-durable/campaigns/native_62c5d3612fb3/oracle-offline.json) (**PASS**: `A=20000`، `supplier=8000`، `cash=-6700`، `B=4700`). |
| 3 — تنفيذ ناقص (**PASS**) | اكتمل `backend/src/recovery-coordinator.mjs` و`backend/test/recovery-coordinator-fixture.mjs` مع اختبارات الوحدة (`recovery-coordinator.test.mjs` **PASS 4/4**) واختبارات المحاكيات المعزولة (`test:recovery-coordinator` **PASS 4/4**، و`npm test` **PASS 220/220**، و`npm run test:archive` **PASS 196/196**): [`recovery-coordinator-integration-nov8.json`](../verification/continuation-2026-11-02/final-review/recovery-coordinator-integration-nov8.json). |
| 4 — التفعيل المنسق محليًا وفجوة المزود (**PASS محليًا / BLOCKED إنتاجيًا**) | تم تنفيذ واختبار التفعيل المنسق (`activatePreparedRecoveryCoordinator` / `activateRecoveryCoordinatorDemo`) للانتقال من الحجر الصحي الموثق إلى منشأة مستعادة قابلة للتشغيل في بيئة demo المعزولة؛ يظل تفعيل الإنتاج (`productionRecoveryAccepted: false`) والتحقق الحي من دخول SCRYPT ومفاتيح الإصدار **BLOCKED** لحين توفير بيئة معزولة معتمدة. |
| 5 — بيئة وموافقات (**PARTIAL PASS / BLOCKED**) | فحص read-only لقائمة النشر ([`backend-production-readonly-nov8.json`](../verification/continuation-2026-11-02/final-review/backend-production-readonly-nov8.json)) أثبت أن النسخة الحية الحالية هي `f06328bf-1d81-4826-a994-4b175384ee2b` بتاريخ `2026-10-28` (قبل إصلاح `syncProtocolVersion`)، بينما تعذر فحص تفاصيل الـbindings/secrets بسبب اتصال Wrangler؛ النشر وتأهيل التخزين وتواريخ الافتتاح تنتظر موافقة المالك. |
| 6 — تغطية ومخاطر (**NOT RUN على عتاد فعلي**) | جهاز ARM فعلي وذاكرة release و16KiB runtime **NOT RUN**. full reports بلغت نحو730MiB؛ اختبر جهاز العميل قبل handover. بقيت 11 ثغرة moderate في dev Firebase CLI وتفصيلها في `docs/dependency-security-review.md`؛ ليست runtime findings. البحث المفهرس عبر السنوات غير منفذ. |

## 6. الأدلة الموجودة وعمرها

الجذر `E=/home/younis/strawberry-trade-annual-review/verification/continuation-2026-11-02`. الأدلة عمرها يوم إلى ثلاثة أيام، ولم تُعد هنا. الأعداد متداخلة.

| النتيجة | الأمر، working directory، الدليل والحد |
|---|---|
| **PASS 235 / صفر issues**، 6 نوفمبر | من `R`: `flutter test --no-pub --concurrency=2` و`flutter analyze --no-pub`؛ `E/final-review/flutter-host-bulk-nov6.json` و`flutter-analyze-bulk-nov6-corrected.json`. hashes تربط app bytes بـ7058؛ تعديل commercial fixture اللاحق خارج full analysis السابق. |
| **PASS 216 و192**، 7 نوفمبر | من `R/backend`: `taskset -c 0,1 npm test` و`taskset -c 0,1 npm run test:archive`؛ [الإيصال](/home/younis/strawberry-trade-annual-review/verification/continuation-2026-11-02/final-review/recovery-integration-independent-review-expanded-backend-nov7.json)، logs بجواره. الـ124 source hashes ما زالت مطابقة؛ coordinator الجديد غير مشمول. |
| **PASS Worker9 / HTTP95 / financial41**، 6 نوفمبر | `npm test` من `R/backend/worker`؛ `npm run test:worker-http` و`npm run test:invitations` من `R/backend`؛ `E/final-review/dependency-acceptance-summary.json` وإيصالات `dependency-worker-http-java25` و`dependency-financial-invitations-java25`. workerd/DO/Auth/Firestore حقيقية محليًا؛ المصدر base6383 مع hashes، لا إنتاج. |
| **PASS recovery72 / actual16**، 7 نوفمبر | `npm run test:recovery-local` مكافئ للمسارات الخمسة المسجلة؛ `npm run test:recovery-authority` يشغل نفس integration عبر wrapper أحدث. `E/final-review/recovery-integration-independent-review-local-pure-nov7.json` و`recovery-authority-integration-v5.json/.log`؛ disabled Auth UID/hash/salt وfinancial quarantine، لا دخول إنتاج أو activation. |
| **PASS quarantine18 / R2 SDK11** | `npm run test:tenant-recovery` و`npm run test:node-r2` من `R/backend`؛ `E/final-review/recovery-quarantine-integration-final-v2.json` و`E/backend-completion/node-r2-sdk-transport-final.json`؛ emulator وHTTP fixture، لا مزود حي. |
| **PASS annual volume/crash**، 7 نوفمبر | سلسلة `launch-native-drive.py employee --label annual-nov6batch-{kill,base,growth,verify}` مع signing metadata؛ [ملخص](/home/younis/strawberry-trade-annual-review/verification/continuation-2026-11-02/native-durable/annual-nov6batch-final-summary.json). 73,000→80,300، SIGKILL/rollback/boot، SQLCipher وتقارير RTL، المصدر7058؛ emulator API35 x86_64 فرض2560MiB، لا هاتف1GiB أو500k acceptance. |
| **PASS جزئي / FAIL الحملة**، 7 نوفمبر | `E/native-durable/business-recovery-r4-resumed-progress.json`: manager/employee/revocation/replacement PASS؛ [oracle](/home/younis/strawberry-trade-annual-review/verification/continuation-2026-11-02/native-durable/campaigns/native_62c5d3612fb3/oracle-final.json) A18500/B4700. `business-recovery-r4-offline-resumed-progress.json` FAIL؛ offline final **NOT RUN**، وليس عيب posting مثبتًا. |
| **PASS signed upgrade**، 7 نوفمبر | من `R`: `python3 verification/continuation-2026-11-02/upgrade/final-chain/attempt3/run-final-chain.py`؛ المرجع [ملخص attempt3](/home/younis/strawberry-trade-annual-review/verification/continuation-2026-11-02/upgrade/final-chain/attempt3/final-signed-upgrade-summary.json). DEBUG seed8→actual signed9→11→final12→verifier، ثلاث assertions ثم reboot وإعادتها؛ seed لم يُنشأ بواجهة v9 الموثقة. أحدثv12 على هاتف فعلي **NOT RUN**؛ تثبيتv9 يوم23أكتوبر لا يثبتv12. |

## 7. APK والـbackend

أحدث **signed release** مثبت بالـhash، لا DEBUG: **1.0.0+12**، package `com.strawberrytrade.strawberry_trade`، schema4، الحجم78,430,556 بايت:

`/home/younis/strawberry-trade-annual-review/verification/continuation-2026-11-02/release-v12-bulk-nov6/strawberry-trade-annual-review-v12-final.apk`

SHA-256: `9595d4ea4e0f7afe484c7af79066353c421445e35e5023b4ee5dc79df0cf15a9`.
الشهادة: `bf1cb6377be0c37cad31811b557ac32b686ffdc75730778edb8488d2bdb3d82b`.
مصدر البناء7058، digest المدخلات `15f28601af0d3d3b09ad3b97843a9e9351fbef3e8fdb7668eedfd4276e365840`؛ approved production definitions، HTTPS، `USE_EMULATORS=false`. [الهوية والفحص](/home/younis/strawberry-trade-annual-review/verification/continuation-2026-11-02/final-review/release-bulk-independent-review-nov6.json). تغييرات recovery/backend/fixture الأحدث ليست APK جديدة.

الخلل الأصلي هو `syncProtocolVersion` المرفوض في `syncOperation` و`pullChanges`، حتى بقيمة1. v12 يحذف الحقل لـv1، ويرسل2 بعد bootstrap موثق؛ backend المعد يقبل omitted/1/2 ويرفض null/غير المدعوم بلا mutation. v10/v11 ذات explicit1 تحتاج compatible backend؛ v9 يبقى مدعومًا عند minimum1.

الحزمة `E/backend-deployment-nov6-retry/compatible-backend-source.tar.gz` SHA `a4473a6284547ff5ccb8015afd88de0573dcf5f9a7e7890b77ef3dfbdc9703ab`، وpayload SHA `fe3eb536ed163b28a3fe77478cb31fd251f82765bf05b38d5a589436527f8815`. inventory20 ما زال يطابق المصدر؛ هويتها base6383+hashes. [النشر والرجوع](/home/younis/strawberry-trade-annual-review/docs/compatible-backend-deployment.md). النسخة الحية/bindings **UNKNOWN**؛ lookup6نوفمبر BLOCKED لغياب cloud authentication. لا ضمان اتصال تجاري آمن حاليًا، ولا نشر مثبت خلال هذه المهمة.

## 8. البيئة والاستمرار الآمن

Flutter3.47.2 في `/home/younis/flutter`، Dart3.13.2، Node22.22.2/npm10.9.7، Python3.14.6. Android SDK `/home/younis/Android/Sdk`، وبناء Android يستخدم `/usr/lib/jvm/java-17-temurin-jdk`. Firebase integrations الحديثة تحتاج Node24.22.1 في `/home/younis/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node` وJava25 في `/usr/lib/jvm/java-25-openjdk`؛ harness يحد Java إلى512MiB. لا تحول production Node22 اعتباطًا.

أوامر لاحقة بعد مراجعة harness، **لم تُنفذ للتسليم**:

```bash
cd /home/younis/strawberry-trade-annual-review
python3 tools/annual-review/native_device_guards.test.py
python3 tools/annual-review/native-disposable-runtime.py start replacement --gpu host --detach
# Native backend: shell مع Node24/Java25 أول PATH وبيئة demo معزولة فقط:
cd backend
STRAWBERRY_NATIVE_RUNTIME_ROOT=/home/younis/.local/share/strawberry-trade-test-runtime/backend-native-20261102 node scripts/worker-http-test-runner.mjs --serve --native
# الاختبار المنفصل: npm run test:recovery-authority
```

المنافذ native8788/8080/9099؛ isolated integration18180/19199/15101. كانت مغلقة وقت الفحص ولا QEMU للحملات قيد التشغيل. شغّل AVD واحدًا فقط؛ لا Android build متزامنًا معه، ولا تلمس هاتف المالك أو `strawberry_test_api35`.

إعادة البناء المعتمدة لاحقًا من `R`: `python3 tools/annual-review/build-release.py --output-dir verification/REVIEW-UNIQUE`؛ fixture: `python3 tools/annual-review/build-native-fixture.py commercial --output-dir verification/REVIEW-DEBUG-UNIQUE`. لا تتجاوز شرط المصدر المحفوظ أو تعيد استخدام evidence directory.

المفتاح الموجود `/home/younis/.local/share/strawberry-trade-operator/android-release.jks`، alias `strawberry-release-v1`؛ كلمة المرور من Secret Service purpose `android-release-v1`، في ذاكرة الأداة فقط. ملف التعريف `/home/younis/.local/share/strawberry-trade-operator/firebase-production/cloudflare-setup-v8-defines.json`. الملفات موجودة؛ unlock حاليًا **UNKNOWN**. أعد استخدام الهوية، ولا تولد بديلًا.

لا تلتزم أو تلصق operator directory، `.dev.vars*`، exports Auth/Firestore، backups/passphrases، jobs/invitations أو userdata. السكربت الخاص `private-campaign-20261107/run-r4-offline-final.py` ومسار `offline-resume-job.json` موجودان لكن غير منفذين؛ يتوقعان fixture directory غير موجود حاليًا. backend checkpoint الأخير يحفظ accepted state؛ pending الجديدة بقيت على replacement، فلا تستبدل userdata.

## 9. حدود الأمان وحكم الإصدار

`backend/src/archive-calendar.mjs`: `schedulerEnabled=false`، `exportEnabled=false`، `cleanupEnabled=false`، `graceDays=90`، cron المقترح أعلاه. `annual-scheduler.mjs` يطلب صراحة close/storage/recovery approvals. لا cron/R2 bindings في config الإنتاج الحالية. `feed-pruner.mjs` لا يمس إلا نسخ manager feed؛ يحتفظ بالحقائق المالية والreceipts/locks وemployee feed، وله exact-plan/fleet/recovery gates.

لا ترحيل إنتاج منفذ. تعطيل scheduler لا يلغي close؛ وبعد prune لا تخفض floor أو ترجع backend قديمًا بينما prefix محذوف. إرجاع strict backend الأصلي يكسر explicit-field clients.

- **Core commercial APK: NO-GO**؛ upgrade PASS، لكن offline campaign وقبول backend الحي وجهاز العميل ناقصة.
- **Archive export/read-only viewing: NO-GO إنتاجيًا**؛ التنفيذ المحلي يمر، storage/key/runtime/independent restore غير مقبولة.
- **Automatic closing: NO-GO**؛ coordinator/activation ناقصان، وسياسات وأدلة وموافقة الإنتاج معلقة.
- **Destructive cleanup: NO-GO**؛ يتطلب كل السابق وplan/grace/fleet وموافقة مستقلة؛ يبقى معطلًا.

الاستعادة: server-accepted من الخادم؛ pending من backup مشفر، بحد1000 عنصر لكل queue/drafts/conflicts و16MiB plaintext/23MiB envelope؛ وجهاز مفقود بلا نسخة إضافية **غير قابل للاستعادة**. لا تحول عرض الأرشيف إلى إدخال مالي أو تعد المستخدم باستعادة مستحيلة.

## 10. ابدأ هنا

**ابدأ هنا:** اقرأ `docs/commercial-release-readiness.md` و`docs/compatible-backend-deployment.md` ثم راجع diff لـ`tools/annual-review/native-commercial-device.py` واختباراته و`integration_test/commercial_business_test.dart`. أول مهمة آمنة لاحقًا: إصلاح دليل الانقطاع قبل استئناف R4 بالـpending الموجودة.
