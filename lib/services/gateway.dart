import 'dart:convert';
import 'dart:typed_data';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:firebase_core/firebase_core.dart';

import '../domain/ledger.dart';
import '../security/device_security.dart';
import 'employee_registration.dart';
import 'gateway_endpoint.dart';
import 'invitation_code.dart';

abstract interface class SyncGateway {
  Future<Map<String, dynamic>> bootstrap(
    String tenantId,
    InstallationIdentity identity,
  );
  Future<void> activateLicense(
    String tenantId,
    String deviceId,
    String package,
  );
  Future<Map<String, dynamic>> send(
    String tenantId,
    String deviceId,
    Map<String, dynamic> operation,
  );
  Future<Map<String, dynamic>> pull(
    String tenantId,
    String deviceId,
    int afterSequence,
  );
}

class FirebaseGateway implements SyncGateway, EmployeeRegistrationAuth {
  FirebaseGateway(this.security);
  final DeviceSecurity security;
  static const emulator = bool.fromEnvironment(
    'USE_EMULATORS',
    defaultValue: true,
  );
  static const emulatorHost = String.fromEnvironment(
    'EMULATOR_HOST',
    defaultValue: '10.0.2.2',
  );
  static final endpoint = GatewayEndpoint.parse(
    const String.fromEnvironment('GATEWAY_BASE_URL'),
    emulator: emulator,
  );
  static const _fallbackAppCheckToken = String.fromEnvironment(
    'APP_CHECK_DEBUG_TOKEN',
  );
  static bool _appCheckReady = false;
  static bool _usingFallbackAppCheck = false;
  String? _onlineSession;
  String? _boundTenant;
  String? _boundUid;
  String? _boundDevice;
  static Future<void>? _initializing;
  static Future<void> initialize() async {
    if (_initializing case final Future<void> existing) return existing;
    final future = _initialize();
    _initializing = future;
    try {
      await future;
    } catch (_) {
      if (identical(_initializing, future)) _initializing = null;
      rethrow;
    }
  }

  static Future<void> _initialize() async {
    // Reject a malformed explicit destination before initializing SDKs or Auth.
    endpoint.urlFor('bootstrap');
    if (emulator) {
      // firebase_core 5 names a demo app after the project unless explicitly
      // given DEFAULT. Auth/Functions below intentionally use that default app.
      final app = Firebase.apps.any((a) => a.name == '[DEFAULT]')
          ? Firebase.app()
          : await Firebase.initializeApp(
              name: '[DEFAULT]',
              demoProjectId: 'demo-strawberry-flutter',
            );
      if (app.options.projectId != 'demo-strawberry-flutter') {
        throw StateError('emulator_project_mismatch');
      }
      await FirebaseAuth.instance.useAuthEmulator(emulatorHost, 9099);
      FirebaseFunctions.instanceFor(region: 'europe-west1')
          .useFunctionsEmulator(emulatorHost, 5001);
    } else {
      const project = String.fromEnvironment('FIREBASE_PROJECT_ID');
      const appId = String.fromEnvironment('FIREBASE_ANDROID_APP_ID');
      const apiKey = String.fromEnvironment('FIREBASE_API_KEY');
      if (project.isEmpty || appId.isEmpty || apiKey.isEmpty) {
        throw StateError('firebase_config_missing');
      }
      if (!Firebase.apps.any((a) => a.name == '[DEFAULT]')) {
        await Firebase.initializeApp(
          options: const FirebaseOptions(
            apiKey: apiKey,
            appId: appId,
            messagingSenderId: String.fromEnvironment('FIREBASE_SENDER_ID'),
            projectId: project,
          ),
        );
      }
      if (Firebase.app().options.projectId != project ||
          Firebase.app().options.appId != appId) {
        throw StateError('firebase_config_mismatch');
      }
      // Only connected setup/sync initializes attestation. Opening the local
      // ledger and authorized local commits never wait for an App Check token.
      await FirebaseAppCheck.instance.activate(
        providerAndroid: const AndroidPlayIntegrityProvider(),
      );
    }
    await FirebaseAuth.instance.setLanguageCode('ar');
  }

  Future<void> login(String email, String password) async {
    await signIn(email, password);
  }

  static EmployeeAccount _account(User user) => EmployeeAccount(
    uid: user.uid,
    email: user.email ?? '',
    emailVerified: user.emailVerified,
  );

  @override
  Future<EmployeeAccount> signIn(String email, String password) async {
    await initialize();
    final result = await FirebaseAuth.instance.signInWithEmailAndPassword(
      email: email.trim(),
      password: password,
    );
    final user = result.user;
    if (user == null) throw StateError('authentication_required');
    return _account(user);
  }

  @override
  Future<EmployeeAccount> createAccount(String email, String password) async {
    await initialize();
    try {
      final result = await FirebaseAuth.instance.createUserWithEmailAndPassword(
        email: email.trim(),
        password: password,
      );
      final user = result.user;
      if (user == null) throw StateError('authentication_required');
      return _account(user);
    } on FirebaseAuthException catch (error) {
      if (error.code == 'email-already-in-use') {
        try {
          return await signIn(email, password);
        } on FirebaseAuthException {
          throw error;
        }
      }
      rethrow;
    }
  }

  Future<EmployeeAccount?> currentSignedInAccount() async {
    await initialize();
    final user = FirebaseAuth.instance.currentUser;
    if (user == null || (user.email ?? '').isEmpty) return null;
    try {
      await user.reload();
    } catch (_) {}
    final refreshed = FirebaseAuth.instance.currentUser;
    if (refreshed == null || (refreshed.email ?? '').isEmpty) return null;
    return _account(refreshed);
  }

  Future<void> signOut() async {
    clearSession();
    if (Firebase.apps.any((a) => a.name == '[DEFAULT]')) {
      await FirebaseAuth.instance.signOut();
    }
  }

  @override
  Future<EmployeeAccount> reloadAccount(String expectedUid) async {
    await initialize();
    final user = FirebaseAuth.instance.currentUser;
    if (user == null || user.uid != expectedUid) {
      throw StateError('session_changed');
    }
    await user.reload();
    final refreshed = FirebaseAuth.instance.currentUser;
    if (refreshed == null || refreshed.uid != expectedUid) {
      throw StateError('session_changed');
    }
    if (refreshed.emailVerified) await refreshed.getIdToken(true);
    if (FirebaseAuth.instance.currentUser?.uid != expectedUid) {
      throw StateError('session_changed');
    }
    return _account(refreshed);
  }

  @override
  Future<void> sendVerification(String expectedUid) async {
    await initialize();
    final user = FirebaseAuth.instance.currentUser;
    if (user == null || user.uid != expectedUid) {
      throw StateError('session_changed');
    }
    if (!user.emailVerified) await user.sendEmailVerification();
    if (FirebaseAuth.instance.currentUser?.uid != expectedUid) {
      throw StateError('session_changed');
    }
  }

  static Future<void> _activateFallbackAppCheck() async {
    if (_fallbackAppCheckToken.isEmpty) return;
    await FirebaseAppCheck.instance.activate(
      providerAndroid: const AndroidDebugProvider(
        debugToken: _fallbackAppCheckToken,
      ),
    );
    _usingFallbackAppCheck = true;
    final token = await FirebaseAppCheck.instance.getToken(true);
    if (token != null && token.isNotEmpty) {
      _appCheckReady = true;
    }
  }

  static Future<void> _ensureAppCheck() async {
    if (emulator || _appCheckReady) return;
    try {
      final token = await FirebaseAppCheck.instance.getToken(false);
      if (token != null && token.isNotEmpty) {
        _appCheckReady = true;
        return;
      }
    } catch (_) {
      // Play Integrity fails on uncertified environments (Waydroid, custom
      // ROMs, emulators). Fall back to the registered App Check token if provided.
    }
    await _activateFallbackAppCheck();
  }

  Future<Map<String, dynamic>> _call(
    String name,
    Map<String, dynamic> data,
  ) async {
    await _ensureAppCheck();
    final url = endpoint.urlFor(name);
    final functions = FirebaseFunctions.instanceFor(region: 'europe-west1');
    final options = HttpsCallableOptions(timeout: const Duration(seconds: 25));
    // Both routes use the Firebase callable SDK, including its Auth and App
    // Check token handling. The external host must enforce the same protocol.
    final callable = url == null
        ? functions.httpsCallable(name, options: options)
        : functions.httpsCallableFromUrl(url, options: options);
    try {
      final result = await callable.call<dynamic>(data);
      return Map<String, dynamic>.from(result.data as Map);
    } on FirebaseFunctionsException catch (error) {
      final reason = error.details is Map
          ? (error.details as Map)['reason']
          : null;
      if (!emulator &&
          !_usingFallbackAppCheck &&
          _fallbackAppCheckToken.isNotEmpty &&
          {'app-check-required', 'app-check-invalid'}.contains(reason)) {
        _appCheckReady = false;
        await _activateFallbackAppCheck();
        final retry = await callable.call<dynamic>(data);
        return Map<String, dynamic>.from(retry.data as Map);
      }
      rethrow;
    }
  }

  /// This byte-for-byte canonical challenge is also constructed by the trusted
  /// enrollment endpoint. The private signing key stays in Android Keystore.
  static String invitationChallenge({
    required String tenantId,
    required String uid,
    required String deviceId,
    required String invitationToken,
  }) => canonicalJson({
    'domain': 'strawberry-accept-invitation-v1',
    'tenantId': tenantId,
    'uid': uid,
    'deviceId': deviceId,
    'invitationToken': invitationToken,
  });

  Future<void> acceptInvitation(
    String tenantId,
    String invitationToken,
    InstallationIdentity identity,
  ) async {
    await initialize();
    safeId(tenantId);
    final parsed = EmployeeInvitationCode.parse(
      invitationToken,
      legacyTenantId: tenantId,
    );
    if (parsed.tenantId != tenantId) {
      invalid(
        'invitation_tenant',
        'كود الدعوة يخص منشأة أخرى؛ استخدم بيانات الدعوة الصحيحة',
      );
    }
    final token = parsed.token;
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) throw StateError('authentication_required');
    if (!user.emailVerified) {
      invalid('email_unverified', 'أكد بريدك الإلكتروني أولاً ثم اضغط متابعة');
    }
    await user.getIdToken(true);
    final signature = await security.signChallenge(
      Uint8List.fromList(
        utf8.encode(
          invitationChallenge(
            tenantId: tenantId,
            uid: user.uid,
            deviceId: identity.deviceId,
            invitationToken: token,
          ),
        ),
      ),
    );
    if (FirebaseAuth.instance.currentUser?.uid != user.uid) {
      throw StateError('session_changed');
    }
    try {
      await _call('acceptInvitation', {
        'tenantId': tenantId,
        'deviceId': identity.deviceId,
        'publicKeySpki': identity.publicKeySpki,
        'invitationToken': token,
        'signature': base64UrlEncode(signature).replaceAll('=', ''),
      });
    } on FirebaseFunctionsException catch (error) {
      if ({'failed-precondition', 'permission-denied'}.contains(error.code)) {
        invalid(
          'invitation_refused',
          'تعذر قبول الدعوة؛ تأكد من تأكيد بريدك وصلاحية كود الدعوة. إذا انتهت الدعوة أو استُخدمت لحساب آخر فاطلب كوداً جديداً من المدير',
        );
      }
      rethrow;
    }
    if (FirebaseAuth.instance.currentUser?.uid != user.uid) {
      throw StateError('session_changed');
    }
  }

  Future<Map<String, dynamic>> createEmployeeInvitation(
    String tenantId,
    String deviceId, {
    required String employeeId,
    String? uid,
  }) async {
    if (uid != null) safeId(uid);
    safeId(employeeId);
    return _call('createEmployeeInvitation', {
      ..._scope(tenantId, deviceId),
      'uid': ?uid,
      'employeeId': employeeId,
    });
  }

  Future<void> setMemberActive(
    String tenantId,
    String deviceId, {
    String? uid,
    String? employeeId,
    required bool active,
  }) async {
    if (uid != null) safeId(uid);
    if (employeeId != null) safeId(employeeId);
    if (uid == null && employeeId == null) {
      invalid('employee_required', 'اختر سجل الموظف أولاً');
    }
    await _call('setMemberActive', {
      ..._scope(tenantId, deviceId),
      'uid': ?uid,
      'employeeId': ?employeeId,
      'active': active,
    });
  }

  @override
  Future<Map<String, dynamic>> bootstrap(
    String tenantId,
    InstallationIdentity identity,
  ) async {
    await initialize();
    final authenticatedUid = FirebaseAuth.instance.currentUser?.uid;
    if (authenticatedUid == null) throw StateError('authentication_required');
    await FirebaseAuth.instance.currentUser?.getIdToken(true);
    final input = {'tenantId': tenantId, 'deviceId': identity.deviceId};
    var result = await _call('bootstrap', input);
    if (result['requiresDeviceProof'] == true) {
      final signature = await security.signChallenge(
        Uint8List.fromList(utf8.encode(result['challenge'] as String)),
      );
      result = await _call('bootstrap', {
        ...input,
        'challengeId': result['challengeId'],
        'signature': base64UrlEncode(signature).replaceAll('=', ''),
      });
    }
    if (FirebaseAuth.instance.currentUser?.uid != authenticatedUid) {
      throw StateError('session_changed');
    }
    _onlineSession = result['sessionToken'] as String?;
    _boundTenant = tenantId;
    _boundUid = authenticatedUid;
    _boundDevice = identity.deviceId;
    return result;
  }

  bool hasActiveSession(String tenantId, String deviceId) =>
      _onlineSession != null &&
      _boundTenant == tenantId &&
      _boundDevice == deviceId &&
      (Firebase.apps.isEmpty ||
          _boundUid == FirebaseAuth.instance.currentUser?.uid);

  void clearSession() {
    _onlineSession = null;
  }

  Map<String, dynamic> _scope(String tenantId, String deviceId) {
    if (!hasActiveSession(tenantId, deviceId)) {
      throw StateError('session_expired');
    }
    return {
      'tenantId': tenantId,
      'deviceId': deviceId,
      'sessionToken': _onlineSession,
    };
  }

  @override
  Future<void> activateLicense(
    String tenantId,
    String deviceId,
    String package,
  ) async {
    await _call('activateLicense', {
      ..._scope(tenantId, deviceId),
      'licensePackage': jsonDecode(package),
    });
  }

  @override
  Future<Map<String, dynamic>> send(
    String tenantId,
    String deviceId,
    Map<String, dynamic> operation,
  ) => _call('syncOperation', {
    ..._scope(tenantId, deviceId),
    'operation': operation,
  });
  @override
  Future<Map<String, dynamic>> pull(
    String tenantId,
    String deviceId,
    int afterSequence,
  ) => _call('pullChanges', {
    ..._scope(tenantId, deviceId),
    'afterSequence': afterSequence,
    'limit': 200,
  });
}

String arabicError(Object error) {
  if (error is FormatException && error.message == 'gateway_base_url_invalid') {
    return 'إعداد عنوان المزامنة غير صحيح؛ يلزم مراجعة نسخة التطبيق';
  }
  if (error is FirebaseAuthException) {
    return switch (error.code) {
      'invalid-credential' ||
      'wrong-password' ||
      'user-not-found' => 'البريد الإلكتروني أو كلمة المرور غير صحيحة',
      'email-already-in-use' => 'البريد مسجل بالفعل؛ اختر «لدي حساب ومعي دعوة» واستخدم كلمة مروره الحالية',
      'invalid-email' => 'أدخل بريداً إلكترونياً صحيحاً يخصك',
      'weak-password' => 'اختر كلمة مرور قوية من 6 أحرف على الأقل',
      'operation-not-allowed' =>
        'تسجيل الحسابات غير متاح حالياً؛ راجع مسؤول المنشأة',
      'too-many-requests' => 'محاولات كثيرة؛ انتظر قليلاً ثم أعد المحاولة',
      'network-request-failed' =>
        'تعذر الوصول إلى الخادم؛ البيانات المحلية محفوظة',
      'user-disabled' => 'تم إيقاف الحساب؛ راجع مسؤول المنشأة',
      'user-token-expired' || 'invalid-user-token' || 'requires-recent-login' =>
        'يلزم تجديد تسجيل الدخول عند الاتصال؛ العمليات المحلية محفوظة',
      _ => 'تعذر الاتصال أو تجديد جلسة الدخول؛ البيانات المحلية محفوظة ويمكنك متابعة العمل المسموح',
    };
  }
  if (error is FirebaseFunctionsException) {
    final reason = error.details is Map
        ? (error.details as Map)['reason']
        : null;
    if (reason == 'employee-account-already-linked') {
      return 'هذا الموظف لديه حساب مرتبط بالفعل؛ يمكنك تفعيل أو إيقاف حسابه من سجل الموظف';
    }
    if (reason == 'employee-account-not-linked') {
      return 'الموظف لم يسجل حسابه بعد؛ أنشئ له كود دعوة واطلب منه إكمال التسجيل أولاً';
    }
    if (reason == 'missing-employee') {
      return 'لم يصل سجل الموظف إلى الخادم بعد؛ تأكد من الاتصال بالإنترنت واضغط المزامنة ثم أعد المحاولة';
    }
    if (reason == 'employee-invitation-unavailable') {
      return 'الموظف غير نشط أو تعذر إصدار الدعوة؛ راجع سجل الموظف';
    }
    if (reason == 'device-session-expired' ||
        reason == 'device-session-required' ||
        reason == 'device-proof-required') {
      return 'انتهت جلسة الاتصال المؤقتة؛ اضغط المزامنة ثم أعد المحاولة';
    }
    if (reason == 'reauthentication-required') {
      return 'يلزم تجديد تسجيل الدخول لتنفيذ هذا الإجراء الحساس';
    }
    if (reason == 'app-check-required' ||
        reason == 'app-check-invalid' ||
        reason == 'app-check-app-mismatch') {
      return 'تعذر التحقق من أمان نسخة التطبيق على هذا الجهاز؛ تأكد من تحديث التطبيق والاتصال بالإنترنت ثم أعد المحاولة';
    }
    return switch (error.code) {
      'unavailable' || 'deadline-exceeded' =>
        'تعذر الوصول إلى الخادم؛ ستبقى العملية في قائمة الانتظار',
      'unauthenticated' =>
        'يلزم تجديد تسجيل الدخول عند الاتصال؛ العمليات المحلية محفوظة',
      'permission-denied' =>
        'الصلاحية أو العضوية لا تسمح بهذه العملية؛ راجع المدير',
      'failed-precondition' =>
        'تعذر قبول العملية؛ تحقق من الترخيص وبيانات الفاتورة',
      'resource-exhausted' => 'بلغت حد المحاولات؛ أعد المزامنة لاحقاً',
      'already-exists' ||
      'aborted' => 'تعارض مع عملية أخرى؛ راجع قائمة التعارضات',
      'invalid-argument' => 'بيانات العملية غير صالحة؛ راجع الحقول',
      _ => 'تعذرت المزامنة؛ العملية محفوظة محلياً',
    };
  }
  final text = error.toString();
  if (text.contains('session_expired')) {
    return 'انتهت جلسة الاتصال المؤقتة؛ اضغط المزامنة ثم أعد المحاولة';
  }
  if (RegExp(r'[\u0600-\u06ff]').hasMatch(text)) {
    return text.replaceFirst('Exception: ', '');
  }
  if (text.contains('database') ||
      text.contains('SQLite') ||
      text.contains('disk')) {
    return 'تعذر الحفظ في الجهاز؛ تحقق من المساحة ثم أعد المحاولة. المسودة محفوظة ما أمكن';
  }
  return 'تعذر إكمال الإجراء؛ أعد المحاولة أو راجع مسؤول المنشأة';
}
