# Manual Android UI acceptance — final debug version 6

Passed on the running Android API 35 Google APIs x86_64 emulator (`emulator-5554`) using ADB, native accessibility dumps and screenshots. This was the installed main application, version `1.0.0` / code `6`, package `com.strawberrytrade.strawberry_trade`. No Flutter build, dependency command, generated file or app source was touched during this acceptance run.

Only the existing synthetic tenant was used. Airplane mode remained enabled. No financial save/submit button was tapped, and the Home screen still showed the same one operation waiting for the server before and after this run.

| Check | Actual result | Evidence |
| --- | --- | --- |
| English device, Arabic application | Android configuration was `[en_US]`, `ldltr`; application labels, navigation and form were Arabic RTL | `android-ui-manual-home.png`, `android-ui-manual-home.xml`, `android-ui-manual-environment.txt` |
| Native keyboard | Tapping expense amount opened the native numeric keyboard; captured input-method flags included `mInputShown=true` and `mIsInputViewShown=true` | `android-ui-manual-keyboard.png`, `android-ui-manual-keyboard-state.txt` |
| Back with keyboard open | Android Back hid the keyboard and kept the unfinished expense form and input visible | `android-ui-manual-before-rotation.png`, `android-ui-manual-before-rotation.xml` |
| Portrait to landscape | Amount `23.45`, note `AFT-ROTATE-12345`, and date `2026-10-19` remained unchanged; native hierarchy reported rotation `1` | `android-ui-manual-landscape.png`, `android-ui-manual-landscape.xml` |
| Landscape scrolling | Form could scroll to its note, checkbox and full local-save button; the save button was not pressed | `android-ui-manual-landscape-bottom.png`, `android-ui-manual-landscape-bottom.xml` |
| Return to portrait | Same three input values remained; native hierarchy reported rotation `0` | `android-ui-manual-restored-portrait.xml` |
| Back with keyboard hidden | Android Back returned to local Home and its original one queued operation | `android-ui-manual-back-home.xml` |
| Force-stop and offline restart | Force-stopped the process, launched the normal activity, reached cached Home, and found the unfinished expense under **مسودات لم تُحفظ كعمليات** at the bottom of Home | `android-ui-manual-reopened-home.xml`, `android-ui-manual-drafts-list.png`, `android-ui-manual-drafts-list.xml` |
| Restored draft values | Opening that saved draft restored exact amount `23.45`, note `AFT-ROTATE-12345`, and date `2026-10-19` | `android-ui-manual-draft-restored.png`, `android-ui-manual-draft-restored.xml` |
| Final device state | Restored original rotation settings (`accelerometer_rotation=1`, `user_rotation=0`), retained airplane mode, returned to Home top; same one queued operation | `android-ui-manual-final-home.png`, `android-ui-manual-final-home.xml`, `android-ui-manual-environment.txt` |

The draft is found on Home, not under More. The unfinished synthetic draft remains available for later review; no clearing of application data or uninstall was performed.

## Value comparison

Native accessibility dumps independently report the same editable values before rotation, in landscape, after returning to portrait, and after force-stop/reopening the saved draft:

```text
['2026-10-19', '23.45', 'AFT-ROTATE-12345']
```

A local XML assertion checked those four snapshots and confirmed exact amount/note equality. Separate assertions checked that Back and process restart both returned to Home with `1 عملية محفوظة في انتظار الخادم`.

The baseline above is the actual observed field text. Initial immediate ADB text injection occurred while the input connection was opening and did not deliver its first characters (`123.45` requested, `23.45` observed; `DRAFT-ROTATE-12345` requested, `AFT-ROTATE-12345` observed). The values were then explicitly read and captured before testing persistence. This run establishes retention of observed input; it does not establish that unsynchronized ADB key injection delivers every requested character or replace physical-device typing acceptance.

## Principal commands

All commands targeted only the test emulator. Screen coordinates came from the preceding native hierarchy. After taps/input, `uiautomator dump` and screenshots were used to observe settled UI rather than assuming navigation succeeded.

```sh
/home/younis/Android/Sdk/platform-tools/adb -s emulator-5554 shell dumpsys package com.strawberrytrade.strawberry_trade
/home/younis/Android/Sdk/platform-tools/adb -s emulator-5554 shell dumpsys activity activities
/home/younis/Android/Sdk/platform-tools/adb -s emulator-5554 shell cmd connectivity airplane-mode
/home/younis/Android/Sdk/platform-tools/adb -s emulator-5554 shell uiautomator dump /sdcard/window.xml
/home/younis/Android/Sdk/platform-tools/adb -s emulator-5554 shell screencap -p /sdcard/android-ui-manual-home.png
/home/younis/Android/Sdk/platform-tools/adb -s emulator-5554 shell input keyevent 4
/home/younis/Android/Sdk/platform-tools/adb -s emulator-5554 shell settings put system accelerometer_rotation 0
/home/younis/Android/Sdk/platform-tools/adb -s emulator-5554 shell settings put system user_rotation 1
/home/younis/Android/Sdk/platform-tools/adb -s emulator-5554 shell settings put system user_rotation 0
/home/younis/Android/Sdk/platform-tools/adb -s emulator-5554 shell settings put system accelerometer_rotation 1
/home/younis/Android/Sdk/platform-tools/adb -s emulator-5554 shell am force-stop com.strawberrytrade.strawberry_trade
/home/younis/Android/Sdk/platform-tools/adb -s emulator-5554 shell am start -n com.strawberrytrade.strawberry_trade/.MainActivity
```

The first native dump immediately after process launch returned a null root while the activity was starting. It was retried after startup; the saved reopened-Home snapshot and subsequent draft checks use the successful fresh dump. No pass result relies on that failed capture.

This run covers an emulator, one expense draft, keyboard visibility, Back, orientation and process restart. Physical phones, every form, full-device storage, Android cloud restore and production attestation are outside this manual acceptance result.
