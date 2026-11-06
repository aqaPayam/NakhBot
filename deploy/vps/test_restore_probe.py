"""Synthetic validation; successful fixtures never certify an actual restore."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import unittest
from unittest.mock import patch

from restore_probe import main, read_payload, restore, validate_isolation, validate_manifest


def fixture():
    dump, roles = b'PGDMP-private-D0_NOT_LEAK', b'-- private DO_NOT_LEAK\n'
    manifest = {'version': 1, 'applicationSourceSha': 'a' * 40, 'operatorSourceSha': 'b' * 40,
                'encryptedArchiveSha256': 'c' * 64, 'dumpSha256': hashlib.sha256(dump).hexdigest(),
                'rolesSha256': hashlib.sha256(roles).hexdigest(), 'postgresImageId': 'sha256:' + 'd' * 64,
                'postgresUid': 999, 'postgresGid': 999, 'hostIdentitySha256': 'e' * 64,
                'migrations': [{'name': '000001_foundation.sql', 'sha256': 'f' * 64}]}
    accepted = {'sourceSha': 'b' * 40, 'allSixJobsPassed': True, 'artifacts': [{}] * 10}
    return manifest, accepted, {'database.dump': dump, 'database-roles.sql': roles}


def payload(entries):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as archive:
        for name, content in entries:
            member = tarfile.TarInfo(name)
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
    stream.seek(0)
    return stream


def isolated(manifest):
    paths = ['/var/lib/postgresql/data', '/var/run/postgresql', '/tmp']
    return {'Image': manifest['postgresImageId'],
            'Config': {'User': '999:999', 'Labels': {'nakh.restore-probe': 'nonce'}},
            'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True, 'PortBindings': {},
                           'Privileged': False, 'Binds': None, 'Devices': [], 'CapAdd': None,
                           'PidMode': '', 'IpcMode': 'private', 'CapDrop': ['ALL'],
                           'SecurityOpt': ['no-new-privileges'], 'Memory': 1024 ** 3, 'MemorySwap': 1024 ** 3,
                           'NanoCpus': 10 ** 9, 'PidsLimit': 128, 'Tmpfs': dict.fromkeys(paths, 'rw,noswap')},
            'Mounts': [{'Type': 'tmpfs', 'Destination': path} for path in paths]}


class RestoreProbeTests(unittest.TestCase):
    def test_exact_manifest_and_members(self):
        manifest, accepted, members = fixture()
        self.assertIsNone(validate_manifest(manifest, accepted))
        self.assertEqual(read_payload(payload(members.items()), manifest), members)

    def test_requires_exact_source_and_all_ci_artifacts(self):
        manifest, accepted, _ = fixture()
        for key, value in [('sourceSha', 'c' * 40), ('allSixJobsPassed', False), ('artifacts', [])]:
            changed = {**accepted, key: value}
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_manifest(manifest, changed)

    def test_unknown_authority_and_invalid_hash_rejected(self):
        manifest, accepted, _ = fixture()
        for key, value in [('authorizeLiveRestore', True), ('dumpSha256', 'x' * 64), ('postgresImageId', 'postgres:latest')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_manifest({**manifest, key: value}, accepted)

    def test_root_user_and_unbounded_identity_rejected(self):
        manifest, accepted, _ = fixture()
        for value in [0, -1, True, 65535, '999']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_manifest({**manifest, 'postgresUid': value}, accepted)

    def test_duplicate_or_changed_migration_inventory_rejected(self):
        manifest, accepted, _ = fixture()
        for rows in [[], manifest['migrations'] * 2, [{'name': '../escape.sql', 'sha256': 'f' * 64}]]:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                validate_manifest({**manifest, 'migrations': rows}, accepted)

    def test_extra_missing_duplicate_and_traversal_payload_rejected(self):
        manifest, _, members = fixture()
        entries = list(members.items())
        for changed in [entries[:1], entries + [entries[0]], entries + [('secrets/key', b'PRIVATE')], [('../database.dump', entries[0][1]), entries[1]]]:
            with self.subTest(names=[row[0] for row in changed]), self.assertRaises(ValueError):
                read_payload(payload(changed), manifest)

    def test_links_and_oversized_or_empty_payload_rejected(self):
        manifest, _, _ = fixture()
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            member = tarfile.TarInfo('database.dump')
            member.type, member.linkname = tarfile.SYMTYPE, '/etc/passwd'
            archive.addfile(member)
        stream.seek(0)
        with self.assertRaises(ValueError):
            read_payload(stream, manifest)
        for data in [b'', b'x' * 1025]:
            with patch('restore_probe.LIMIT', 1024), self.assertRaises(ValueError):
                read_payload(io.BytesIO(data), manifest)

    def test_modified_dump_or_roles_rejected(self):
        manifest, _, members = fixture()
        for name in members:
            changed = {**members, name: members[name] + b'changed'}
            with self.subTest(name=name), self.assertRaises(ValueError):
                read_payload(payload(changed.items()), manifest)

    def test_hidden_data_after_tar_end_is_rejected(self):
        manifest, _, members = fixture()
        stream = payload(members.items())
        with self.assertRaises(ValueError):
            read_payload(io.BytesIO(stream.getvalue() + b'PRIVATE_EXTRA_MEMBER'), manifest)

    def test_exact_private_ram_isolation(self):
        manifest, _, _ = fixture()
        self.assertIsNone(validate_isolation(isolated(manifest), manifest, 'nonce'))
        for key, value in [('NetworkMode', 'bridge'), ('ReadonlyRootfs', False), ('Privileged', True), ('PortBindings', {'5432/tcp': [{}]}), ('CapAdd', ['SYS_ADMIN']), ('Binds', ['/opt/nakh:/live']), ('IpcMode', 'host'), ('PidsLimit', 0), ('Memory', 0), ('MemorySwap', -1), ('Tmpfs', {'/tmp': 'rw'})]:
            info = isolated(manifest)
            info['HostConfig'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_isolation(info, manifest, 'nonce')

    def test_wrong_image_owner_or_persistent_mount_rejected(self):
        manifest, _, _ = fixture()
        for field in ['image', 'owner', 'label', 'mount']:
            info = isolated(manifest)
            if field == 'image':
                info['Image'] = 'sha256:' + 'f' * 64
            elif field == 'owner':
                info['Config']['User'] = '0'
            elif field == 'label':
                info['Config']['Labels']['nakh.restore-probe'] = 'other'
            else:
                info['Mounts'][0]['Type'] = 'volume'
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_isolation(info, manifest, 'nonce')

    def test_non_linux_cli_cannot_issue_actual_receipt(self):
        with patch('restore_probe.sys.platform', 'win32'), self.assertRaises(ValueError):
            main(['fixture', 'fixture', 'output'])

    def test_isolated_python_bootstrap_fails_privately_without_arguments(self):
        result = subprocess.run([sys.executable, '-I', '-B', str(Path(__file__).with_name('restore_probe.py'))], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b'')
        self.assertIn(b'no successful receipt issued', result.stderr)
        self.assertNotIn(b'Traceback', result.stderr)

    def test_failed_isolation_cleans_only_new_container(self):
        manifest, _, members = fixture()
        identifier = '1' * 64
        responses = [identifier.encode(), json.dumps([{}]).encode(), b'']
        with patch('restore_probe.command', side_effect=responses) as call, self.assertRaises(ValueError):
            restore(manifest, members)
        self.assertEqual(call.call_args.args[0], ['docker', 'rm', '--force', '--volumes', identifier])


if __name__ == '__main__':
    unittest.main()
