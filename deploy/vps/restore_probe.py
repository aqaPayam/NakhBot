"""Restore an authenticated backup's database members into disposable private RAM.

The caller authenticates/decrypts the encrypted backup off-host and streams only
database.dump and database-roles.sql. This tool never receives a backup key,
connects to the live database, restores photos or authorizes a production restore.
"""
import datetime
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import time
import uuid

# -I omits the script directory. Resolve only this reviewed sibling, never cwd.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from deletion_cutover import private_json, private_parent

ROOT = Path('/opt/nakh')
LIMIT = 64 * 1024 * 1024
HEX = re.compile(r'[a-f0-9]{64}\Z')
SHA = re.compile(r'[a-f0-9]{40}\Z')


def deny():
    raise ValueError('Private backup restore unavailable.')


def validate_manifest(value, accepted):
    required = {'version', 'applicationSourceSha', 'operatorSourceSha',
                'encryptedArchiveSha256', 'dumpSha256', 'rolesSha256',
                'postgresImageId', 'postgresUid', 'postgresGid',
                'hostIdentitySha256', 'migrations'}
    if (set(value) != required or type(value['version']) is not int or value['version'] != 1 or
            not SHA.fullmatch(value.get('applicationSourceSha', '')) or
            not SHA.fullmatch(value.get('operatorSourceSha', '')) or
            accepted.get('sourceSha') != value['operatorSourceSha'] or
            accepted.get('allSixJobsPassed') is not True or len(accepted.get('artifacts', [])) != 10):
        deny()
    for key in ['encryptedArchiveSha256', 'dumpSha256', 'rolesSha256', 'hostIdentitySha256']:
        if not isinstance(value[key], str) or not HEX.fullmatch(value[key]):
            deny()
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', value['postgresImageId']):
        deny()
    for key in ['postgresUid', 'postgresGid']:
        if type(value[key]) is not int or not 1 <= value[key] <= 65534:
            deny()
    rows = value['migrations']
    if not isinstance(rows, list) or not 1 <= len(rows) <= 1000:
        deny()
    for row in rows:
        if (not isinstance(row, dict) or set(row) != {'name', 'sha256'} or
                not re.fullmatch(r'[0-9]{6}_[a-z0-9_]+\.sql', row.get('name', '')) or
                not HEX.fullmatch(row.get('sha256', ''))):
            deny()
    names = [row['name'] for row in rows]
    if names != sorted(set(names)):
        deny()


def read_payload(stream, manifest):
    data = stream.read(LIMIT + 1)
    if not data or len(data) > LIMIT:
        deny()
    members = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        for member in archive:
            if (member.name not in {'database.dump', 'database-roles.sql'} or
                    member.name in members or member.type != tarfile.REGTYPE or
                    member.pax_headers or not 0 < member.size <= LIMIT // 2):
                deny()
            members[member.name] = archive.extractfile(member).read()
        if any(data[archive.offset:]):
            deny()
    if set(members) != {'database.dump', 'database-roles.sql'}:
        deny()
    if (not members['database.dump'].startswith(b'PGDMP') or
            hashlib.sha256(members['database.dump']).hexdigest() != manifest['dumpSha256'] or
            hashlib.sha256(members['database-roles.sql']).hexdigest() != manifest['rolesSha256']):
        deny()
    members['database-roles.sql'].decode('utf-8')
    return members


def validate_isolation(info, manifest, nonce):
    host, config = info.get('HostConfig', {}), info.get('Config', {})
    uid = str(manifest['postgresUid']) + ':' + str(manifest['postgresGid'])
    if (info.get('Image') != manifest['postgresImageId'] or config.get('User') != uid or
            config.get('Labels', {}).get('nakh.restore-probe') != nonce or
            host.get('NetworkMode') != 'none' or host.get('ReadonlyRootfs') is not True or
            host.get('PortBindings') or host.get('Privileged') or host.get('Binds') or
            host.get('Devices') or host.get('CapAdd') or host.get('PidMode') or
            host.get('IpcMode') != 'private' or host.get('CapDrop') != ['ALL'] or
            'no-new-privileges' not in host.get('SecurityOpt', []) or
            host.get('Memory') != 1024 ** 3 or host.get('MemorySwap') != 1024 ** 3 or host.get('NanoCpus') != 10 ** 9 or
            host.get('PidsLimit') != 128):
        deny()
    paths = {'/var/lib/postgresql/data', '/var/run/postgresql', '/tmp'}
    if (host.get('CgroupnsMode') != 'private' or set(host.get('Tmpfs', {})) != paths or any(
            mount.get('Type') != 'tmpfs' or mount.get('Destination') not in paths
            for mount in info.get('Mounts', []))):
        deny()


def command(args, data=None, timeout=120):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if result.returncode:
        deny()
    return result.stdout


def verify_no_swap(identifier):
    if command(['docker', 'exec', identifier, 'cat', '/sys/fs/cgroup/memory.swap.max']).strip() != b'0':
        deny()


@contextmanager
def temporary_database(manifest):
    nonce = uuid.uuid4().hex
    user = 'nakh_restore_' + nonce[:16]
    uid, gid = manifest['postgresUid'], manifest['postgresGid']
    args = ['docker', 'create', '--name', 'nakh-restore-probe-' + nonce,
            '--label', 'nakh.restore-probe=' + nonce, '--network', 'none',
            '--read-only', '--user', str(uid) + ':' + str(gid), '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--memory', '1g', '--memory-swap', '1g', '--cpus', '1',
            '--pids-limit', '128', '--ipc', 'private', '--cgroupns', 'private',
            '--env', 'POSTGRES_USER=' + user, '--env', 'POSTGRES_DB=restore_probe',
            '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', 'PGDATA=/var/lib/postgresql/data']
    for path, size in [('/var/lib/postgresql/data', '768m'), ('/var/run/postgresql', '16m'), ('/tmp', '16m')]:
        args += ['--tmpfs', path + ':rw,noexec,nosuid,nodev,size=' + size + ',uid=' + str(uid) + ',gid=' + str(gid)]
    identifier = command(args + [manifest['postgresImageId']]).decode().strip()
    if not HEX.fullmatch(identifier):
        deny()
    try:
        info = json.loads(command(['docker', 'inspect', identifier]))[0]
        validate_isolation(info, manifest, nonce)
        command(['docker', 'start', identifier])
        verify_no_swap(identifier)
        deadline = time.monotonic() + 90
        while True:
            logs = command(['docker', 'logs', identifier])
            ready = subprocess.run(['docker', 'exec', identifier, 'pg_isready', '-h', '/var/run/postgresql', '-U', user, '-d', 'restore_probe'], capture_output=True, timeout=10)
            if b'PostgreSQL init process complete; ready for start up.' in logs and ready.returncode == 0:
                break
            if time.monotonic() > deadline:
                deny()
            time.sleep(1)
        yield identifier, user, nonce
    finally:
        # Only the exact new container ID returned by this invocation is removed.
        command(['docker', 'rm', '--force', '--volumes', identifier])
        remaining = command(['docker', 'ps', '--all', '--no-trunc', '--quiet', '--filter', 'id=' + identifier])
        if remaining.strip():
            deny()


def restore(manifest, members):
    with temporary_database(manifest) as (identifier, user, nonce):
        base = ['docker', 'exec', '-i', identifier]
        socket = ['-h', '/var/run/postgresql', '-U', user]
        command(base + ['psql', *socket, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], members['database-roles.sql'])
        command(base + ['pg_restore', *socket, '-d', 'restore_probe', '--exit-on-error'], members['database.dump'], timeout=300)
        query = "SELECT json_build_object('dataDirectory',current_setting('data_directory'),'migrations',(SELECT json_agg(json_build_object('name',name,'sha256',sha256) ORDER BY name) FROM platform.schema_migrations),'accounts',(SELECT count(*) FROM identity.accounts))"
        facts = json.loads(command(base + ['psql', *socket, '-d', 'restore_probe', '-v', 'ON_ERROR_STOP=1', '-Atc', query]))
        if (facts.get('dataDirectory') != '/var/lib/postgresql/data' or facts.get('migrations') != manifest['migrations'] or
                type(facts.get('accounts')) is not int or facts['accounts'] < 0):
            deny()
        validate_isolation(json.loads(command(['docker', 'inspect', identifier]))[0], manifest, nonce)
        verify_no_swap(identifier)
    return {'migrationInventoryVerified': True, 'restoredMigrationCount': len(manifest['migrations']),
            'restoredAccountCount': facts['accounts'], 'temporaryContainerRemoved': True, 'effectiveSwapDisabled': True}


def main(args):
    if sys.platform != 'linux' or os.getuid() != 0 or len(args) != 3:
        deny()
    manifest, accepted = [private_json(path) for path in args[:2]]
    validate_manifest(manifest, accepted)
    machine = Path('/etc/machine-id').read_text().strip()
    if hashlib.sha256(machine.encode()).hexdigest() != manifest['hostIdentitySha256']:
        deny()
    private_parent(args[2])
    if Path(args[2]).exists():
        deny()
    memory = {line.split(':', 1)[0]: int(line.split()[1]) * 1024
              for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')}
    if memory.get('MemAvailable', 0) < 2 * 1024 ** 3:
        deny()
    limits = json.loads(command(['docker', 'info', '--format', '{{json .}}']))
    if (limits.get('MemoryLimit') is not True or limits.get('SwapLimit') is not True or
            str(limits.get('CgroupVersion')) != '2'):
        deny()
    compose = ['docker', 'compose', '-p', 'nakh-trial', '-f', str(ROOT / 'compose.yaml'), '-f', str(ROOT / 'compose.scanner.yaml')]
    live = command(compose + ['ps', '--quiet', 'postgres']).decode().strip()
    if not HEX.fullmatch(live) or json.loads(command(['docker', 'inspect', live]))[0]['Image'] != manifest['postgresImageId']:
        deny()
    members = read_payload(sys.stdin.buffer, manifest)
    started = time.monotonic()
    facts = restore(manifest, members)
    facts.update({'schemaVersion': 1, 'observationScope': 'actual_isolated_database_backup_restore',
                  'applicationSourceSha': manifest['applicationSourceSha'],
                  'operatorSourceSha': manifest['operatorSourceSha'],
                  'suppliedEncryptedArchiveSha256': manifest['encryptedArchiveSha256'],
                  'databaseDumpSha256': manifest['dumpSha256'],
                  'operatorCodeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  'privateInputChecksCodeSha256': hashlib.sha256(Path(__file__).with_name('deletion_cutover.py').read_bytes()).hexdigest(),
                  'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'restoreDurationMs': round((time.monotonic() - started) * 1000, 3),
                  'networkDisabled': True, 'databaseStorageInTmpfs': True,
                  'encryptedBackupAuthenticationPerformedHere': False,
                  'liveDatabaseReplaced': False, 'photoObjectsRestored': False,
                  'pointInTimeRecoveryQualified': False, 'productionQualified': False})
    body = (json.dumps(facts, sort_keys=True, separators=(',', ':')) + '\n').encode()
    fd = os.open(args[2], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(body)
        output.flush()
        os.fsync(output.fileno())
    print(json.dumps({'isolatedBackupRestored': True, 'receiptSha256': hashlib.sha256(body).hexdigest(), 'productionQualified': False}))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception:
        print('Private backup restore unavailable; no successful receipt issued. Private inputs and diagnostics withheld.', file=sys.stderr)
        sys.exit(1)
