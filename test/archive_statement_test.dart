import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/services/archive_statement.dart';

Map<String, dynamic> invoice(
  String id, {
  String kind = 'sale',
  String date = '2027-09-02',
  int total = 2000000,
  int qty = 10000,
  int price = 200000,
  String original = '',
}) => {
  'id': id,
  'tenantId': 'tenant',
  'kind': kind,
  'date': date,
  'partyId': 'party',
  'partyName': 'عميل ومورد اختباري',
  'totalMinor': total,
  'paidMinor': 0,
  'qtyMilli': qty,
  'priceMinor': price,
  'grade': 'أول',
  'unit': 'كجم',
  if (original.isNotEmpty) 'originalId': original,
};
Map<String, dynamic> payment(
  String id, {
  String kind = 'merchant_payment',
  int amount = 500000,
}) => {
  'id': id,
  'tenantId': 'tenant',
  'kind': kind,
  'date': '2027-09-02',
  'partyId': 'party',
  'totalMinor': amount,
  'paidMinor': amount,
};
Map<String, dynamic> reversal(String id, String original) => {
  'id': id,
  'tenantId': 'tenant',
  'kind': 'reversal',
  'date': '2027-10-02',
  'originalId': original,
  'note': 'عكس موثق',
};
Map<String, dynamic> row(
  int sequence,
  Map<String, dynamic> entry,
  String role,
  int effect,
) => {
  'sequence': sequence,
  'entry': entry,
  'role': role,
  'partyEffectMinor': effect,
};
Map<String, dynamic> account(String role, int opening, int period) => {
  'role': role,
  'openingMinor': opening,
  'periodMinor': period,
  'closingMinor': opening + period,
};
Map<String, dynamic> page({
  int year = 2027,
  List<Map<String, dynamic>>? accounts,
  List<Map<String, dynamic>> entries = const [],
  List<Map<String, dynamic>> references = const [],
  List<Map<String, dynamic>> reversals = const [],
  List<Map<String, dynamic>>? openings,
  List<Map<String, dynamic>> parties = const [],
  int from = 0,
  int to = 1,
  int total = 1,
}) {
  final controls = accounts ?? [account('merchant', 2000000, -500000)];
  return {
    'status': to == total ? 'complete' : 'continue',
    'archived': true,
    'readOnly': true,
    'statement': {
      'tenantId': 'tenant',
      'partyId': 'party',
      'manifestSha256': 'a' * 64,
      'year': year,
      'runId': 'synthetic_run_$year',
      'startDate': '$year-09-01',
      'endDate': '${year + 1}-09-01',
      'timeZone': 'Africa/Cairo',
      'closingSequence': 100,
      'closingVersion': year - 2025,
      'accounts': controls,
    },
    'fragment': {
      'fromChunk': from,
      'toChunkExclusive': to,
      'totalChunks': total,
      'partySnapshots': parties,
      'openingBaselines':
          openings ??
          [
            for (final a in controls)
              {'role': a['role'], 'balanceMinor': a['openingMinor']},
          ],
      'entries': entries,
      'references': references,
      'reversals': reversals,
    },
    'nextChunk': to == total ? null : to,
  };
}

ArchiveStatementAssembler assembler({int year = 2027}) =>
    ArchiveStatementAssembler(tenantId: 'tenant', year: year, partyId: 'party');
ArchivedPartyStatement parse(
  Map<String, dynamic> response, {
  int year = 2027,
}) => (assembler(year: year)..addPage(response)).finish();
Map<String, dynamic> copy(Map<String, dynamic> value) =>
    jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
Matcher get rejects => throwsA(isA<LedgerException>());

void main() {
  test('two years carry customer EGP20,000 to15,000 without reposting party opening', () {
    final first = parse(
      page(
        year: 2026,
        accounts: [account('merchant', 0, 2000000)],
        entries: [
          row(
            1,
            invoice('old_invoice', date: '2027-08-31'),
            'merchant',
            2000000,
          ),
        ],
      ),
      year: 2026,
    );
    final next = parse(
      page(
        entries: [row(2, payment('receipt'), 'merchant', -500000)],
        parties: [
          {
            'id': 'party',
            'tenantId': 'tenant',
            'name': 'عميل اختباري',
            'kind': 'merchant',
            'openingMinor': 987654,
          },
        ],
      ),
    );
    expect(first.accounts.single.closingMinor, 2000000);
    expect(
      next.accounts.single.openingMinor,
      first.accounts.single.closingMinor,
    );
    expect(next.accounts.single.closingMinor, 1500000);
    expect(next.rows.single.partyEffectMinor, -500000);
    expect(next.partySnapshots.single.openingMinor, 987654);
    expect(next.partyName, 'عميل اختباري');
    expect(next.archived && next.readOnly, true);
  });
  test('two supplier years carry exact payable 20,000 to15,000', () {
    final first = parse(
      page(
        year: 2026,
        accounts: [account('supplier', 0, 2000000)],
        entries: [
          row(
            1,
            invoice('purchase', kind: 'purchase', date: '2027-08-31'),
            'supplier',
            2000000,
          ),
        ],
      ),
      year: 2026,
    );
    final next = parse(
      page(
        accounts: [account('supplier', 2000000, -500000)],
        entries: [
          row(
            2,
            payment('paid', kind: 'supplier_payment'),
            'supplier',
            -500000,
          ),
        ],
      ),
    );
    expect(
      first.accounts.single.closingMinor,
      next.accounts.single.openingMinor,
    );
    expect(next.accounts.single.closingMinor, 1500000);
  });
  test(
    'mixed-role stable ID retains separate signed accounts and advances',
    () {
      final result = parse(
        page(
          accounts: [
            account('merchant', -100000, -50000),
            account('supplier', 3000000, -700000),
          ],
          entries: [
            row(1, payment('advance', amount: 50000), 'merchant', -50000),
            row(
              2,
              payment('paid', kind: 'supplier_payment', amount: 700000),
              'supplier',
              -700000,
            ),
          ],
        ),
      );
      expect(result.accounts.map((a) => [a.role, a.closingMinor]), [
        ['merchant', -150000],
        ['supplier', 2300000],
      ]);
      expect(result.rows.map((r) => r.partyEffectMinor), [-50000, -700000]);
    },
  );
  test('cross-page cross-year return and reversal resolve originals only when complete', () {
    final a = assembler();
    final controls = [account('merchant', 2000000, 0)];
    final first = page(
      accounts: controls,
      references: [
        row(1, invoice('original', date: '2027-08-31'), 'merchant', 2000000),
      ],
      from: 0,
      to: 1,
      total: 3,
    );
    a.addPage(first);
    expect(a.manifestSha256, 'a' * 64);
    expect(a.nextChunk, 1);
    expect(a.finish, rejects);
    a.addPage(
      page(
        accounts: controls,
        openings: [],
        entries: [
          row(
            2,
            invoice(
              'returned',
              kind: 'sale_return',
              total: 500000,
              qty: 2500,
              original: 'original',
            ),
            'merchant',
            -500000,
          ),
        ],
        from: 1,
        to: 2,
        total: 3,
      ),
    );
    a.addPage(
      page(
        accounts: controls,
        openings: [],
        reversals: [
          {'sequence': 3, 'entry': reversal('reverse_return', 'returned')},
          {
            'sequence': 4,
            'entry': reversal('other_party', 'unrelated_original'),
          },
        ],
        from: 2,
        to: 3,
        total: 3,
      ),
    );
    final result = a.finish();
    expect(result.references.single.entry.id, 'original');
    expect(result.rows.map((r) => [r.entry.id, r.partyEffectMinor]), [
      ['returned', -500000],
      ['reverse_return', 500000],
    ]);
    expect(result.accounts.single.closingMinor, 2000000);
  });
  test(
    'prior invoice reversal and current correction preserve separate dates',
    () {
      final corrected = {
        ...payment('corrected', amount: 10000),
        'originalBusinessDate': '2027-08-31',
        'correctionOfOperationId': 'offline_op',
      };
      final result = parse(
        page(
          accounts: [account('merchant', 2000000, -2010000)],
          references: [
            row(
              1,
              invoice('old_invoice', date: '2027-08-31'),
              'merchant',
              2000000,
            ),
          ],
          entries: [row(3, corrected, 'merchant', -10000)],
          reversals: [
            {
              'sequence': 2,
              'entry': reversal('reverse_invoice', 'old_invoice'),
            },
          ],
        ),
      );
      expect(result.rows.map((r) => r.entry.id), [
        'reverse_invoice',
        'corrected',
      ]);
      expect(result.accounts.single.closingMinor, -10000);
      expect(result.rows.last.entry.date, '2027-09-02');
      expect(result.rows.last.entry.originalBusinessDate, '2027-08-31');
      expect(result.rows.last.entry.correctionOfOperationId, 'offline_op');
    },
  );
  test(
    'zero activity retains signed baseline and not-found is explicitly empty',
    () {
      expect(
        parse(page(accounts: [account('merchant', -100000, 0)]))
            .accounts
            .single
            .closingMinor,
        -100000,
      );
      final missing = page(accounts: [], openings: [], to: 0, total: 20)
        ..['status'] = 'not_found'
        ..['nextChunk'] = null;
      final result = parse(missing);
      expect(result.found, false);
      expect(result.rows, isEmpty);
    },
  );
  test('repeated parsing changes neither source nor a synthetic queue and output is immutable', () {
    final source = page(
      entries: [row(2, payment('receipt'), 'merchant', -500000)],
    );
    final queue = [
      {
        'id': 'pending',
        'payload': {'paidMinor': 900},
        'attempts': 4,
        'retry': 123,
        'draft': 'محفوظ',
      },
    ];
    final before = canonicalJson({'source': source, 'queue': queue});
    for (var i = 0; i < 3; i++) {
      final a = assembler()..addPage(source);
      final result = a.finish();
      expect(identical(result, a.finish()), true);
      expect(() => result.rows.clear(), throwsUnsupportedError);
      expect(result.accounts.single.closingMinor, 1500000);
    }
    expect(canonicalJson({'source': source, 'queue': queue}), before);
  });
  test(
    'publication hash, scope, dates, checkpoint and role controls are pinned',
    () {
      final valid = page(
        entries: [row(2, payment('receipt'), 'merchant', -500000)],
      );
      for (final change in [
        {'tenantId': 'other'},
        {'partyId': 'other'},
        {'year': 2026},
        {'manifestSha256': 'bad'},
        {'startDate': '2027-08-31'},
        {'endDate': '2028-08-31'},
        {'timeZone': 'UTC'},
        {'closingSequence': -1},
        {'closingVersion': 0},
        {'closingSequence': 9007199254740992},
        {'closingSequence': -9223372036854775808},
        {'runId': '../bad'},
        {
          'accounts': [
            account('merchant', 2000000, -500000),
            account('merchant', 0, 0),
          ],
        },
        {
          'accounts': [account('cash', 2000000, -500000)],
        },
      ]) {
        final bad = copy(valid);
        bad['statement'] = {...bad['statement'] as Map, ...change};
        expect(() => parse(bad), rejects, reason: '$change');
      }
      final a = assembler()
        ..addPage(
          page(accounts: [account('merchant', 0, 0)], from: 0, to: 1, total: 2),
        );
      final replaced = page(
        accounts: [account('merchant', 0, 0)],
        openings: [],
        from: 1,
        to: 2,
        total: 2,
      );
      (replaced['statement'] as Map)['manifestSha256'] = 'b' * 64;
      expect(() => a.addPage(replaced), rejects);
      expect(a.finish, rejects);
    },
  );
  test(
    'full chunk coverage prevents skipped, repeated and inconsistent pages',
    () {
      for (final bad in [
        page(from: 1, to: 2, total: 2),
        page(to: 0, total: 2),
        page(to: 2, total: 1),
        {...page(), 'readOnly': false},
        {...page(), 'archived': false},
        {...page(), 'status': 'continue'},
        {...page(), 'nextChunk': 1},
      ]) {
        expect(() => parse(bad), rejects);
      }
      final a = assembler()
        ..addPage(
          page(accounts: [account('merchant', 0, 0)], from: 0, to: 1, total: 2),
        );
      expect(
        () => a.addPage(
          page(
            accounts: [account('merchant', 0, 0)],
            openings: [],
            from: 1,
            to: 3,
            total: 3,
          ),
        ),
        rejects,
      );
    },
  );
  test(
    'effects are computed independently and safe signed integers cannot wrap',
    () {
      final good = page(
        entries: [row(2, payment('receipt'), 'merchant', -500000)],
      );
      for (final field in ['partyEffectMinor', 'role', 'sequence']) {
        final bad = copy(good);
        final item = (bad['fragment'] as Map)['entries'][0] as Map;
        item[field] = field == 'role'
            ? 'supplier'
            : (field == 'sequence' ? 101 : -499999);
        expect(() => parse(bad), rejects);
      }
      for (final amount in [1.5, -1, 9007199254740992, -9223372036854775808]) {
        final bad = copy(good);
        ((bad['fragment'] as Map)['entries'][0]['entry'] as Map)['paidMinor'] =
            amount;
        expect(() => parse(bad), rejects);
      }
      final overflow = page(
        accounts: [
          {
            'role': 'merchant',
            'openingMinor': 9007199254740991,
            'periodMinor': 1,
            'closingMinor': -9007199254740991,
          },
        ],
      );
      expect(() => parse(overflow), rejects);
      final mismatch = copy(good);
      ((mismatch['statement'] as Map)['accounts'][0] as Map)['periodMinor'] =
          -499999;
      ((mismatch['statement'] as Map)['accounts'][0] as Map)['closingMinor'] =
          1500001;
      expect(() => parse(mismatch), rejects);
    },
  );
  test(
    'missing return original, wrong original role and duplicate reversal fail',
    () {
      final returned = invoice(
        'returned',
        kind: 'sale_return',
        total: 500000,
        qty: 2500,
        original: 'original',
      );
      final missing = page(entries: [row(2, returned, 'merchant', -500000)]);
      expect(() => parse(missing), rejects);
      final wrong = copy(missing);
      (wrong['fragment'] as Map)['references'] = [
        row(
          1,
          invoice('original', kind: 'purchase', date: '2027-08-31'),
          'supplier',
          2000000,
        ),
      ];
      expect(() => parse(wrong), rejects);
      final duplicate = page(
        accounts: [account('merchant', 2000000, -4000000)],
        references: [
          row(1, invoice('original', date: '2027-08-31'), 'merchant', 2000000),
        ],
        reversals: [
          {'sequence': 2, 'entry': reversal('r1', 'original')},
          {'sequence': 3, 'entry': reversal('r2', 'original')},
        ],
      );
      expect(() => parse(duplicate), rejects);
    },
  );
  test(
    'opening baselines required and original references are never reposted',
    () {
      final good = page(
        accounts: [account('merchant', 2000000, 0)],
        references: [
          row(1, invoice('original', date: '2027-08-31'), 'merchant', 2000000),
        ],
      );
      expect(parse(good).rows, isEmpty);
      expect(
        () => parse({
          ...good,
          'fragment': {...good['fragment'] as Map, 'openingBaselines': []},
        }),
        rejects,
      );
      final bad = copy(good);
      ((bad['fragment'] as Map)['openingBaselines'][0] as Map)['balanceMinor'] =
          123;
      expect(() => parse(bad), rejects);
    },
  );
  test('record and byte caps fail before exposing a partial statement', () {
    final tooMany = page(
      accounts: [account('merchant', 0, -204900)],
      entries: [
        for (var i = 1; i <= 2049; i++)
          row(i, payment('payment_$i', amount: 100), 'merchant', -100),
      ],
    );
    (tooMany['statement'] as Map)['closingSequence'] = 10000;
    expect(() => parse(tooMany), rejects);
    final oversized = page(
      entries: [
        row(
          1,
          {
            ...payment('large'),
            'note': 'x' * ArchiveStatementAssembler.maxPageBytes,
          },
          'merchant',
          -500000,
        ),
      ],
    );
    expect(() => parse(oversized), rejects);
  });
  test('reversing a prior return needs the return evidence, not a reposted prior invoice', () {
    final oldReturn = invoice(
      'old_return',
      kind: 'sale_return',
      date: '2027-08-31',
      total: 500000,
      qty: 2500,
      original: 'older_invoice',
    );
    final result = parse(
      page(
        accounts: [account('merchant', 1500000, 500000)],
        references: [row(1, oldReturn, 'merchant', -500000)],
        reversals: [
          {
            'sequence': 2,
            'entry': reversal('reverse_old_return', 'old_return'),
          },
        ],
      ),
    );
    expect(result.rows.single.partyEffectMinor, 500000);
    expect(result.accounts.single.closingMinor, 2000000);
    expect(result.references.single.entry.originalId, 'older_invoice');
  });
  test(
    'signed adjustment uses its one explicit role and exact bounded arithmetic',
    () {
      final adjustment = {
        ...payment('adjustment', amount: 75000),
        'kind': 'balance_adjustment',
        'paidMinor': 0,
        'adjustmentDirection': 'increase',
        'note': 'سبب موثق',
      };
      final result = parse(
        page(
          accounts: [account('supplier', -9007199254740991, 75000)],
          entries: [row(1, adjustment, 'supplier', 75000)],
        ),
      );
      expect(result.accounts.single.closingMinor, -9007199254665991);
      final ambiguous = page(
        accounts: [account('merchant', 0, 75000), account('supplier', 0, 0)],
        entries: [row(1, adjustment, 'merchant', 75000)],
      );
      expect(() => parse(ambiguous), rejects);
    },
  );
  test('forged reversal effect, reused identities and malformed references fail closed', () {
    final good = page(
      accounts: [account('merchant', 2000000, -2000000)],
      references: [
        row(1, invoice('old', date: '2027-08-31'), 'merchant', 2000000),
      ],
      reversals: [
        {'sequence': 2, 'entry': reversal('reverse', 'old')},
      ],
    );
    final forged = copy(good);
    ((forged['fragment'] as Map)['reversals'][0] as Map)['partyEffectMinor'] =
        1;
    expect(() => parse(forged), rejects);
    final duplicate = copy(good);
    ((duplicate['fragment'] as Map)['reversals'][0]['entry'] as Map)['id'] =
        'old';
    expect(() => parse(duplicate), rejects);
    final sequence = copy(good);
    ((sequence['fragment'] as Map)['reversals'][0] as Map)['sequence'] = 1;
    expect(() => parse(sequence), rejects);
    final wrongDate = copy(good);
    ((wrongDate['fragment'] as Map)['references'][0]['entry'] as Map)['date'] =
        '2027-09-01';
    expect(() => parse(wrongDate), rejects);
  });
  test('assembled record budget stops a long otherwise valid sequence of bounded pages', () {
    final a = assembler();
    final controls = [account('merchant', 0, -2000000)];
    Map<String, dynamic> make(int index) {
      final response = page(
        accounts: controls,
        openings: index == 0 ? null : [],
        from: index,
        to: index + 1,
        total: 21,
        entries: [
          for (var j = 0; j < 1000; j++)
            row(
              index * 1000 + j + 1,
              payment('bounded_${index}_$j', amount: 100),
              'merchant',
              -100,
            ),
        ],
      );
      (response['statement'] as Map)['closingSequence'] = 25000;
      return response;
    }

    for (var i = 0; i < 19; i++) {
      a.addPage(make(i));
    }
    expect(a.nextChunk, 19);
    expect(() => a.addPage(make(19)), rejects);
    expect(a.finish, rejects);
  });
}
