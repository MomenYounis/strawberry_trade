"""Drive only the synthetic native gateway acceptance fixture; never send a file."""
import argparse
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--adb', default='adb')
parser.add_argument('--log', type=Path, required=True)
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
args.evidence.mkdir(parents=True, exist_ok=True)
shared = offline = False
for _ in range(600):
    log = args.log.read_text(errors='replace') if args.log.exists() else ''
    if not shared and 'ANDROID_PDF_SHARE_CHOOSER' in log:
        time.sleep(1)
        with (args.evidence / 'android-share-chooser.png').open('wb') as target:
            subprocess.run([args.adb, 'exec-out', 'screencap', '-p'], stdout=target, check=True)
        subprocess.run([args.adb, 'shell', 'input', 'keyevent', '4'], check=True)
        print('Captured and dismissed native PDF chooser; no recipient selected.', flush=True)
        shared = True
    if not offline and 'ANDROID_OFFLINE_SAVE_READY' in log:
        subprocess.run([args.adb, 'shell', 'cmd', 'connectivity', 'airplane-mode', 'enable'], check=True)
        subprocess.run([args.adb, 'shell', 'svc', 'wifi', 'disable'], check=True)
        print('Enabled airplane mode before the local save.', flush=True)
        offline = True
    if offline and 'ANDROID_OFFLINE_OPERATION_COMMITTED' in log:
        print('Observed the durable offline commit.', flush=True)
        break
    if 'Some tests failed' in log or 'No supported devices' in log:
        raise SystemExit('Native test failed; inspect its log.')
    time.sleep(1)
else:
    raise SystemExit('Timed out waiting for native fixture markers.')
