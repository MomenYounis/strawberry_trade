#!/usr/bin/env python3
"""Create/start/stop only marked private synthetic AVDs; never owner devices.

`start` stays in the foreground unless --detach is selected for a supervised
durable job. Stopping preserves userdata, including the seeded upgrade fixture.
No clear/uninstall.
"""
import argparse, datetime, json, os, pathlib, subprocess, tempfile, time

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'verification/continuation-2026-11-02/native-durable'
SDK = pathlib.Path('/home/younis/Android/Sdk')
PREFIX = 'strawberry-commercial-native-'
DURABLE = pathlib.Path('/home/younis/.local/share/strawberry-trade-test-runtime')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('phase', choices=['create', 'start', 'stop', 'mark-pristine', 'relocate', 'template'])
parser.add_argument('name', choices=['source', 'employee', 'replacement','compatibility','upgrade'])
parser.add_argument('--base-directory',choices=['/tmp','/dev/shm',str(DURABLE)],default='/tmp')
parser.add_argument('--from-pristine',action='store_true')
parser.add_argument('--gpu', choices=['swiftshader', 'host'], default='swiftshader')
parser.add_argument('--detach',action='store_true',help='Keep this owned AVD running across chat/tool interruptions.')
args = parser.parse_args()
OUT.mkdir(parents=True, exist_ok=True)
metadata = OUT / (args.name + '-runtime.json')
port = {'source': 5580, 'employee': 5582, 'replacement': 5584,'compatibility':5586,'upgrade':5578}[args.name]

def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def load():
    r = json.loads(metadata.read_text())
    folder = pathlib.Path(r['runtimeRoot'])
    if (folder.parent not in {pathlib.Path('/tmp'),pathlib.Path('/dev/shm'),DURABLE} or not folder.name.startswith(PREFIX)
        or folder.is_symlink() or not folder.is_dir()
        or r['name'] != args.name or r['serial'] != 'emulator-' + str(port)
        or pathlib.Path(r['avdPath']).parent != folder / 'avd'
        or r['avdName'] != 'strawberry_commercial_disposable_' + args.name):
        raise RuntimeError('marked-private-runtime-required')
    return r

def command_matches(r):
    p = pathlib.Path('/proc') / str(r.get('pid', 0)) / 'cmdline'
    command = p.read_bytes() if p.exists() else b''
    return r['avdPath'].encode() in command and r['avdName'].encode() in command

if args.phase == 'create':
    if metadata.exists():
        raise SystemExit('runtime-metadata-already-exists; preserve existing data')
    folder = pathlib.Path(tempfile.mkdtemp(prefix=PREFIX,dir=args.base_directory)); os.chmod(folder, 0o700)
    home = folder / 'avd'; home.mkdir(mode=0o700)
    name = 'strawberry_commercial_disposable_' + args.name
    path = home / (name + '.avd')
    env = {**os.environ, 'ANDROID_AVD_HOME': str(home), 'ANDROID_SDK_ROOT': str(SDK)}
    command = [str(SDK / 'cmdline-tools/latest/bin/avdmanager'), 'create', 'avd',
               '--name', name, '--package', 'system-images;android-35;google_apis;x86_64',
               '--path', str(path), '--device', 'pixel_2']
    created = subprocess.run(command, input='no\n', text=True, capture_output=True, env=env)
    (OUT / (args.name + '-avd-create.log')).write_text(created.stdout + created.stderr)
    if created.returncode:
        raise SystemExit('private-avd-create-failed')
    config = path / 'config.ini'
    import re
    config.write_text(re.sub(r'^disk.dataPartition.size\s*=.*$', 'disk.dataPartition.size=2147483648', config.read_text(), flags=re.M))
    with config.open('a') as output:
        output.write('\nhw.ramSize=1024\nhw.cpu.ncore=2\nhw.gpu.enabled=yes\n'
                     'hw.gpu.mode=swiftshader_indirect\nhw.lcd.width=720\nhw.lcd.height=1280\ndisk.dataPartition.size=2147483648\nsdcard.size=128 MB\n')
    if args.from_pristine:
        template=DURABLE/'pristine-template.avd'; proof=json.loads((DURABLE/'pristine-template.json').read_text())
        if proof.get('applicationAbsent') is not True or not template.is_dir() or template.is_symlink():raise RuntimeError('verified-pristine-template-required')
        # Replace only the just-created empty constructor directory. avdmanager
        # marks it NOCOW; a pristine COW image must keep matching attributes.
        import shutil
        if (path/'userdata-qemu.img').exists():raise RuntimeError('new-empty-constructor-required')
        shutil.rmtree(path)
        subprocess.run(['cp','-a','--reflink=always',str(template),str(path)],check=True)
        for item in path.rglob('*'):
            if item.suffix in {'.ini','.json'} and item.is_file() and item.stat().st_size<1_000_000:
                item.write_text(item.read_text().replace(proof['originalRoot'],str(folder)))
    r = {'synthetic': True, 'ownerDeviceTouched': False, 'name': args.name,
         'runtimeRoot': str(folder), 'avdHome': str(home), 'avdPath': str(path),
         'avdName': name, 'serial': 'emulator-' + str(port), 'createdAtUtc': timestamp()}
    metadata.write_text(json.dumps(r, indent=2) + '\n'); print(json.dumps(r, indent=2))
elif args.phase == 'start':
    r = load()
    if command_matches(r):
        raise SystemExit('owned-runtime-already-running')
    devices = subprocess.check_output([str(SDK / 'platform-tools/adb'), 'devices'], text=True)
    if r['serial'] in devices:
        raise SystemExit('serial-already-in-use; no device was touched')
    command = [str(SDK / 'emulator/emulator'), '-avd', r['avdName'], '-datadir', r['avdPath'],
               '-port', str(port), '-partition-size', '2048', '-gpu', args.gpu, '-feature', '-Vulkan',
               '-memory', '1024', '-cores', '2', '-no-window', '-no-audio', '-no-boot-anim',
               '-no-snapshot-load', '-no-snapshot-save', '-no-metrics',
               '-dns-server', '127.0.0.1']
    env = {**os.environ, 'ANDROID_AVD_HOME': r['avdHome'], 'ANDROID_SDK_ROOT': str(SDK)}
    with (OUT / (args.name + '-emulator.log')).open('ab', buffering=0) as output:
        child = subprocess.Popen(command, env=env, stdout=output, stderr=subprocess.STDOUT,
                                 stdin=subprocess.DEVNULL,start_new_session=args.detach)
        r.update(pid=child.pid, command=command, startedAtUtc=timestamp())
        metadata.write_text(json.dumps(r, indent=2) + '\n')
        print(json.dumps({'pid': child.pid, 'serial': r['serial'], 'runtime': str(metadata)}), flush=True)
        if args.detach:
            raise SystemExit(0)
        raise SystemExit(child.wait())
elif args.phase == 'stop':
    r = load()
    if not command_matches(r):
        raise SystemExit('owned-running-process-required; no device was touched')
    subprocess.run([str(SDK / 'platform-tools/adb'), '-s', r['serial'], 'emu', 'kill'],
                   check=True, capture_output=True, timeout=30)
    r['stoppedAtUtc'] = timestamp(); r['userdataPreserved'] = True
    metadata.write_text(json.dumps(r, indent=2) + '\n'); print('Owned runtime stopped; seeded userdata preserved.')

if args.phase == 'mark-pristine':
    r=load()
    if not command_matches(r):raise RuntimeError('owned-running-process-required')
    adb=[str(SDK/'platform-tools/adb'),'-s',r['serial']]
    installed=subprocess.run(adb+['shell','pm','path','com.strawberrytrade.strawberry_trade'],capture_output=True,text=True)
    if installed.returncode not in {0,1} or installed.stderr.strip():raise RuntimeError('pristine-package-query-failed')
    if installed.stdout.strip():raise RuntimeError('pristine-must-have-no-application')
    for command in [['cmd','connectivity','airplane-mode','enable'],['svc','data','disable'],['svc','wifi','disable']]:subprocess.run(adb+['shell']+command,check=True,capture_output=True)
    r['applicationAbsent']=True;metadata.write_text(json.dumps(r,indent=2)+'\n');print('Verified pristine synthetic device; network disabled.')
elif args.phase in {'relocate','template'}:
    r=load()
    if command_matches(r) or r.get('applicationAbsent') is not True:raise RuntimeError('stopped-pristine-runtime-required')
    DURABLE.mkdir(mode=0o700,exist_ok=True)
    if DURABLE.stat().st_mode&0o077:raise RuntimeError('private-durable-root-required')
    if args.phase=='relocate':
        old=pathlib.Path(r['runtimeRoot']);target=DURABLE/old.name
        if target.exists():raise RuntimeError('destination-already-exists')
        subprocess.run(['cp','-a','--sparse=always',str(old),str(target)],check=True)
        oldroot=str(old);newroot=str(target)
        for item in target.rglob('*'):
            if item.suffix in {'.ini','.json'} and item.is_file() and item.stat().st_size<1_000_000:item.write_text(item.read_text().replace(oldroot,newroot))
        for key in ['runtimeRoot','avdHome','avdPath']:r[key]=r[key].replace(oldroot,newroot)
        r['relocatedAtUtc']=timestamp();metadata.write_text(json.dumps(r,indent=2)+'\n');print('Pristine synthetic runtime copied to durable private storage; original retained.')
    else:
        target=DURABLE/'pristine-template.avd'
        if target.exists():raise RuntimeError('pristine-template-already-exists')
        subprocess.run(['cp','-a','--reflink=always',r['avdPath'],str(target)],check=True)
        (DURABLE/'pristine-template.json').write_text(json.dumps({'synthetic':True,'applicationAbsent':True,'originalRoot':r['runtimeRoot']})+'\n')
        print('Created private copy-on-write pristine test template; no application or app Keystore identity present.')
