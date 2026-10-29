import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';

import '../application/app_controller.dart';
import '../domain/ledger.dart';
import '../services/gateway.dart';
import '../services/invitation_code.dart';

/// Administrative enrollment always waits for server acceptance. A local
/// employee directory row alone never creates a login account or membership.
class EmployeeEnrollmentActions extends StatefulWidget {
  const EmployeeEnrollmentActions({
    super.key,
    required this.app,
    required this.employee,
  });
  final AppController app;
  final Employee employee;

  static Future<void> openInvite(
    BuildContext context,
    AppController app,
    Employee employee,
  ) => _openEnrollmentDialog(
    context: context,
    app: app,
    employee: employee,
    invite: true,
  );

  @override
  State<EmployeeEnrollmentActions> createState() =>
      _EmployeeEnrollmentActionsState();
}

Future<FirebaseGateway> _prepareOnlineManager(
  AppController app, {
  required String employeeId,
}) async {
  await app.requireAllowed();
  if (!app.manager ||
      app.identity == null ||
      app.gateway is! FirebaseGateway) {
    invalid('manager', 'يلزم حساب مدير متصل لإدارة حسابات الموظفين');
  }
  // Publish any just-created employee directory record (and wait if a
  // background sync was already in flight) before the server checks that the
  // invited account belongs to an active employee.
  await app.waitForSync(resetRetryId: employeeId);
  await app.requireAllowed();
  if (!app.manager) invalid('manager', 'هذه العملية متاحة للمدير فقط');
  if (app.store != null) {
    final outbox = await app.store!.listOutbox();
    if (outbox.any((item) => item.id == employeeId)) {
      invalid(
        'employee_unsynced',
        app.syncMessage ??
            'لم يصل سجل الموظف إلى الخادم بعد؛ تأكد من الاتصال بالإنترنت وأعد المحاولة',
      );
    }
  }
  final gateway = app.gateway as FirebaseGateway;
  if (Firebase.apps.isNotEmpty &&
      !gateway.hasActiveSession(app.tenantId, app.identity!.deviceId)) {
    await gateway.bootstrap(app.tenantId, app.identity!);
  }
  return gateway;
}

Future<T> _withSessionRetry<T>(
  AppController app,
  FirebaseGateway gateway,
  Future<T> Function() action,
) async {
  try {
    return await action();
  } catch (e) {
    final reason = e is FirebaseFunctionsException && e.details is Map
        ? (e.details as Map)['reason']
        : null;
    final expired =
        (e is StateError && e.message == 'session_expired') ||
        reason == 'device-session-expired' ||
        reason == 'device-session-required';
    if (expired && Firebase.apps.isNotEmpty && app.identity != null) {
      gateway.clearSession();
      await gateway.bootstrap(app.tenantId, app.identity!);
      return await action();
    }
    rethrow;
  }
}

Future<void> _openEnrollmentDialog({
  required BuildContext context,
  required AppController app,
  required Employee employee,
  required bool invite,
  ValueChanged<bool>? onBusyChanged,
}) async {
  final form = GlobalKey<FormState>();
  String? error;
  bool submitting = false;
  bool active = false;
  bool acceptedMemberChange = false;
  Map<String, dynamic>? invitation;
  await showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (dialogContext) => StatefulBuilder(
      builder: (dialogContext, set) => AlertDialog(
        title: Text(
          invite ? 'دعوة ${employee.name}' : 'صلاحية حساب ${employee.name}',
        ),
        content: SingleChildScrollView(
          child: Form(
            key: form,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  invite
                      ? 'سيحصل هذا الموظف على كود يستخدم مرة واحدة. ينشئ حسابه ببريده وكلمة مروره على هاتفه، ويحدد الكود المنشأة تلقائياً. إنشاء كود جديد يلغي الدعوة السابقة التي لم تُستخدم.'
                      : 'سيُطبق القرار على حساب الدخول المرتبط بسجل هذا الموظف. إيقاف الحساب لا يحذف بياناته، ويمكنك إعادة تفعيله لاحقاً.',
                ),
                const SizedBox(height: 12),
                if (!invite)
                  DropdownButtonFormField<bool>(
                    initialValue: active,
                    decoration: const InputDecoration(labelText: 'القرار'),
                    items: const [
                      DropdownMenuItem(
                        value: false,
                        child: Text('إيقاف دخول الموظف'),
                      ),
                      DropdownMenuItem(
                        value: true,
                        child: Text('إعادة تفعيل دخول الموظف'),
                      ),
                    ],
                    onChanged: submitting
                        ? null
                        : (value) => set(() => active = value ?? false),
                  ),
                const SizedBox(height: 12),
                const Text(
                  'يتطلب اتصالاً بالإنترنت. يظهر التأكيد بعد قبول الخادم.',
                ),
                if (error != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    error!,
                    style: TextStyle(
                      color: Theme.of(dialogContext).colorScheme.error,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: submitting ? null : () => Navigator.pop(dialogContext),
            child: const Text('إلغاء'),
          ),
          FilledButton(
            onPressed: submitting
                ? null
                : () async {
                    if (!form.currentState!.validate()) return;
                    set(() {
                      submitting = true;
                      error = null;
                    });
                    onBusyChanged?.call(true);
                    try {
                      final gateway = await _prepareOnlineManager(
                        app,
                        employeeId: employee.id,
                      );
                      if (invite) {
                        invitation = await _withSessionRetry(
                          app,
                          gateway,
                          () => gateway.createEmployeeInvitation(
                            app.tenantId,
                            app.identity!.deviceId,
                            employeeId: employee.id,
                          ),
                        );
                      } else {
                        await _withSessionRetry(
                          app,
                          gateway,
                          () => gateway.setMemberActive(
                            app.tenantId,
                            app.identity!.deviceId,
                            employeeId: employee.id,
                            active: active,
                          ),
                        );
                        acceptedMemberChange = true;
                      }
                      if (dialogContext.mounted) Navigator.pop(dialogContext);
                    } catch (e) {
                      if (dialogContext.mounted) {
                        set(() => error = arabicError(e));
                      }
                    } finally {
                      if (dialogContext.mounted) {
                        set(() => submitting = false);
                      }
                      onBusyChanged?.call(false);
                    }
                  },
            child: Text(
              submitting
                  ? 'جارٍ تأكيد الخادم'
                  : invite
                  ? 'إنشاء الدعوة'
                  : 'حفظ القرار',
            ),
          ),
        ],
      ),
    ),
  );
  if (!context.mounted) return;
  if (invitation != null) {
    await _showInvitationDialog(context, app, employee, invitation!);
  } else if (acceptedMemberChange) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          active
              ? 'أكد الخادم إعادة تفعيل الحساب؛ يمكن للموظف تسجيل الدخول'
              : 'أكد الخادم إيقاف الحساب؛ سيُقفل عند اتصاله أو انتهاء عضويته المحفوظة',
        ),
      ),
    );
  }
}

Future<void> _showInvitationDialog(
  BuildContext context,
  AppController app,
  Employee employee,
  Map<String, dynamic> invitation,
) async {
  final token = invitation['invitationToken'];
  try {
    if (token is! String ||
        EmployeeInvitationCode.parse(token).tenantId != app.tenantId) {
      throw const FormatException('invitation_invalid');
    }
  } catch (_) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('تعذر قراءة رمز الدعوة؛ أعد المحاولة')),
    );
    return;
  }
  final expiry = invitation['expiresAtMs'];
  final date = expiry is num
      ? DateTime.fromMillisecondsSinceEpoch(expiry.toInt()).toLocal()
      : null;
  await showDialog<void>(
    context: context,
    builder: (c) => AlertDialog(
      title: const Text('الدعوة جاهزة'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'أرسل الكود للموظف المقصود بصورة خاصة. يختار «إنشاء حساب موظف» على هاتفه، ويكتب بريده وكلمة مروره والكود، ثم يؤكد بريده. لو لديه حساب يختار «لدي حساب ومعي دعوة». الكود يستخدم مرة واحدة ويحدد المنشأة تلقائياً.',
            ),
            const SizedBox(height: 12),
            Text('المنشأة: ${app.business}'),
            const SizedBox(height: 8),
            SelectableText(token, textDirection: TextDirection.ltr),
            if (date != null)
              Text(
                'تنتهي الدعوة: ${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}',
              ),
          ],
        ),
      ),
      actions: [
        TextButton.icon(
          onPressed: () async {
            await SharePlus.instance.share(
              ShareParams(
                text:
                    'كود دعوة الموظف (${employee.name}) في ${app.business}:\n$token',
              ),
            );
          },
          icon: const Icon(Icons.share_outlined),
          label: const Text('مشاركة الكود'),
        ),
        TextButton.icon(
          onPressed: () async {
            await Clipboard.setData(ClipboardData(text: token));
            if (c.mounted) {
              ScaffoldMessenger.of(c).showSnackBar(
                const SnackBar(content: Text('نُسخ رمز الدعوة')),
              );
            }
          },
          icon: const Icon(Icons.copy),
          label: const Text('نسخ الرمز'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(c),
          child: const Text('تم'),
        ),
      ],
    ),
  );
}

class _EmployeeEnrollmentActionsState extends State<EmployeeEnrollmentActions> {
  bool _busy = false;

  @override
  Widget build(BuildContext context) => Wrap(
    spacing: 8,
    children: [
      TextButton.icon(
        onPressed: _busy || !widget.app.allowed || !widget.app.manager
            ? null
            : () => _edit(invite: true),
        icon: const Icon(Icons.person_add_alt_1_outlined),
        label: const Text('إنشاء كود دعوة الموظف'),
      ),
      TextButton.icon(
        onPressed: _busy || !widget.app.allowed || !widget.app.manager
            ? null
            : () => _edit(invite: false),
        icon: const Icon(Icons.manage_accounts_outlined),
        label: const Text('تفعيل أو إيقاف الحساب'),
      ),
    ],
  );

  Future<void> _edit({required bool invite}) => _openEnrollmentDialog(
    context: context,
    app: widget.app,
    employee: widget.employee,
    invite: invite,
    onBusyChanged: (value) {
      if (mounted) setState(() => _busy = value);
    },
  );
}
