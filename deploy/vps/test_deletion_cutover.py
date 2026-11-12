"""Synthetic observation validation; these tests do not certify a real drain."""
import copy
import json
import stat
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch, mock_open

from deletion_cutover import (APPS, REPOSITORY, ROOT, main, private_json,
                              private_webhook_file, validate_snapshot, webhook_secret)


def fixture():
    source = "a" * 40
    binding = {"version": 1, "environment": "staging", "sourceSha": source}
    images = [{"service": app, "imageId": "sha256:" + str(index + 1) * 64, "nonRoot": True}
              for index, app in enumerate(APPS)]
    build = {"sourceSha": source, "images": images}
    accepted = {"sourceSha": source, "allSixJobsPassed": True, "artifacts": [{}] * 10}
    rows = []
    for index, app in enumerate(APPS):
        rows.append({"Id": str(index + 1) * 64, "Image": images[index]["imageId"],
                     "Config": {"Image": "nakh-" + app + ":" + source, "User": "nakh",
                                "Labels": {"com.docker.compose.service": app, "com.docker.compose.project": "nakh-trial",
                                           "org.opencontainers.image.revision": source,
                                           "org.opencontainers.image.source": REPOSITORY},
                                "Env": ["NAKH_RELEASE=" + source, "NAKH_ENV=staging", "NAKH_DATABASE_ROLE_ISOLATION_ENABLED=true",
                                        "NAKH_QUEUE_PREFIX=private-test", "SAVED_PASSWORD=DO_NOT_LEAK", "BOT_TOKEN=DO_NOT_LEAK"]},
                     "HostConfig": {"ReadonlyRootfs": True},
                     "State": {"Running": False, "Status": "exited", "Pid": 0, "ExitCode": 0,
                               "FinishedAt": "2026-11-05T12:00:00Z"}})
    policy = {"mode": "closed", "sourceSha": source, "version": 13,
              "policyId": "00000000-0000-4000-8000-000000000001"}
    return [binding, build, accepted, rows, [], [], policy, True]


class DeletionCutoverTests(unittest.TestCase):
    def test_ledger_format_image_tag_requires_exact_reviewed_build_and_digest(self):
        data = fixture()
        for image, row in zip(data[1]["images"], data[3]):
            image["image"] = row["Config"]["Image"] + "-vps-ledger"
            row["Config"]["Image"] = image["image"]
        self.assertTrue(validate_snapshot(*data)["allApplicationProducersStopped"])
        for mutate in [lambda d: d[1]["images"][0].pop("image"),
                       lambda d: d[1]["images"][0].update(image="unreviewed:image"),
                       lambda d: d[3][0].update(Image="sha256:" + "f" * 64)]:
            changed = copy.deepcopy(data)
            mutate(changed)
            with self.assertRaises(ValueError):
                validate_snapshot(*changed)

    def test_private_file_and_legacy_inline_webhook_secret_stay_out_of_receipts(self):
        secret = "DO_NOT_LEAK_" * 5
        gateway = {"Config": {"Env": ["NAKH_TELEGRAM_WEBHOOK_SECRET=" + secret]}}
        self.assertEqual(webhook_secret(gateway), secret)
        source = (ROOT / "secrets").as_posix() + "/release/services/telegram-gateway"
        gateway = {"Config": {"Env": ["NAKH_TELEGRAM_WEBHOOK_SECRET_FILE=/run/nakh-secrets/webhook"]},
                   "Mounts": [{"Type": "bind", "Source": source, "Destination": "/run/nakh-secrets", "RW": False}]}
        with patch("deletion_cutover.private_webhook_file", return_value=secret) as read:
            self.assertEqual(webhook_secret(gateway), secret)
        self.assertEqual(read.call_args[0][0], ROOT / "secrets/release/services/telegram-gateway/webhook")
        self.assertNotIn(secret, json.dumps(validate_snapshot(*fixture())))

    def test_ambiguous_or_invalid_webhook_environment_never_reads_a_file(self):
        for env in [[], ["NAKH_TELEGRAM_WEBHOOK_SECRET=short"],
                    ["NAKH_TELEGRAM_WEBHOOK_SECRET=" + "a" * 32 + "\n"],
                    ["NAKH_TELEGRAM_WEBHOOK_SECRET_FILE=/run/nakh-secrets/a/../webhook"],
                    ["NAKH_TELEGRAM_WEBHOOK_SECRET_FILE=/etc/webhook"],
                    ["NAKH_TELEGRAM_WEBHOOK_SECRET=", "NAKH_TELEGRAM_WEBHOOK_SECRET_FILE=/run/nakh-secrets/webhook"]]:
            with patch("deletion_cutover.private_webhook_file") as read, self.assertRaises(ValueError):
                webhook_secret({"Config": {"Env": env}})
            read.assert_not_called()

    def test_writable_foreign_duplicate_or_traversing_secret_mount_is_denied(self):
        source = (ROOT / "secrets").as_posix() + "/release/services/gateway"
        good = {"Type": "bind", "Source": source, "Destination": "/run/nakh-secrets", "RW": False}
        bad = [{**good, "RW": True}, {**good, "Type": "volume"},
               {**good, "Source": "/etc"}, {**good, "Source": source + "/../../../../etc"},
               {**good, "Source": source + "//extra"}, {**good, "Destination": "/other"}]
        for mounts in [[], [good, good], *[[m] for m in bad]]:
            gateway = {"Config": {"Env": ["NAKH_TELEGRAM_WEBHOOK_SECRET_FILE=/run/nakh-secrets/webhook"]}, "Mounts": mounts}
            with patch("deletion_cutover.private_webhook_file") as read, self.assertRaises(ValueError):
                webhook_secret(gateway)
            read.assert_not_called()

    def test_private_webhook_file_rejects_unsafe_metadata_before_reading(self):
        for change in [{"st_uid": 1000}, {"st_nlink": 2}, {"st_mode": stat.S_IFREG | 0o644},
                       {"st_mode": stat.S_IFIFO | 0o400}, {"st_size": 0}, {"st_size": 259}]:
            values = {"st_uid": 10001, "st_nlink": 1, "st_mode": stat.S_IFREG | 0o400, "st_size": 64}
            values.update(change)
            with (
                patch("deletion_cutover.ROOT", Path.cwd()),
                patch("deletion_cutover.private_parent"),
                patch("deletion_cutover.os.O_DIRECTORY", 65536, create=True),
                patch("deletion_cutover.os.O_NOFOLLOW", 131072, create=True),
                patch("deletion_cutover.os.O_NONBLOCK", 2048, create=True),
                patch("deletion_cutover.os.open", side_effect=[10, 11]) as opened,
                patch("deletion_cutover.os.fstat", side_effect=[SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0), SimpleNamespace(**values)]),
                patch("deletion_cutover.os.fdopen") as read,
                patch("deletion_cutover.os.close") as closed,
                self.assertRaises(ValueError),
            ):
                private_webhook_file(Path.cwd() / "secrets/webhook")
            read.assert_not_called()
            self.assertTrue(all(c.args[1] & 131072 for c in opened.call_args_list))
            self.assertEqual([c.args[0] for c in closed.call_args_list], [11, 10])

    def test_changed_webhook_file_is_denied_and_service_owned_private_file_is_supported(self):
        before = SimpleNamespace(st_mode=stat.S_IFREG | 0o400, st_uid=10001, st_nlink=1,
                                 st_size=64, st_mtime_ns=1, st_ctime_ns=2)
        for changed in [False, True]:
            after = copy.copy(before)
            if changed:
                after.st_mtime_ns = 3
            with (
                patch("deletion_cutover.ROOT", Path.cwd()),
                patch("deletion_cutover.private_parent"),
                patch("deletion_cutover.os.O_DIRECTORY", 65536, create=True),
                patch("deletion_cutover.os.O_NOFOLLOW", 131072, create=True),
                patch("deletion_cutover.os.O_NONBLOCK", 2048, create=True),
                patch("deletion_cutover.os.open", side_effect=[10, 11]),
                patch("deletion_cutover.os.fstat", side_effect=[SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0), before, after]),
                patch("deletion_cutover.os.fdopen", mock_open(read_data=b"a" * 64)),
                patch("deletion_cutover.os.close"),
            ):
                if changed:
                    with self.assertRaises(ValueError):
                        private_webhook_file(Path.cwd() / "secrets/webhook")
                else:
                    self.assertEqual(private_webhook_file(Path.cwd() / "secrets/webhook"), "a" * 64)

    def test_webhook_symlinks_and_parent_traversal_never_read_content(self):
        with patch("deletion_cutover.ROOT", Path.cwd()), patch("deletion_cutover.os.open") as opened:
            with self.assertRaises(ValueError):
                private_webhook_file(Path.cwd() / "secrets/../foreign/webhook")
            opened.assert_not_called()
        with (
            patch("deletion_cutover.ROOT", Path.cwd()),
            patch("deletion_cutover.private_parent"),
            patch("deletion_cutover.os.O_DIRECTORY", 65536, create=True),
            patch("deletion_cutover.os.O_NOFOLLOW", 131072, create=True),
                patch("deletion_cutover.os.O_NONBLOCK", 2048, create=True),
            patch("deletion_cutover.os.open", side_effect=OSError("symlink refused")) as opened,
            patch("deletion_cutover.os.fdopen") as read,
            self.assertRaises(OSError),
        ):
            private_webhook_file(Path.cwd() / "secrets/webhook")
        self.assertTrue(opened.call_args.args[1] & 131072)
        read.assert_not_called()

    def test_nonprivate_or_foreign_intermediate_secret_directory_is_denied(self):
        for mode, uid in [(stat.S_IFDIR | 0o755, 10001), (stat.S_IFDIR | 0o700, 1000),
                          (stat.S_IFLNK | 0o700, 0)]:
            with (
                patch("deletion_cutover.ROOT", Path.cwd()),
                patch("deletion_cutover.private_parent"),
                patch("deletion_cutover.os.O_DIRECTORY", 65536, create=True),
                patch("deletion_cutover.os.O_NOFOLLOW", 131072, create=True),
                patch("deletion_cutover.os.O_NONBLOCK", 2048, create=True),
                patch("deletion_cutover.os.open", side_effect=[10, 11]),
                patch("deletion_cutover.os.fstat", side_effect=[SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0), SimpleNamespace(st_mode=mode, st_uid=uid)]),
                patch("deletion_cutover.os.fdopen") as read,
                patch("deletion_cutover.os.close") as closed,
                self.assertRaises(ValueError),
            ):
                private_webhook_file(Path.cwd() / "secrets/service/webhook")
            read.assert_not_called()
            self.assertEqual([c.args[0] for c in closed.call_args_list], [11, 10])

    def test_only_content_free_selected_facts_leave_validation(self):
        result = validate_snapshot(*fixture())
        self.assertTrue(result["allApplicationProducersStopped"])
        self.assertFalse(result["deletionAuthorized"])
        self.assertFalse(result["productionQualified"])
        self.assertFalse(result["redisAbsenceClaimed"])
        self.assertNotIn("observationScope", result)
        encoded = json.dumps(result)
        self.assertNotIn("DO_NOT_LEAK", encoded)
        self.assertNotIn("private-test", encoded)
        self.assertEqual(len(result["fleet"]), 4)

    def test_live_or_uncertain_processes_never_become_a_drain(self):
        for field, value in [("Running", True), ("Status", "running"), ("Pid", 42),
                             ("ExitCode", 137), ("FinishedAt", "0001-01-01T00:00:00Z")]:
            data = fixture()
            data[3][0]["State"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_snapshot(*data)

    def test_missing_duplicate_or_extra_producers_are_rejected(self):
        for change in [lambda rows: rows.pop(), lambda rows: rows.append(copy.deepcopy(rows[0])),
                       lambda rows: rows.__setitem__(0, copy.deepcopy(rows[1]))]:
            data = fixture()
            change(data[3])
            with self.assertRaises(ValueError):
                validate_snapshot(*data)

    def test_image_source_user_and_filesystem_substitution_are_rejected(self):
        for target, field, value in [("row", "Image", "sha256:" + "f" * 64),
                                     ("Config", "User", "root"), ("Config", "Image", "nakh-api:other"),
                                     ("HostConfig", "ReadonlyRootfs", False),
                                     ("Labels", "org.opencontainers.image.revision", "b" * 40),
                                     ("Labels", "com.docker.compose.project", "other")]:
            data = fixture()
            row = data[3][0]
            selected = row if target == "row" else row["Config"]["Labels"] if target == "Labels" else row[target]
            selected[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_snapshot(*data)

    def test_different_namespace_or_unqualified_configuration_is_rejected(self):
        for value in ["NAKH_QUEUE_PREFIX=another", "NAKH_RELEASE=" + "b" * 40,
                      "NAKH_ENV=production", "NAKH_DATABASE_ROLE_ISOLATION_ENABLED=false"]:
            data = fixture()
            key = value.split("=", 1)[0]
            data[3][1]["Config"]["Env"] = [entry for entry in data[3][1]["Config"]["Env"] if not entry.startswith(key + "=")] + [value]
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_snapshot(*data)

    def test_rogue_containers_and_host_node_processes_block_receipts(self):
        for running, processes in [([fixture()[3][0]], []),
                                   ([{"Config": {"Image": "nakh-old:legacy"}}], []),
                                   ([], [123])]:
            data = fixture()
            data[4], data[5] = running, processes
            with self.assertRaises(ValueError):
                validate_snapshot(*data)

    def test_unrelated_database_and_scanner_containers_do_not_claim_to_be_producers(self):
        data = fixture()
        data[4] = [{"Config": {"Image": "postgres:17"}}, {"Config": {"Image": "clamav:1.5"}}]
        self.assertTrue(validate_snapshot(*data)["allApplicationProducersStopped"])

    def test_closed_policy_and_live_transport_hold_are_both_required(self):
        for field, value in [("mode", "cohort"), ("sourceSha", "b" * 40), ("version", 0), ("version", True)]:
            data = fixture()
            data[6][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_snapshot(*data)
        data = fixture()
        data[7] = False
        with self.assertRaises(ValueError):
            validate_snapshot(*data)

    def test_unknown_sources_or_incomplete_ci_never_qualify(self):
        for index, field, value in [(0, "environment", "production"), (0, "sourceSha", "dev"),
                                    (1, "sourceSha", "b" * 40), (2, "sourceSha", "b" * 40),
                                    (2, "allSixJobsPassed", False), (2, "artifacts", [{}] * 9)]:
            data = fixture()
            data[index][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_snapshot(*data)

    def test_command_cannot_be_used_as_a_fixture_transport_or_without_linux_root(self):
        with patch("deletion_cutover.sys.platform", "win32"), self.assertRaises(ValueError):
            main(["binding", "build", "accepted", "output"])
        with patch("deletion_cutover.sys.platform", "linux"), patch("deletion_cutover.os.getuid", return_value=1000, create=True), self.assertRaises(ValueError):
            main(["binding", "build", "accepted", "output"])
        with patch("deletion_cutover.sys.platform", "linux"), patch("deletion_cutover.os.getuid", return_value=0, create=True), self.assertRaises(ValueError):
            main(["--fixture"])

    def test_changed_second_observation_never_creates_a_receipt(self):
        data = fixture()
        data[0]["machineId"] = "c" * 32
        changed = copy.deepcopy(data)
        changed[3][0]["Id"] = "f" * 64
        with (
            patch("deletion_cutover.sys.platform", "linux"),
            patch("deletion_cutover.os.getuid", return_value=0, create=True),
            patch("deletion_cutover.private_json", side_effect=data[:3]),
            patch("deletion_cutover.Path.read_text", return_value="c" * 32),
            patch("deletion_cutover.observe", side_effect=[tuple(data[3:]), tuple(changed[3:])]),
            patch("deletion_cutover.os.open") as output,
            self.assertRaises(ValueError),
        ):
            main(["binding", "build", "accepted", "output"])
        output.assert_not_called()

    def test_host_identity_mismatch_never_observes_or_opens_output(self):
        data = fixture()
        data[0]["machineId"] = "c" * 32
        with (
            patch("deletion_cutover.sys.platform", "linux"),
            patch("deletion_cutover.os.getuid", return_value=0, create=True),
            patch("deletion_cutover.private_json", side_effect=data[:3]),
            patch("deletion_cutover.Path.read_text", return_value="d" * 32),
            patch("deletion_cutover.observe") as observe,
            patch("deletion_cutover.os.open") as output,
            self.assertRaises(ValueError),
        ):
            main(["binding", "build", "accepted", "output"])
        observe.assert_not_called()
        output.assert_not_called()

    def test_unknown_stop_timestamps_are_not_evidence(self):
        for value in ["not-a-date", None, "0001-01-01T00:00:00Z", "2026-11-05T12:00:00"]:
            data = fixture()
            data[3][0]["State"]["FinishedAt"] = value
            with self.assertRaises(ValueError):
                validate_snapshot(*data)

    def test_private_inputs_reject_hardlinks_public_modes_owners_and_oversize_before_reading(self):
        for change in [{"st_nlink": 2}, {"st_uid": 1000}, {"st_mode": stat.S_IFREG | 0o644},
                       {"st_size": 0}, {"st_size": 1048577}, {"st_mode": stat.S_IFDIR | 0o700}]:
            values = {"st_nlink": 1, "st_uid": 0, "st_mode": stat.S_IFREG | 0o600, "st_size": 10}
            values.update(change)
            with (
                patch("deletion_cutover.private_parent"),
                patch("deletion_cutover.os.O_NOFOLLOW", 131072, create=True),
                patch("deletion_cutover.os.O_NONBLOCK", 2048, create=True),
                patch("deletion_cutover.os.open", return_value=123) as opened,
                patch("deletion_cutover.os.fstat", return_value=SimpleNamespace(**values)),
                patch("deletion_cutover.os.fdopen") as read,
                patch("deletion_cutover.os.close") as closed,
                self.assertRaises(ValueError),
            ):
                private_json("/private/input.json")
            self.assertEqual(opened.call_args[0][1] & 131072, 131072)
            read.assert_not_called()
            closed.assert_called_once_with(123)


if __name__ == "__main__":
    unittest.main()
