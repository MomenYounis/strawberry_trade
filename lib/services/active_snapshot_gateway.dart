/// Authenticated snapshot transport. It never clears a local ledger or queue.
abstract interface class ActiveSnapshotGateway {
  Future<Map<String, dynamic>> getActiveSnapshot(
    String tenantId,
    String deviceId,
  );
  Future<Map<String, dynamic>> readActiveSnapshotPage(
    String tenantId,
    String deviceId, {
    required String snapshotId,
    required int index,
    required String headerSha256,
  });
}
