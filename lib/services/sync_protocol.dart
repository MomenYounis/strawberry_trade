import '../domain/ledger.dart';

/// Maximum supported version. Transport negotiates v2 only after an authenticated
/// bootstrap advertises it; existing full-history v1 servers remain supported.
const syncProtocolVersion = 2;
const maxSyncSequence = 9007199254740991;

class SyncPage {
  const SyncPage(this.changes, this.lastSequence, this.hasMore);
  final List<Map<String, dynamic>> changes;
  final int lastSequence;
  final bool hasMore;

  factory SyncPage.parse(Map<String, dynamic> response, int cursor) {
    if (response['status'] == 'resync_required' ||
        response['status'] == 'upgrade_required') {
      invalid(
        'resync-required',
        'يلزم تحديث التطبيق واستعادة سجل المزامنة بإشراف المسؤول؛ العمليات المحلية محفوظة.',
      );
    }
    final protocol = response['syncProtocolVersion'] ?? 1;
    if (protocol is! int || protocol < 1 || protocol > syncProtocolVersion) {
      invalid(
        'upgrade-required',
        'إصدار المزامنة غير مدعوم؛ حدّث التطبيق مع الاحتفاظ ببياناته المحلية.',
      );
    }
    final floor = response['historyFloor'] ?? 0;
    final sequence = response['lastSequence'];
    final more = response['hasMore'];
    final raw = response['changes'];
    if (cursor < 0 ||
        cursor > maxSyncSequence ||
        floor is! int ||
        floor < 0 ||
        floor > maxSyncSequence ||
        sequence is! int ||
        sequence < cursor ||
        sequence > maxSyncSequence ||
        more is! bool ||
        raw is! List ||
        raw.length > 1000 ||
        (more && sequence == cursor)) {
      invalid(
        'sync_response',
        'استجابة مزامنة غير صالحة؛ لم يتغير مؤشر السجل المحلي.',
      );
    }
    if (cursor < floor) {
      invalid(
        'resync-required',
        'السجل المطلوب أقدم من المتاح؛ يلزم تحديث واستعادة آمنة دون حذف العمليات المحلية.',
      );
    }
    final changes = <Map<String, dynamic>>[];
    var previousSequence = cursor;
    for (final change in raw) {
      if (change is! Map ||
          change['entity'] is! String ||
          change['payload'] is! Map) {
        invalid(
          'sync_response',
          'بنية سجل المزامنة غير صالحة؛ البيانات المحلية محفوظة.',
        );
      }
      final changeSequence = change['sequence'];
      if (changeSequence is! int ||
          changeSequence <= previousSequence ||
          changeSequence > maxSyncSequence) {
        invalid(
          'sync_response',
          'ترتيب سجل المزامنة غير صالح؛ لم يتغير المؤشر المحلي.',
        );
      }
      previousSequence = changeSequence;
      changes.add({
        'entity': change['entity'],
        'payload': Map<String, dynamic>.from(change['payload'] as Map),
      });
    }
    if (sequence != previousSequence) {
      invalid(
        'sync_response',
        'مؤشر الصفحة لا يطابق السجلات المستلمة؛ لم يتغير المؤشر المحلي.',
      );
    }
    return SyncPage(changes, sequence, more);
  }
}
