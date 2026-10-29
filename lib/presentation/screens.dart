import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../application/app_controller.dart';
import '../domain/ledger.dart';
import '../services/employee_registration.dart';
import '../services/exports.dart';
import '../services/gateway.dart';
import '../services/invitation_code.dart';
import 'enrollment.dart';
import 'shipments.dart';
import 'reports_extra.dart';

const grades = [
  'فراولة طازة (سوق محلي)',
  'فراولة تصدير (فرز أول)',
  'فراولة مصانع / تجميد',
  'فراولة فرز تاني',
  'كرتونة عربي',
  'كرتونة اوروبي',
  'عربي محسن',
  'برنيكة فرزة',
  'برنيكة خرط',
];
String today() => DateTime.now().toIso8601String().substring(0, 10);
String month() => today().substring(0, 7);
String stateLabel(String? value) => switch (value) {
  'accepted' || 'server_accepted' => 'قبله الخادم',
  'awaiting_approval' => 'بانتظار اعتماد المدير',
  'approved' => 'معتمد',
  'rejected' => 'مرفوض',
  'review_pending' => 'قرار اعتماد مبدئي',
  'conflict' => 'تعارض يحتاج مراجعة',
  'blocked' => 'متوقف لحين تجديد الصلاحية',
  'retry' => 'محفوظ محلياً - إعادة محاولة',
  _ => 'محفوظ محلياً - بانتظار الإرسال',
};
void snack(BuildContext context, String text) {
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(content: Text(text), behavior: SnackBarBehavior.floating),
  );
}

Future<void> guard(BuildContext context, Future<void> Function() action) async {
  try {
    await action();
  } catch (e) {
    if (context.mounted) snack(context, arabicError(e));
  }
}

Future<T?> completedDialog<T>({
  required BuildContext context,
  required WidgetBuilder builder,
}) async {
  final route = DialogRoute<T>(context: context, builder: builder);
  final result = await Navigator.of(context, rootNavigator: true).push(route);
  // Fields remain mounted throughout the closing animation. Their controllers
  // can safely be disposed by the caller once the route is fully removed.
  await route.completed;
  return result;
}

Widget heading(String text) => Padding(
  padding: const EdgeInsets.only(top: 20, bottom: 10),
  child: Text(
    text,
    style: const TextStyle(fontSize: 21, fontWeight: FontWeight.bold),
  ),
);
Widget empty(String text) => Padding(
  padding: const EdgeInsets.all(28),
  child: Text(
    text,
    textAlign: TextAlign.center,
    style: const TextStyle(color: Colors.black54, fontSize: 17),
  ),
);
Widget money(int amount, {double size = 20}) => Text(
  '${formatMoney(amount)} ج.م',
  textDirection: TextDirection.ltr,
  style: TextStyle(fontSize: size, fontWeight: FontWeight.bold),
);

class AppShell extends ConsumerStatefulWidget {
  const AppShell({super.key});
  @override
  ConsumerState<AppShell> createState() => _AppShellState();
}

class _AppShellState extends ConsumerState<AppShell>
    with WidgetsBindingObserver {
  int index = 0;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(ref.read(appProvider).onResume());
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = ref.watch(appProvider);
    if (app.loading) {
      return const Scaffold(
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              CircularProgressIndicator(),
              SizedBox(height: 16),
              Text('جارٍ فتح السجل المحلي بأمان'),
            ],
          ),
        ),
      );
    }
    if (!app.ready) return SetupScreen(app: app);
    final pages = app.manager
        ? [
            HomeScreen(app: app),
            LedgerScreen(app: app),
            AccountsScreen(app: app),
            MoreScreen(app: app),
          ]
        : [
            HomeScreen(app: app),
            SubmissionScreen(app: app),
            LicenseScreen(app: app),
            MoreScreen(app: app),
          ];
    return PopScope(
      canPop: index == 0,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) setState(() => index = 0);
      },
      child: Scaffold(
        appBar: AppBar(
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'دفتر الفراولة',
                style: TextStyle(fontSize: 23, fontWeight: FontWeight.bold),
              ),
              Text(
                app.manager ? 'مساحة المدير · ${app.business}' : 'مساحة الموظف',
                style: const TextStyle(fontSize: 12),
              ),
            ],
          ),
          actions: [
            IconButton(
              tooltip: 'المزامنة الآن',
              onPressed: app.syncing ? null : () => app.synchronizeNow(),
              icon: app.syncing
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.sync),
            ),
            IconButton(
              tooltip: 'الترخيص والتفعيل',
              onPressed: () => Navigator.push(
                context,
                MaterialPageRoute<void>(
                  builder: (_) => Scaffold(
                    appBar: AppBar(title: const Text('الترخيص والتفعيل')),
                    body: LicenseScreen(app: app),
                  ),
                ),
              ),
              icon: const Icon(Icons.verified_user_outlined),
            ),
          ],
        ),
        body: SafeArea(
          child: Column(
            children: [
              if (!app.allowed)
                MaterialBanner(
                  content: Text(app.license?.message ?? 'أكمل التفعيل'),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.push(
                        context,
                        MaterialPageRoute<void>(
                          builder: (_) => Scaffold(
                            appBar: AppBar(title: const Text('التفعيل')),
                            body: LicenseScreen(app: app),
                          ),
                        ),
                      ),
                      child: const Text('التفعيل'),
                    ),
                  ],
                ),
              Expanded(child: pages[index.clamp(0, pages.length - 1)]),
            ],
          ),
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: index,
          onDestinationSelected: (i) => setState(() => index = i),
          destinations: app.manager
              ? const [
                  NavigationDestination(
                    icon: Icon(Icons.space_dashboard_outlined),
                    label: 'الرئيسية',
                  ),
                  NavigationDestination(
                    icon: Icon(Icons.receipt_long_outlined),
                    label: 'السجل',
                  ),
                  NavigationDestination(
                    icon: Icon(Icons.people_outline),
                    label: 'الحسابات',
                  ),
                  NavigationDestination(
                    icon: Icon(Icons.more_horiz),
                    label: 'المزيد',
                  ),
                ]
              : const [
                  NavigationDestination(
                    icon: Icon(Icons.home_outlined),
                    label: 'الرئيسية',
                  ),
                  NavigationDestination(
                    icon: Icon(Icons.send_outlined),
                    label: 'طلباتي',
                  ),
                  NavigationDestination(
                    icon: Icon(Icons.key_outlined),
                    label: 'التفعيل',
                  ),
                  NavigationDestination(
                    icon: Icon(Icons.more_horiz),
                    label: 'المزيد',
                  ),
                ],
        ),
      ),
    );
  }
}

class SetupScreen extends StatefulWidget {
  const SetupScreen({super.key, required this.app, this.registrationAuth});
  final AppController app;
  final EmployeeRegistrationAuth? registrationAuth;
  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

enum _SetupMode { login, employeeCreate, employeeExisting }

class _SetupScreenState extends State<SetupScreen> {
  final form = GlobalKey<FormState>();
  final tenant = TextEditingController(),
      email = TextEditingController(),
      confirmedEmail = TextEditingController(),
      password = TextEditingController(),
      invitation = TextEditingController();
  _SetupMode mode = _SetupMode.login;
  EmployeeRegistration? registration;
  bool busy = false;
  String? localError, deliveryNotice;
  bool get employeeFlow => mode != _SetupMode.login;
  bool get awaitingVerification => registration?.account != null;
  bool get working => busy || widget.app.connecting;

  @override
  void dispose() {
    tenant.dispose();
    email.dispose();
    confirmedEmail.dispose();
    password.dispose();
    invitation.dispose();
    super.dispose();
  }

  void _switchMode(_SetupMode value, {bool clearSession = false}) {
    if (working) return;
    setState(() {
      mode = value;
      registration = null;
      password.clear();
      confirmedEmail.clear();
      localError = null;
      deliveryNotice = null;
    });
    if (clearSession &&
        widget.registrationAuth == null &&
        !FirebaseGateway.emulator &&
        widget.app.gateway is FirebaseGateway) {
      unawaited((widget.app.gateway as FirebaseGateway).signOut());
    } else if (!clearSession &&
        value != _SetupMode.login &&
        widget.registrationAuth == null &&
        !FirebaseGateway.emulator &&
        widget.app.gateway is FirebaseGateway) {
      unawaited(_restoreSignedInEmployee());
    }
  }

  Future<void> _restoreSignedInEmployee() async {
    try {
      final remote = widget.app.gateway as FirebaseGateway;
      final account = await remote.currentSignedInAccount();
      if (!mounted ||
          account == null ||
          !employeeFlow ||
          registration != null) {
        return;
      }
      final flow = EmployeeRegistration(
        widget.registrationAuth ?? widget.app.employeeRegistrationAuth,
      )..account = account;
      setState(() {
        registration = flow;
        email.text = account.email;
        deliveryNotice = account.emailVerified
            ? 'البريد مؤكد وجاهز؛ أدخل كود دعوة المدير واضغط متابعة.'
            : 'أُرسلت رسالة تأكيد إلى بريدك. افتحها واضغط رابط التأكيد ثم ارجع هنا.';
      });
    } catch (_) {}
  }

  Future<void> _employeeAction(Future<void> Function() action) async {
    if (working) return;
    setState(() {
      busy = true;
      localError = null;
    });
    try {
      await action();
    } catch (error) {
      if (mounted) setState(() => localError = arabicError(error));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _beginEmployee() => _employeeAction(() async {
    if (!form.currentState!.validate()) return;
    EmployeeInvitationCode.parse(invitation.text);
    final flow = registration ??= EmployeeRegistration(
      widget.registrationAuth ?? widget.app.employeeRegistrationAuth,
    );
    await flow.begin(
      email: email.text,
      password: password.text,
      create: mode == _SetupMode.employeeCreate,
    );
    password.clear();
    if (flow.verificationDeliveryError != null) {
      deliveryNotice = 'الحساب موجود ويمكنك الدخول به. تعذر إرسال رسالة التأكيد؛ اضغط إعادة الإرسال. لا تنشئ حساباً آخر.';
    } else if (!flow.account!.emailVerified) {
      deliveryNotice = 'أُرسلت رسالة تأكيد إلى بريدك. افتحها واضغط رابط التأكيد ثم ارجع هنا.';
    }
    if (flow.account!.emailVerified) await _completeEmployee();
  });

  Future<void> _completeEmployee() async {
    EmployeeInvitationCode.parse(invitation.text);
    final flow = registration!;
    if (!await flow.refreshVerified()) {
      invalid(
        'email_unverified',
        'البريد لم يتأكد بعد؛ افتح رسالة التأكيد ثم أعد المحاولة',
      );
    }
    await widget.app.connectEmployeeInvitation(
      invitationToken: invitation.text,
      expectedUid: flow.account!.uid,
    );
  }

  Future<void> _resend() => _employeeAction(() async {
    await registration!.resend();
    deliveryNotice =
        'أُرسلت رسالة تأكيد جديدة؛ راجع الوارد والرسائل غير المرغوب فيها.';
  });

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              const SizedBox(height: 24),
              const Icon(
                Icons.spa_outlined,
                size: 64,
                color: Color(0xff235b42),
              ),
              const Text(
                'دفتر الفراولة',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 32, fontWeight: FontWeight.bold),
              ),
              const Text(
                'شغلك محفوظ معك، حتى دون إنترنت',
                textAlign: TextAlign.center,
              ),
              heading('إعداد الحساب والجهاز'),
              const Text(
                'يلزم الإنترنت أول مرة. بعد الإعداد يمكنك العمل من السجل المحلي دون اتصال.',
              ),
              if (FirebaseGateway.emulator)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 12),
                  child: Text(
                    'نسخة اختبار متصلة بالمحاكيات فقط',
                    style: TextStyle(color: Colors.deepOrange),
                  ),
                ),
              Form(
                key: form,
                child: Column(
                  children: [
                    const SizedBox(height: 16),
                    DropdownButtonFormField<_SetupMode>(
                      key: ValueKey(mode),
                      initialValue: mode,
                      decoration: const InputDecoration(
                        labelText: 'طريقة الدخول',
                      ),
                      items: const [
                        DropdownMenuItem(
                          value: _SetupMode.login,
                          child: Text('تسجيل الدخول المعتاد'),
                        ),
                        DropdownMenuItem(
                          value: _SetupMode.employeeCreate,
                          child: Text('إنشاء حساب موظف'),
                        ),
                        DropdownMenuItem(
                          value: _SetupMode.employeeExisting,
                          child: Text('لدي حساب ومعي دعوة'),
                        ),
                      ],
                      onChanged: working
                          ? null
                          : (value) {
                              if (value != null) _switchMode(value);
                            },
                    ),
                    if (employeeFlow) ...[
                      const SizedBox(height: 12),
                      const Text(
                        'كود المدير يحدد المنشأة تلقائياً ويمنحك صلاحية موظف. لا يلزم حساب من لوحة اللاب.',
                      ),
                    ] else ...[
                      const SizedBox(height: 14),
                      TextFormField(
                        controller: tenant,
                        enabled: !working,
                        textDirection: TextDirection.ltr,
                        decoration: const InputDecoration(
                          labelText: 'معرّف المنشأة',
                        ),
                        validator: (v) => v == null || v.isEmpty
                            ? 'أدخل معرّف المنشأة'
                            : null,
                      ),
                    ],
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: email,
                      enabled: !working && !awaitingVerification,
                      textDirection: TextDirection.ltr,
                      keyboardType: TextInputType.emailAddress,
                      autocorrect: false,
                      enableSuggestions: false,
                      decoration: const InputDecoration(
                        labelText: 'البريد الإلكتروني',
                      ),
                      validator: (v) => v == null || !v.contains('@')
                          ? 'أدخل بريداً إلكترونياً صحيحاً'
                          : null,
                    ),
                    if (mode == _SetupMode.employeeCreate &&
                        !awaitingVerification) ...[
                      const SizedBox(height: 14),
                      TextFormField(
                        controller: confirmedEmail,
                        enabled: !working,
                        textDirection: TextDirection.ltr,
                        keyboardType: TextInputType.emailAddress,
                        autocorrect: false,
                        enableSuggestions: false,
                        decoration: const InputDecoration(
                          labelText: 'تأكيد البريد الإلكتروني',
                        ),
                        validator: (v) =>
                            v?.trim().toLowerCase() ==
                                email.text.trim().toLowerCase()
                            ? null
                            : 'اكتب نفس البريد مرة أخرى لتأكيده',
                      ),
                    ],
                    if (!awaitingVerification) ...[
                      const SizedBox(height: 14),
                      TextFormField(
                        controller: password,
                        enabled: !working,
                        textDirection: TextDirection.ltr,
                        obscureText: true,
                        enableSuggestions: false,
                        autocorrect: false,
                        decoration: const InputDecoration(
                          labelText: 'كلمة المرور',
                        ),
                        validator: (v) => v == null || v.isEmpty
                            ? 'أدخل كلمة المرور'
                            : mode == _SetupMode.employeeCreate && v.length < 6
                            ? 'اكتب كلمة مرور من 6 أحرف على الأقل'
                            : null,
                      ),
                    ],
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: invitation,
                      enabled: !working,
                      textDirection: TextDirection.ltr,
                      autocorrect: false,
                      enableSuggestions: false,
                      decoration: InputDecoration(
                        labelText: employeeFlow
                            ? 'كود دعوة المدير'
                            : 'رمز دعوة الموظف (أول مرة فقط)',
                      ),
                      maxLength: 240,
                      validator: employeeFlow
                          ? (value) {
                              try {
                                EmployeeInvitationCode.parse(value ?? '');
                                return null;
                              } catch (error) {
                                return arabicError(error);
                              }
                            }
                          : null,
                    ),
                    const SizedBox(height: 20),
                    if (awaitingVerification) ...[
                      Text('الحساب جاهز: ${registration!.account!.email}'),
                      const SizedBox(height: 8),
                      if (deliveryNotice != null) Text(deliveryNotice!),
                      const SizedBox(height: 8),
                      const Text(
                        'لن تُستخدم الدعوة قبل تأكيد البريد وقبول الخادم. لو أغلقت التطبيق، اختر «لدي حساب ومعي دعوة» واستخدم نفس الحساب والكود.',
                      ),
                      TextButton.icon(
                        onPressed: working ? null : _resend,
                        icon: const Icon(Icons.mark_email_unread_outlined),
                        label: const Text('إعادة إرسال رسالة التأكيد'),
                      ),
                    ],
                    if (localError != null ||
                        (!employeeFlow && widget.app.error != null))
                      Text(
                        localError ?? widget.app.error!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    FilledButton.icon(
                      onPressed: working
                          ? null
                          : employeeFlow
                          ? awaitingVerification
                                ? () => _employeeAction(_completeEmployee)
                                : _beginEmployee
                          : () async {
                              if (!form.currentState!.validate()) return;
                              await guard(
                                context,
                                () => widget.app.connect(
                                  tenant: tenant.text.trim(),
                                  email: email.text,
                                  password: password.text,
                                  invitationToken: invitation.text,
                                ),
                              );
                              if (mounted) setState(() {});
                            },
                      icon: working
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.lock_open),
                      label: Text(
                        !employeeFlow
                            ? 'إعداد آمن وفتح السجل'
                            : awaitingVerification
                            ? 'أكدت بريدي، متابعة'
                            : mode == _SetupMode.employeeCreate
                            ? 'إنشاء الحساب وإرسال التأكيد'
                            : 'تسجيل الدخول بالدعوة',
                      ),
                    ),
                    if (awaitingVerification)
                      TextButton(
                        onPressed: working
                            ? null
                            : () => _switchMode(
                                _SetupMode.employeeExisting,
                                clearSession: true,
                              ),
                        child: const Text('تغيير الحساب أو كود الدعوة'),
                      ),
                    if (employeeFlow && !awaitingVerification)
                      const Padding(
                        padding: EdgeInsets.only(top: 12),
                        child: Text(
                          'لو بريدك مسجل بالفعل، اختر «لدي حساب ومعي دعوة». لن تتغير كلمة مرور حساب موجود.',
                        ),
                      ),
                  ],
                ),
              ),
              heading('معرّف هذا الجهاز'),
              SelectableText(
                widget.app.identity?.deviceId ?? 'جارٍ تجهيز هوية الجهاز',
                textDirection: TextDirection.ltr,
              ),
              TextButton.icon(
                onPressed: widget.app.identity == null
                    ? null
                    : () => Clipboard.setData(
                        ClipboardData(
                          text: jsonEncode({
                            'deviceId': widget.app.identity!.deviceId,
                            'publicKeySpki': widget.app.identity!.publicKeySpki,
                            'algorithm': widget.app.identity!.algorithm,
                          }),
                        ),
                      ),
                icon: const Icon(Icons.copy),
                label: const Text('نسخ طلب تسجيل الجهاز'),
              ),
              const Text(
                'أرسل الطلب إلى المسؤول بالطريقة التي تختارها. لا يرسل التطبيق رسائل تلقائياً.',
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, required this.app});
  final AppController app;
  @override
  Widget build(BuildContext context) {
    final active = LedgerRules.activeEntries(app.displayRecentEntries);
    final sales = active
        .where((e) => e.kind == 'sale' || e.kind == 'sale_return')
        .fold(
          0,
          (n, e) => n + (e.kind == 'sale' ? e.totalMinor : -e.totalMinor),
        );
    final purchases = active
        .where((e) => e.kind == 'purchase' || e.kind == 'purchase_return')
        .fold(
          0,
          (n, e) => n + (e.kind == 'purchase' ? e.totalMinor : -e.totalMinor),
        );
    final pendingReviews = app.submissions
        .where(
          (s) => {
            'pending',
            'awaiting_approval',
            'server_accepted',
          }.contains(s['state']),
        )
        .length;
    final actions = app.manager
        ? <String, IconData>{
            'sale': Icons.north_east,
            'purchase': Icons.south_west,
            'merchant_payment': Icons.payments_outlined,
            'supplier_payment': Icons.account_balance_wallet_outlined,
            'expense_business': Icons.receipt_outlined,
            'sale_return': Icons.assignment_return_outlined,
          }
        : <String, IconData>{
            'delivery': Icons.local_shipping_outlined,
            'purchase_delivery': Icons.agriculture_outlined,
            'expense_business': Icons.receipt_outlined,
            'sale_return': Icons.assignment_return_outlined,
            'purchase_return': Icons.keyboard_return_outlined,
          };
    void openPage(String title, Widget body) => Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) => Scaffold(
          appBar: AppBar(title: Text(title)),
          body: SafeArea(child: body),
        ),
      ),
    );
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: const Color(0xff235b42),
            borderRadius: BorderRadius.circular(22),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Row(
                children: [
                  Icon(Icons.offline_pin_outlined, color: Color(0xffd6ebc8)),
                  SizedBox(width: 8),
                  Text(
                    'سجلك المحلي جاهز',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                app.pending.isEmpty
                    ? 'لا توجد عمليات في انتظار الإرسال'
                    : '${app.pending.length} عملية محفوظة في انتظار الخادم',
                style: const TextStyle(color: Colors.white),
              ),
              Text(
                app.lastSync == null
                    ? 'لم تكتمل المزامنة بعد'
                    : 'آخر مزامنة: ${app.lastSync!.replaceFirst('T', ' ').substring(0, 16)}',
                style: const TextStyle(color: Color(0xffd6ebc8), fontSize: 12),
              ),
              if (app.syncMessage != null)
                Text(
                  app.syncMessage!,
                  style: const TextStyle(color: Colors.white, fontSize: 12),
                ),
            ],
          ),
        ),
        if (app.manager && pendingReviews > 0) ...[
          const SizedBox(height: 12),
          Card(
            color: const Color(0xfffff4e5),
            child: ListTile(
              leading: const Icon(
                Icons.fact_check_outlined,
                color: Color(0xff8a4b00),
              ),
              title: Text(
                'لديك $pendingReviews طلب من الموظفين بانتظار المراجعة',
                style: const TextStyle(fontWeight: FontWeight.bold),
              ),
              subtitle: const Text('اضغط للمراجعة والاعتماد فوراً'),
              trailing: const Icon(Icons.chevron_left),
              onTap: () =>
                  openPage('مراجعة الطلبات', ReviewScreen(app: app)),
            ),
          ),
        ],
        heading('عملية جديدة'),
        GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: 10,
          crossAxisSpacing: 10,
          childAspectRatio: 1.7,
          children: actions.entries
              .map(
                (a) => Card(
                  margin: EdgeInsets.zero,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(18),
                    onTap: app.allowed
                        ? () => openEntry(context, app, a.key)
                        : null,
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Row(
                        children: [
                          Icon(
                            a.value,
                            color: const Color(0xff235b42),
                            size: 27,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(
                              kindLabels[a.key] ??
                                  {
                                    'delivery': 'تسليم لعميل',
                                    'purchase_delivery': 'استلام من مورد',
                                  }[a.key] ??
                                  'عملية',
                              style: const TextStyle(
                                fontSize: 17,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              )
              .toList(),
        ),
        if (app.manager) ...[
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              ActionChip(
                avatar: const Icon(Icons.keyboard_return_outlined, size: 18),
                label: const Text('مرتجع شراء'),
                onPressed: app.allowed
                    ? () => openEntry(context, app, 'purchase_return')
                    : null,
              ),
              ActionChip(
                avatar: const Icon(Icons.payments_outlined, size: 18),
                label: const Text('دفعة راتب'),
                onPressed: app.allowed
                    ? () => openEntry(context, app, 'payroll')
                    : null,
              ),
              ActionChip(
                avatar: const Icon(Icons.home_work_outlined, size: 18),
                label: const Text('مصروف منزل'),
                onPressed: app.allowed
                    ? () => openEntry(context, app, 'expense_home')
                    : null,
              ),
              ActionChip(
                avatar: const Icon(Icons.person_add_alt_1_outlined, size: 18),
                label: const Text('عميل جديد'),
                onPressed: app.allowed
                    ? () => _addParty(context, app, 'merchant')
                    : null,
              ),
              ActionChip(
                avatar: const Icon(Icons.agriculture_outlined, size: 18),
                label: const Text('مورد جديد'),
                onPressed: app.allowed
                    ? () => _addParty(context, app, 'supplier')
                    : null,
              ),
              ActionChip(
                avatar: const Icon(Icons.badge_outlined, size: 18),
                label: const Text('الموظفون والدعوات'),
                onPressed: () =>
                    openPage('الموظفون والرواتب', EmployeesScreen(app: app)),
              ),
            ],
          ),
        ],
        if (app.manager) ...[
          heading('نظرة على السجل'),
          Row(
            children: [
              Expanded(
                child: _Metric(title: 'إجمالي البيع المسجل', amount: sales),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: _Metric(
                  title: 'إجمالي الشراء المسجل',
                  amount: purchases,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          _Metric(
            title: 'صافي الحركة النقدية المسجلة',
            amount: LedgerRules.netRecordedCash(active),
          ),
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text(
              'لا تمثل هذه المؤشرات الربح الفعلي أو النقدية الفعلية في الخزينة.',
              style: TextStyle(fontSize: 12, color: Colors.black54),
            ),
          ),
          heading('أحدث العمليات'),
          ...app.displayRecentEntries
              .take(5)
              .map((e) => EntryTile(entry: e, app: app)),
        ] else ...[
          heading('آخر طلباتك'),
          ...app.submissions
              .take(5)
              .map((s) => SubmissionTile(value: s, app: app)),
        ],
        FutureBuilder<List<Map<String, dynamic>>>(
          future: app.store!.listDrafts(),
          builder: (context, snapshot) {
            final drafts = snapshot.data ?? [];
            return drafts.isEmpty
                ? const SizedBox.shrink()
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      heading('مسودات لم تُحفظ كعمليات'),
                      ...drafts.map(
                        (d) => ListTile(
                          leading: const Icon(Icons.edit_note),
                          title: Text(kindLabels[d['kind']] ?? 'مسودة'),
                          subtitle: const Text('اضغط لاستكمال الإدخال'),
                          onTap: () => openEntry(
                            context,
                            app,
                            d['kind'] as String? ?? 'sale',
                            draft: d,
                          ),
                        ),
                      ),
                    ],
                  );
          },
        ),
      ],
    );
  }
}

class _Metric extends StatelessWidget {
  const _Metric({required this.title, required this.amount});
  final String title;
  final int amount;
  @override
  Widget build(BuildContext context) => Card(
    margin: EdgeInsets.zero,
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(fontSize: 13, color: Colors.black54),
          ),
          const SizedBox(height: 8),
          FittedBox(child: money(amount)),
        ],
      ),
    ),
  );
}

class EntryTile extends StatelessWidget {
  const EntryTile({super.key, required this.entry, required this.app});
  final LedgerEntry entry;
  final AppController app;
  @override
  Widget build(BuildContext context) {
    final queued = app.pending
        .where(
          (p) =>
              p['id'] == entry.id ||
              (entry.id.startsWith('review_') &&
                  p['entity'] == 'review' &&
                  (p['payload'] as Map?)?['submissionId'] ==
                      entry.id.substring('review_'.length)),
        )
        .firstOrNull;
    final actor = app.entryActorLabel(entry);
    return Card(
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        leading: CircleAvatar(
          backgroundColor: const Color(0xffedf4ef),
          child: Icon(
            entry.isReturn
                ? Icons.assignment_return_outlined
                : Icons.receipt_long,
            color: const Color(0xff235b42),
          ),
        ),
        title: Text(
          '${entryDescription(entry)}${entry.partyName.isEmpty ? '' : ' · ${entry.partyName}'}',
        ),
        subtitle: Text(
          '${entry.date} · $actor · ${stateLabel(queued == null ? 'server_accepted' : queued['state'] as String?)}\n${entry.qtyMilli > 0 ? '${formatQuantity(entry.qtyMilli)} ${entry.unit} · ${entry.grade}' : entry.note}',
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
        ),
        trailing: entry.kind == 'shipment_update'
            ? const Text('تحديث شحنة')
            : money(entry.totalMinor, size: 15),
        onTap: () => showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          builder: (c) => SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    entryDescription(entry),
                    style: const TextStyle(
                      fontSize: 24,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  if (entry.partyName.isNotEmpty) Text(entry.partyName),
                  Text('مسجل العملية: $actor'),
                  if (entry.qtyMilli > 0)
                    Text(
                      'الكمية: ${formatQuantity(entry.qtyMilli)} ${entry.unit} · الصنف: ${entry.grade}${entry.priceMinor > 0 ? ' · سعر الوحدة: ${formatMoney(entry.priceMinor)} ج.م' : ''}',
                    ),
                  Text(
                    'القيمة: ${formatMoney(entry.totalMinor)} ج.م · المدفوع: ${formatMoney(entry.paidMinor)} ج.م',
                  ),
                  Text('المعرف: ${entry.id}', textDirection: TextDirection.ltr),
                  if (entry.originalId.isNotEmpty)
                    Text(
                      'أصل الفاتورة: ${entry.originalId}',
                      textDirection: TextDirection.ltr,
                    ),
                  Text(entry.note),
                  const SizedBox(height: 14),
                  if (entry.kind != 'shipment_update')
                    OutlinedButton.icon(
                      onPressed: () {
                        Navigator.pop(c);
                        openEntry(context, app, entry.kind, copy: entry);
                      },
                      icon: const Icon(Icons.copy),
                      label: const Text('نسخ إلى مسودة جديدة'),
                    ),
                  if (entry.isInvoice)
                    OutlinedButton.icon(
                      onPressed: app.allowed
                          ? () {
                              Navigator.pop(c);
                              openEntry(
                                context,
                                app,
                                '${entry.kind}_return',
                                original: entry,
                              );
                            }
                          : null,
                      icon: const Icon(Icons.assignment_return),
                      label: const Text('تسجيل مرتجع من الفاتورة'),
                    ),
                  if (entry.isInvoice)
                    OutlinedButton.icon(
                      onPressed: () {
                        Navigator.pop(c);
                        Navigator.push(
                          context,
                          MaterialPageRoute<void>(
                            builder: (_) =>
                                ShipmentEditor(app: app, invoice: entry),
                          ),
                        );
                      },
                      icon: const Icon(Icons.local_shipping_outlined),
                      label: const Text('عرض وتحديث بيانات الشحنة'),
                    ),
                  if (entry.kind != 'reversal' &&
                      entry.kind != 'shipment_update')
                    TextButton.icon(
                      onPressed: app.allowed
                          ? () {
                              Navigator.pop(c);
                              openEntry(
                                context,
                                app,
                                'reversal',
                                original: entry,
                              );
                            }
                          : null,
                      icon: const Icon(Icons.undo),
                      label: const Text('تصحيح بقيد عكسي موثق'),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class LedgerScreen extends StatefulWidget {
  const LedgerScreen({super.key, required this.app});
  final AppController app;
  @override
  State<LedgerScreen> createState() => _LedgerScreenState();
}

class _LedgerScreenState extends State<LedgerScreen> {
  String search = '', kind = 'all', from = '', to = '';
  int count = 100;
  @override
  Widget build(BuildContext context) {
    final entries = widget.app.displayRecentEntries
        .where(
          (e) =>
              (kind == 'all' || e.kind == kind) &&
              (search.isEmpty ||
                  '${e.partyName} ${e.note} ${e.id} ${widget.app.entryActorLabel(e)}'
                      .contains(search)) &&
              (from.isEmpty || e.date.compareTo(from) >= 0) &&
              (to.isEmpty || e.date.compareTo(to) <= 0),
        )
        .toList();
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        TextField(
          decoration: const InputDecoration(
            labelText: 'ابحث باسم الطرف أو الملاحظات أو المعرف',
            prefixIcon: Icon(Icons.search),
          ),
          onChanged: (v) => setState(() => search = v),
        ),
        const SizedBox(height: 12),
        DropdownButtonFormField<String>(
          initialValue: kind,
          decoration: const InputDecoration(labelText: 'نوع العملية'),
          items: [
            const DropdownMenuItem(value: 'all', child: Text('كل العمليات')),
            ...kindLabels.entries.map(
              (e) => DropdownMenuItem(value: e.key, child: Text(e.value)),
            ),
          ],
          onChanged: (v) => setState(() => kind = v!),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: TextField(
                decoration: const InputDecoration(
                  labelText: 'من تاريخ',
                  hintText: '2026-01-01',
                ),
                textDirection: TextDirection.ltr,
                onChanged: (v) => setState(() => from = v),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: TextField(
                decoration: const InputDecoration(
                  labelText: 'إلى تاريخ',
                  hintText: '2026-12-31',
                ),
                textDirection: TextDirection.ltr,
                onChanged: (v) => setState(() => to = v),
              ),
            ),
          ],
        ),
        heading('${entries.length} عملية'),
        if (entries.isEmpty) empty('لا توجد عمليات مطابقة'),
        ...entries.take(count).map((e) => EntryTile(entry: e, app: widget.app)),
        if (entries.length > count)
          OutlinedButton(
            onPressed: () => setState(() => count += 100),
            child: const Text('عرض عمليات أقدم'),
          ),
        const SizedBox(height: 20),
      ],
    );
  }
}

Future<void> openEntry(
  BuildContext context,
  AppController app,
  String kind, {
  LedgerEntry? original,
  LedgerEntry? copy,
  Map<String, dynamic>? draft,
}) async {
  await Navigator.push<void>(
    context,
    MaterialPageRoute(
      builder: (_) => EntryForm(
        app: app,
        kind: kind,
        original: original,
        copy: copy,
        draft: draft,
      ),
    ),
  );
}

class EntryForm extends StatefulWidget {
  const EntryForm({
    super.key,
    required this.app,
    required this.kind,
    this.original,
    this.copy,
    this.draft,
  });
  final AppController app;
  final String kind;
  final LedgerEntry? original, copy;
  final Map<String, dynamic>? draft;
  @override
  State<EntryForm> createState() => _EntryFormState();
}

class _EntryFormState extends State<EntryForm> with WidgetsBindingObserver {
  final form = GlobalKey<FormState>();
  late String id, kind, date, grade, unit;
  String category = 'مصاريف أخرى', adjustmentDirection = 'increase';
  String? partyId, employeeId, originalId;
  final qty = TextEditingController(),
      price = TextEditingController(),
      paid = TextEditingController(text: '0'),
      amount = TextEditingController(),
      note = TextEditingController(),
      salaryMonth = TextEditingController(),
      shipmentRef = TextEditingController();
  bool saving = false, another = false;
  String? error, draftError;
  Timer? debounce;
  AppController get app => widget.app;
  bool get invoice =>
      {'sale', 'purchase', 'delivery', 'purchase_delivery'}.contains(kind);
  bool get returns => kind.endsWith('_return');
  bool get needsParty =>
      invoice ||
      returns ||
      {
        'merchant_payment',
        'supplier_payment',
        'balance_adjustment',
      }.contains(kind);
  LedgerEntry? get original =>
      originalId == null || originalId!.isEmpty
          ? null
          : (app.entries.where((e) => e.id == originalId).firstOrNull ??
                (widget.original?.id == originalId ? widget.original : null));
  Party? get party => app.parties.where((p) => p.id == partyId).firstOrNull;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    kind = widget.kind;
    id = widget.draft?['id'] as String? ?? newId();
    date = widget.draft?['date'] as String? ?? today();
    grade =
        widget.draft?['grade'] as String? ??
        widget.original?.grade ??
        widget.copy?.grade ??
        grades.first;
    unit =
        widget.draft?['unit'] as String? ??
        widget.original?.unit ??
        widget.copy?.unit ??
        'كيلو';
    partyId =
        widget.draft?['partyId'] as String? ??
        widget.original?.partyId ??
        widget.copy?.partyId;
    originalId = widget.draft?['originalId'] as String? ?? widget.original?.id;
    employeeId = widget.draft?['employeeId'] as String?;
    salaryMonth.text = widget.draft?['salaryMonth'] as String? ?? month();
    category =
        widget.draft?['category'] as String? ??
        widget.copy?.category ??
        'مصاريف أخرى';
    if (category.isEmpty) category = 'مصاريف أخرى';
    adjustmentDirection =
        widget.draft?['adjustmentDirection'] as String? ?? 'increase';
    final d = widget.draft;
    if (d != null) {
      qty.text = d['qtyText'] as String? ?? '';
      price.text = d['priceText'] as String? ?? '';
      paid.text = d['paidText'] as String? ?? '0';
      amount.text = d['amountText'] as String? ?? '';
      note.text = d['note'] as String? ?? '';
      shipmentRef.text = d['shipmentRef'] as String? ?? '';
    } else if (widget.copy != null) {
      price.text = widget.copy!.priceMinor > 0
          ? formatMoney(widget.copy!.priceMinor)
          : '';
      note.text = widget.copy!.note;
    }
    if (returns && original != null) {
      price.text = formatMoney(original!.priceMinor);
    }
    for (final c in [
      qty,
      price,
      paid,
      amount,
      note,
      salaryMonth,
      shipmentRef,
    ]) {
      c.addListener(_changed);
    }
    unawaited(_preferences());
  }

  Future<void> _preferences() async {
    if (widget.draft != null ||
        widget.original != null ||
        widget.copy != null) {
      return;
    }
    final g = await app.store!.preference('grade'),
        u = await app.store!.preference('unit');
    if (mounted) {
      setState(() {
        if (g is String) grade = g;
        if (u is String) unit = u;
      });
    }
  }

  void _changed() {
    if (mounted) setState(() {});
    debounce?.cancel();
    debounce = Timer(const Duration(milliseconds: 350), () => _saveDraft());
  }

  Map<String, dynamic> _draft() => {
    'id': id,
    'tenantId': app.tenantId,
    'creatorUid': app.uid,
    'employeeId': app.manager ? (employeeId ?? '') : app.employeeId,
    'kind': kind,
    'date': date,
    'partyId': partyId ?? '',
    'partyName': party?.name ?? '',
    'grade': grade,
    'unit': unit,
    'originalId': originalId ?? '',
    'qtyMilli': 0,
    'amountMinor': 0,
    'qtyText': qty.text,
    'category': kind.startsWith('expense_') ? category : '',
    if (app.manager)
      'adjustmentDirection': kind == 'balance_adjustment'
          ? adjustmentDirection
          : '',
    'amountText': amount.text,
    'note': note.text,
    if (app.manager || kind == 'purchase_delivery') 'priceText': price.text,
    if (app.manager) ...{
      'paidText': paid.text,
      'salaryMonth': salaryMonth.text,
      'shipmentRef': shipmentRef.text,
    },
  };
  Future<void> _saveDraft() async {
    if (saving || app.store == null) return;
    try {
      await app.store!.saveDraft(id, _draft());
      if (mounted && draftError != null) setState(() => draftError = null);
    } catch (e) {
      if (mounted) {
        setState(
          () => draftError = 'تعذر حفظ المسودة في الجهاز؛ احتفظ بالشاشة مفتوحة حتى تتوفر مساحة',
        );
      }
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) unawaited(_saveDraft());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    debounce?.cancel();
    for (final c in [
      qty,
      price,
      paid,
      amount,
      note,
      salaryMonth,
      shipmentRef,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  String? numeric(String? text, int scale, {bool positive = false}) {
    try {
      final n = parseScaled(text ?? '', scale);
      return positive && n <= 0 ? 'أدخل قيمة أكبر من صفر' : null;
    } catch (e) {
      return arabicError(e);
    }
  }

  Widget number(
    TextEditingController c,
    String label,
    int scale, {
    bool positive = false,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 14),
    child: TextFormField(
      controller: c,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      textDirection: TextDirection.ltr,
      decoration: InputDecoration(labelText: label),
      validator: (v) => numeric(v, scale, positive: positive),
    ),
  );
  int get total {
    try {
      if (returns) {
        if (original != null) {
          return LedgerRules.returnTotal(
            original!,
            parseScaled(qty.text, 1000),
            app.entries,
          );
        }
        if (app.manager) {
          return invoiceTotal(
            parseScaled(qty.text, 1000),
            parseScaled(price.text, 100),
          );
        }
        return 0;
      }
      if ((invoice && app.manager) ||
          (!app.manager && kind == 'purchase_delivery')) {
        return invoiceTotal(
          parseScaled(qty.text, 1000),
          parseScaled(price.text, 100),
        );
      }
      return parseScaled(amount.text, 100);
    } catch (_) {
      return 0;
    }
  }

  List<int> _suggestedPrices() {
    if (!invoice || !app.manager) return const [];
    final result = <int>[];
    final active = LedgerRules.activeEntries(app.entries).reversed;
    if (partyId != null) {
      for (final e in active) {
        if (e.kind == kind &&
            e.partyId == partyId &&
            e.grade == grade &&
            e.priceMinor > 0 &&
            !result.contains(e.priceMinor)) {
          result.add(e.priceMinor);
          if (result.length >= 2) break;
        }
      }
    }
    for (final e in active) {
      if (e.kind == kind &&
          e.grade == grade &&
          e.priceMinor > 0 &&
          !result.contains(e.priceMinor)) {
        result.add(e.priceMinor);
        if (result.length >= 3) break;
      }
    }
    return result;
  }

  Future<void> _selectParty() async {
    final scopedStore = app.store;
    var recentIds = <String>[];
    try {
      recentIds = List<String>.from(
        await scopedStore?.preference('recentPartyIds') as List? ?? [],
      );
    } catch (_) {
      // Selection remains available if an optional preference cannot be read.
    }
    if (!mounted || app.store != scopedStore) return;
    final wanted = kind == 'balance_adjustment'
        ? null
        : {'sale', 'sale_return', 'delivery', 'merchant_payment'}.contains(kind)
        ? 'merchant'
        : 'supplier';
    final selected = await showModalBottomSheet<Party>(
      context: context,
      isScrollControlled: true,
      builder: (c) => PartyPicker(
        app: app,
        wantedKind: wanted,
        recentIds: recentIds,
        parties: app.parties
            .where((p) => wanted == null || p.kind == wanted)
            .toList(),
      ),
    );
    if (selected != null) {
      setState(() => partyId = selected.id);
      _changed();
    }
  }

  Future<void> _save() async {
    if (saving || !form.currentState!.validate()) return;
    if (needsParty && party == null) {
      setState(() => error = 'اختر العميل أو المورد أولاً');
      return;
    }
    if (kind == 'reversal' && (originalId == null || originalId!.isEmpty)) {
      setState(() => error = 'اختر العملية المراد عكسها');
      return;
    }
    setState(() {
      saving = true;
      error = null;
    });
    debounce?.cancel();
    try {
      await app.requireAllowed();
      if (!app.manager) {
        final submission = EmployeeSubmission(
          id: id,
          tenantId: app.tenantId,
          creatorUid: app.uid,
          employeeId: app.employeeId,
          kind: kind,
          date: date,
          partyId: needsParty ? party!.id : '',
          partyName: needsParty ? party!.name : '',
          qtyMilli: needsParty ? parseScaled(qty.text, 1000) : 0,
          grade: needsParty ? grade : '',
          unit: needsParty ? unit : '',
          originalId: returns ? (originalId ?? '') : '',
          amountMinor: kind == 'expense_business'
              ? parseScaled(amount.text, 100)
              : kind == 'purchase_delivery'
              ? parseScaled(price.text, 100)
              : 0,
          note: note.text.trim(),
          category: kind == 'expense_business' ? category : '',
        );
        await app.saveSubmission(submission);
      } else {
        final isMoney = !invoice && !returns && kind != 'reversal';
        final entry = LedgerEntry(
          id: id,
          tenantId: app.tenantId,
          creatorUid: app.uid,
          kind: kind,
          date: date,
          partyId: needsParty ? party!.id : '',
          partyName: needsParty ? party!.name : '',
          employeeId: kind == 'payroll' ? employeeId ?? '' : '',
          salaryMonth: kind == 'payroll' ? salaryMonth.text : '',
          qtyMilli: invoice || returns ? parseScaled(qty.text, 1000) : 0,
          priceMinor: invoice
              ? parseScaled(price.text, 100)
              : returns
              ? (original != null
                    ? original!.priceMinor
                    : parseScaled(price.text, 100))
              : 0,
          totalMinor: kind == 'reversal' ? 0 : total,
          paidMinor: kind == 'balance_adjustment'
              ? 0
              : kind == 'reversal'
              ? 0
              : isMoney
              ? parseScaled(amount.text, 100)
              : parseScaled(paid.text, 100),
          grade: invoice || returns ? grade : '',
          unit: invoice || returns ? unit : '',
          originalId: returns || kind == 'reversal' ? originalId ?? '' : '',
          note: note.text.trim(),
          shipmentRef: invoice ? shipmentRef.text.trim() : '',
          category: kind.startsWith('expense_') ? category : '',
          adjustmentDirection: kind == 'balance_adjustment'
              ? adjustmentDirection
              : '',
        );
        await app.saveEntry(entry);
      }
      try {
        await app.store!.setPreference('grade', grade);
        await app.store!.setPreference('unit', unit);
        if (needsParty) {
          final recent = List<String>.from(
            await app.store!.preference('recentPartyIds') as List? ?? [],
          );
          recent.remove(partyId);
          recent.insert(0, partyId!);
          await app.store!.setPreference(
            'recentPartyIds',
            recent.take(12).toList(),
          );
        }
      } catch (_) {
        /* Preferences never change a committed-save result. */
      }
      if (!mounted) return;
      snack(
        context,
        app.manager
            ? 'حُفظت العملية محلياً؛ سيظهر قبول الخادم بعد المزامنة'
            : 'حُفظ الطلب محلياً؛ بانتظار الإرسال واعتماد المدير',
      );
      if (another) {
        setState(() {
          id = newId();
          qty.clear();
          if (!app.manager && kind == 'purchase_delivery') price.clear();
          paid.text = '0';
          amount.clear();
          note.clear();
          saving = false;
        });
      } else {
        Navigator.pop(context);
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          saving = false;
          error = arabicError(e);
        });
        await _saveDraft();
      }
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !saving,
    onPopInvokedWithResult: (didPop, result) {
      if (didPop) unawaited(_saveDraft());
    },
    child: Scaffold(
      appBar: AppBar(
        title: Text(
          kindLabels[kind] ??
              {
                'delivery': 'تسليم لعميل',
                'purchase_delivery': 'استلام من مورد',
              }[kind] ??
              'عملية جديدة',
        ),
      ),
      body: SafeArea(
        child: Form(
          key: form,
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              Text(
                'التسجيل محلي أولاً · ${app.manager ? 'عملية مالية' : 'طلب لاعتماد المدير'}',
                style: const TextStyle(color: Colors.black54),
              ),
              const SizedBox(height: 16),
              TextFormField(
                initialValue: date,
                textDirection: TextDirection.ltr,
                decoration: const InputDecoration(labelText: 'تاريخ العملية'),
                onChanged: (v) {
                  date = v;
                  _changed();
                },
                validator: (v) =>
                    validDate(v ?? '') ? null : 'التاريخ بصيغة سنة-شهر-يوم',
              ),
              const SizedBox(height: 14),
              if (needsParty) ...[
                OutlinedButton.icon(
                  onPressed: _selectParty,
                  icon: const Icon(Icons.person_search),
                  label: Text(party?.name ?? 'اختر العميل أو المورد'),
                ),
                const SizedBox(height: 14),
              ],
              if (returns && app.manager) ...[
                DropdownButtonFormField<String?>(
                  initialValue: originalId,
                  decoration: const InputDecoration(
                    labelText: 'الفاتورة الأصلية (اختياري)',
                  ),
                  isExpanded: true,
                  items: [
                    const DropdownMenuItem<String?>(
                      value: null,
                      child: Text('بدون فاتورة محددة (إدخال السعر يدوياً)'),
                    ),
                    ...LedgerRules.activeEntries(app.entries)
                        .where(
                          (e) =>
                              e.kind ==
                                  (kind == 'sale_return'
                                      ? 'sale'
                                      : 'purchase') &&
                              (partyId == null || partyId == e.partyId),
                        )
                        .map(
                          (e) => DropdownMenuItem<String?>(
                            value: e.id,
                            child: Text(
                              '${e.partyName} · ${e.date} · ${formatQuantity(e.qtyMilli)} ${e.unit}',
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ),
                  ],
                  onChanged: (v) {
                    setState(() {
                      originalId = v;
                      if (original != null) {
                        partyId = original!.partyId;
                        grade = original!.grade;
                        unit = original!.unit;
                        price.text = formatMoney(original!.priceMinor);
                      }
                    });
                    _changed();
                  },
                ),
                const SizedBox(height: 14),
              ],
              if (invoice || returns) ...[
                DropdownButtonFormField<String>(
                  initialValue: grade,
                  isExpanded: true,
                  decoration: const InputDecoration(
                    labelText: 'الصنف / الفرزة',
                  ),
                  items: {...grades, grade}
                      .map((g) => DropdownMenuItem(value: g, child: Text(g)))
                      .toList(),
                  onChanged: returns && app.manager && original != null
                      ? null
                      : (v) {
                          setState(() => grade = v!);
                          _changed();
                        },
                ),
                const SizedBox(height: 14),
                DropdownButtonFormField<String>(
                  initialValue: unit,
                  decoration: const InputDecoration(labelText: 'الوحدة'),
                  items: {'كيلو', 'طن', 'كرتونة', 'برنيكة', unit}
                      .map((u) => DropdownMenuItem(value: u, child: Text(u)))
                      .toList(),
                  onChanged: returns && app.manager && original != null
                      ? null
                      : (v) {
                          setState(() => unit = v!);
                          _changed();
                        },
                ),
                const SizedBox(height: 14),
                number(qty, 'الكمية (حتى ٣ منازل عشرية)', 1000, positive: true),
                Padding(
                  padding: const EdgeInsets.only(bottom: 14),
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 6,
                    children: [
                      for (final q in const ['10', '25', '50', '100', '250', '500'])
                        ActionChip(
                          label: Text('$q $unit'),
                          onPressed: () => qty.text = q,
                        ),
                    ],
                  ),
                ),
                if (app.manager) ...[
                  if (invoice || (returns && original == null)) ...[
                    number(price, 'سعر الوحدة بالجنيه', 100, positive: true),
                    if (_suggestedPrices().isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 14),
                        child: Wrap(
                          spacing: 8,
                          runSpacing: 6,
                          children: [
                            for (final p in _suggestedPrices())
                              ActionChip(
                                avatar: const Icon(Icons.history, size: 16),
                                label: Text('سعر سابق: ${formatMoney(p)}'),
                                onPressed: () => price.text = formatMoney(p),
                              ),
                          ],
                        ),
                      ),
                  ],
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: const Color(0xffedf4ef),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [const Text('الإجمالي'), money(total)],
                    ),
                  ),
                  const SizedBox(height: 14),
                  number(
                    paid,
                    returns ? 'النقدية المرتجعة بالجنيه' : 'المدفوع بالجنيه',
                    100,
                  ),
                  Wrap(
                    spacing: 10,
                    children: [
                      ActionChip(
                        label: const Text('آجل بالكامل'),
                        onPressed: () => paid.text = '0',
                      ),
                      ActionChip(
                        label: const Text('مدفوع بالكامل'),
                        onPressed: () => paid.text = formatMoney(total),
                      ),
                    ],
                  ),
                ] else if (kind == 'purchase_delivery') ...[
                  number(price, 'سعر الوحدة بالجنيه', 100, positive: true),
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: const Color(0xffedf4ef),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text('الإجمالي'),
                        const SizedBox(width: 8),
                        Flexible(child: FittedBox(child: money(total))),
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),
                ],
              ],
              if (kind.startsWith('expense_')) ...[
                DropdownButtonFormField<String>(
                  initialValue: category,
                  decoration: const InputDecoration(labelText: 'بند المصروف'),
                  items:
                      [
                            'شحن ونقل ونولون',
                            'عمالة تحميل وتفريغ',
                            'بوكسات وكراتين وتعبئة',
                            'شاي وضيافة وأكل',
                            'وقود ومواصلات',
                            'إيجار وفواتير',
                            'صيانة ومستلزمات',
                            'مصاريف أخرى',
                          ]
                          .map(
                            (v) => DropdownMenuItem(value: v, child: Text(v)),
                          )
                          .toList(),
                  onChanged: (v) {
                    setState(() => category = v!);
                    _changed();
                  },
                ),
                const SizedBox(height: 14),
              ],
              if (kind == 'balance_adjustment') ...[
                const Text(
                  'تسوية غير نقدية للمديونية مع سبب موثق. لا تسجل تحصيلاً أو دفعاً نقدياً.',
                ),
                DropdownButtonFormField<String>(
                  initialValue: adjustmentDirection,
                  decoration: const InputDecoration(labelText: 'اتجاه التسوية'),
                  items: const [
                    DropdownMenuItem(
                      value: 'increase',
                      child: Text('زيادة المديونية'),
                    ),
                    DropdownMenuItem(
                      value: 'decrease',
                      child: Text('تخفيض المديونية'),
                    ),
                  ],
                  onChanged: (v) {
                    setState(() => adjustmentDirection = v!);
                    _changed();
                  },
                ),
                const SizedBox(height: 14),
              ],
              if (kind == 'payroll') ...[
                DropdownButtonFormField<String>(
                  initialValue: employeeId,
                  decoration: const InputDecoration(labelText: 'الموظف'),
                  items: app.employees
                      .map(
                        (e) =>
                            DropdownMenuItem(value: e.id, child: Text(e.name)),
                      )
                      .toList(),
                  onChanged: (v) {
                    setState(() => employeeId = v);
                    _changed();
                  },
                  validator: (v) => v == null ? 'اختر الموظف' : null,
                ),
                const SizedBox(height: 14),
                TextFormField(
                  controller: salaryMonth,
                  textDirection: TextDirection.ltr,
                  decoration: const InputDecoration(
                    labelText: 'شهر الراتب',
                    hintText: '2026-10',
                  ),
                  validator: (v) =>
                      validMonth(v ?? '') ? null : 'أدخل شهراً صحيحاً',
                ),
                const SizedBox(height: 14),
              ],
              if (!invoice && !returns && kind != 'reversal')
                number(
                  amount,
                  kind == 'payroll'
                      ? 'قيمة دفعة الراتب بالجنيه'
                      : 'المبلغ بالجنيه',
                  100,
                  positive: true,
                ),
              if (kind == 'reversal') ...[
                Text(
                  'سيُحفظ قيد عكسي للعملية ${original?.id ?? ''} مع بقاء أصل العملية وسجل المراجعة.',
                ),
                const SizedBox(height: 14),
              ],
              if (invoice && app.manager) ...[
                TextFormField(
                  controller: shipmentRef,
                  maxLength: 120,
                  decoration: const InputDecoration(
                    labelText: 'مرجع الشحنة (اختياري)',
                  ),
                ),
                const SizedBox(height: 14),
              ],
              TextFormField(
                controller: note,
                minLines: 2,
                maxLines: 4,
                maxLength: 1000,
                decoration: InputDecoration(
                  labelText:
                      (kind == 'reversal' || kind == 'balance_adjustment')
                      ? 'سبب التصحيح (مطلوب)'
                      : 'الملاحظات / بند المصروف',
                ),
                validator: (v) =>
                    (kind == 'reversal' || kind == 'balance_adjustment') &&
                        (v ?? '').trim().isEmpty
                    ? 'أدخل سبب التصحيح'
                    : null,
              ),
              if (error != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(
                    error!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              if (draftError != null)
                Text(
                  draftError!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              CheckboxListTile(
                value: another,
                onChanged: (v) => setState(() => another = v!),
                title: const Text('حفظ وإضافة عملية أخرى'),
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
              ),
              FilledButton.icon(
                onPressed: saving ? null : _save,
                icon: saving
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.save_outlined),
                label: Text(
                  saving ? 'جارٍ الحفظ في الجهاز' : 'حفظ في السجل المحلي',
                ),
              ),
              const SizedBox(height: 16),
              const Text(
                'تحفظ المسودة تلقائياً أثناء الإدخال. لا تصبح عملية مالية إلا بعد نجاح الحفظ.',
                style: TextStyle(fontSize: 12, color: Colors.black54),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

class PartyPicker extends StatefulWidget {
  const PartyPicker({
    super.key,
    required this.parties,
    this.recentIds = const [],
    this.app,
    this.wantedKind,
  });
  final List<Party> parties;
  final List<String> recentIds;
  final AppController? app;
  final String? wantedKind;
  @override
  State<PartyPicker> createState() => _PartyPickerState();
}

class _PartyPickerState extends State<PartyPicker> {
  String search = '';
  @override
  Widget build(BuildContext context) {
    final values =
        widget.parties
            .where((p) => '${p.name} ${p.phone}'.contains(search))
            .toList()
          ..sort((a, b) {
            final favorite = (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
            if (favorite != 0) return favorite;
            int rank(Party p) {
              final index = widget.recentIds.indexOf(p.id);
              return index < 0 ? widget.recentIds.length : index;
            }

            final recent = rank(a).compareTo(rank(b));
            return recent != 0 ? recent : a.name.compareTo(b.name);
          });
    final addKind = widget.wantedKind ?? 'merchant';
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * .8,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 18, 18, 8),
              child: TextField(
                autofocus: true,
                decoration: const InputDecoration(
                  labelText: 'ابحث عن العميل أو المورد',
                  prefixIcon: Icon(Icons.search),
                ),
                onChanged: (v) => setState(() => search = v),
              ),
            ),
            if (widget.app != null && widget.app!.allowed)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 18),
                child: Align(
                  alignment: Alignment.centerRight,
                  child: OutlinedButton.icon(
                    onPressed: () async {
                      final created = await _addParty(
                        context,
                        widget.app!,
                        addKind,
                        initialName: search.trim(),
                      );
                      if (created != null && context.mounted) {
                        Navigator.pop(context, created);
                      }
                    },
                    icon: const Icon(Icons.person_add_alt_1_outlined),
                    label: Text(
                      addKind == 'merchant'
                          ? 'إضافة عميل جديد فوراً'
                          : 'إضافة مورد جديد فوراً',
                    ),
                  ),
                ),
              ),
            Expanded(
              child: values.isEmpty
                  ? empty('لا توجد نتائج؛ أضف الطرف من صفحة الحسابات')
                  : ListView.builder(
                      itemCount: values.length,
                      itemBuilder: (c, i) => ListTile(
                        minVerticalPadding: 16,
                        leading: Icon(
                          values[i].favorite
                              ? Icons.star
                              : Icons.person_outline,
                        ),
                        title: Text(values[i].name),
                        subtitle: Text(
                          [
                            if (widget.recentIds.contains(values[i].id))
                              'استخدمته مؤخراً',
                            if (values[i].phone.isNotEmpty) values[i].phone,
                          ].join(' · '),
                        ),
                        onTap: () => Navigator.pop(context, values[i]),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class AccountsScreen extends StatefulWidget {
  const AccountsScreen({super.key, required this.app});
  final AppController app;
  @override
  State<AccountsScreen> createState() => _AccountsScreenState();
}

class _AccountsScreenState extends State<AccountsScreen> {
  String search = '';
  int group = 0;
  @override
  Widget build(BuildContext context) {
    final values = widget.app.parties
        .where(
          (p) =>
              p.kind == (group == 0 ? 'merchant' : 'supplier') &&
              '${p.name} ${p.phone}'.contains(search),
        )
        .toList();
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        SegmentedButton<int>(
          segments: const [
            ButtonSegment(
              value: 0,
              label: Text('العملاء'),
              icon: Icon(Icons.storefront),
            ),
            ButtonSegment(
              value: 1,
              label: Text('الموردون'),
              icon: Icon(Icons.agriculture),
            ),
          ],
          selected: {group},
          onSelectionChanged: (v) => setState(() => group = v.first),
        ),
        const SizedBox(height: 14),
        TextField(
          decoration: const InputDecoration(
            labelText: 'البحث في الحسابات',
            prefixIcon: Icon(Icons.search),
          ),
          onChanged: (v) => setState(() => search = v),
        ),
        const SizedBox(height: 14),
        FilledButton.icon(
          onPressed: widget.app.allowed
              ? () => _addParty(
                  context,
                  widget.app,
                  group == 0 ? 'merchant' : 'supplier',
                )
              : null,
          icon: const Icon(Icons.person_add_alt_1),
          label: Text(group == 0 ? 'إضافة عميل' : 'إضافة مورد'),
        ),
        heading('${values.length} حساب'),
        if (values.isEmpty) empty('أضف أول حساب لبدء تسجيل البيع أو الشراء'),
        ...values.map(
          (p) => Card(
            child: Column(
              children: [
                ListTile(
                  minVerticalPadding: 14,
                  leading: const CircleAvatar(child: Icon(Icons.person_outline)),
                  title: Text(p.name),
                  subtitle: Text(
                    p.phone.isEmpty ? 'كشف الحساب والعمليات' : p.phone,
                  ),
                  trailing: money(
                    LedgerRules.partyBalance(p, widget.app.entries),
                    size: 16,
                  ),
                  onTap: () => Navigator.push(
                    context,
                    MaterialPageRoute<void>(
                      builder: (_) =>
                          StatementScreen(app: widget.app, party: p),
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                  child: Row(
                    children: [
                      TextButton.icon(
                        onPressed: widget.app.allowed
                            ? () => openEntry(
                                context,
                                widget.app,
                                p.kind == 'merchant' ? 'sale' : 'purchase',
                                draft: {
                                  'id': newId(),
                                  'kind': p.kind == 'merchant'
                                      ? 'sale'
                                      : 'purchase',
                                  'partyId': p.id,
                                  'date': today(),
                                },
                              )
                            : null,
                        icon: Icon(
                          p.kind == 'merchant'
                              ? Icons.north_east
                              : Icons.south_west,
                          size: 18,
                        ),
                        label: Text(p.kind == 'merchant' ? 'بيع' : 'شراء'),
                      ),
                      TextButton.icon(
                        onPressed: widget.app.allowed
                            ? () => openEntry(
                                context,
                                widget.app,
                                p.kind == 'merchant'
                                    ? 'merchant_payment'
                                    : 'supplier_payment',
                                draft: {
                                  'id': newId(),
                                  'kind': p.kind == 'merchant'
                                      ? 'merchant_payment'
                                      : 'supplier_payment',
                                  'partyId': p.id,
                                  'date': today(),
                                },
                              )
                            : null,
                        icon: const Icon(Icons.payments_outlined, size: 18),
                        label: Text(
                          p.kind == 'merchant' ? 'تحصيل دفعة' : 'سداد دفعة',
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

Future<Party?> _addParty(
  BuildContext context,
  AppController app,
  String kind, {
  String initialName = '',
}) async {
  final name = TextEditingController(text: initialName),
      phone = TextEditingController(),
      opening = TextEditingController(text: '0');
  bool favorite = false, busy = false;
  String? error;
  Party? created;
  final key = GlobalKey<FormState>();
  await completedDialog<void>(
    context: context,
    builder: (c) => StatefulBuilder(
      builder: (c, set) => AlertDialog(
        title: Text(kind == 'merchant' ? 'إضافة عميل' : 'إضافة مورد'),
        content: SingleChildScrollView(
          child: Form(
            key: key,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextFormField(
                  controller: name,
                  decoration: const InputDecoration(labelText: 'الاسم'),
                  maxLength: 160,
                  validator: (v) =>
                      (v ?? '').trim().isEmpty ? 'أدخل الاسم' : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: phone,
                  textDirection: TextDirection.ltr,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(
                    labelText: 'الهاتف (اختياري)',
                  ),
                  maxLength: 40,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: opening,
                  textDirection: TextDirection.ltr,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  decoration: const InputDecoration(
                    labelText: 'الرصيد الافتتاحي بالجنيه',
                  ),
                  validator: (v) {
                    try {
                      parseOpeningBalance(v ?? '');
                      return null;
                    } catch (e) {
                      return arabicError(e);
                    }
                  },
                ),
                CheckboxListTile(
                  value: favorite,
                  onChanged: (v) => set(() => favorite = v!),
                  title: const Text('إضافة إلى المفضلة'),
                ),
                if (error != null)
                  Text(error!, style: const TextStyle(color: Colors.red)),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: busy ? null : () => Navigator.pop(c),
            child: const Text('إلغاء'),
          ),
          FilledButton(
            onPressed: busy
                ? null
                : () async {
                    if (!key.currentState!.validate()) return;
                    set(() => busy = true);
                    try {
                      final party = Party(
                        id: newId(),
                        tenantId: app.tenantId,
                        name: name.text.trim(),
                        kind: kind,
                        openingMinor: parseOpeningBalance(opening.text),
                        phone: phone.text.trim(),
                        favorite: favorite,
                      );
                      await app.saveParty(party);
                      created = party;
                      if (c.mounted) Navigator.pop(c);
                    } catch (e) {
                      set(() {
                        busy = false;
                        error = arabicError(e);
                      });
                    }
                  },
            child: const Text('حفظ محلياً'),
          ),
        ],
      ),
    ),
  );
  name.dispose();
  phone.dispose();
  opening.dispose();
  return created;
}

class StatementScreen extends StatefulWidget {
  const StatementScreen({super.key, required this.app, required this.party});
  final AppController app;
  final Party party;
  @override
  State<StatementScreen> createState() => _StatementScreenState();
}

class _StatementScreenState extends State<StatementScreen> {
  String? from, to;
  bool busy = false;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.app,
    builder: (context, _) => _content(context),
  );

  Widget _content(BuildContext context) {
    final rangeValid = from == null || to == null || from!.compareTo(to!) <= 0;
    final lines = rangeValid
        ? LedgerRules.statement(
            widget.party,
            widget.app.entries,
            from: from,
            to: to,
          )
        : <StatementLine>[];
    final isMerchant = widget.party.kind == 'merchant';
    return Scaffold(
      appBar: AppBar(title: Text('كشف حساب ${widget.party.name}')),
      body: ListView(
        padding: const EdgeInsets.all(18),
        children: [
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: widget.app.allowed
                      ? () => openEntry(
                          context,
                          widget.app,
                          isMerchant ? 'sale' : 'purchase',
                          draft: {
                            'id': newId(),
                            'kind': isMerchant ? 'sale' : 'purchase',
                            'partyId': widget.party.id,
                            'date': today(),
                          },
                        )
                      : null,
                  icon: Icon(isMerchant ? Icons.north_east : Icons.south_west),
                  label: Text(isMerchant ? 'فاتورة بيع' : 'فاتورة شراء'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: widget.app.allowed
                      ? () => openEntry(
                          context,
                          widget.app,
                          isMerchant ? 'merchant_payment' : 'supplier_payment',
                          draft: {
                            'id': newId(),
                            'kind': isMerchant
                                ? 'merchant_payment'
                                : 'supplier_payment',
                            'partyId': widget.party.id,
                            'date': today(),
                          },
                        )
                      : null,
                  icon: const Icon(Icons.payments_outlined),
                  label: Text(isMerchant ? 'تحصيل دفعة' : 'سداد دفعة'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (rangeValid)
            Text(
              'رصيد أول الفترة: ${formatMoney(LedgerRules.statementOpeningBalance(widget.party, widget.app.entries, from: from))} ج.م',
            ),
          Row(
            children: [
              Expanded(
                child: TextFormField(
                  decoration: const InputDecoration(labelText: 'من تاريخ'),
                  textDirection: TextDirection.ltr,
                  onChanged: (v) =>
                      setState(() => from = validDate(v) ? v : null),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: TextFormField(
                  decoration: const InputDecoration(labelText: 'إلى تاريخ'),
                  textDirection: TextDirection.ltr,
                  onChanged: (v) =>
                      setState(() => to = validDate(v) ? v : null),
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          if (!rangeValid)
            const Text(
              'يجب أن يكون تاريخ النهاية بعد تاريخ البداية أو مساوياً له',
              style: TextStyle(color: Colors.red),
            ),
          FilledButton.icon(
            onPressed: busy || !rangeValid
                ? null
                : () async {
                    setState(() => busy = true);
                    await guard(context, () async {
                      final bytes = await ArabicExports.statement(
                        business: widget.app.business,
                        title: 'كشف حساب ${widget.party.name}',
                        entries: widget.app.entries,
                        party: widget.party,
                        from: from,
                        to: to,
                      );
                      await ArabicExports.shareBytes(
                        bytes,
                        'statement.pdf',
                        'application/pdf',
                      );
                    });
                    if (mounted) setState(() => busy = false);
                  },
            icon: const Icon(Icons.picture_as_pdf),
            label: const Text('مشاركة كشف حساب عربي'),
          ),
          OutlinedButton.icon(
            onPressed: widget.app.allowed
                ? () => openEntry(
                    context,
                    widget.app,
                    'balance_adjustment',
                    draft: {
                      'id': newId(),
                      'kind': 'balance_adjustment',
                      'partyId': widget.party.id,
                      'date': today(),
                    },
                  )
                : null,
            icon: const Icon(Icons.balance),
            label: const Text('تسوية رصيد موثقة'),
          ),
          OutlinedButton.icon(
            onPressed: !rangeValid
                ? null
                : () => guard(context, () async {
                    widget.app.requireDataAccess();
                    await Clipboard.setData(
                      ClipboardData(
                        text: buildStatementText(
                          widget.party,
                          widget.app.entries,
                          from: from,
                          to: to,
                        ),
                      ),
                    );
                    if (context.mounted) {
                      snack(
                        context,
                        'تم نسخ كشف الحساب؛ يمكنك لصقه ومشاركته بنفسك',
                      );
                    }
                  }),
            icon: const Icon(Icons.copy),
            label: const Text('نسخ كشف الحساب للمشاركة'),
          ),
          heading('الحركة والرصيد الجاري'),
          ...lines.map(
            (line) => Card(
              child: ListTile(
                title: Text(
                  '${kindLabels[line.entry.kind]} · ${line.entry.date}',
                ),
                subtitle: Text(
                  '${widget.app.entryActorLabel(line.entry)} · مدين ${formatMoney(line.debitMinor)} · دائن ${formatMoney(line.creditMinor)}',
                ),
                trailing: money(line.balanceMinor, size: 16),
              ),
            ),
          ),
          if (lines.isEmpty) empty('لا توجد حركة في الفترة المختارة'),
          if (rangeValid)
            Text(
              'الرصيد حتى نهاية الفترة: ${formatMoney(LedgerRules.statementClosingBalance(widget.party, widget.app.entries, to: to))} ج.م',
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
            ),
        ],
      ),
    );
  }
}

class MoreScreen extends StatelessWidget {
  const MoreScreen({super.key, required this.app});
  final AppController app;
  void open(BuildContext c, String title, Widget body) => Navigator.push(
    c,
    MaterialPageRoute<void>(
      builder: (_) => Scaffold(
        appBar: AppBar(title: Text(title)),
        body: SafeArea(child: body),
      ),
    ),
  );
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      heading('إدارة العمل'),
      Card(
        child: Column(
          children: [
            ListTile(
              minVerticalPadding: 14,
              leading: const Icon(Icons.sync_problem_outlined),
              title: const Text('المزامنة والعمليات المعلقة'),
              subtitle: Text('${app.pending.length} عملية في قائمة الإرسال'),
              trailing: const Icon(Icons.chevron_left),
              onTap: () => open(
                context,
                'المزامنة والعمليات المعلقة',
                SyncScreen(app: app),
              ),
            ),
            if (app.manager) ...[
              ListTile(
                minVerticalPadding: 14,
                leading: const Icon(Icons.fact_check_outlined),
                title: const Text('مراجعة طلبات الموظفين'),
                onTap: () =>
                    open(context, 'مراجعة الطلبات', ReviewScreen(app: app)),
              ),
              ListTile(
                minVerticalPadding: 14,
                leading: const Icon(Icons.badge_outlined),
                title: const Text('الموظفون والرواتب'),
                onTap: () => open(
                  context,
                  'الموظفون والرواتب',
                  EmployeesScreen(app: app),
                ),
              ),
              ListTile(
                minVerticalPadding: 14,
                leading: const Icon(Icons.insights_outlined),
                title: const Text('التقارير والتصدير'),
                onTap: () =>
                    open(context, 'التقارير والتصدير', ReportsScreen(app: app)),
              ),
              ListTile(
                minVerticalPadding: 14,
                leading: const Icon(Icons.backup_outlined),
                title: const Text('النسخ الاحتياطي والاستعادة'),
                onTap: () =>
                    open(context, 'النسخ والاستعادة', BackupScreen(app: app)),
              ),
            ],
            ListTile(
              minVerticalPadding: 14,
              leading: const Icon(Icons.key_outlined),
              title: const Text('الترخيص والتفعيل'),
              onTap: () =>
                  open(context, 'الترخيص والتفعيل', LicenseScreen(app: app)),
            ),
          ],
        ),
      ),
      heading('العمل دون اتصال'),
      const Card(
        child: Padding(
          padding: EdgeInsets.all(16),
          child: Text(
            'احفظ العملية وانتظر رسالة الحفظ المحلي. تبقى العمليات على جهازك حتى يقبلها الخادم. افتح المزامنة عند توفر اتصال، وراجع أي تعارض. لا تمسح بيانات التطبيق قبل تنزيل نسخة احتياطية.',
          ),
        ),
      ),
      TextButton.icon(
        onPressed: () => guard(context, app.signOut),
        icon: const Icon(Icons.logout),
        label: const Text('تسجيل الخروج مع الاحتفاظ بالسجل والطابور'),
      ),
    ],
  );
}

class SyncScreen extends ConsumerWidget {
  const SyncScreen({super.key, required this.app});
  final AppController app;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(appProvider);
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        Text(
          app.lastSync == null
              ? 'لم تكتمل مزامنة بعد'
              : 'آخر مزامنة ناجحة: ${app.lastSync}',
        ),
        const SizedBox(height: 10),
        Text(app.syncMessage ?? 'المزامنة لا تغيّر نتيجة الحفظ المحلي'),
        const SizedBox(height: 14),
        FilledButton.icon(
          onPressed: app.syncing ? null : app.synchronizeNow,
          icon: const Icon(Icons.sync),
          label: const Text('المزامنة الآن'),
        ),
        heading('قائمة الإرسال'),
        if (app.pending.isEmpty) empty('لا توجد عمليات معلقة'),
        ...app.pending.map(
          (p) => Card(
            child: ListTile(
              isThreeLine: true,
              title: Text(stateLabel(p['state'] as String?)),
              subtitle: Text(
                '${p['id']}\nالمحاولات: ${p['attempts'] ?? 0}${(p['error'] as String? ?? '').isEmpty ? '' : ' · ${syncErrorArabic(p['error'] as String? ?? '')}'}',
              ),
              trailing: IconButton(
                tooltip: 'إعادة المحاولة',
                onPressed: p['state'] == 'conflict'
                    ? null
                    : () => guard(context, () => app.retry(p['id'] as String)),
                icon: const Icon(Icons.refresh),
              ),
            ),
          ),
        ),
        heading('التعارضات المحفوظة'),
        FutureBuilder(
          future: app.store!.listConflicts(),
          builder: (context, snapshot) {
            final values = snapshot.data ?? [];
            return Column(
              children: values
                  .map(
                    (p) => Card(
                      child: ListTile(
                        title: const Text('نسختان تحتاجان قراراً موثقاً'),
                        subtitle: Text(
                          '${p['id']}\n${p['resolution'] == null ? 'لم يُحل التعارض' : 'تم توثيق المراجعة'}',
                        ),
                        onTap: () => _conflict(context, p),
                      ),
                    ),
                  )
                  .toList(),
            );
          },
        ),
        const Text(
          'قد تؤثر العمليات المحلية المبدئية في الإجماليات قبل قبول الخادم. يحتفظ التعارض بنسختي البيانات ولا يستبدل القيم المالية تلقائياً.',
        ),
      ],
    );
  }

  Future<void> _conflict(
    BuildContext context,
    Map<String, Object?> item,
  ) async {
    final note = TextEditingController();
    final remote = jsonDecode(item['remote_payload'] as String? ?? '{}') as Map;
    await completedDialog<void>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('مراجعة التعارض'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'القيم محفوظة للمراجعة. راجع أصل الفاتورة ومرتجعاتها قبل اختيار نسخة الخادم.',
              ),
              Text(
                'النسخة المحلية\n${describeConflict(item['local_payload'] as String? ?? '{}')}',
              ),
              Text(
                'نسخة الخادم\n${describeConflict(item['remote_payload'] as String? ?? '{}')}',
              ),
              TextField(
                controller: note,
                maxLength: 1000,
                decoration: const InputDecoration(
                  labelText: 'قرار المراجعة وسببه',
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c),
            child: const Text('إغلاق'),
          ),
          if (app.manager && remote.isNotEmpty)
            FilledButton(
              onPressed: () async {
                await guard(
                  c,
                  () => app.store!.resolveConflict(
                    item['id'] as String,
                    note: note.text,
                    acceptRemote: true,
                  ),
                );
                if (c.mounted) Navigator.pop(c);
              },
              child: const Text('اعتماد نسخة الخادم بعد المراجعة'),
            ),
        ],
      ),
    );
    note.dispose();
  }
}

class SubmissionTile extends StatelessWidget {
  const SubmissionTile({super.key, required this.value, this.app});
  final Map<String, dynamic> value;
  final AppController? app;
  @override
  Widget build(BuildContext context) {
    final kind = value['kind'] as String? ?? '';
    final enteredUnitMinor =
        kind == 'purchase_delivery' && value['amountMinor'] is int
        ? value['amountMinor'] as int
        : 0;
    int? approvedUnitMinor;
    final rev = value['review'];
    if (rev is Map) {
      if (rev['approvedUnitMinor'] is int) {
        approvedUnitMinor = rev['approvedUnitMinor'] as int;
      } else if (rev['entry'] is Map &&
          (rev['entry'] as Map)['priceMinor'] is int) {
        approvedUnitMinor = (rev['entry'] as Map)['priceMinor'] as int;
      }
    }
    final actorPrefix = app != null && app!.manager
        ? 'الموظف: ${app!.submissionEmployeeName(value)} · '
        : '';
    final detailLine =
        value['qtyMilli'] is int && value['qtyMilli'] != 0
        ? '${formatQuantity(value['qtyMilli'] as int)} ${value['unit']} · ${value['grade']}'
        : (kind == 'expense_business' &&
              value['amountMinor'] is int &&
              (value['amountMinor'] as int) > 0)
        ? '${formatMoney(value['amountMinor'] as int)} ج.م · ${value['category'] ?? ''}'
        : '${value['note'] ?? ''}';
    String priceLine = '';
    if (kind == 'purchase_delivery') {
      if (approvedUnitMinor != null && approvedUnitMinor > 0) {
        if (enteredUnitMinor > 0 && approvedUnitMinor != enteredUnitMinor) {
          priceLine =
              '\nسعر الموظف: ${formatMoney(enteredUnitMinor)} ج.م · السعر المعتمد من المدير: ${formatMoney(approvedUnitMinor)} ج.م';
        } else {
          priceLine =
              '\nالسعر المعتمد من المدير: ${formatMoney(approvedUnitMinor)} ج.م';
        }
      } else if (enteredUnitMinor > 0) {
        priceLine = '\nسعر الوحدة المسجل: ${formatMoney(enteredUnitMinor)} ج.م';
      }
    }
    return Card(
      child: ListTile(
        title: Text(
          '${value['partyName'] ?? ''} · ${{'delivery': 'تسليم لعميل', 'purchase_delivery': 'استلام من مورد', 'expense_business': 'مصروف تشغيل', 'sale_return': 'مرتجع بيع', 'purchase_return': 'مرتجع شراء'}[kind] ?? 'طلب'}',
        ),
        subtitle: Text(
          '${value['date']} · $actorPrefix${stateLabel(value['state'] as String?)}\n$detailLine$priceLine',
        ),
      ),
    );
  }
}

class SubmissionScreen extends StatelessWidget {
  const SubmissionScreen({super.key, required this.app});
  final AppController app;
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      heading('طلباتك المسجلة'),
      const Text(
        'الحفظ المحلي وإرسال الطلب واعتماد المدير مراحل منفصلة. لا تتضمن هذه الشاشة أسعار البيع أو الأرصدة أو رواتب الآخرين.',
      ),
      if (app.submissions.isEmpty) empty('لم تسجل أي طلب بعد'),
      ...app.submissions.map((s) => SubmissionTile(value: s, app: app)),
    ],
  );
}

class ReviewScreen extends ConsumerWidget {
  const ReviewScreen({super.key, required this.app});
  final AppController app;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(appProvider);
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        const Text(
          'راجع الطرف والكمية والفاتورة والأثر المالي. القرار محلي ومبدئي حتى يقبله الخادم مرة واحدة.',
        ),
        if (app.submissions.isEmpty) empty('لا توجد طلبات للمراجعة'),
        ...app.submissions.map(
          (s) => Column(
            children: [
              SubmissionTile(value: s, app: app),
              if ({
                'pending',
                'awaiting_approval',
                'server_accepted',
              }.contains(s['state']))
                Row(
                  children: [
                    Expanded(
                      child: FilledButton(
                        onPressed: app.allowed
                            ? () => _review(context, s, true)
                            : null,
                        child: const Text('مراجعة واعتماد'),
                      ),
                    ),
                    TextButton(
                      onPressed: app.allowed
                          ? () => _review(context, s, false)
                          : null,
                      child: const Text('رفض مع السبب'),
                    ),
                  ],
                ),
            ],
          ),
        ),
      ],
    );
  }

  Future<void> _review(
    BuildContext context,
    Map<String, dynamic> raw,
    bool approved,
  ) async {
    final source = Map<String, dynamic>.from(raw)
      ..remove('state')
      ..remove('review');
    final s = EmployeeSubmission.fromJson(source);
    final employeeName = app.submissionEmployeeName(raw);
    String initialPrice = '';
    if (s.kind == 'purchase_delivery' && s.amountMinor > 0) {
      initialPrice = formatMoney(s.amountMinor);
    } else if (s.kind.endsWith('_return')) {
      final orig = s.originalId.isEmpty
          ? null
          : app.entries.where((e) => e.id == s.originalId).firstOrNull;
      if (orig != null && orig.priceMinor > 0) {
        initialPrice = formatMoney(orig.priceMinor);
      } else {
        final targetKind = s.kind == 'sale_return' ? 'sale' : 'purchase';
        final recentMatch = LedgerRules.activeEntries(app.entries).reversed
            .where(
              (e) =>
                  e.kind == targetKind &&
                  e.partyId == s.partyId &&
                  e.priceMinor > 0 &&
                  (e.grade == s.grade || s.grade.isEmpty),
            )
            .firstOrNull;
        if (recentMatch != null) {
          initialPrice = formatMoney(recentMatch.priceMinor);
        }
      }
    }
    final price = TextEditingController(text: initialPrice),
        paid = TextEditingController(text: '0'),
        note = TextEditingController();
    String? error;
    bool busy = false;
    await completedDialog<void>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, set) => AlertDialog(
          title: Text(
            approved ? 'اعتماد ${s.partyName}' : 'رفض طلب ${s.partyName}',
          ),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'الموظف: $employeeName',
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
                Text('الطرف: ${s.partyName}'),
                Text('التاريخ: ${s.date}'),
                if (s.qtyMilli > 0)
                  Text(
                    'الكمية: ${formatQuantity(s.qtyMilli)} ${s.unit}\nالصنف: ${s.grade}',
                  ),
                if (s.kind == 'purchase_delivery' && s.amountMinor > 0)
                  Text(
                    'سعر الوحدة المدخل من الموظف: ${formatMoney(s.amountMinor)} ج.م',
                  ),
                if (s.originalId.isNotEmpty)
                  SelectableText('الفاتورة الأصلية: ${s.originalId}'),
                if (s.note.isNotEmpty) Text(s.note),
                if (approved &&
                    ({'delivery', 'purchase_delivery'}.contains(s.kind) ||
                        (s.kind.endsWith('_return') && s.originalId.isEmpty)))
                  TextField(
                    controller: price,
                    textDirection: TextDirection.ltr,
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                    ),
                    decoration: const InputDecoration(
                      labelText: 'سعر الوحدة بالجنيه',
                    ),
                  ),
                if (approved && s.kind != 'expense_business')
                  TextField(
                    controller: paid,
                    textDirection: TextDirection.ltr,
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                    ),
                    decoration: const InputDecoration(
                      labelText: 'المدفوع / النقدية المرتجعة',
                    ),
                  ),
                TextField(
                  controller: note,
                  maxLength: 1000,
                  decoration: const InputDecoration(
                    labelText: 'سبب القرار / ملاحظات',
                  ),
                ),
                if (error != null)
                  Text(error!, style: const TextStyle(color: Colors.red)),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: busy ? null : () => Navigator.pop(c),
              child: const Text('إلغاء'),
            ),
            FilledButton(
              onPressed: busy
                  ? null
                  : () async {
                      set(() => busy = true);
                      try {
                        await app.requireAllowed();
                        LedgerEntry? entry;
                        if (approved) {
                          final kind =
                              {
                                'delivery': 'sale',
                                'purchase_delivery': 'purchase',
                              }[s.kind] ??
                              s.kind;
                          final original = s.originalId.isEmpty
                              ? null
                              : app.entries
                                    .where((e) => e.id == s.originalId)
                                    .firstOrNull;
                          final p = s.kind == 'expense_business'
                              ? 0
                              : (s.kind.endsWith('_return') && original != null)
                              ? original.priceMinor
                              : parseScaled(price.text, 100);
                          if (s.kind != 'expense_business' && p <= 0) {
                            invalid(
                              'invalid_price',
                              'أدخل سعر الوحدة بالجنيه لاعتماد الطلب',
                            );
                          }
                          final total = s.kind == 'expense_business'
                              ? s.amountMinor
                              : (s.kind.endsWith('_return') && original != null)
                              ? LedgerRules.returnTotal(
                                  original,
                                  s.qtyMilli,
                                  app.entries,
                                )
                              : invoiceTotal(s.qtyMilli, p);
                          entry = LedgerEntry(
                            id: 'review_${s.id}',
                            tenantId: app.tenantId,
                            creatorUid: s.creatorUid,
                            kind: kind,
                            date: s.date,
                            partyId: s.partyId,
                            partyName: s.partyName,
                            qtyMilli: s.qtyMilli,
                            priceMinor: p,
                            totalMinor: total,
                            paidMinor: s.kind == 'expense_business'
                                ? total
                                : parseScaled(paid.text, 100),
                            grade: s.grade,
                            unit: s.unit,
                            originalId: s.originalId,
                            note: s.note,
                            category: s.category,
                          );
                        }
                        await app.store!.saveReview(
                          id: newId(),
                          submissionId: s.id,
                          approved: approved,
                          entry: entry,
                          note: note.text,
                        );
                        await app.refresh();
                        unawaited(app.synchronize());
                        if (c.mounted) Navigator.pop(c);
                      } catch (e) {
                        set(() {
                          busy = false;
                          error = arabicError(e);
                        });
                      }
                    },
              child: const Text('حفظ القرار المبدئي'),
            ),
          ],
        ),
      ),
    );
    price.dispose();
    paid.dispose();
    note.dispose();
  }
}

class EmployeesScreen extends ConsumerWidget {
  const EmployeesScreen({super.key, required this.app});
  final AppController app;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(appProvider);
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        FilledButton.icon(
          onPressed: app.allowed ? () => _add(context) : null,
          icon: const Icon(Icons.person_add),
          label: const Text('إضافة موظف'),
        ),
        const SizedBox(height: 10),
        OutlinedButton.icon(
          onPressed: app.allowed
              ? () => openEntry(context, app, 'payroll')
              : null,
          icon: const Icon(Icons.payments),
          label: const Text('تسجيل دفعة راتب'),
        ),
        heading('الرواتب في ${month()}'),
        if (app.employees.isEmpty)
          empty('أضف الموظف ثم وثّق الراتب وشهر بدء سريانه'),
        ...app.employees.map((e) {
          final stats = LedgerRules.payroll(
            e.id,
            month(),
            app.terms,
            app.entries,
          );
          return Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    e.name,
                    style: const TextStyle(
                      fontSize: 21,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  Text(
                    stats.entitlementMinor == null
                        ? 'الراتب التاريخي غير موثّق'
                        : 'المستحق: ${formatMoney(stats.entitlementMinor!)} ج.م · المدفوع: ${formatMoney(stats.paidMinor)} ج.م',
                  ),
                  if (stats.remainingMinor != null)
                    Text('المتبقي: ${formatMoney(stats.remainingMinor!)} ج.م'),
                  Text(
                    'معرّف الموظف: ${e.id}',
                    textDirection: TextDirection.ltr,
                  ),
                  Wrap(
                    spacing: 8,
                    children: [
                      TextButton.icon(
                        onPressed: app.allowed ? () => _term(context, e) : null,
                        icon: const Icon(Icons.edit_calendar_outlined, size: 18),
                        label: const Text('إضافة راتب بتاريخ سريان'),
                      ),
                      TextButton.icon(
                        onPressed: app.allowed
                            ? () => openEntry(
                                context,
                                app,
                                'payroll',
                                draft: {
                                  'id': newId(),
                                  'kind': 'payroll',
                                  'employeeId': e.id,
                                  'date': today(),
                                  'salaryMonth': month(),
                                },
                              )
                            : null,
                        icon: const Icon(Icons.payments_outlined, size: 18),
                        label: const Text('صرف راتب'),
                      ),
                    ],
                  ),
                  EmployeeEnrollmentActions(app: app, employee: e),
                  TextButton(
                    onPressed: () => _history(context, e),
                    child: const Text('حركة الرواتب التاريخية'),
                  ),
                ],
              ),
            ),
          );
        }),
      ],
    );
  }

  Future<void> _add(BuildContext context) async {
    final name = TextEditingController();
    String? error;
    bool busy = false;
    Employee? createdForInvite;
    await completedDialog<void>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, set) => AlertDialog(
          title: const Text('إضافة موظف'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: name,
                maxLength: 160,
                decoration: const InputDecoration(labelText: 'اسم الموظف'),
              ),
              if (error != null)
                Text(error!, style: const TextStyle(color: Colors.red)),
            ],
          ),
          actions: [
            TextButton(
              onPressed: busy ? null : () => Navigator.pop(c),
              child: const Text('إلغاء'),
            ),
            OutlinedButton(
              onPressed: busy
                  ? null
                  : () async {
                      if (name.text.trim().isEmpty) {
                        set(() => error = 'أدخل اسم الموظف');
                        return;
                      }
                      set(() => busy = true);
                      try {
                        final emp = Employee(
                          id: newId(),
                          tenantId: app.tenantId,
                          name: name.text.trim(),
                        );
                        await app.saveEmployee(emp);
                        createdForInvite = emp;
                        if (c.mounted) Navigator.pop(c);
                      } catch (e) {
                        set(() {
                          busy = false;
                          error = arabicError(e);
                        });
                      }
                    },
              child: const Text('حفظ وإنشاء كود دعوة'),
            ),
            FilledButton(
              onPressed: busy
                  ? null
                  : () async {
                      if (name.text.trim().isEmpty) {
                        set(() => error = 'أدخل اسم الموظف');
                        return;
                      }
                      set(() => busy = true);
                      try {
                        await app.saveEmployee(
                          Employee(
                            id: newId(),
                            tenantId: app.tenantId,
                            name: name.text.trim(),
                          ),
                        );
                        if (c.mounted) Navigator.pop(c);
                      } catch (e) {
                        set(() {
                          busy = false;
                          error = arabicError(e);
                        });
                      }
                    },
              child: const Text('حفظ'),
            ),
          ],
        ),
      ),
    );
    name.dispose();
    if (createdForInvite != null && context.mounted) {
      await EmployeeEnrollmentActions.openInvite(
        context,
        app,
        createdForInvite!,
      );
    }
  }

  Future<void> _term(BuildContext context, Employee employee) async {
    final salary = TextEditingController(),
        effective = TextEditingController(text: month());
    String? error;
    bool busy = false;
    await completedDialog<void>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, set) => AlertDialog(
          title: Text('راتب ${employee.name}'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'لن يغيّر الراتب الجديد الأشهر السابقة. لا تخمّن راتباً تاريخياً مفقوداً.',
              ),
              TextField(
                controller: effective,
                textDirection: TextDirection.ltr,
                decoration: const InputDecoration(
                  labelText: 'بدء السريان (سنة-شهر)',
                ),
              ),
              TextField(
                controller: salary,
                textDirection: TextDirection.ltr,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                decoration: const InputDecoration(
                  labelText: 'الراتب الشهري بالجنيه',
                ),
              ),
              if (error != null)
                Text(error!, style: const TextStyle(color: Colors.red)),
            ],
          ),
          actions: [
            TextButton(
              onPressed: busy ? null : () => Navigator.pop(c),
              child: const Text('إلغاء'),
            ),
            FilledButton(
              onPressed: busy
                  ? null
                  : () async {
                      set(() => busy = true);
                      try {
                        await app.saveSalaryTerm(
                          SalaryTerm(
                            id: newId(),
                            tenantId: app.tenantId,
                            employeeId: employee.id,
                            effectiveMonth: effective.text,
                            monthlyMinor: parseScaled(salary.text, 100),
                          ),
                        );
                        if (c.mounted) Navigator.pop(c);
                      } catch (e) {
                        set(() {
                          busy = false;
                          error = arabicError(e);
                        });
                      }
                    },
              child: const Text('توثيق الراتب'),
            ),
          ],
        ),
      ),
    );
    salary.dispose();
    effective.dispose();
  }

  Future<void> _history(BuildContext context, Employee employee) async {
    final values = app.entries
        .where((e) => e.kind == 'payroll' && e.employeeId == employee.id)
        .toList();
    await Navigator.push<void>(
      context,
      MaterialPageRoute(
        builder: (_) => Scaffold(
          appBar: AppBar(title: Text('حركة رواتب ${employee.name}')),
          body: ListView(
            padding: const EdgeInsets.all(18),
            children: [
              ...app.terms
                  .where((t) => t.employeeId == employee.id)
                  .map(
                    (t) => ListTile(
                      title: Text('من ${t.effectiveMonth}'),
                      trailing: money(t.monthlyMinor),
                    ),
                  ),
              const Divider(),
              ...values.map((e) => EntryTile(entry: e, app: app)),
              OutlinedButton.icon(
                onPressed: () => guard(context, () async {
                  final bytes = await ArabicExports.statement(
                    business: app.business,
                    title: 'حركة رواتب ${employee.name}',
                    entries: values,
                  );
                  await ArabicExports.shareBytes(
                    bytes,
                    'payroll.pdf',
                    'application/pdf',
                  );
                }),
                icon: const Icon(Icons.picture_as_pdf),
                label: const Text('مشاركة حركة الرواتب'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class ReportsScreen extends StatefulWidget {
  const ReportsScreen({super.key, required this.app});
  final AppController app;
  @override
  State<ReportsScreen> createState() => _ReportsScreenState();
}

class _ReportsScreenState extends State<ReportsScreen> {
  String from = '', to = '';
  bool busy = false;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.app,
    builder: (context, _) => _content(context),
  );

  Widget _content(BuildContext context) {
    final rangeValid = from.isEmpty || to.isEmpty || from.compareTo(to) <= 0;
    final entries = widget.app.entries
        .where(
          (e) =>
              (from.isEmpty || e.date.compareTo(from) >= 0) &&
              (to.isEmpty || e.date.compareTo(to) <= 0),
        )
        .toList();
    final period = rangeValid
        ? RecordedPeriod.fromEntries(
            widget.app.entries,
            from: from.isEmpty ? null : from,
            to: to.isEmpty ? null : to,
          )
        : null;
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        Row(
          children: [
            Expanded(
              child: TextField(
                decoration: const InputDecoration(labelText: 'من تاريخ'),
                textDirection: TextDirection.ltr,
                onChanged: (v) => setState(() => from = validDate(v) ? v : ''),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: TextField(
                decoration: const InputDecoration(labelText: 'إلى تاريخ'),
                textDirection: TextDirection.ltr,
                onChanged: (v) => setState(() => to = validDate(v) ? v : ''),
              ),
            ),
          ],
        ),
        if (!rangeValid)
          const Text(
            'يجب أن يكون تاريخ النهاية بعد تاريخ البداية أو مساوياً له',
            style: TextStyle(color: Colors.red),
          ),
        if (period != null) ...[
          heading('مؤشرات الفترة'),
          _Metric(
            title: 'صافي البيع المسجل بعد المرتجعات والتصحيحات',
            amount: period.salesMinor,
          ),
          _Metric(
            title: 'صافي الشراء المسجل بعد المرتجعات والتصحيحات',
            amount: period.purchasesMinor,
          ),
          _Metric(
            title: 'مصروفات التشغيل والرواتب',
            amount: period.businessExpenseMinor,
          ),
          _Metric(
            title: 'الرواتب والأجور المسجلة',
            amount: period.businessCategories['رواتب وأجور'] ?? 0,
          ),
          _Metric(
            title: 'صافي الحركة النقدية المسجلة',
            amount: period.cashMinor,
          ),
          const SizedBox(height: 10),
          const Text(
            'البيع ناقص الشراء والمصروفات ليس ربحاً فعلياً دون تقييم المخزون. صافي الحركة لا يمثل جرد النقدية.',
          ),
          BudgetAndCharts(
            app: widget.app,
            from: from.isEmpty ? null : from,
            to: to.isEmpty ? null : to,
          ),
        ],
        heading('ملفات عربية تعمل دون اتصال'),
        FilledButton.icon(
          onPressed: busy || !rangeValid
              ? null
              : () async {
                  setState(() => busy = true);
                  await guard(context, () async {
                    final bytes = await ArabicExports.statement(
                      business: widget.app.business,
                      title: 'تقرير حركة السجل',
                      entries: widget.app.entries,
                      from: from.isEmpty ? null : from,
                      to: to.isEmpty ? null : to,
                    );
                    await ArabicExports.shareBytes(
                      bytes,
                      'ledger.pdf',
                      'application/pdf',
                    );
                  });
                  if (mounted) setState(() => busy = false);
                },
          icon: const Icon(Icons.picture_as_pdf_outlined),
          label: const Text('مشاركة تقرير عربي'),
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: !rangeValid
              ? null
              : () => guard(
                  context,
                  () => ArabicExports.shareText(
                    ArabicExports.csv(entries),
                    'ledger.csv',
                    'text/csv',
                  ),
                ),
          icon: const Icon(Icons.table_chart_outlined),
          label: const Text('تصدير جدول العمليات'),
        ),
      ],
    );
  }
}

class BackupScreen extends StatefulWidget {
  const BackupScreen({super.key, required this.app});
  final AppController app;
  @override
  State<BackupScreen> createState() => _BackupScreenState();
}

class _BackupScreenState extends State<BackupScreen> {
  bool busy = false;
  String? message;
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(20),
    children: [
      const Icon(Icons.shield_outlined, size: 60, color: Color(0xff235b42)),
      heading('نسخة تحفظ سجلك وطابور الإرسال'),
      const Text(
        'تحتوي النسخة على بيانات مالية خاصة. احتفظ بها في مكان آمن، ولا تشاركها مع غير المصرح لهم. لا تتضمن كلمة المرور أو مفاتيح الجهاز أو صلاحية التفعيل.',
      ),
      const SizedBox(height: 20),
      FilledButton.icon(
        onPressed: busy
            ? null
            : () => _run(() async {
                final backup = await widget.app.store!.exportBackup();
                await ArabicExports.shareText(
                  jsonEncode(backup),
                  'strawberry-backup.json',
                  'application/json',
                );
                message = 'تم تجهيز النسخة للمشاركة أو الحفظ';
              }),
        icon: const Icon(Icons.save_alt),
        label: const Text('حفظ / مشاركة نسخة احتياطية'),
      ),
      const SizedBox(height: 14),
      OutlinedButton.icon(
        onPressed: busy
            ? null
            : () => _run(() async {
                final result = await FilePicker.pickFile(
                  type: FileType.custom,
                  allowedExtensions: ['json'],
                );
                if (result == null) return;
                final file = result;
                if ((await file.length() ?? 0) > 50000000) {
                  throw const LedgerException(
                    'backup_size',
                    'حجم النسخة أكبر من الحد المسموح',
                  );
                }
                final bytes = await readPickedFile(file, 50000000);
                final decoded = jsonDecode(utf8.decode(bytes));
                if (decoded is! Map) {
                  throw const LedgerException(
                    'backup_format',
                    'تنسيق النسخة غير صالح',
                  );
                }
                await widget.app.store!.restoreBackup(
                  Map<String, dynamic>.from(decoded),
                );
                await widget.app.refresh();
                message = 'اكتملت الاستعادة المحلية؛ راجع المزامنة قبل الاعتماد على حالة الخادم';
              }),
        icon: const Icon(Icons.restore_page_outlined),
        label: const Text('اختيار نسخة واستعادتها'),
      ),
      heading('الاستعادة على هاتف آخر'),
      const Text(
        'سجّل الهاتف الجديد أولاً بواسطة المسؤول واحصل على حزمة عضوية وتفعيل تخصه. لا تنقل النسخة مفاتيح أندرويد. استخدم الحساب والمنشأة نفسيهما؛ تظل معرفات العمليات المعلقة كما هي لتجنب التكرار. لا تبدأ الاستعادة فترة تجريبية جديدة.',
      ),
      if (busy)
        const Padding(
          padding: EdgeInsets.all(16),
          child: Center(child: CircularProgressIndicator()),
        ),
      if (message != null)
        Padding(padding: const EdgeInsets.all(12), child: Text(message!)),
    ],
  );
  Future<void> _run(Future<void> Function() action) async {
    setState(() => busy = true);
    try {
      await action();
    } catch (e) {
      message = arabicError(e);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
}

class LicenseScreen extends ConsumerStatefulWidget {
  const LicenseScreen({super.key, required this.app});
  final AppController app;
  @override
  ConsumerState<LicenseScreen> createState() => _LicenseScreenState();
}

class _LicenseScreenState extends ConsumerState<LicenseScreen> {
  final code = TextEditingController();
  bool busy = false;
  String? message;
  @override
  void dispose() {
    code.dispose();
    super.dispose();
  }

  Future<void> _import() async {
    if (busy) return;
    setState(() => busy = true);
    try {
      await widget.app.importLicense(code.text.trim());
      message = widget.app.license?.message;
    } catch (e) {
      message = arabicError(e);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(appProvider);
    final app = widget.app, status = app.license;
    final days = status?.remaining == null
        ? null
        : (status!.remaining!.inSeconds / 86400).ceil().clamp(0, 99999);
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Icon(
          status?.operationalAllowed == true
              ? Icons.verified_user_outlined
              : Icons.key_outlined,
          size: 64,
          color: const Color(0xff235b42),
        ),
        heading('ترخيص المنشأة'),
        Text(
          status?.message ?? 'يلزم إعداد الحساب',
          style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
        ),
        if (days != null) Text('المدة المتبقية: $days يوم'),
        if (status?.license != null)
          Text(
            status!.license!.trial
                ? 'فترة تجريبية واحدة للمنشأة: ٣٠ يوماً'
                : 'تفعيل مدفوع وفق الحزمة الصادرة',
          ),
        Text('المنشأة: ${app.tenantId}', textDirection: TextDirection.ltr),
        heading('معرّف الجهاز'),
        SelectableText(
          app.identity?.deviceId ?? '',
          textDirection: TextDirection.ltr,
        ),
        Wrap(
          spacing: 8,
          children: [
            OutlinedButton.icon(
              onPressed: () => Clipboard.setData(
                ClipboardData(text: app.identity?.deviceId ?? ''),
              ),
              icon: const Icon(Icons.copy),
              label: const Text('نسخ المعرّف'),
            ),
            OutlinedButton.icon(
              onPressed: () => Clipboard.setData(
                ClipboardData(
                  text: jsonEncode({
                    'tenantId': app.tenantId,
                    'uid': app.uid,
                    'deviceId': app.identity?.deviceId,
                    'publicKeySpki': app.identity?.publicKeySpki,
                    'request': 'activation',
                  }),
                ),
              ),
              icon: const Icon(Icons.content_copy),
              label: const Text('نسخ طلب التفعيل'),
            ),
          ],
        ),
        const Text(
          'أرسل الطلب بنفسك إلى مصدر التفعيل، ثم أدخل الحزمة التي يعيدها إليك. لا يرسل التطبيق رسائل نيابة عنك.',
        ),
        heading('إدخال حزمة التفعيل'),
        TextField(
          controller: code,
          textDirection: TextDirection.ltr,
          minLines: 3,
          maxLines: 6,
          maxLength: 65536,
          decoration: const InputDecoration(
            labelText: 'الصق حزمة التفعيل الموقعة',
          ),
        ),
        Wrap(
          spacing: 8,
          children: [
            TextButton.icon(
              onPressed: () async {
                final c = await Clipboard.getData(Clipboard.kTextPlain);
                code.text = c?.text ?? '';
              },
              icon: const Icon(Icons.paste),
              label: const Text('لصق'),
            ),
            TextButton.icon(
              onPressed: () => guard(context, () async {
                final result = await FilePicker.pickFile(
                  type: FileType.custom,
                  allowedExtensions: ['json'],
                );
                if (result == null) return;
                final file = result;
                if ((await file.length() ?? 0) > 65536) {
                  throw const LedgerException(
                    'license_size',
                    'حزمة التفعيل أكبر من الحد المسموح',
                  );
                }
                code.text = utf8.decode(await readPickedFile(file, 65536));
              }),
              icon: const Icon(Icons.folder_open),
              label: const Text('استيراد ملف'),
            ),
          ],
        ),
        FilledButton(
          onPressed: busy ? null : _import,
          child: Text(busy ? 'جارٍ التحقق من التوقيع' : 'التحقق والتفعيل'),
        ),
        if (message != null) Text(message!),
        heading('تفعيل أجهزة الموظفين دون اتصال'),
        const Text(
          'كل موظف يستخدم حزمة أصلية موقعة تخص حسابه وجهازه وترخيص المنشأة نفسه. اطلب الحزمة من مصدر التفعيل وانقل الملف إلى هاتفه ثم استورده. لا يستطيع المدير إنشاء مدة إضافية بنفسه.',
        ),
        const Text(
          'تصل التجديدات وقرارات الإيقاف الجديدة عند الاتصال أو استلام حزمة موثقة. لا تصل تغييرات الأجهزة الأخرى أثناء انقطاع الاتصال.',
        ),
        TextButton.icon(
          onPressed: app.syncing ? null : app.synchronize,
          icon: const Icon(Icons.sync),
          label: const Text('تحديث الترخيص عند الاتصال'),
        ),
      ],
    );
  }
}

class AccountLockedScreen extends StatelessWidget {
  const AccountLockedScreen({super.key, required this.app});
  final AppController app;
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 460),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.lock_outline, size: 60),
                  const SizedBox(height: 20),
                  Text(
                    app.license?.message ?? 'أوقفت صلاحية الحساب',
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 22),
                  ),
                  const SizedBox(height: 20),
                  const Text(
                    'السجل وطابور الإرسال محفوظان. يلزم التحقق من العضوية قبل عرض البيانات مرة أخرى.',
                  ),
                  const SizedBox(height: 20),
                  FilledButton(
                    onPressed: app.syncing ? null : app.synchronize,
                    child: const Text('التحقق عند الاتصال'),
                  ),
                  TextButton(
                    onPressed: app.signOut,
                    child: const Text('تسجيل الخروج'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

String syncErrorArabic(String code) => switch (code) {
  'permission-denied' => 'الصلاحية الحالية لا تسمح بالإرسال',
  'unauthenticated' => 'يلزم تجديد تسجيل الدخول عند الاتصال',
  'license-expired' ||
  'license_expired' => 'انتهى الترخيص؛ الطابور محفوظ لحين التفعيل',
  'unavailable' ||
  'deadline-exceeded' ||
  'server_error' => 'تعذر تأكيد قبول الخادم؛ أعد المحاولة',
  'return-exceeded' ||
  'return_limit' => 'المرتجعات تتجاوز الكمية أو القيمة المتاحة',
  'immutable-record-conflict' ||
  'immutable_remote_conflict' => 'توجد نسخة أخرى؛ راجع التعارض',
  '' => '',
  _ => 'لم يقبل الخادم العملية؛ راجع بياناتها أو تواصل مع مسؤول المنشأة',
};
String describeConflict(String encoded) {
  final d = Map<String, dynamic>.from(jsonDecode(encoded) as Map);
  if (d.isEmpty) {
    return 'لم تصل نسخة نهائية من الخادم؛ احتفظ بالعملية لحين المراجعة.';
  }
  return [
    if (d['name'] is String) 'الاسم: ${d['name']}',
    if (d['partyName'] is String) 'الطرف: ${d['partyName']}',
    if (d['kind'] is String) 'النوع: ${kindLabels[d['kind']] ?? 'سجل بيانات'}',
    if (d['date'] is String) 'التاريخ: ${d['date']}',
    if (d['qtyMilli'] is int)
      'الكمية: ${formatQuantity(d['qtyMilli'] as int)} ${d['unit'] ?? ''}',
    if (d['grade'] is String) 'الصنف: ${d['grade']}',
    if (d['totalMinor'] is int)
      'القيمة: ${formatMoney(d['totalMinor'] as int)} ج.م',
    if (d['paidMinor'] is int)
      'المدفوع: ${formatMoney(d['paidMinor'] as int)} ج.م',
    if (d['note'] is String) 'الملاحظات: ${d['note']}',
  ].join('\n');
}

int parseOpeningBalance(String input) {
  final text = input.trim();
  return text.startsWith('-')
      ? -parseScaled(text.substring(1), 100)
      : parseScaled(text, 100);
}

Future<Uint8List> readPickedFile(PlatformFile file, int maxBytes) async {
  final output = BytesBuilder(copy: false);
  await for (final chunk in file.readAsByteStream()) {
    if (output.length + chunk.length > maxBytes) {
      throw const LedgerException(
        'file_size',
        'حجم الملف أكبر من الحد المسموح',
      );
    }
    output.add(chunk);
  }
  return output.takeBytes();
}
