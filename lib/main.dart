import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'presentation/screens.dart';
import 'application/app_controller.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const ProviderScope(child: StrawberryApp()));
}

class StrawberryApp extends ConsumerWidget {
  const StrawberryApp({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final app = ref.watch(appProvider);
    return MaterialApp(
      // Replacing the account also replaces the navigation stack, including any
      // open statement, export, or form that belongs to the previous account.
      key: ValueKey((
        app.tenantId,
        app.uid,
        app.employeeId,
        app.manager,
        app.ready,
      )),
      title: 'دفتر الفراولة',
      debugShowCheckedModeBanner: false,
      locale: const Locale('ar'),
      supportedLocales: const [Locale('ar')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      theme: ThemeData(
        useMaterial3: true,
        fontFamily: 'NotoArabic',
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xff235b42),
          primary: const Color(0xff235b42),
          secondary: const Color(0xffb84f53),
        ),
        scaffoldBackgroundColor: const Color(0xfff7f8f4),
        appBarTheme: const AppBarTheme(
          backgroundColor: Color(0xfff7f8f4),
          foregroundColor: Color(0xff193f30),
          centerTitle: false,
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: Colors.white,
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 16,
            vertical: 15,
          ),
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            minimumSize: const Size(48, 52),
            textStyle: const TextStyle(
              fontFamily: 'NotoArabic',
              fontSize: 17,
              fontWeight: FontWeight.bold,
            ),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
            ),
          ),
        ),
        cardTheme: CardThemeData(
          elevation: 0,
          color: Colors.white,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(18),
            side: const BorderSide(color: Color(0xffe3e9df)),
          ),
        ),
      ),
      builder: (context, child) => Consumer(
        builder: (context, ref, _) {
          final app = ref.watch(appProvider);
          if (app.ready && !app.hasDataAccess) {
            return AccountLockedScreen(app: app);
          }
          return child ?? const SizedBox.shrink();
        },
      ),
      home: const AppShell(),
    );
  }
}
