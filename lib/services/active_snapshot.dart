import 'dart:convert';

import 'package:crypto/crypto.dart';

import '../domain/ledger.dart';

/// A full retained server projection, separate from an annual archive package.
/// The authenticated gateway supplies the expected header digest. A digest alone
/// is an integrity check and never grants authority to install another scope.
const activeSnapshotMaxPageBytes = 65536;
const activeSnapshotMaxRecordBytes = 24000;
const activeSnapshotMaxPages = 4096;
const activeSnapshotMaxRecords = 500000;
const activeSnapshotMaxTotalBytes = 268435456;
// Disk/transaction bounds; installation streams pages and indexed dependencies.
const activeSnapshotInstallMaxRecords = 1000000;
const activeSnapshotInstallMaxBytes = 536870912;
const _maxSafeInteger = 9007199254740991;
final _hashPattern = RegExp(r'^[a-f0-9]{64}$');

String activeSnapshotHash(Object? value) =>
    sha256.convert(utf8.encode(canonicalJson(value))).toString();

void _exact(Map<String, dynamic> value, Set<String> fields) {
  if (value.length != fields.length ||
      value.keys.any((key) => !fields.contains(key))) {
    invalid('snapshot_schema', 'بنية نسخة الاستعادة غير صالحة.');
  }
}

/// Reject non-JSON values and unsafe integers before hashing or persistence.
void validateActiveSnapshotJson(Object? value) {
  var nodes = 0;
  void visit(Object? value, int depth) {
    if (depth > 20 || ++nodes > 200000) {
      invalid('snapshot_json_limit', 'نسخة الاستعادة تتجاوز حدود التحقق.');
    }
    if (value == null || value is bool || value is String) return;
    if (value is int && value >= -_maxSafeInteger && value <= _maxSafeInteger) {
      return;
    }
    if (value is List) {
      for (final child in value) {
        visit(child, depth + 1);
      }
      return;
    }
    if (value is Map) {
      for (final entry in value.entries) {
        if (entry.key is! String ||
            {'__proto__', 'prototype', 'constructor'}.contains(entry.key)) {
          invalid('snapshot_json', 'بيانات نسخة الاستعادة غير صالحة.');
        }
        visit(entry.value, depth + 1);
      }
      return;
    }
    invalid('snapshot_json', 'بيانات نسخة الاستعادة غير صالحة.');
  }

  visit(value, 0);
}

int _integer(Map<String, dynamic> value, String key, int min, int max) {
  final result = value[key];
  if (result is! int || result < min || result > max) {
    invalid('snapshot_number', 'قيمة رقمية في نسخة الاستعادة غير صالحة.');
  }
  return result;
}

class ActiveSnapshotHeader {
  ActiveSnapshotHeader._(this._json);
  final Map<String, dynamic> _json;
  String get snapshotId => _json['snapshotId'] as String;
  String get tenantId => _json['tenantId'] as String;
  String get role => _json['role'] as String;
  String get uid => _json['uid'] as String;
  int get membershipEpoch => _json['membershipEpoch'] as int;
  int get checkpointSequence => _json['checkpointSequence'] as int;
  int get historyFloor => _json['historyFloor'] as int;
  int get pageCount => _json['pageCount'] as int;
  int get recordCount => _json['recordCount'] as int;
  String get contentSha256 => _json['contentSha256'] as String;
  Map<String, dynamic> toJson() => Map<String, dynamic>.from(_json);

  factory ActiveSnapshotHeader.parse(Map<String, dynamic> value) {
    _exact(value, {
      'format',
      'version',
      'syncProtocolVersion',
      'snapshotId',
      'tenantId',
      'role',
      'uid',
      'membershipEpoch',
      'checkpointSequence',
      'historyFloor',
      'pageCount',
      'recordCount',
      'contentSha256',
    });
    validateActiveSnapshotJson(value);
    if (value['format'] != 'active_snapshot' ||
        value['version'] != 1 ||
        value['syncProtocolVersion'] != 2) {
      invalid('snapshot_version', 'إصدار نسخة الاستعادة غير مدعوم.');
    }
    for (final key in ['snapshotId', 'tenantId', 'uid']) {
      safeId(strictString(value, key));
    }
    if (!{'manager', 'employee'}.contains(value['role'])) {
      invalid('snapshot_scope', 'صلاحية نسخة الاستعادة غير صالحة.');
    }
    _integer(value, 'membershipEpoch', 1, _maxSafeInteger);
    final checkpoint = _integer(
      value,
      'checkpointSequence',
      0,
      _maxSafeInteger,
    );
    _integer(value, 'historyFloor', 0, checkpoint);
    final pages = _integer(value, 'pageCount', 0, activeSnapshotMaxPages);
    final records = _integer(value, 'recordCount', 0, activeSnapshotMaxRecords);
    if (value['contentSha256'] is! String ||
        !_hashPattern.hasMatch(value['contentSha256'] as String) ||
        (pages == 0) != (records == 0)) {
      invalid('snapshot_counts', 'عدد صفحات أو سجلات الاستعادة غير صالح.');
    }
    return ActiveSnapshotHeader._(Map<String, dynamic>.unmodifiable(value));
  }

  void requireScope({
    required String tenantId,
    required String uid,
    required String role,
    required int membershipEpoch,
  }) {
    if (this.tenantId != tenantId ||
        this.uid != uid ||
        this.role != role ||
        this.membershipEpoch != membershipEpoch ||
        membershipEpoch < 1 ||
        membershipEpoch > _maxSafeInteger) {
      invalid('snapshot_scope', 'نسخة الاستعادة لا تخص جلسة الحساب الحالية.');
    }
  }
}

void _validateSnapshotPayload(String entity, Map<String, dynamic> payload) {
  Set<String> fields;
  switch (entity) {
    case 'party':
      final value = Party.fromJson(payload)..validate();
      fields = value.toJson().keys.toSet();
    case 'employee':
      final value = Employee.fromJson(payload)..validate();
      fields = value.toJson().keys.toSet();
    case 'salary_term':
      final value = SalaryTerm.fromJson(payload)..validate();
      fields = value.toJson().keys.toSet();
    case 'entry':
      fields = LedgerEntry.fromJson(payload).toJson().keys.toSet()
        ..addAll({
          'submittedByEmployeeId',
          'originalBusinessDate',
          'correctionOfOperationId',
        });
      if (payload.containsKey('submittedByEmployeeId')) {
        safeId(strictString(payload, 'submittedByEmployeeId'));
      }
    case 'submission':
      fields = {
        'id',
        'tenantId',
        'creatorUid',
        'employeeId',
        'kind',
        'date',
        'partyId',
        'partyName',
        'qtyMilli',
        'grade',
        'unit',
        'originalId',
        'amountMinor',
        'note',
        'category',
      };
      EmployeeSubmission.fromJson({
        for (final key in fields)
          if (payload.containsKey(key)) key: payload[key],
      }).validate();
      fields.addAll({
        'status',
        'recordedByUid',
        'recordedAtMs',
        'approvedUnitMinor',
        'reviewNote',
      });
      if (payload.containsKey('status') &&
          !{'pending', 'approved', 'rejected'}.contains(payload['status'])) {
        invalid('snapshot_submission', 'حالة طلب الاستعادة غير صالحة.');
      }
      if (payload.containsKey('recordedByUid') &&
          payload['recordedByUid'] != payload['creatorUid']) {
        invalid('snapshot_submission', 'هوية مسجل الطلب غير صالحة.');
      }
      if (payload.containsKey('recordedAtMs')) {
        _integer(payload, 'recordedAtMs', 0, 8640000000000000);
      }
      if (payload.containsKey('approvedUnitMinor')) {
        _integer(payload, 'approvedUnitMinor', 0, 1000000000);
      }
      if (payload.containsKey('reviewNote') &&
          (payload['reviewNote'] is! String ||
              (payload['reviewNote'] as String).length > 1000)) {
        invalid('snapshot_submission', 'ملاحظة مراجعة الطلب غير صالحة.');
      }
    case 'review':
      fields = {
        'id',
        'tenantId',
        'submissionId',
        'decision',
        'note',
        'reviewerUid',
        'reviewedAtMs',
        'entryId',
      };
      safeId(strictString(payload, 'submissionId'));
      if (!{'approved', 'rejected'}.contains(payload['decision']) ||
          strictString(payload, 'note').length > 1000) {
        invalid('snapshot_review', 'قرار مراجعة الاستعادة غير صالح.');
      }
      if (payload.containsKey('reviewerUid')) {
        safeId(strictString(payload, 'reviewerUid'));
      }
      if (payload.containsKey('entryId') && payload['entryId'] != '') {
        safeId(strictString(payload, 'entryId'));
      }
      if (payload.containsKey('reviewedAtMs')) {
        _integer(payload, 'reviewedAtMs', 0, 8640000000000000);
      }
    default:
      invalid('snapshot_entity', 'نوع سجل الاستعادة غير صالح.');
  }
  if (payload.keys.any((key) => !fields.contains(key))) {
    invalid(
      'snapshot_private_data',
      'يحتوي سجل الاستعادة حقولاً غير مصرح بها.',
    );
  }
}

String activeSnapshotRecordKey(Map<String, dynamic> record) =>
    '${record['entity']}/${(record['sequence'] as int).toString().padLeft(16, '0')}/${(record['payload'] as Map)['id']}';

class ActiveSnapshotPage {
  ActiveSnapshotPage._(this.index, this.sha256, this.records, this.recordsJson);
  final int index;
  final String sha256;
  final List<Map<String, dynamic>> records;
  final String recordsJson;
  int get bytes => utf8.encode(recordsJson).length;
  Map<String, dynamic> get descriptor => {
    'index': index,
    'sha256': sha256,
    'recordCount': records.length,
  };

  factory ActiveSnapshotPage.parse(
    Map<String, dynamic> value,
    ActiveSnapshotHeader header,
  ) {
    _exact(value, {'snapshotId', 'index', 'records', 'sha256'});
    validateActiveSnapshotJson(value);
    final index = _integer(value, 'index', 0, header.pageCount - 1);
    final raw = value['records'];
    if (value['snapshotId'] != header.snapshotId ||
        raw is! List ||
        raw.isEmpty ||
        raw.length > header.recordCount ||
        value['sha256'] is! String ||
        !_hashPattern.hasMatch(value['sha256'] as String)) {
      invalid('snapshot_page', 'صفحة الاستعادة غير صالحة.');
    }
    final recordsJson = canonicalJson(raw);
    if (utf8.encode(recordsJson).length > activeSnapshotMaxPageBytes ||
        utf8.encode(canonicalJson(value)).length > 66560) {
      invalid('snapshot_page_limit', 'صفحة الاستعادة أكبر من الحد المسموح.');
    }
    if (activeSnapshotHash(raw) != value['sha256']) {
      invalid('snapshot_page_integrity', 'فشل التحقق من سلامة صفحة الاستعادة.');
    }
    final records = <Map<String, dynamic>>[];
    String? previous;
    for (final item in raw) {
      if (item is! Map<String, dynamic>) {
        invalid('snapshot_record', 'سجل الاستعادة غير صالح.');
      }
      _exact(item, {'entity', 'payload', 'sequence'});
      _integer(item, 'sequence', 1, header.checkpointSequence);
      final entity = item['entity'];
      final payload = item['payload'];
      if (!{
            'party',
            'employee',
            'salary_term',
            'submission',
            'entry',
            'review',
          }.contains(entity) ||
          payload is! Map<String, dynamic> ||
          payload['tenantId'] != header.tenantId ||
          utf8.encode(canonicalJson(item)).length >
              activeSnapshotMaxRecordBytes) {
        invalid('snapshot_record', 'بيانات سجل الاستعادة أو نطاقه غير صالح.');
      }
      safeId(strictString(payload, 'id'));
      if (header.role == 'employee') {
        if (entity == 'party') {
          _exact(payload, {
            'id',
            'tenantId',
            'name',
            'kind',
            'phone',
            'favorite',
            'revision',
          });
        } else if (entity != 'submission' ||
            payload['creatorUid'] != header.uid) {
          invalid(
            'snapshot_private_data',
            'تحتوي النسخة بيانات تخص صلاحية أخرى.',
          );
        }
      }
      _validateSnapshotPayload(entity as String, payload);
      final key = activeSnapshotRecordKey(item);
      if (previous != null && previous.compareTo(key) >= 0) {
        invalid('snapshot_record_order', 'ترتيب سجلات الاستعادة غير صالح.');
      }
      previous = key;
      // Copy through canonical JSON to avoid retaining mutable caller objects.
      records.add(
        Map<String, dynamic>.from(jsonDecode(canonicalJson(item)) as Map),
      );
    }
    return ActiveSnapshotPage._(
      index,
      value['sha256'] as String,
      List.unmodifiable(records),
      recordsJson,
    );
  }
}

class ActiveSnapshotStatus {
  const ActiveSnapshotStatus({
    required this.header,
    required this.receivedPageIndexes,
    required this.installed,
  });
  final ActiveSnapshotHeader header;
  final List<int> receivedPageIndexes;
  final bool installed;
  // A committed install marker attests that the complete package was verified
  // atomically. Its disposable download pages may subsequently be reclaimed.
  bool get complete =>
      installed || receivedPageIndexes.length == header.pageCount;
}
