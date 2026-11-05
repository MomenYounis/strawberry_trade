#!/usr/bin/env python3
"""Review-only compatible Worker packaging. Never deploys or reads credentials.

Builds in a private temporary source tree from an explicit local import closure,
reinstalls the exact lock offline, runs Worker unit tests and Wrangler's local
production-config dry run. Delivers deterministic source/payload tarballs and
hashes. No annual scheduler, R2 binding or cleanup activation is introduced.
"""
import argparse, datetime, gzip, hashlib, io, json, os, pathlib, re, shutil
import subprocess, tarfile, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', default='verification/continuation-2026-11-02/backend-deployment')
args = parser.parse_args()
OUT = (ROOT / args.output_dir).resolve()
if not OUT.is_relative_to(ROOT / 'verification'):
    raise SystemExit('verification-output-required')
OUT.mkdir(parents=True, exist_ok=True)
if (OUT / 'release-manifest.json').exists():
    raise SystemExit('sealed-evidence-exists; select a fresh output directory')

def sha(data):
    return hashlib.sha256(data).hexdigest()

def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def archive_bytes(files):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.PAX_FORMAT) as tar:
        for name, data in sorted(files.items()):
            entry = tarfile.TarInfo(name); entry.size = len(data); entry.mode = 0o644
            entry.uid = entry.gid = entry.mtime = 0; entry.uname = entry.gname = ''
            tar.addfile(entry, io.BytesIO(data))
    result = io.BytesIO()
    with gzip.GzipFile(fileobj=result, mode='wb', mtime=0, filename='') as output:
        output.write(raw.getvalue())
    return result.getvalue()

result = {'status': 'FAIL', 'preparedAtUtc': utc(), 'productionDeployed': False,
          'cloudAuthenticationUsed': False, 'credentialsIncluded': False,
          'baseSourceRevision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
          'sourceIdentity': 'base revision plus exact file hashes; authored working-tree changes are included',
          'commands': [], 'artifacts': {}}
runtime = pathlib.Path(tempfile.mkdtemp(prefix='strawberry-backend-package-'))
try:
    paths = set()
    def include(relative):
        path = (ROOT / relative).resolve()
        if not path.is_relative_to(ROOT) or path.is_symlink() or not path.is_file():
            raise RuntimeError('bounded-regular-source-file-required')
        name = path.relative_to(ROOT).as_posix()
        if name in paths:
            return
        paths.add(name)
        if path.suffix != '.mjs':
            return
        source = path.read_text()
        for specifier in re.findall(r"(?:\bfrom\s*|\bimport\s*\(?)\s*['\"](\.[^'\"]+)['\"]", source):
            if '/node_modules/' in specifier or specifier.startswith('./node_modules/'):
                continue  # exact dependencies are installed from the unchanged lock
            include((path.parent / specifier).relative_to(ROOT))
    include(pathlib.Path('backend/worker/index.mjs'))
    for name in ['backend/worker/package.json', 'backend/worker/package-lock.json',
                 'backend/worker/wrangler.jsonc', 'config/wrangler.production.json',
                 'backend/worker/test/config.test.mjs',
                 'backend/worker/test/emulator-firestore-auth.test.mjs',
                 'backend/worker/test/request-forward.test.mjs']:
        include(pathlib.Path(name))
    files = {name: (ROOT / name).read_bytes() for name in sorted(paths)}
    if any('/archive-' in name or '/feed-pruner' in name or '/active-snapshot-' in name for name in files):
        raise RuntimeError('unexpected-private-annual-worker-dependency-review-required')
    for name, data in files.items():
        if re.search(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/]{20,}', data):
            raise RuntimeError('private-key-material-refused')
        destination = runtime / name; destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    config = json.loads(files['config/wrangler.production.json'])
    if config.get('r2_buckets') or config.get('triggers') or config.get('env'):
        raise RuntimeError('unexpected-storage-scheduler-environment-review-required')
    result['target'] = {key: config.get(key) for key in ['name', 'account_id', 'compatibility_date', 'workers_dev']}
    result['sourceInventory'] = [{'path': name, 'sha256': sha(data), 'bytes': len(data)} for name, data in files.items()]
    result['sourceFileCount'] = len(files)
    (OUT / 'source-inventory.json').write_text(json.dumps(result['sourceInventory'], indent=2) + '\n')
    env = {key: value for key, value in os.environ.items()
           if key in {'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR'}}
    env.update(CLOUDFLARE_SEND_METRICS='false', WRANGLER_SEND_METRICS='false',
               CI='true', NO_COLOR='1', XDG_CONFIG_HOME=str(runtime / 'isolated-xdg'),
               WRANGLER_LOG_PATH=str(runtime / 'wrangler.log'))
    def run(command, name, cwd, timeout=600):
        started = utc()
        with (OUT / name).open('w') as log:
            completed = subprocess.run(command, cwd=cwd, env=env, stdout=log,
                                       stderr=subprocess.STDOUT, timeout=timeout)
        result['commands'].append({'command': command, 'log': name,
                                   'startedAtUtc': started, 'finishedAtUtc': utc(),
                                   'exitCode': completed.returncode})
        if completed.returncode:
            raise RuntimeError(name + '-failed')
    worker = runtime / 'backend/worker'
    run(['npm', 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], 'npm-ci-offline.log', worker)
    run(['npm', 'test'], 'worker-unit-final.log', worker)
    run([str(worker / 'node_modules/.bin/wrangler'), 'deploy', '--env=',
         '--config', '../../config/wrangler.production.json', '--dry-run',
         '--no-upload-source-maps', '--outdir', str(runtime / 'payload'),
         '--metafile', str(runtime / 'bundle-metafile.json')],
        'production-config-dry-run.log', worker)
    metafile = json.loads((runtime / 'bundle-metafile.json').read_text())
    # Explicit proof that private Node SQLite/annual runners were not bundled.
    private_inputs = [name for name in metafile['inputs'] if re.search(
        r'(?:archive-(?:coordinator|source|projection|runner|storage|scheduler)|feed-pruner|active-snapshot-projection|node:sqlite)', name)]
    if private_inputs:
        raise RuntimeError('unexpected-private-annual-bundle-input')
    (OUT / 'bundle-metafile.json').write_text(json.dumps(metafile, indent=2) + '\n')
    result['workerInputCount'] = len(metafile['inputs'])
    result['privateAnnualModulesBundled'] = []
    for name, original in files.items():
        if (ROOT / name).read_bytes() != original:
            raise RuntimeError('source-changed-during-preparation')
    inventory = json.dumps({'baseSourceRevision': result['baseSourceRevision'],
                            'sourceIdentity': result['sourceIdentity'],
                            'files': result['sourceInventory']}, sort_keys=True, indent=2).encode() + b'\n'
    source_files = {**files, 'BUILD-SOURCE-INVENTORY.json': inventory}
    source = archive_bytes(source_files)
    source_name = 'compatible-backend-source.tar.gz'; (OUT / source_name).write_bytes(source)
    payload_files = {path.relative_to(runtime / 'payload').as_posix(): path.read_bytes()
                     for path in sorted((runtime / 'payload').rglob('*'))
                     if path.is_file() and path.suffix != '.map' and path.name != 'README.md'}
    if not payload_files or not any(name.endswith('.js') for name in payload_files):
        raise RuntimeError('compiled-worker-payload-required')
    for name in payload_files:
        if '.env' in name or '.dev.vars' in name or name.endswith('.map'):
            raise RuntimeError('private-artifact-name-refused')
    payload = archive_bytes(payload_files)
    payload_name = 'compatible-backend-dry-run-payload.tar.gz'; (OUT / payload_name).write_bytes(payload)
    for name, data in [(source_name, source), (payload_name, payload)]:
        result['artifacts'][name] = {'sha256': sha(data), 'bytes': len(data)}
    result['payloadInventory'] = [{'path': name, 'sha256': sha(data), 'bytes': len(data)}
                                  for name, data in payload_files.items()]
    (OUT / 'SHA256SUMS').write_text(''.join(value['sha256'] + '  ' + name + '\n'
        for name, value in result['artifacts'].items()))
    result.update(status='PASS', completedAtUtc=utc(),
                  cleanOfflineInstall=True, workerUnitTests='PASS', productionConfigDryRun='PASS',
                  excluded=['credentials', '.env', '.dev.vars', 'source maps', 'node_modules',
                            'private annual Node SQLite source/preparation runners', 'R2 bindings', 'cron triggers'])
except Exception as error:
    result['failure'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
finally:
    shutil.rmtree(runtime)
    (OUT / 'release-manifest.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: result[key] for key in ['status', 'baseSourceRevision', 'artifacts']}, indent=2))
if result.get('failure'):
    print(result['failure'])
raise SystemExit(0 if result['status'] == 'PASS' else 1)
