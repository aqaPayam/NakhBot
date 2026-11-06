"""Real-container CI rehearsal with synthetic SQL only; never a private receipt."""
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from restore_probe import command, deny, restore, temporary_database


def inventory():
    return set(command(['docker', 'ps', '--all', '--no-trunc', '--quiet', '--filter', 'label=nakh.restore-probe']).splitlines())


def main(args):
    if sys.platform != 'linux' or len(args) != 4 or not re.fullmatch(r'sha256:[a-f0-9]{64}', args[0]):
        deny()
    uid, gid = int(args[1]), int(args[2])
    if not 1 <= uid <= 65534 or not 1 <= gid <= 65534:
        deny()
    output = Path(args[3])
    if output.exists():
        deny()
    memory = {line.split(':')[0]: int(line.split()[1]) * 1024
              for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')}
    if memory.get('MemAvailable', 0) < 3 * 1024 ** 3:
        deny()
    # Deliberately incomplete: this cannot be supplied to the actual-host CLI.
    manifest = {'postgresImageId': args[0], 'postgresUid': uid, 'postgresGid': gid,
                'migrations': [{'name': '000001_fixture.sql', 'sha256': 'a' * 64}]}
    before = inventory()
    with temporary_database(manifest) as (identifier, user, _nonce):
        sql = "CREATE SCHEMA platform; CREATE SCHEMA identity; CREATE TABLE platform.schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL); INSERT INTO platform.schema_migrations VALUES ('000001_fixture.sql','" + 'a' * 64 + "'); CREATE TABLE identity.accounts(user_id uuid PRIMARY KEY); INSERT INTO identity.accounts VALUES ('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');"
        base = ['docker', 'exec', '-i', identifier]
        socket = ['-h', '/var/run/postgresql', '-U', user]
        command(base + ['psql', *socket, '-d', 'restore_probe', '-v', 'ON_ERROR_STOP=1'], sql.encode())
        dump = command(base + ['pg_dump', *socket, '-d', 'restore_probe', '-Fc'])
        roles = ('CREATE ROLE ' + user + ' NOLOGIN;\n').encode()
        facts = restore(manifest, {'database.dump': dump, 'database-roles.sql': roles})
        if facts['restoredMigrationCount'] != 1 or facts['restoredAccountCount'] != 2 or not facts['effectiveSwapDisabled']:
            deny()
        rejected = False
        try:
            restore(manifest, {'database.dump': b'PGDMPinvalid', 'database-roles.sql': roles})
        except ValueError:
            rejected = True
        if not rejected:
            deny()
    if inventory() != before:
        deny()
    source = os.environ.get('GITHUB_SHA', '')
    value = {'scenario': 'PRIVATE-VPS-RESTORE-SYNTHETIC-REHEARSAL',
             'sourceSha': source if re.fullmatch(r'[a-f0-9]{40}', source) else None,
             'syntheticFixtureOnly': True, 'privateBackupAccessed': False,
             'actualPrivateReceiptIssued': False, 'passed': True,
             'independentClusterRestore': facts, 'corruptAttemptWithheldSuccess': True,
             'allTemporaryContainersRemoved': True, 'productionQualified': False}
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2)
    print(json.dumps(value))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception:
        print('Synthetic restore rehearsal failed; no private-host qualification issued.', file=sys.stderr)
        sys.exit(1)
