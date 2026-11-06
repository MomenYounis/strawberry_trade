#!/usr/bin/env python3
"""Persist one guarded synthetic native drive across chat/tool interruptions."""
import argparse
import datetime
import fcntl
import importlib.util
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'verification/continuation-2026-11-02/native-durable'
DRIVER = ROOT / 'tools/annual-review/native-commercial-device.py'
# The gate is read before the fixed driver is executed. Parent death before
# publication closes the pipe; that child exits without making any ADB call.
GATED_EXEC = '''import os,sys
lock_fd,gate_fd=int(sys.argv[1]),int(sys.argv[2])
os.set_inheritable(lock_fd,True)
allowed=os.read(gate_fd,1)
os.close(gate_fd)
if allowed!=b'G':sys.exit(125)
os.execv(sys.executable,[sys.executable,*sys.argv[3:]])
'''


def per_device_lock(jobs, device):
    path = jobs / (device + '.lock')
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError('ordinary-owned-device-lock-required')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('this-device-already-has-a-running-drive') from None
        return fd
    except BaseException:
        os.close(fd)
        raise


def publish_receipt(path, record):
    """Publish a complete fsynced receipt atomically without replacing evidence."""
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(json.dumps(record, indent=2) + '\n')
            output.flush()
            os.fsync(output.fileno())
        # link creates the final name atomically and refuses an existing name.
        os.link(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.unlink(temporary)


def start_gated_drive(command, record, receipt, log, lock_fd):
    gate_read, gate_write = os.pipe2(os.O_CLOEXEC)
    child = None
    try:
        child = subprocess.Popen(
            [sys.executable, '-c', GATED_EXEC, str(lock_fd), str(gate_read), *command[1:]],
            cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=True, pass_fds=(lock_fd, gate_read))
        os.close(gate_read)
        gate_read = None
        record['pid'] = child.pid
        publish_receipt(receipt, record)
        # A child can only execute the fixed helper after its PID and complete
        # command have been published. Failure/parent death closes this gate.
        os.write(gate_write, b'G')
        return child
    except BaseException:
        os.close(gate_write)
        gate_write = None
        if child is not None:
            # The unopened gate guarantees that this process has not run the
            # device helper. Reap it after EOF rather than leaving a zombie.
            child.wait(timeout=5)
        raise
    finally:
        if gate_read is not None:
            os.close(gate_read)
        if gate_write is not None:
            os.close(gate_write)



def legacy_drive_is_running(prior, device, proc_root=pathlib.Path('/proc')):
    """Ignore unrelated job metadata; only match the fixed historical driver."""
    if (not isinstance(prior, dict) or prior.get('device') != device
            or not isinstance(prior.get('label'), str)
            or not re.fullmatch('[a-z0-9-]+', prior['label'])
            or type(prior.get('pid')) is not int or prior['pid'] <= 0
            or not isinstance(prior.get('command'), list)):
        return False
    expected = [str(DRIVER), 'drive', device, '--label', prior['label']]
    if (len(prior['command']) < len(expected) + 1
            or prior['command'][1:len(expected) + 1] != expected
            or not isinstance(prior['command'][0], str)
            or pathlib.Path(prior['command'][0]).resolve() != pathlib.Path(sys.executable).resolve()):
        return False
    try:
        command = (proc_root / str(prior['pid']) / 'cmdline').read_bytes().split(b'\0')
    except FileNotFoundError:
        return False
    # Match full arguments rather than substrings/PID existence, so PID reuse
    # and a metadata-only inhibitor receipt cannot block or target a device.
    return (len(command) >= len(expected) + 1
            and pathlib.Path(os.fsdecode(command[0])).resolve() == pathlib.Path(sys.executable).resolve()
            and command[1:len(expected) + 1] == [part.encode() for part in expected])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('device', choices=['source', 'employee', 'replacement', 'compatibility', 'upgrade'])
    parser.add_argument('--label', required=True)
    parser.add_argument('--signing-metadata', type=pathlib.Path, required=True)
    parser.add_argument('--timeout-minutes', type=int, default=9)
    parser.add_argument('--expect-crash', action='store_true')
    args = parser.parse_args()
    if (not re.fullmatch('[a-z0-9-]+', args.label) or not 1 <= args.timeout_minutes <= 45
            or args.expect_crash and not args.label.startswith('annual-')):
        raise SystemExit('bounded-labelled-fixture-required')
    spec = importlib.util.spec_from_file_location('native_commercial_device', DRIVER)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    fixture = helper.validated_fixture(args.signing_metadata)
    runtime = json.loads((OUT / (args.device + '-runtime.json')).read_text())
    helper.guard_runtime(runtime, args.device, durable_only=True)
    jobs = OUT / 'drive-jobs'
    jobs.mkdir(exist_ok=True)
    if jobs.is_symlink() or not jobs.is_dir():
        raise SystemExit('ordinary-drive-jobs-directory-required')
    lock_fd = per_device_lock(jobs, args.device)
    try:
        # Historical drives predate flock. Check them under the new lock so a
        # current old helper can finish undisturbed before the next invocation.
        for path in jobs.glob('*.json'):
            prior = json.loads(path.read_text())
            if legacy_drive_is_running(prior, args.device):
                raise RuntimeError('this-device-already-has-a-running-drive')
        receipt = jobs / (args.device + '-' + args.label + '.json')
        if receipt.exists():
            raise RuntimeError('drive-receipt-already-exists-use-a-new-label')
        command = [sys.executable, str(DRIVER), 'drive', args.device, '--label', args.label,
                   '--signing-metadata', fixture['metadataPath'], '--timeout-minutes', str(args.timeout_minutes)]
        if args.expect_crash:
            command.append('--expect-crash')
        record = {'synthetic': True, 'device': args.device, 'label': args.label,
                  'avdPid': runtime['pid'], 'command': command, 'fixture': fixture,
                  'startedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'hostBootId': pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                  'survivesChatInterruption': True, 'productionNetworkUsed': False,
                  'perDeviceLockHeldByChild': True, 'receiptPublishedBeforeDriverExecution': True,
                  'completionRequiresDriveReceipt': str(OUT / (args.device + '-' + args.label + '-drive.json'))}
        with (jobs / (args.device + '-' + args.label + '.log')).open('xb') as log:
            child = start_gated_drive(command, record, receipt, log, lock_fd)
        print(json.dumps({'driveStarted': True, 'pid': child.pid, 'label': args.label, 'receipt': str(receipt)}))
    finally:
        # The detached driver inherits this same open-file-description lock.
        # It is automatically released when that driver exits, including crash.
        os.close(lock_fd)


if __name__ == '__main__':
    main()
