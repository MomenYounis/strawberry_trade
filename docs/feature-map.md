# Legacy function map

Acorn AST inventory of every function declaration, class method and anonymous callback in application-owned source. Generated web/index.html duplicates source/manager.html and is not counted twice. Vendored Firebase SDKs, inline data-library Chart.js, and test functions are dependency and verification code.

Inventory: **593 function nodes**, 286 named and 307 anonymous. Baseline rerun: 30 client assertions and 42 rules tests passed in isolated copies; rules/test source hashes match the original. The fresh rules emulator used separate ports and did not touch the Android acceptance backend. Mapping identifies implementation and intentional differences; it does not claim every legacy interaction passed Android acceptance.

## Functional status and intentional changes

| Capability | Flutter replacement / status | Verification boundary |
|---|---|---|
| Sales/purchases, collections/payments, operating/home expenses, returns, parties/opening balances | Native forms, fixed-point domain rules and SQLite outbox. Expense categories and invoice shipment metadata retained. | Domain/SQLite/widget tests plus gateway emulator validation; Android interaction evidence is separate. |
| Debt corrections and posted edits/deletion/undo | Documented immutable reversal and debt-only balance adjustment. Original financial records remain. | Dart and backend regression tests; concurrent immutable edits retain conflict. |
| Employee deliveries/purchases/returns/expenses | Own quantity-only requests plus manager financial review; directory names are preserved. | Employee feed excludes prices, balances/payroll; legacy own-purchase pricing is intentionally not downloaded or editable in this safer initial role projection. |
| Employee accounts | Verified existing UID, single-use invitation, native acceptance and membership enable/disable. | Emulator enrollment/ownership tests; creating passwords/real Auth users or reset-email sending inside manager app is intentionally replaced by trusted account setup. |
| Payroll and employee statements | Effective-dated salary terms, installment payments and native Arabic statement/PDF. | Known historical salary tests; missing legacy historical salary needs evidence, never inferred from current salary. |
| History, reports, statements, PDF/CSV, backups/recovery | Local queries, filters and exported documents; scoped backup/outbox restore including allowed preferences. | Real SQLite and export tests; device PDF/airplane/share/update tests must be listed in final acceptance evidence. |
| Dashboard charts | Native monthly net-sales, purchases and expense bars, expense-category comparison and accurately labelled cash metrics. | RecordedPeriod reference tests include dated reversals and returns; widget rendering is distinct from Android visual acceptance. |
| Monthly operating/home budget editing and forecast | Editable per-user/tenant SQLite targets, variance and explicitly estimated current-month forecast. | Scoped preference/widget tests; historical or future months have no manufactured forecast. |
| Existing shipment status editing | Dedicated native screen appends ordered, audited metadata events; invoice financial facts stay immutable. | Zero-financial-effect, tenant/role checks, active invoice/assignee, duplicate and concurrent-order gateway tests. |
| Destructive ledger reset / demo replacement | Removed from business UI; synthetic fixtures exist only in explicit emulator setup. | Intentional safety change; no production reset/migration was run. |
| Statement text-copy shortcut | Arabic statement text copied to clipboard plus native PDF sharing. | Known-ledger text tests; user chooses any external destination, no automatic message sending. |

The inventory below is a source-to-implementation map, not a claim that all legacy interactions or acceptance criteria are complete. Repeated callbacks/DOM helpers collapse into native widgets. Final executed backend and Android evidence is recorded in test-results.md; overlapping test subsets must not be summed.

## source/manager.html

| Existing function (source line) | Replacement | Verification / status |
|---|---|---|
| `getTodayISO` (1437) | Fixed integer parsing / formatting / newId in domain/ledger.dart | Dart Arabic/Persian/Western digit, precision and date tests. |
| `createDemoState` (1445) | Explicit emulator-only synthetic fixture helper | No automatic production data or Auth account creation. |
| `loadState` (1646) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `showStorageNotice` (1662) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `saveState` (1669) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `validISODate` (1680) | Fixed integer parsing / formatting / newId in domain/ledger.dart | Dart Arabic/Persian/Western digit, precision and date tests. |
| `normalizeTradeState` (1686) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `anonymous callback in normalizeTradeState` (1691) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `validateTradeFields` (1695) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `validateLedgerState` (1717) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `fail` (1718) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `safeId` (1720) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `number` (1721) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `anonymous callback in validateLedgerState` (1729) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `anonymous callback in validateLedgerState` (1730) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `anonymous callback in validateLedgerState` (1750) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `anonymous callback in validateLedgerState` (1753) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `keepRecoverySnapshot` (1764) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `recoverPreviousState` (1774) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `undoLastDeletion` (1790) | Immutable reversal entry and audit | Deletion/undo replaced by correction history; original records retained. |
| `anonymous callback in undoLastDeletion` (1792) | Immutable reversal entry and audit | Deletion/undo replaced by correction history; original records retained. |
| `formatCurrency` (1802) | Fixed integer parsing / formatting / newId in domain/ledger.dart | Dart Arabic/Persian/Western digit, precision and date tests. |
| `showToast` (1807) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in showToast` (1815) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in showToast` (1817) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `roundCurrency` (1824) | Fixed integer parsing / formatting / newId in domain/ledger.dart | Dart Arabic/Persian/Western digit, precision and date tests. |
| `roundQuantity` (1830) | Fixed integer parsing / formatting / newId in domain/ledger.dart | Dart Arabic/Persian/Western digit, precision and date tests. |
| `createEntryId` (1834) | Fixed integer parsing / formatting / newId in domain/ledger.dart | Dart Arabic/Persian/Western digit, precision and date tests. |
| `getReturnableQuantity` (1840) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in getReturnableQuantity` (1841) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in getReturnableQuantity` (1843) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `getReturnAmount` (1848) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in getReturnAmount` (1850) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in getReturnAmount` (1851) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in getReturnAmount` (1852) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `computeMerchantStats` (1860) | LedgerRules.statement / metrics / payrollBalance | Known-ledger Dart reference tests; accurate financial labels. |
| `anonymous callback in computeMerchantStats` (1861) | LedgerRules.statement / metrics / payrollBalance | Known-ledger Dart reference tests; accurate financial labels. |
| `computeSupplierStats` (1883) | LedgerRules.statement / metrics / payrollBalance | Known-ledger Dart reference tests; accurate financial labels. |
| `anonymous callback in computeSupplierStats` (1884) | LedgerRules.statement / metrics / payrollBalance | Known-ledger Dart reference tests; accurate financial labels. |
| `computeGlobalMetrics` (1906) | LedgerRules.statement / metrics / payrollBalance | Known-ledger Dart reference tests; accurate financial labels. |
| `anonymous callback in computeGlobalMetrics` (1939) | LedgerRules.statement / metrics / payrollBalance | Known-ledger Dart reference tests; accurate financial labels. |
| `anonymous callback in computeGlobalMetrics` (1956) | LedgerRules.statement / metrics / payrollBalance | Known-ledger Dart reference tests; accurate financial labels. |
| `switchTab` (1965) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `renderAll` (2000) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `renderDashboardView` (2036) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in renderDashboardView` (2057) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in renderDashboardView` (2058) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in renderDashboardView` (2059) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in renderDashboardView` (2064) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in renderDashboardView` (2083) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in renderDashboardView` (2084) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in renderDashboardView` (2089) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in renderDashboardView` (2108) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in renderDashboardView` (2109) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in renderDashboardView` (2114) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `renderCharts` (2136) | BudgetAndCharts / RecordedPeriod in presentation/reports_extra.dart | Native monthly net-sales, purchases and expense bars plus expense categories; dated returns and reversals included. Host reference/widget tests; Android visual evidence is separate. |
| `anonymous callback in renderCharts` (2140) | BudgetAndCharts / RecordedPeriod in presentation/reports_extra.dart | Native monthly net-sales, purchases and expense bars plus expense categories; dated returns and reversals included. Host reference/widget tests; Android visual evidence is separate. |
| `anonymous callback in renderCharts` (2141) | BudgetAndCharts / RecordedPeriod in presentation/reports_extra.dart | Native monthly net-sales, purchases and expense bars plus expense categories; dated returns and reversals included. Host reference/widget tests; Android visual evidence is separate. |
| `anonymous callback in renderCharts` (2142) | BudgetAndCharts / RecordedPeriod in presentation/reports_extra.dart | Native monthly net-sales, purchases and expense bars plus expense categories; dated returns and reversals included. Host reference/widget tests; Android visual evidence is separate. |
| `getBusinessExpenseCategory` (2222) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in getBusinessExpenseCategory` (2225) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `renderExpensesView` (2228) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in renderExpensesView` (2243) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in renderExpensesView` (2245) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in renderExpensesView` (2250) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in renderExpensesView` (2250) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in renderExpensesView` (2251) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `filterExpensesByCategory` (2257) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `resetExpenseFilters` (2262) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `saveBusinessBudget` (2268) | BudgetAndCharts / scoped SQLite budget preferences | Editable monthly operating/home targets and explicitly estimated current-month forecast; historical months do not fabricate a forecast. SQLite/widget tests; no actual-profit claim. |
| `openExpenseModal` (2275) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in openExpenseModal` (2277) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in openExpenseModal` (2277) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `handleSaveExpense` (2284) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in handleSaveExpense` (2290) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `renderMerchantsView` (2298) | PartyPicker / AccountsScreen / Party / statement | Searchable local directory, server validates tenant relationship. |
| `anonymous callback in renderMerchantsView` (2307) | PartyPicker / AccountsScreen / Party / statement | Searchable local directory, server validates tenant relationship. |
| `anonymous callback in renderMerchantsView` (2310) | PartyPicker / AccountsScreen / Party / statement | Searchable local directory, server validates tenant relationship. |
| `anonymous callback in renderMerchantsView` (2323) | PartyPicker / AccountsScreen / Party / statement | Searchable local directory, server validates tenant relationship. |
| `renderSuppliersView` (2380) | PartyPicker / AccountsScreen / Party / statement | Searchable local directory, server validates tenant relationship. |
| `anonymous callback in renderSuppliersView` (2389) | PartyPicker / AccountsScreen / Party / statement | Searchable local directory, server validates tenant relationship. |
| `anonymous callback in renderSuppliersView` (2392) | PartyPicker / AccountsScreen / Party / statement | Searchable local directory, server validates tenant relationship. |
| `anonymous callback in renderSuppliersView` (2405) | PartyPicker / AccountsScreen / Party / statement | Searchable local directory, server validates tenant relationship. |
| `validPayrollMonth` (2465) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `getEmployeeName` (2469) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in getEmployeeName` (2470) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `populateEmployeeSelect` (2474) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in populateEmployeeSelect` (2477) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in populateEmployeeSelect` (2478) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in populateEmployeeSelect` (2479) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `getEmployeePayrollStats` (2482) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `anonymous callback in getEmployeePayrollStats` (2483) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `anonymous callback in getEmployeePayrollStats` (2485) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `anonymous callback in getEmployeePayrollStats` (2486) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `renderEmployeesView` (2491) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderEmployeesView` (2497) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderEmployeesView` (2498) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderEmployeesView` (2500) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderEmployeesView` (2501) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderEmployeesView` (2505) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderEmployeesView` (2508) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderEmployeesView` (2511) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderEmployeesView` (2528) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderEmployeesView` (2529) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderEmployeesView` (2529) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderEmployeesView` (2530) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `openEmployeeModal` (2536) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in openEmployeeModal` (2537) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `handleSaveEmployee` (2547) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in handleSaveEmployee` (2560) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `toggleEmployeeActive` (2568) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in toggleEmployeeActive` (2569) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `openSalaryModal` (2576) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `updateSalaryBalanceHint` (2589) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `handleSaveSalary` (2601) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `anonymous callback in handleSaveSalary` (2604) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `getEmployeeStatementData` (2624) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `anonymous callback in getEmployeeStatementData` (2625) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `inRange` (2635) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `order` (2648) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `sum` (2650) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `anonymous callback in sum` (2650) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `openEmployeeStatementModal` (2660) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `anonymous callback in openEmployeeStatementModal` (2661) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `refreshEmployeeStatement` (2671) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `section` (2692) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `anonymous callback in section` (2692) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in refreshEmployeeStatement` (2699) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `anonymous callback in refreshEmployeeStatement` (2703) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `downloadEmployeeStatementPdf` (2716) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `shareEmployeeStatementPdf` (2722) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `buildEmployeeStatementPdf` (2736) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `anonymous callback in buildEmployeeStatementPdf` (2736) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `font` (2743) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `text` (2744) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `fit` (2745) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `wrap` (2746) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `paragraph` (2760) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `box` (2761) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `startPage` (2762) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `finishPage` (2780) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `anonymous callback in finishPage` (2784) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `sectionHeader` (2788) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `anonymous callback in buildEmployeeStatementPdf` (2804) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `anonymous callback in buildEmployeeStatementPdf` (2804) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `anonymous callback in buildEmployeeStatementPdf` (2814) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `anonymous callback in buildEmployeeStatementPdf` (2818) | SalaryTerm / LedgerRules.payroll / ArabicExports | Historical terms immutable; missing salary evidence rejected by server. |
| `renderLedgerView` (2829) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in renderLedgerView` (2836) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in renderLedgerView` (2859) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `getPartyNameForTx` (2893) | PartyPicker / AccountsScreen / Party / statement | Searchable local directory, server validates tenant relationship. |
| `anonymous callback in getPartyNameForTx` (2896) | PartyPicker / AccountsScreen / Party / statement | Searchable local directory, server validates tenant relationship. |
| `anonymous callback in getPartyNameForTx` (2900) | PartyPicker / AccountsScreen / Party / statement | Searchable local directory, server validates tenant relationship. |
| `describeTransaction` (2906) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in describeTransaction` (2910) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `openModal` (3003) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in openModal` (3013) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `closeModal` (3018) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `shippingStatusLabel` (3032) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `getShipmentInfo` (3036) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `anonymous callback in getShipmentInfo` (3038) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `anonymous callback in getShipmentInfo` (3043) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `getShipmentSummary` (3049) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `renderShipmentTag` (3056) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `populateShippingEmployeeFilter` (3063) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `anonymous callback in populateShippingEmployeeFilter` (3067) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `matchesShippingEmployeeFilter` (3072) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `resetShippingFields` (3078) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `readShippingFields` (3086) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `anonymous callback in readShippingFields` (3093) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `openShipmentModal` (3101) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `anonymous callback in openShipmentModal` (3102) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `anonymous callback in openShipmentModal` (3109) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `handleSaveShipment` (3114) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `anonymous callback in handleSaveShipment` (3116) | ShipmentEditor / append-only shipment_update / trusted shipmentCounters | Post-entry metadata updates retain original invoice finances. Ordered audited events, manager-only authorization and concurrent-order conflict tested in gateway emulator. |
| `openSaleModal` (3130) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `recalcSaleModal` (3145) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `setSalePaidFull` (3156) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `setSalePaidZero` (3163) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `handleSaveSale` (3168) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in handleSaveSale` (3170) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in handleSaveSale` (3192) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `openPurchaseModal` (3226) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `recalcPurchaseModal` (3241) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `setPurchasePaidFull` (3252) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `setPurchasePaidZero` (3259) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `handleSavePurchase` (3264) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in handleSavePurchase` (3266) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in handleSavePurchase` (3288) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `toggleInlinePartyInput` (3321) | PartyPicker / AccountsScreen / Party / statement | Searchable local directory, server validates tenant relationship. |
| `populatePartyDropdown` (3337) | PartyPicker / AccountsScreen / Party / statement | Searchable local directory, server validates tenant relationship. |
| `anonymous callback in populatePartyDropdown` (3344) | PartyPicker / AccountsScreen / Party / statement | Searchable local directory, server validates tenant relationship. |
| `openReturnModal` (3348) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `openReturnForTransaction` (3355) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in openReturnForTransaction` (3356) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `setReturnKind` (3361) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in setReturnKind` (3371) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in setReturnKind` (3371) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in setReturnKind` (3373) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in setReturnKind` (3374) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `populateReturnOriginals` (3379) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in populateReturnOriginals` (3382) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in populateReturnOriginals` (3384) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in populateReturnOriginals` (3385) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `updateReturnDetails` (3389) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in updateReturnDetails` (3390) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `setReturnFullQuantity` (3406) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `recalcReturnModal` (3412) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in recalcReturnModal` (3413) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `handleSaveReturn` (3423) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `anonymous callback in handleSaveReturn` (3426) | LedgerRules.returnTotal / EntryForm / atomic returnCounters | Cumulative rounding, original unit/grade and overshoot tests. |
| `openQuickPaymentModal` (3466) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `openMerchantPaymentModal` (3474) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `openSupplierPaymentModal` (3482) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `setPaymentDirection` (3490) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `updatePaymentPartyBalanceHint` (3513) | Fixed integer parsing / formatting / newId in domain/ledger.dart | Dart Arabic/Persian/Western digit, precision and date tests. |
| `handleSavePayment` (3532) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in handleSavePayment` (3540) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `openAddPartyModal` (3563) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `handleSaveParty` (3581) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `statementMoney` (3615) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `statementRound` (3616) | Fixed integer parsing / formatting / newId in domain/ledger.dart | Dart Arabic/Persian/Western digit, precision and date tests. |
| `statementBalanceLabel` (3618) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `getStatementData` (3624) | LedgerRules.statement / metrics / payrollBalance | Known-ledger Dart reference tests; accurate financial labels. |
| `anonymous callback in getStatementData` (3626) | LedgerRules.statement / metrics / payrollBalance | Known-ledger Dart reference tests; accurate financial labels. |
| `anonymous callback in getStatementData` (3632) | LedgerRules.statement / metrics / payrollBalance | Known-ledger Dart reference tests; accurate financial labels. |
| `anonymous callback in getStatementData` (3632) | LedgerRules.statement / metrics / payrollBalance | Known-ledger Dart reference tests; accurate financial labels. |
| `anonymous callback in getStatementData` (3633) | LedgerRules.statement / metrics / payrollBalance | Known-ledger Dart reference tests; accurate financial labels. |
| `anonymous callback in getStatementData` (3658) | LedgerRules.statement / metrics / payrollBalance | Known-ledger Dart reference tests; accurate financial labels. |
| `openStatementModal` (3671) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `resetStatementDates` (3679) | Fixed integer parsing / formatting / newId in domain/ledger.dart | Dart Arabic/Persian/Western digit, precision and date tests. |
| `refreshStatement` (3685) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in refreshStatement` (3714) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in refreshStatement` (3719) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in refreshStatement` (3723) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `downloadStatementPdf` (3737) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `saveStatementPdfFile` (3743) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `anonymous callback in saveStatementPdfFile` (3748) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `shareStatementPdf` (3751) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `copyStatementForWhatsApp` (3767) | buildStatementText / statement clipboard action / native PDF sharing | Arabic statement copy is user initiated; no automatic messages or external send. Known-ledger text reference tests; device interaction evidence is separate. |
| `anonymous callback in copyStatementForWhatsApp` (3774) | buildStatementText / statement clipboard action / native PDF sharing | Arabic statement copy is user initiated; no automatic messages or external send. Known-ledger text reference tests; device interaction evidence is separate. |
| `anonymous callback in copyStatementForWhatsApp` (3774) | buildStatementText / statement clipboard action / native PDF sharing | Arabic statement copy is user initiated; no automatic messages or external send. Known-ledger text reference tests; device interaction evidence is separate. |
| `copyStatementFallback` (3778) | buildStatementText / statement clipboard action / native PDF sharing | Arabic statement copy is user initiated; no automatic messages or external send. Known-ledger text reference tests; device interaction evidence is separate. |
| `buildStatementPdf` (3790) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `anonymous callback in buildStatementPdf` (3790) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `font` (3797) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `text` (3798) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `fitText` (3799) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `wrap` (3804) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `drawWrapped` (3824) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `anonymous callback in drawWrapped` (3826) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `drawSummaryBox` (3829) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `tableHeader` (3834) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `startPage` (3844) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `finishPage` (3863) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `anonymous callback in finishPage` (3867) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in buildStatementPdf` (3889) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `anonymous callback in buildStatementPdf` (3902) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `statementImagesToPdf` (3915) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `add` (3918) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `object` (3919) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `anonymous callback in statementImagesToPdf` (3926) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `anonymous callback in statementImagesToPdf` (3927) | ArabicExports PDF / native share / statements | Bundled Arabic fonts; Android PDF/share acceptance recorded separately. |
| `copyTextToClipboard` (3942) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in copyTextToClipboard` (3944) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `fallbackCopy` (3950) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `deleteTransaction` (3964) | Immutable reversal entry and audit | Deletion/undo replaced by correction history; original records retained. |
| `anonymous callback in deleteTransaction` (3965) | Immutable reversal entry and audit | Deletion/undo replaced by correction history; original records retained. |
| `anonymous callback in deleteTransaction` (3969) | Immutable reversal entry and audit | Deletion/undo replaced by correction history; original records retained. |
| `anonymous callback in deleteTransaction` (3972) | Immutable reversal entry and audit | Deletion/undo replaced by correction history; original records retained. |
| `openBackupModal` (3979) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `openConfirmClearModal` (3983) | Append-only financial history; no destructive reset button | Intentional security change: operational clearing/demo replacement removed; isolated emulator fixtures only. |
| `clearAllDataToZero` (3987) | Append-only financial history; no destructive reset button | Intentional security change: operational clearing/demo replacement removed; isolated emulator fixtures only. |
| `resetToDemoData` (4004) | Append-only financial history; no destructive reset button | Intentional security change: operational clearing/demo replacement removed; isolated emulator fixtures only. |
| `downloadBackupJSON` (4014) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `handleRestoreBackupFile` (4028) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `anonymous callback in handleRestoreBackupFile` (4034) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `anonymous callback in handleRestoreBackupFile` (4045) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `exportTransactionsCSV` (4049) | ArabicExports.csv | CSV quoting and spreadsheet-formula prefix protection. |
| `anonymous callback in exportTransactionsCSV` (4077) | ArabicExports.csv | CSV quoting and spreadsheet-formula prefix protection. |
| `anonymous callback in exportTransactionsCSV` (4077) | ArabicExports.csv | CSV quoting and spreadsheet-formula prefix protection. |
| `escapeHtml` (4090) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in module` (4102) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in module` (4103) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in module` (4107) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |
| `anonymous callback in module` (4113) | presentation/screens.dart widgets / AppController / domain/ledger.dart | DOM helper consolidated into widgets; code mapping is not an Android interaction pass. |

## web/core.js

| Existing function (source line) | Replacement | Verification / status |
|---|---|---|
| `round` (4) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |
| `isoDate` (5) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |
| `clean` (6) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |
| `same` (7) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |
| `stable` (7) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |
| `anonymous callback in stable` (7) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |
| `directoryRecord` (8) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |
| `emptyState` (9) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |
| `stateRecords` (10) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |
| `stateFromMaps` (11) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |
| `anonymous callback in stateFromMaps` (11) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |
| `validateSubmission` (12) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |
| `anonymous callback in validateSubmission` (18) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |
| `canonicalFromSubmission` (22) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |
| `submissionSummary` (40) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |
| `kindLabel` (41) | domain/ledger.dart / backend validation.mjs | Integer financial reference tests and employee projection tests. |

## web/cache.js

| Existing function (source line) | Replacement | Verification / status |
|---|---|---|
| `name` (1) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `open` (2) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `anonymous callback in open` (2) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `anonymous callback in open` (2) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `anonymous callback in open` (2) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `anonymous callback in open` (2) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `loadRecordCache` (3) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `anonymous callback in loadRecordCache` (3) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `anonymous callback in loadRecordCache` (3) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `anonymous callback in loadRecordCache` (3) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `anonymous callback in loadRecordCache` (3) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `saveRecordCache` (4) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `anonymous callback in saveRecordCache` (4) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `anonymous callback in saveRecordCache` (4) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `anonymous callback in saveRecordCache` (4) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `clearRecordCache` (5) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `anonymous callback in clearRecordCache` (5) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `anonymous callback in clearRecordCache` (5) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |
| `anonymous callback in clearRecordCache` (5) | LedgerStore SQLite persistence | Actual disk transaction, close/reopen, migration tests. |

## web/sync.js

| Existing function (source line) | Replacement | Verification / status |
|---|---|---|
| `newId` (4) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `validReturn` (5) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `constructor` (7) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `start` (8) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in start` (10) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in start` (10) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in start` (10) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in start` (11) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in start` (11) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `stop` (13) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in stop` (13) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `persist` (14) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `status` (15) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in status` (15) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in status` (15) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `apply` (16) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `save` (17) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in save` (17) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `flush` (18) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in flush` (18) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in flush` (18) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `commit` (19) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in commit` (19) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in commit` (31) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `approve` (41) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `reject` (47) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in reject` (47) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `retry` (48) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in retry` (48) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `discard` (49) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in discard` (49) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `staffRecords` (50) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `saveStaffRecord` (51) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in saveStaffRecord` (51) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `acknowledgeStaffRecord` (52) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in acknowledgeStaffRecord` (52) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in acknowledgeStaffRecord` (52) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `sendStaffRecord` (53) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in sendStaffRecord` (53) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `anonymous callback in sendStaffRecord` (53) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `writeStaffRecord` (54) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |
| `submit` (55) | AppController.synchronize / LedgerStore outbox / syncOperation | Emulator duplicate sends, atomic approval/return limits, conflicts; SQLite queue persistence. |

## web/cloud.js

| Existing function (source line) | Replacement | Verification / status |
|---|---|---|
| `$` (8) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `esc` (8) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in esc` (8) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `show` (12) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `error` (12) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `hideWork` (13) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `stop` (14) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in stop` (14) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in stop` (14) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `nowISO` (15) | Fixed integer parsing / formatting / newId in domain/ledger.dart | Dart Arabic/Persian/Western digit, precision and date tests. |
| `bind` (16) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `status` (17) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `renderOutbox` (18) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in renderOutbox` (18) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `download` (19) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in download` (19) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `clearUserCache` (20) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `scheduleAccount` (21) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in scheduleAccount` (21) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in scheduleAccount` (21) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `startAccount` (22) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `isCurrent` (22) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in startAccount` (32) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in startAccount` (32) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in startAccount` (32) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `staffChange` (34) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `state` (34) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `listenRequests` (39) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in listenRequests` (39) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in listenRequests` (39) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in listenRequests` (39) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `startManager` (41) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in startManager` (41) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `getEmployees` (42) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `hasPending` (42) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `onChange` (42) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `startStaff` (45) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in startStaff` (45) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in startStaff` (45) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in startStaff` (45) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in startStaff` (45) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in startStaff` (45) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in startStaff` (45) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `refreshStaffFields` (46) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in refreshStaffFields` (46) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in refreshStaffFields` (46) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in refreshStaffFields` (46) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in refreshStaffFields` (46) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `staffPayload` (47) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `submitStaff` (48) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in submitStaff` (48) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in submitStaff` (48) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `staffRecordExists` (49) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in staffRecordExists` (49) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `recoverStaffOperations` (50) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `retryFailed` (51) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in retryFailed` (51) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in retryFailed` (51) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in retryFailed` (51) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `failedStaffRecords` (52) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in failedStaffRecords` (52) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in failedStaffRecords` (52) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `staffStatus` (53) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in staffStatus` (53) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in staffStatus` (53) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `renderStaffHistory` (54) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderStaffHistory` (54) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderStaffHistory` (54) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderStaffHistory` (54) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderStaffHistory` (54) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderStaffHistory` (54) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `renderReviews` (55) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in renderReviews` (55) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `openReview` (56) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in openReview` (56) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in openReview` (56) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in openReview` (56) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in openReview` (56) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `decide` (57) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in decide` (57) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `decorateManager` (59) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `decorateEmployeeAccounts` (60) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in decorateEmployeeAccounts` (63) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in decorateEmployeeAccounts` (64) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `anonymous callback in decorateEmployeeAccounts` (64) | EmployeeSubmission / ReviewScreen / saveReview / review gateway | Atomic approval and immutable creator tested in emulator; employee data sanitized. |
| `renderAccountOptions` (66) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in renderAccountOptions` (67) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in renderAccountOptions` (68) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in renderAccountOptions` (69) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in renderAccountOptions` (70) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `renderAccounts` (72) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in renderAccounts` (79) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `openAccounts` (81) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `accountAction` (86) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `decorateInvoices` (88) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in decorateInvoices` (88) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in decorateInvoices` (88) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in decorateInvoices` (88) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `openEditor` (89) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in openEditor` (89) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `saveEditor` (90) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in saveEditor` (90) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `anonymous callback in saveEditor` (90) | EntryForm / AppController saves / LedgerStore transaction | Local success only after commit; failed form remains, SQLite/widget tests. |
| `importBackup` (91) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `anonymous callback in importBackup` (91) | LedgerStore.exportBackup / restoreBackup / strict domain rules | SQLite backup roundtrip includes pending queue; legacy quarantine migration prepared. |
| `pendingForExit` (92) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `downloadPendingExit` (93) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `logout` (94) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in logout` (94) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `boot` (95) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (97) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (98) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (98) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (98) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (98) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (98) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (98) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (98) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (98) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (98) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (98) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (98) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (98) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (99) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (99) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (99) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (99) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (101) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (101) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (101) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (101) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (101) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (101) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (101) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (101) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (102) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (102) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (102) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |
| `anonymous callback in boot` (102) | SetupScreen / AppController / FirebaseGateway / SyncScreen | Device proof, trusted setup, role feeds and durable outbox replace web session glue. |

## web/accounts.js

| Existing function (source line) | Replacement | Verification / status |
|---|---|---|
| `identifier` (11) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `validName` (13) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `emailAddress` (14) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `accountError` (21) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `safeError` (26) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `randomIndex` (41) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `hiddenPassword` (47) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `jobId` (60) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in jobId` (60) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `constructor` (64) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in constructor` (82) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `state` (85) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in state` (87) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_notify` (95) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_assertOpen` (100) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_pending` (106) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_assertReady` (111) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_guard` (118) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_run` (127) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in _run` (140) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_readJob` (163) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_writeJob` (180) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_removeJob` (192) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_ownedJob` (201) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_employee` (208) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_memberTarget` (217) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_upsert` (224) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in _upsert` (225) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in _upsert` (226) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `load` (229) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in load` (230) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in load` (235) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in load` (236) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in load` (237) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `create` (241) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in create` (242) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in create` (251) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `resume` (265) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in resume` (266) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_openSecondary` (274) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in _openSecondary` (277) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in _openSecondary` (278) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_authUID` (306) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `remember` (316) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in _authUID` (327) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_resumeJob` (345) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_linkJob` (361) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in _linkJob` (363) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `setActive` (393) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in setActive` (394) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in setActive` (397) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `resetEmail` (427) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in resetEmail` (428) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_releaseSecondary` (446) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in _releaseSecondary` (450) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in _releaseSecondary` (457) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `cleanup` (461) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in cleanup` (468) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in cleanup` (469) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in cleanup` (471) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in cleanup` (472) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in cleanup` (475) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in cleanup` (480) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `_finishCleanup` (484) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `finish` (485) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |
| `anonymous callback in _finishCleanup` (496) | Trusted invitations / acceptInvitation / setMemberActive | Browser secondary Auth account creation retired; native invitation creation/acceptance/disable UI implemented; real-device acceptance remains to verify. |

## web/sw.js

| Existing function (source line) | Replacement | Verification / status |
|---|---|---|
| `anonymous callback in module` (1) | Packaged Flutter assets and SQLite | Service worker retired; disk durability tested. |
| `anonymous callback in module` (1) | Packaged Flutter assets and SQLite | Service worker retired; disk durability tested. |
| `anonymous callback in module` (1) | Packaged Flutter assets and SQLite | Service worker retired; disk durability tested. |
| `anonymous callback in module` (1) | Packaged Flutter assets and SQLite | Service worker retired; disk durability tested. |
| `anonymous callback in module` (1) | Packaged Flutter assets and SQLite | Service worker retired; disk durability tested. |
| `anonymous callback in module` (1) | Packaged Flutter assets and SQLite | Service worker retired; disk durability tested. |
| `anonymous callback in module` (1) | Packaged Flutter assets and SQLite | Service worker retired; disk durability tested. |
| `anonymous callback in module` (1) | Packaged Flutter assets and SQLite | Service worker retired; disk durability tested. |
| `anonymous callback in module` (1) | Packaged Flutter assets and SQLite | Service worker retired; disk durability tested. |

## build.mjs

| Existing function (source line) | Replacement | Verification / status |
|---|---|---|

## backend/scripts/provision-member.mjs

| Existing function (source line) | Replacement | Verification / status |
|---|---|---|
| `cliFirestore` (13) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |
| `decode` (18) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |
| `decodeFields` (29) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |
| `anonymous callback in decodeFields` (29) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |
| `encode` (30) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |
| `anonymous callback in encode` (37) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |
| `doc` (41) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |
| `get` (42) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |
| `data` (43) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |
| `batch` (47) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |
| `set` (50) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |
| `commit` (58) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |
| `parseOptions` (64) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |
| `provision` (92) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |
| `getAccessToken` (105) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |
| `serverTime` (115) | Trusted provisionTenant / issueEmployeeInvitation | Emulator: verified UID required, no unverified promotion. |

