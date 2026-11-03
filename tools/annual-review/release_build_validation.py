"""Pure, non-secret release provenance checks. Does not build, sign or install."""
import hashlib
import json
from pathlib import Path
import re
import stat
import subprocess
from urllib.parse import urlsplit

APPROVED_CERTIFICATE_SHA256 = 'bf1cb6377be0c37cad31811b557ac32b686ffdc75730778edb8488d2bdb3d82b'
APPROVED_DEFINITIONS_SHA256 = 'bfc10fa87f36844a992f67d87d73f510dbdad6e8d56b50e975a53103df88e2b0'
APPLICATION_ID = 'com.strawberrytrade.strawberry_trade'
DEFINITION_KEYS = {'USE_EMULATORS', 'FIREBASE_PROJECT_ID', 'FIREBASE_ANDROID_APP_ID',
                   'FIREBASE_API_KEY', 'FIREBASE_SENDER_ID', 'GATEWAY_BASE_URL', 'LICENSE_PUBLIC_KEYS'}
ROOT_INPUTS = ['pubspec.yaml', 'pubspec.lock', 'analysis_options.yaml', '.metadata']


class ReleaseValidationError(RuntimeError):
    pass


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def fresh_output(path):
    path = Path(path)
    if path.is_symlink() or (path.exists() and (not path.is_dir() or any(path.iterdir()))):
        raise ReleaseValidationError('release-output-already-in-use')


def public_definitions(path, expected_sha256=APPROVED_DEFINITIONS_SHA256):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ReleaseValidationError('ordinary-approved-public-definitions-required')
    raw = path.read_bytes()
    if len(raw) > 65_536 or hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ReleaseValidationError('approved-public-definitions-hash-mismatch')
    try:
        value = json.loads(raw)
        endpoint = urlsplit(value['GATEWAY_BASE_URL'])
        valid = (type(value) is dict and set(value) == DEFINITION_KEYS
                 and all(isinstance(item, str) and item for item in value.values())
                 and value['USE_EMULATORS'] == 'false'
                 and value['FIREBASE_PROJECT_ID'] == 'strawberry-trade-261017-6a49b'
                 and endpoint.scheme == 'https' and endpoint.hostname
                 and not endpoint.username and not endpoint.password
                 and not endpoint.query and not endpoint.fragment)
    except (KeyError, ValueError, TypeError):
        valid = False
    if not valid:
        raise ReleaseValidationError('approved-public-definitions-mismatch')
    return {'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
            'keys': sorted(value), 'containsPrivateCredentials': False}


def excluded_source(name):
    path = Path(name)
    return (path.parts[0] == 'android'
            and (any(part in {'build', '.gradle', '.dart_tool'} for part in path.parts)
                 or path.name in {'local.properties', 'key.properties', 'GeneratedPluginRegistrant.java'}))


def source_inventory(root, tracked=None):
    root = Path(root).resolve()
    if tracked is None:
        raw = subprocess.check_output(['git', 'ls-files', '-z', '--',
                                       'lib', 'assets', 'android', *ROOT_INPUTS], cwd=root)
        tracked = [name.decode() for name in raw.split(b'\0') if name]
    names = set(tracked)
    # New application source/assets are build inputs even before a commit.
    # Android discoveries stay under app/src, excluding generated registrants;
    # local Gradle/signing/build paths must never enter the manifest.
    for directory in ['lib', 'assets', 'android/app/src']:
        base = root / directory
        if base.is_symlink():
            raise ReleaseValidationError('ordinary-release-source-required')
        if base.is_dir():
            names.update(str(path.relative_to(root)) for path in base.rglob('*')
                         if path.is_file() or path.is_symlink())
    names.update(name for name in ROOT_INPUTS if (root / name).exists())
    result = []
    for name in sorted(names):
        path = Path(name)
        if path.is_absolute() or '..' in path.parts:
            raise ReleaseValidationError('release-source-path')
        if excluded_source(name):
            continue
        target = root / path
        if any(parent.is_symlink() for parent in [target, *target.parents]
               if parent == root or root in parent.parents):
            raise ReleaseValidationError('ordinary-release-source-required')
        info = target.stat()
        if not stat.S_ISREG(info.st_mode):
            raise ReleaseValidationError('ordinary-release-source-required')
        result.append({'path': name, 'sha256': file_sha256(target), 'bytes': info.st_size,
                       'mode': oct(stat.S_IMODE(info.st_mode))})
    if not result:
        raise ReleaseValidationError('release-source-inventory-empty')
    return result


def inventory_sha256(inventory):
    return hashlib.sha256(json.dumps(inventory, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def require_unchanged(before, after):
    if before != after:
        raise ReleaseValidationError('release-source-changed-during-build')


def approved_keytool_certificate(output):
    found = re.findall(r'(?m)^\s*SHA256:\s*([0-9A-Fa-f:]+)\s*$', output)
    if ('Entry type: PrivateKeyEntry' not in output or len(found) != 1
            or found[0].replace(':', '').lower() != APPROVED_CERTIFICATE_SHA256):
        raise ReleaseValidationError('existing-keystore-certificate-mismatch')
    return APPROVED_CERTIFICATE_SHA256


def approved_apk_certificate(output):
    found = re.findall(r'(?m)^Signer #\d+ certificate SHA-256 digest:\s*([0-9A-Fa-f]+)\s*$', output)
    if len(found) != 1 or found[0].lower() != APPROVED_CERTIFICATE_SHA256:
        raise ReleaseValidationError('release-apk-certificate-mismatch')
    return APPROVED_CERTIFICATE_SHA256


def release_badging(output, version_name, version_code):
    match = re.search(r"(?m)^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", output)
    if (not match or match.groups() != (APPLICATION_ID, str(version_code), version_name)
            or re.search(r'(?m)^application-debuggable\s*$', output)):
        raise ReleaseValidationError('release-package-version-or-debuggable-mismatch')
    return {'applicationId': APPLICATION_ID, 'versionName': version_name,
            'versionCode': version_code, 'debuggable': False}
