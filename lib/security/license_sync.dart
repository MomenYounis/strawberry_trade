import 'licensing.dart';

/// The transport owns online proof sessions. This coordinator owns the ordering
/// of local package acceptance and trusted tenant-wide activation redemption.
Future<LicenseStatus> synchronizeLicense({
  required LicenseSession session,
  required Future<String> Function() bootstrap,
  required Future<void> Function(String package) activate,
}) async {
  var response = await bootstrap();
  var incoming = await session.verifier.verifyPackage(
    response,
    tenantId: session.tenantId,
    uid: session.uid,
    deviceId: session.deviceId,
  );
  // Never use a paid file to bypass a live revocation, including when the paid
  // tenant entitlement has not yet been redeemed on the server.
  if (!incoming.membership.enabled ||
      (session.verifiedPackage != null &&
          incoming.membership.role !=
              session.verifiedPackage!.membership.role)) {
    return session.importPackage(response, trustedOnline: true);
  }
  final pending = session.pendingTenantActivation;
  if (pending != null) {
    await activate(pending);
    response = await bootstrap();
    incoming = await session.verifier.verifyPackage(
      response,
      tenantId: session.tenantId,
      uid: session.uid,
      deviceId: session.deviceId,
    );
  }
  final local = session.verifiedPackage;
  if (local != null &&
      incoming.membership.enabled &&
      incoming.license.epoch < local.license.epoch) {
    // An employee can receive authentic offline renewal before the manager
    // redeems it. Keep the local certificate; server sends remain authoritative.
    return session.refreshTrustedTime(response);
  }
  final result = await session.importPackage(response, trustedOnline: true);
  if (pending != null && incoming.membership.enabled) {
    final pendingPackage = await session.verifier.verifyPackage(
      pending,
      tenantId: session.tenantId,
      uid: session.uid,
      deviceId: session.deviceId,
    );
    if (incoming.license.epoch < pendingPackage.license.epoch ||
        (incoming.license.epoch == pendingPackage.license.epoch &&
            incoming.entitlementPayload != pendingPackage.entitlementPayload)) {
      throw const LicenseException(
        'activation_pending',
        'لم يؤكد الخادم تفعيل النشاط بعد؛ حزمة التفعيل محفوظة لإعادة المحاولة.',
      );
    }
    await session.acknowledgeTenantActivation(pending);
  }
  return result;
}
