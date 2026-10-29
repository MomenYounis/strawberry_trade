import '../domain/ledger.dart';

class EmployeeAccount {
  const EmployeeAccount({
    required this.uid,
    required this.email,
    required this.emailVerified,
  });
  final String uid;
  final String email;
  final bool emailVerified;
}

abstract interface class EmployeeRegistrationAuth {
  Future<EmployeeAccount> createAccount(String email, String password);
  Future<EmployeeAccount> signIn(String email, String password);
  Future<EmployeeAccount> reloadAccount(String expectedUid);
  Future<void> sendVerification(String expectedUid);
}

/// Keeps only the authenticated account snapshot in memory. A delivery error
/// does not undo account creation or attempt to create that account again.
/// Passwords and invitation codes are never persisted by this flow.
class EmployeeRegistration {
  EmployeeRegistration(this.auth);
  final EmployeeRegistrationAuth auth;
  EmployeeAccount? account;
  Object? verificationDeliveryError;

  Future<void> begin({
    required String email,
    required String password,
    required bool create,
  }) async {
    if (account != null) {
      invalid(
        'registration_exists',
        'الحساب جاهز؛ تابع تأكيد البريد أو اختر حساباً آخر',
      );
    }
    final current = create
        ? await auth.createAccount(email.trim(), password)
        : await auth.signIn(email.trim(), password);
    account = current;
    verificationDeliveryError = null;
    if (!current.emailVerified) {
      try {
        await auth.sendVerification(current.uid);
      } catch (error) {
        verificationDeliveryError = error;
      }
    }
  }

  Future<void> resend() async {
    final current = account;
    if (current == null) invalid('authentication_required', 'سجّل دخولك أولاً');
    await auth.sendVerification(current.uid);
    verificationDeliveryError = null;
  }

  Future<bool> refreshVerified() async {
    final current = account;
    if (current == null) invalid('authentication_required', 'سجّل دخولك أولاً');
    final refreshed = await auth.reloadAccount(current.uid);
    if (refreshed.uid != current.uid || refreshed.email != current.email) {
      invalid(
        'session_changed',
        'تغيّر حساب الدخول؛ ابدأ من جديد بالحساب الصحيح',
      );
    }
    account = refreshed;
    return refreshed.emailVerified;
  }
}
