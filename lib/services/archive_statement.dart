import 'dart:convert';

import '../domain/ledger.dart';

const _safeInteger = 9007199254740991;
const _entryLimit = 1000000000000;
const _roles = {'merchant', 'supplier'};
final _manifestHash = RegExp(r'^[a-f0-9]{64}$');

Never _bad([String detail = '']) => invalid(
  'archive_statement',
  'كشف الأرشيف غير صالح أو غير مكتمل؛ لم تتغير البيانات المحلية. $detail',
);

int _integer(Object? value, {int min = -_safeInteger, int max = _safeInteger}) {
  if (value is! int || value < min || value > max) _bad();
  return value;
}

int _exact(BigInt value) {
  if (value < BigInt.from(-_safeInteger) || value > BigInt.from(_safeInteger)) {
    _bad();
  }
  return value.toInt();
}

Map<String, dynamic> _object(Object? raw, Set<String> allowed) {
  if (raw is! Map ||
      raw.keys.any((key) => key is! String || !allowed.contains(key))) {
    _bad();
  }
  return Map<String, dynamic>.from(raw);
}

String _text(Object? value, int max, {bool empty = false}) {
  if (value is! String ||
      value.length > max ||
      (!empty && value.trim().isEmpty)) {
    _bad();
  }
  return value;
}

String _id(Object? value) {
  final result = _text(value, 120);
  safeId(result);
  return result;
}

class ArchivedStatementAccount {
  const ArchivedStatementAccount({
    required this.role,
    required this.openingMinor,
    required this.periodMinor,
    required this.closingMinor,
  });
  final String role;
  final int openingMinor, periodMinor, closingMinor;
}

/// A posting already accepted in this archive's period. References are exposed
/// separately and never become rows or contribute to a running balance.
class ArchivedStatementRow {
  const ArchivedStatementRow({
    required this.sequence,
    required this.entry,
    required this.role,
    required this.partyEffectMinor,
  });
  final int sequence, partyEffectMinor;
  final LedgerEntry entry;
  final String role;
  bool get isReversal => entry.kind == 'reversal';
}

/// Independently checked, read-only statement data. This model has no restore,
/// balance mutation, LedgerStore, receipt, acknowledgement or outbox API.
class ArchivedPartyStatement {
  const ArchivedPartyStatement._({
    required this.tenantId,
    required this.partyId,
    required this.year,
    required this.runId,
    required this.manifestSha256,
    required this.startDate,
    required this.endDate,
    required this.closingSequence,
    required this.closingVersion,
    required this.accounts,
    required this.rows,
    required this.references,
    required this.partySnapshots,
  });
  final String tenantId, partyId, runId, manifestSha256, startDate, endDate;
  final int year, closingSequence, closingVersion;
  final List<ArchivedStatementAccount> accounts;
  final List<ArchivedStatementRow> rows, references;
  final List<Party> partySnapshots;
  String get timeZone => 'Africa/Cairo';
  bool get archived => true;
  bool get readOnly => true;
  bool get found => accounts.isNotEmpty;
  String get partyName => partySnapshots.firstOrNull?.name ?? partyId;
}

class _RawRow {
  const _RawRow(this.sequence, this.entry, this.role, this.effect);
  final int sequence;
  final LedgerEntry entry;
  final String? role;
  final int? effect;
}

/// Pages must be supplied in order starting at chunk zero. The assembler pins
/// the first authenticated server publication identity for every continuation.
/// It verifies arithmetic independently, but relies on the authenticated gateway
/// to authenticate archive encryption and the manifest hash; the wire fragments
/// are projections, not copies of the signed/encrypted manifest bytes.
class ArchiveStatementAssembler {
  ArchiveStatementAssembler({
    required this.tenantId,
    required this.year,
    required this.partyId,
  }) {
    safeId(tenantId);
    safeId(partyId);
    if (year < 2026 || year > 9998) _bad();
  }

  static const maxRecords = 20000;
  static const maxBytes = 16 * 1024 * 1024;
  static const maxPageBytes = 1024 * 1024;
  static const maxPageRecords = 2048;
  static const maxChunks = 1024;
  final String tenantId, partyId;
  final int year;
  int? get nextChunk => _done ? null : _next;
  String? get manifestSha256 => _metadata?['manifestSha256'] as String?;
  bool get complete => _done;

  int _next = 0, _bytes = 0, _recordCount = 0;
  int? _totalChunks;
  bool _done = false, _failed = false;
  Map<String, dynamic>? _metadata;
  String? _identity;
  final List<ArchivedStatementAccount> _accounts = [];
  final List<Party> _parties = [];
  final Map<String, int> _openings = {};
  final Map<String, _RawRow> _targets = {};
  final List<_RawRow> _entries = [], _references = [], _reversals = [];
  final Set<String> _ids = {}, _partyRoles = {};
  final Set<int> _sequences = {};
  ArchivedPartyStatement? _result;

  void addPage(Map<String, dynamic> response) {
    if (_done || _failed) _bad();
    try {
      _addPage(response);
    } catch (_) {
      // A malformed partial page must not be repaired by continuing from a
      // cursor derived before the error. Start a fresh read with the same scope.
      _failed = true;
      rethrow;
    }
  }

  void _addPage(Map<String, dynamic> response) {
    final bytes = utf8.encode(jsonEncode(response)).length;
    if (bytes > maxPageBytes || _bytes + bytes > maxBytes) {
      _bad('تجاوز حد العرض.');
    }
    final page = _object(response, {
      'status',
      'archived',
      'readOnly',
      'statement',
      'fragment',
      'nextChunk',
    });
    final status = page['status'];
    if (!{'continue', 'complete', 'not_found'}.contains(status) ||
        page['archived'] != true ||
        page['readOnly'] != true) {
      _bad();
    }
    final metadata = _object(page['statement'], {
      'tenantId',
      'partyId',
      'manifestSha256',
      'year',
      'runId',
      'startDate',
      'endDate',
      'timeZone',
      'closingSequence',
      'closingVersion',
      'accounts',
    });
    if (metadata['tenantId'] != tenantId ||
        metadata['partyId'] != partyId ||
        metadata['year'] != year ||
        metadata['startDate'] != '$year-09-01' ||
        metadata['endDate'] != '${year + 1}-09-01' ||
        metadata['timeZone'] != 'Africa/Cairo' ||
        !_manifestHash.hasMatch(_text(metadata['manifestSha256'], 64))) {
      _bad();
    }
    _id(metadata['runId']);
    _integer(metadata['closingSequence'], min: 0);
    _integer(metadata['closingVersion'], min: 1);
    final identity = canonicalJson(metadata);
    if (_identity != null && identity != _identity) _bad('تغير إصدار الأرشيف.');
    if (_identity == null) {
      final rawAccounts = metadata['accounts'];
      if (rawAccounts is! List || rawAccounts.length > 2) _bad();
      final roles = <String>{};
      for (final raw in rawAccounts) {
        final account = _object(raw, {
          'role',
          'openingMinor',
          'periodMinor',
          'closingMinor',
        });
        final role = _text(account['role'], 20);
        if (!_roles.contains(role) || !roles.add(role)) _bad();
        final opening = _integer(account['openingMinor']);
        final period = _integer(account['periodMinor']);
        final closing = _integer(account['closingMinor']);
        if (_exact(BigInt.from(opening) + BigInt.from(period)) != closing) {
          _bad();
        }
        _accounts.add(
          ArchivedStatementAccount(
            role: role,
            openingMinor: opening,
            periodMinor: period,
            closingMinor: closing,
          ),
        );
      }
      _metadata = Map.unmodifiable(metadata);
      _identity = identity;
    }
    if ((_accounts.isEmpty) != (status == 'not_found')) _bad();
    final fragment = _object(page['fragment'], {
      'fromChunk',
      'toChunkExclusive',
      'totalChunks',
      'partySnapshots',
      'openingBaselines',
      'entries',
      'references',
      'reversals',
    });
    final from = _integer(fragment['fromChunk'], min: 0, max: maxChunks);
    final to = _integer(fragment['toChunkExclusive'], min: 0, max: maxChunks);
    final total = _integer(fragment['totalChunks'], min: 0, max: maxChunks);
    if (from != _next ||
        to < from ||
        to > total ||
        (_totalChunks != null && total != _totalChunks)) {
      _bad();
    }
    if (status == 'continue') {
      if (to <= from || to >= total || page['nextChunk'] != to) _bad();
    } else if (page['nextChunk'] != null ||
        (status == 'complete' && to != total) ||
        (status == 'not_found' && (from != 0 || to != 0))) {
      _bad();
    }
    final lists = <String, List>{};
    var count = 0;
    for (final name in [
      'partySnapshots',
      'openingBaselines',
      'entries',
      'references',
      'reversals',
    ]) {
      final values = fragment[name];
      if (values is! List) _bad();
      lists[name] = values;
      count += values.length;
    }
    if (count > maxPageRecords ||
        _recordCount + count > maxRecords ||
        (status == 'not_found' && count != 0)) {
      _bad('تجاوز حد العرض.');
    }
    for (final raw in lists['partySnapshots']!) {
      final data = _object(raw, {
        'id',
        'tenantId',
        'name',
        'kind',
        'openingMinor',
        'phone',
        'favorite',
        'revision',
      });
      final party = Party.fromJson(data)..validate();
      if (party.id != partyId ||
          party.tenantId != tenantId ||
          !_accounts.any((a) => a.role == party.kind) ||
          !_partyRoles.add(party.kind)) {
        _bad();
      }
      _parties.add(party);
    }
    for (final raw in lists['openingBaselines']!) {
      final data = _object(raw, {'role', 'balanceMinor'});
      final role = _text(data['role'], 20);
      final balance = _integer(data['balanceMinor']);
      if (_openings.containsKey(role) ||
          !_accounts.any((a) => a.role == role && a.openingMinor == balance)) {
        _bad();
      }
      _openings[role] = balance;
    }
    for (final name in ['entries', 'references', 'reversals']) {
      var lastSequence = 0;
      for (final raw in lists[name]!) {
        final data = _object(
          raw,
          name == 'reversals'
              ? {'sequence', 'entry'}
              : {'sequence', 'entry', 'role', 'partyEffectMinor'},
        );
        final sequence = _integer(
          data['sequence'],
          min: 1,
          max: metadata['closingSequence'] as int,
        );
        if (sequence <= lastSequence || !_sequences.add(sequence)) _bad();
        lastSequence = sequence;
        final entry = _parseEntry(
          data['entry'],
          reference: name == 'references',
          reversal: name == 'reversals',
        );
        if (!_ids.add(entry.id)) _bad();
        final String? role;
        final int? effect;
        if (name == 'reversals') {
          role = null;
          effect = null;
        } else {
          role = _text(data['role'], 20);
          effect = _integer(data['partyEffectMinor']);
          if (!_accounts.any((a) => a.role == role) ||
              role != _role(entry) ||
              effect != _effect(entry)) {
            _bad();
          }
        }
        final row = _RawRow(sequence, entry, role, effect);
        if (name == 'entries') _entries.add(row);
        if (name == 'references') _references.add(row);
        if (name == 'reversals') _reversals.add(row);
        if (name != 'reversals') _targets[entry.id] = row;
      }
    }
    _next = to;
    _totalChunks = total;
    _bytes += bytes;
    _recordCount += count;
    _done = status != 'continue';
  }

  String _role(LedgerEntry entry) {
    if (entry.kind == 'balance_adjustment') {
      if (_accounts.length != 1) _bad();
      return _accounts.single.role;
    }
    return switch (entry.kind) {
      'sale' || 'sale_return' || 'merchant_payment' => 'merchant',
      'purchase' || 'purchase_return' || 'supplier_payment' => 'supplier',
      _ => _bad(),
    };
  }

  int _effect(LedgerEntry entry) => _exact(switch (entry.kind) {
    'sale' ||
    'purchase' => BigInt.from(entry.totalMinor) - BigInt.from(entry.paidMinor),
    'sale_return' || 'purchase_return' =>
      BigInt.from(entry.paidMinor) - BigInt.from(entry.totalMinor),
    'merchant_payment' || 'supplier_payment' => -BigInt.from(entry.paidMinor),
    'balance_adjustment' =>
      BigInt.from(entry.totalMinor) *
          BigInt.from(entry.adjustmentDirection == 'increase' ? 1 : -1),
    _ => _bad(),
  });

  LedgerEntry _parseEntry(
    Object? raw, {
    required bool reference,
    required bool reversal,
  }) {
    final data = _object(raw, {
      'id',
      'tenantId',
      'creatorUid',
      'kind',
      'date',
      'partyId',
      'partyName',
      'employeeId',
      'salaryMonth',
      'qtyMilli',
      'priceMinor',
      'totalMinor',
      'paidMinor',
      'grade',
      'unit',
      'originalId',
      'note',
      'revision',
      'shippingEmployeeId',
      'shipmentRef',
      'shipmentStatus',
      'adjustmentDirection',
      'shipmentOrder',
      'category',
      'originalBusinessDate',
      'correctionOfOperationId',
      'submittedByEmployeeId',
    });
    final e = LedgerEntry.fromJson(data);
    _id(e.id);
    if (e.creatorUid.isNotEmpty) _id(e.creatorUid);
    if (e.shippingEmployeeId.isNotEmpty) _id(e.shippingEmployeeId);
    if (!{
          '',
          'pending',
          'in_transit',
          'delivered',
        }.contains(e.shipmentStatus) ||
        (!e.isInvoice &&
            (e.shippingEmployeeId.isNotEmpty ||
                e.shipmentStatus.isNotEmpty ||
                e.shipmentRef.isNotEmpty))) {
      _bad();
    }
    if (data['submittedByEmployeeId'] != null) {
      _id(data['submittedByEmployeeId']);
    }
    if (e.tenantId != tenantId ||
        !validDate(e.date) ||
        e.revision != 1 ||
        e.note.length > 1000 ||
        e.category.length > 80 ||
        e.partyName.length > 160 ||
        e.grade.length > 80 ||
        e.unit.length > 40 ||
        e.shipmentRef.length > 120 ||
        e.shipmentOrder != 0 ||
        e.employeeId.isNotEmpty ||
        e.salaryMonth.isNotEmpty ||
        e.category.isNotEmpty ||
        [
          e.qtyMilli,
          e.priceMinor,
          e.totalMinor,
          e.paidMinor,
        ].any((n) => n < 0 || n > _entryLimit)) {
      _bad();
    }
    if (reference
        ? e.date.compareTo('$year-09-01') >= 0
        : e.date.compareTo('$year-09-01') < 0 ||
              e.date.compareTo('${year + 1}-09-01') >= 0) {
      _bad();
    }
    if ((e.originalBusinessDate.isEmpty) !=
        (e.correctionOfOperationId.isEmpty)) {
      _bad();
    }
    if (e.originalBusinessDate.isNotEmpty) {
      if (!validDate(e.originalBusinessDate) ||
          e.originalBusinessDate.compareTo(e.date) >= 0) {
        _bad();
      }
      _id(e.correctionOfOperationId);
    }
    if (reversal) {
      if (e.kind != 'reversal' ||
          e.partyId.isNotEmpty ||
          e.partyName.isNotEmpty ||
          e.note.trim().isEmpty ||
          e.adjustmentDirection.isNotEmpty ||
          [
            e.qtyMilli,
            e.priceMinor,
            e.totalMinor,
            e.paidMinor,
          ].any((n) => n != 0)) {
        _bad();
      }
      _id(e.originalId);
      return e;
    }
    if (e.partyId != partyId) _bad();
    _role(e);
    if (e.kind == 'balance_adjustment') {
      if (!{'increase', 'decrease'}.contains(e.adjustmentDirection) ||
          e.note.trim().isEmpty) {
        _bad();
      }
    } else if (e.adjustmentDirection.isNotEmpty) {
      _bad();
    }
    if (e.isInvoice || e.isReturn) {
      if (e.qtyMilli < 1 ||
          e.qtyMilli > 1000000000 ||
          e.priceMinor < 1 ||
          e.priceMinor > 1000000000 ||
          e.totalMinor < 1 ||
          e.paidMinor > e.totalMinor ||
          e.grade.trim().isEmpty ||
          e.unit.trim().isEmpty ||
          BigInt.from(e.qtyMilli) * BigInt.from(e.priceMinor) >
              BigInt.from(_safeInteger)) {
        _bad();
      }
      if (e.isInvoice || e.originalId.isEmpty) {
        final expected =
            (BigInt.from(e.qtyMilli) * BigInt.from(e.priceMinor) +
                BigInt.from(500)) ~/
            BigInt.from(1000);
        if (expected != BigInt.from(e.totalMinor) ||
            (e.isInvoice && e.originalId.isNotEmpty)) {
          _bad();
        }
      } else {
        _id(e.originalId);
      }
    } else if (e.qtyMilli != 0 ||
        e.priceMinor != 0 ||
        e.totalMinor < 1 ||
        e.grade.isNotEmpty ||
        e.unit.isNotEmpty ||
        e.originalId.isNotEmpty ||
        (e.kind == 'balance_adjustment'
            ? e.paidMinor != 0
            : e.totalMinor != e.paidMinor)) {
      _bad();
    }
    return e;
  }

  ArchivedPartyStatement finish() {
    if (_failed || !_done || _metadata == null) _bad('الكشف غير مكتمل.');
    if (_result != null) return _result!;
    try {
      return _result = _finish();
    } catch (_) {
      _failed = true;
      rethrow;
    }
  }

  ArchivedPartyStatement _finish() {
    final rows = <ArchivedStatementRow>[];
    final periods = <String, BigInt>{};
    void post(_RawRow raw, String role, int effect) {
      rows.add(
        ArchivedStatementRow(
          sequence: raw.sequence,
          entry: raw.entry,
          role: role,
          partyEffectMinor: effect,
        ),
      );
    }

    for (final raw in _entries) {
      final e = raw.entry;
      if (e.isReturn && e.originalId.isNotEmpty) {
        final original = _targets[e.originalId];
        if (original == null ||
            original.sequence >= raw.sequence ||
            original.entry.kind !=
                (e.kind == 'sale_return' ? 'sale' : 'purchase') ||
            original.entry.partyId != e.partyId ||
            original.entry.grade != e.grade ||
            original.entry.unit != e.unit ||
            original.entry.priceMinor != e.priceMinor ||
            original.entry.qtyMilli < e.qtyMilli ||
            original.entry.totalMinor < e.totalMinor ||
            original.entry.date.compareTo(e.date) > 0) {
          _bad('مرجع المرتجع مفقود أو غير مطابق.');
        }
      }
    }
    for (final row in _entries) {
      post(row, row.role!, row.effect!);
    }
    final reversed = <String>{};
    for (final raw in _reversals) {
      if (!reversed.add(raw.entry.originalId)) _bad();
      final original = _targets[raw.entry.originalId];
      // The service includes raw reversals for every party because the archive
      // format has no party index and a reversal has no party ID. Unmatched
      // originals are other-party evidence and must never invent a posting.
      if (original == null) continue;
      if (original.sequence >= raw.sequence ||
          original.entry.date.compareTo(raw.entry.date) > 0) {
        _bad();
      }
      post(raw, original.role!, _exact(-BigInt.from(original.effect!)));
    }
    rows.sort((a, b) => a.sequence.compareTo(b.sequence));
    for (final row in rows) {
      periods[row.role] =
          (periods[row.role] ?? BigInt.zero) +
          BigInt.from(row.partyEffectMinor);
      _exact(periods[row.role]!);
      final opening = _accounts
          .singleWhere((a) => a.role == row.role)
          .openingMinor;
      _exact(BigInt.from(opening) + periods[row.role]!);
    }
    for (final account in _accounts) {
      final period = periods[account.role] ?? BigInt.zero;
      if (_openings[account.role] != account.openingMinor ||
          _exact(period) != account.periodMinor ||
          _exact(BigInt.from(account.openingMinor) + period) !=
              account.closingMinor) {
        _bad('الأرصدة لا تطابق المستندات.');
      }
    }
    final metadata = _metadata!;
    return ArchivedPartyStatement._(
      tenantId: tenantId,
      partyId: partyId,
      year: year,
      runId: metadata['runId'] as String,
      manifestSha256: metadata['manifestSha256'] as String,
      startDate: metadata['startDate'] as String,
      endDate: metadata['endDate'] as String,
      closingSequence: metadata['closingSequence'] as int,
      closingVersion: metadata['closingVersion'] as int,
      accounts: List.unmodifiable(_accounts),
      rows: List.unmodifiable(rows),
      references: List.unmodifiable(
        _references.map(
          (r) => ArchivedStatementRow(
            sequence: r.sequence,
            entry: r.entry,
            role: r.role!,
            partyEffectMinor: r.effect!,
          ),
        ),
      ),
      partySnapshots: List.unmodifiable(_parties),
    );
  }
}
