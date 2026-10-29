import 'device_security.dart';

/// No short online lease. A known reference advances using elapsedRealtime within
/// a boot. Across boots a sane wall-clock delta is required; rollback fails closed.
class TrustedClockCheckpoint {
  const TrustedClockCheckpoint({
    required this.acceptedMs,
    required this.wallMs,
    required this.elapsedMs,
    required this.bootCount,
  });
  final int acceptedMs;
  final int wallMs;
  final int elapsedMs;
  final int bootCount;

  factory TrustedClockCheckpoint.fromJson(Map<String, dynamic> json) =>
      TrustedClockCheckpoint(
        acceptedMs: json['acceptedMs'] as int,
        wallMs: json['wallMs'] as int,
        elapsedMs: json['elapsedMs'] as int,
        bootCount: json['bootCount'] as int,
      );

  Map<String, int> toJson() => {
    'acceptedMs': acceptedMs,
    'wallMs': wallMs,
    'elapsedMs': elapsedMs,
    'bootCount': bootCount,
  };
}

class TrustedClockResult {
  const TrustedClockResult({
    required this.nowMs,
    required this.checkpoint,
    this.requiresTrustedTime = false,
    this.wallRollback = false,
  });
  final int nowMs;
  final TrustedClockCheckpoint checkpoint;
  final bool requiresTrustedTime;
  final bool wallRollback;
}

class TrustedClock {
  static const rollbackToleranceMs = 2000;

  static TrustedClockResult anchor(
    int signedServerTimeMs,
    ClockSample sample, {
    TrustedClockCheckpoint? previous,
    bool authenticatedFreshTime = false,
  }) {
    // A transferred package proves issuance, not freshness at receipt. The live
    // bootstrap uses a nonce-bound device proof and an authenticated response.
    if (previous == null) {
      final now = authenticatedFreshTime || signedServerTimeMs >= sample.wallMs
          ? signedServerTimeMs
          : sample.wallMs;
      return TrustedClockResult(
        nowMs: now,
        checkpoint: _checkpoint(now, sample),
      );
    }
    final current = advance(previous, sample);
    if (current.requiresTrustedTime && !authenticatedFreshTime) return current;
    if (current.requiresTrustedTime) {
      // A fresh authenticated response can repair the boot/wall baseline even
      // when a prior clock error put the high-water mark ahead of the server.
      // Never lower that mark or turn an expired timed entitlement active.
      final accepted = signedServerTimeMs > current.nowMs
          ? signedServerTimeMs
          : current.nowMs;
      return TrustedClockResult(
        nowMs: accepted,
        checkpoint: _checkpoint(accepted, sample),
      );
    }
    // Keep both the accepted time and expected wall baseline on reimport. Merely
    // signing again must never reset rollback evidence or restart the trial.
    if (signedServerTimeMs <= current.nowMs) return current;
    return TrustedClockResult(
      nowMs: signedServerTimeMs,
      checkpoint: _checkpoint(signedServerTimeMs, sample),
    );
  }

  static TrustedClockResult advance(
    TrustedClockCheckpoint previous,
    ClockSample sample,
  ) {
    final sameBoot =
        previous.bootCount >= 0 &&
        previous.bootCount == sample.bootCount &&
        sample.elapsedMs >= previous.elapsedMs;
    final wallDelta = sample.wallMs - previous.wallMs;
    if (sameBoot) {
      final now = previous.acceptedMs + sample.elapsedMs - previous.elapsedMs;
      final expectedWall =
          previous.wallMs + sample.elapsedMs - previous.elapsedMs;
      final checkpoint = TrustedClockCheckpoint(
        acceptedMs: now,
        wallMs: sample.wallMs > expectedWall ? sample.wallMs : expectedWall,
        elapsedMs: sample.elapsedMs,
        bootCount: sample.bootCount,
      );
      return TrustedClockResult(
        nowMs: now,
        checkpoint: checkpoint,
        wallRollback: wallDelta < -rollbackToleranceMs,
      );
    }
    if (wallDelta < -rollbackToleranceMs || sample.bootCount < 0) {
      return TrustedClockResult(
        nowMs: previous.acceptedMs,
        checkpoint: previous,
        requiresTrustedTime: true,
        wallRollback: true,
      );
    }
    final now = previous.acceptedMs + (wallDelta > 0 ? wallDelta : 0);
    return TrustedClockResult(nowMs: now, checkpoint: _checkpoint(now, sample));
  }

  static TrustedClockCheckpoint _checkpoint(int time, ClockSample sample) =>
      TrustedClockCheckpoint(
        acceptedMs: time,
        wallMs: sample.wallMs,
        elapsedMs: sample.elapsedMs,
        bootCount: sample.bootCount,
      );
}
