"""AWS-mocked state continuity from the last accepted flat staging root."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS = ROOT / "artifacts"
BASE = "68b521a4af323d8d0da916c3756fdc05ab67f2a1"
STAGING = ROOT / "deploy/terraform/staging"
RUNTIME = ROOT / "deploy/terraform/modules/runtime"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def resources(module):
    return module.get("resources", []) + [
        row for child in module.get("child_modules", []) for row in resources(child)
    ]


def main():
    ARTIFACTS.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="terraform-state-move-", dir=ARTIFACTS))
    legacy, current = work / "legacy", work / "current"
    legacy.mkdir()
    current.mkdir()
    versions = (RUNTIME / "versions.tf").read_text(encoding="utf-8")
    prefix = "deploy/terraform/staging/"
    for name in git("ls-tree", "-r", "--name-only", BASE, prefix).splitlines():
        if not name.endswith(".tf") or "/tests/" in name:
            continue
        source = git("show", BASE + ":" + name) + "\n"
        if name.endswith("/versions.tf"):
            source = versions  # Only required providers; use the test's mock AWS.
        source = re.sub(
            r'\$\{path.module\}/../../([^"\n]+)',
            lambda match: (ROOT / "deploy" / match[1]).as_posix(), source,
        )
        (legacy / Path(name).name).write_text(source, encoding="utf-8", newline="\n")
    for path in STAGING.glob("*.tf"):
        source = path.read_text(encoding="utf-8")
        if path.name == "versions.tf":
            source = versions
        source = re.sub(
            r'source\s*=\s*"../modules/runtime"',
            'source = "../../../deploy/terraform/modules/runtime"', source,
        )
        (current / path.name).write_text(source, encoding="utf-8", newline="\n")
    (work / "versions.tf").write_text(versions, encoding="utf-8")
    (work / ".terraform.lock.hcl").write_bytes((STAGING / ".terraform.lock.hcl").read_bytes())
    tests = work / "tests"
    tests.mkdir()
    header = (STAGING / "tests/runtime.tftest.hcl").read_text(encoding="utf-8").split("variables {", 1)[0]
    if 'mock_provider "aws"' not in header:
        raise RuntimeError("Mocked AWS configuration required")
    (tests / "migration.tftest.hcl").write_text(header + '''
variables {
  aws_region = "eu-west-1"
  telegram_bot_token = "123456789:synthetic-state-migration-token"
  telegram_webhook_secret = "synthetic-state-migration-webhook-32"
  telegram_action_token_key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
}
run "accepted_legacy_state" {
  module { source = "./legacy" }
  state_key = "legacy-upgrade"
  command = apply
}
run "extracted_runtime_plan" {
  module { source = "./current" }
  state_key = "legacy-upgrade"
  command = plan
}
''', encoding="utf-8", newline="\n")
    terraform = os.environ.get("TERRAFORM_BIN", "terraform")
    with (work / "init.log").open("w", encoding="utf-8") as log:
        subprocess.run([terraform, "-chdir=" + str(work), "init", "-backend=false", "-lockfile=readonly", "-input=false"], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
    # Verbose JSON can contain synthetic generated secrets. Keep it private and
    # upload only the bounded public proof below, never raw state or plan output.
    log_path = work / "test.jsonl"
    with log_path.open("w", encoding="utf-8") as log:
        subprocess.run([terraform, "-chdir=" + str(work), "test", "-json", "-verbose"], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
    old = plan = summary = None
    with log_path.open(encoding="utf-8") as log:
        for line in log:
            if not line.startswith("{"):
                continue
            event = json.loads(line)
            if event.get("type") == "test_state":
                old = [row for row in resources(event["test_state"]["root_module"]) if row.get("mode") == "managed"]
            elif event.get("type") == "test_plan":
                plan = [row for row in event["test_plan"]["resource_changes"] if row.get("mode") == "managed"]
            elif event.get("type") == "test_summary":
                summary = event["test_summary"]
    if not old or not plan or summary != {"status": "pass", "passed": 2, "failed": 0, "errored": 0, "skipped": 0}:
        raise RuntimeError("Complete state rehearsal required")
    if len(old) != len(plan) or {row["address"] for row in old} != {row.get("previous_address") for row in plan} or any(row["change"]["actions"] != ["no-op"] for row in plan):
        raise RuntimeError("Refactoring must move every accepted instance without infrastructure changes")
    paths = sorted([*STAGING.glob("*.tf"), *RUNTIME.glob("*.tf")])
    proof = {
        "sourceSha": git("rev-parse", "HEAD"), "legacySourceSha": BASE,
        "managedInstances": len(old), "movedInstances": len(plan),
        "created": 0, "updated": 0, "deleted": 0, "replaced": 0,
        "awsMocked": True, "actualProviderAcceptance": False,
        "configurationHashes": {str(path.relative_to(ROOT)).replace("\\", "/"): hashlib.sha256(path.read_text(encoding="utf-8").replace("\r\n", "\n").encode()).hexdigest() for path in paths},
    }
    (ARTIFACTS / "m9-infrastructure-migration.json").write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in proof.items() if key != "configurationHashes"}))
    if work.resolve().parent != ARTIFACTS.resolve() or not work.name.startswith("terraform-state-move-"):
        raise RuntimeError("Unsafe rehearsal cleanup path")
    def clear_readonly(function, name, error):
        path = Path(name)
        if not isinstance(error, PermissionError) or not path.resolve().is_relative_to(work.resolve()):
            raise error
        path.chmod(stat.S_IREAD | stat.S_IWRITE)
        function(name)
    try:
        shutil.rmtree(work, onexc=clear_readonly)
    except PermissionError:
        # A Windows provider process may still hold an executable briefly.
        # Cleanup is optional; Terraform/plan assertions above are mandatory.
        print("Verified temporary cleanup deferred; public proof retained.")


if __name__ == "__main__":
    main()
