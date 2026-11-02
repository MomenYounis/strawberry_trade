import '../domain/ledger.dart';

abstract interface class ArchiveGateway {
  Future<Map<String, dynamic>> listArchives(
    String tenantId,
    String deviceId, {
    int? afterYear,
  });
  Future<Map<String, dynamic>> readArchiveRecord(
    String tenantId,
    String deviceId, {
    required int year,
    required String recordId,
    int nextChunk = 0,
  });
  Future<Map<String, dynamic>> readArchiveStatement(
    String tenantId,
    String deviceId, {
    required int year,
    required String partyId,
    int nextChunk = 0,
    String? manifestSha256,
  });
}

class ArchiveListPage {
  const ArchiveListPage(this.archives, this.nextYear);
  final List<Map<String, dynamic>> archives;
  final int? nextYear;

  factory ArchiveListPage.parse(
    Map<String, dynamic> response, {
    int? afterYear,
  }) {
    final items = response['archives'];
    if (items is! List || items.length > 20) {
      invalid('archive_response', 'قائمة الأرشيف غير صالحة.');
    }
    final parsed = <Map<String, dynamic>>[];
    var previous = afterYear ?? 9999;
    for (final item in items) {
      if (item is! Map ||
          item['year'] is! int ||
          item['year'] < 2026 ||
          item['year'] >= previous) {
        invalid('archive_response', 'ترتيب سنوات الأرشيف غير صالح.');
      }
      previous = item['year'] as int;
      parsed.add(Map<String, dynamic>.from(item));
    }
    final next = response['nextYear'];
    if (next != null &&
        (next is! int ||
            next < 2026 ||
            next > 9998 ||
            (afterYear != null && next >= afterYear) ||
            (parsed.isNotEmpty && next > previous))) {
      invalid('archive_response', 'مؤشر قائمة الأرشيف غير صالح.');
    }
    return ArchiveListPage(parsed, next as int?);
  }
}

/// A read-only boundary: no LedgerStore, outbox, balance mutation or restore API.
class ArchiveRecordPage {
  const ArchiveRecordPage(this.status, this.record, this.nextChunk);
  final String status;
  final LedgerEntry? record;
  final int? nextChunk;

  factory ArchiveRecordPage.parse(
    Map<String, dynamic> response, {
    required String tenantId,
    required int year,
    required String recordId,
    required int requestedChunk,
  }) {
    final status = response['status'];
    if (!{'found', 'continue', 'not_found'}.contains(status)) {
      invalid('archive_response', 'استجابة الأرشيف غير صالحة.');
    }
    final archive = response['archive'];
    if (archive is! Map || archive['year'] != year) {
      invalid('archive_response', 'سنة الأرشيف غير مطابقة.');
    }
    if (status == 'continue') {
      final next = response['nextChunk'];
      if (next is! int || next <= requestedChunk || next > 1000000) {
        invalid('archive_response', 'مؤشر قراءة الأرشيف غير صالح.');
      }
      return ArchiveRecordPage('continue', null, next);
    }
    if (status == 'not_found') {
      return const ArchiveRecordPage('not_found', null, null);
    }
    final raw = response['record'];
    if (raw is! Map ||
        raw['tenantId'] != tenantId ||
        raw['id'] != recordId ||
        raw['archived'] != true ||
        raw['readOnly'] != true ||
        raw['archiveYear'] != year) {
      invalid(
        'archive_response',
        'هوية مستند الأرشيف أو صلاحية القراءة غير مطابقة.',
      );
    }
    final entry = LedgerEntry.fromJson(Map<String, dynamic>.from(raw));
    if (!entryKinds.contains(entry.kind) ||
        !validDate(entry.date) ||
        entry.date.compareTo('$year-09-01') < 0 ||
        entry.date.compareTo('${year + 1}-09-01') >= 0 ||
        [
          entry.totalMinor,
          entry.paidMinor,
          entry.qtyMilli,
          entry.priceMinor,
        ].any((v) => v < 0 || v > 1000000000000)) {
      invalid('archive_response', 'محتوى مستند الأرشيف غير صالح للعرض.');
    }
    return ArchiveRecordPage('found', entry, null);
  }
}
