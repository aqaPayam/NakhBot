"""Read-only physical producer-drain observation for the private staging VPS.

This does not stop processes, remove Redis data, authorize deletion, or qualify
production. A receipt is possible only after a separate operator closes admission,
holds the webhook and gracefully stops every application producer.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import urllib.error
import urllib.request

APPS = ("api", "telegram-gateway", "worker", "scheduler")
REPOSITORY = "https://github.com/aqaPayam/NakhBot"
ROOT = Path("/opt/nakh")
SHA = re.compile(r"[a-f0-9]{40}\Z")
IMAGE = re.compile(r"sha256:[a-f0-9]{64}\Z")


def denied():
    raise ValueError("Private VPS deletion cutover unavailable.")


def stopped_time(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        return False
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).year > 2000
    except ValueError:
        return False


def private_parent(path):
    path = Path(path)
    if not path.is_absolute() or str(path) != os.path.normpath(str(path)):
        denied()
    parent = path.parent
    while True:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            denied()
        if parent == parent.parent:
            return
        parent = parent.parent


def private_json(path):
    private_parent(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                info.st_nlink != 1 or info.st_mode & 0o077 or not 0 < info.st_size <= 1048576):
            denied()
        with os.fdopen(fd, "rb", closefd=False) as stream:
            return json.loads(stream.read(1048577))
    finally:
        os.close(fd)


def validate_snapshot(binding, build, accepted, rows, running, node_pids, policy, held):
    """Validate a supplied snapshot. Only main() obtains actual host observations."""
    source = binding.get("sourceSha")
    if (binding.get("version") != 1 or binding.get("environment") != "staging" or
            not isinstance(source, str) or not SHA.fullmatch(source) or
            build.get("sourceSha") != source or accepted.get("sourceSha") != source or
            accepted.get("allSixJobsPassed") is not True or len(accepted.get("artifacts", [])) != 10):
        denied()
    images = build.get("images", [])
    if (len(images) != 4 or {r.get("service") for r in images} != set(APPS) or
            any(not IMAGE.fullmatch(r.get("imageId", "")) or r.get("nonRoot") is not True for r in images)):
        denied()
    expected = {r["service"]: r["imageId"] for r in images}
    tags = {}
    for row in images:
        canonical = "nakh-" + row["service"] + ":" + source
        tag = row.get("image", canonical)
        if tag not in {canonical, canonical + "-vps-ledger"}:
            denied()
        tags[row["service"]] = tag
    if len(rows) != 4:
        denied()
    fleet = []
    prefixes = set()
    identifiers = set()
    for row in rows:
        labels = row.get("Config", {}).get("Labels", {})
        app = labels.get("com.docker.compose.service")
        state = row.get("State", {})
        if (app not in APPS or app in {r["service"] for r in fleet} or
                labels.get("com.docker.compose.project") != "nakh-trial" or
                labels.get("org.opencontainers.image.revision") != source or
                labels.get("org.opencontainers.image.source") != REPOSITORY or
                row.get("Config", {}).get("Image") != tags.get(app) or
                row.get("Image") != expected[app] or
                row.get("Config", {}).get("User") != "nakh" or
                row.get("HostConfig", {}).get("ReadonlyRootfs") is not True or
                state.get("Running") is not False or state.get("Status") != "exited" or
                state.get("Pid") != 0 or state.get("ExitCode") != 0 or
                not stopped_time(state.get("FinishedAt")) or
                not re.fullmatch(r"[a-f0-9]{64}", row.get("Id", ""))):
            denied()
        env = dict(value.split("=", 1) for value in row["Config"].get("Env", []) if "=" in value)
        prefix = env.get("NAKH_QUEUE_PREFIX", "nakh-local")
        if (env.get("NAKH_RELEASE") != source or env.get("NAKH_ENV") != "staging" or
                env.get("NAKH_DATABASE_ROLE_ISOLATION_ENABLED") != "true" or
                not 1 <= len(prefix) <= 80):
            denied()
        prefixes.add(prefix)
        identifiers.add(row["Id"])
        fleet.append({"service": app, "containerId": row["Id"], "imageId": row["Image"],
                      "finishedAt": state["FinishedAt"], "exitCode": 0, "pid": 0})
    if len(identifiers) != 4 or len(prefixes) != 1 or node_pids:
        denied()
    for row in running:
        config = row.get("Config", {})
        if (config.get("Image", "").startswith("nakh-") or
                config.get("Labels", {}).get("org.opencontainers.image.source") == REPOSITORY):
            denied()
    if (held is not True or policy.get("mode") != "closed" or
            policy.get("sourceSha") != source or not isinstance(policy.get("version"), int) or
            isinstance(policy["version"], bool) or policy["version"] < 1 or
            not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", policy.get("policyId", ""))):
        denied()
    return {"schemaVersion": 1, "applicationSourceSha": source, "environment": "staging",
            "fleet": sorted(fleet, key=lambda row: row["service"]), "closedPolicy": policy,
            "queuePrefixSha256": hashlib.sha256(next(iter(prefixes)).encode()).hexdigest(),
            "suppliedCiReceiptSha256": hashlib.sha256(json.dumps(accepted, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
            "allApplicationProducersStopped": True, "unexpectedNodeProducers": 0,
            "webhookTransportHeld": True, "productionQualified": False,
            "deletionAuthorized": False, "redisAbsenceClaimed": False}


def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if result.returncode:
        denied()
    return result.stdout


def private_webhook_file(path):
    """Read only below the protected host secret root; never follow a symlink.

    Service-owned private files are intentional: the deployed read-only bind
    mounts let UID 10001 read them without making values inspectable in Env.
    Directory-relative opens also fence replacement of intermediate paths.
    """
    root = ROOT / "secrets"
    path = Path(path)
    if not path.is_absolute() or str(path) != os.path.normpath(str(path)):
        denied()
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        denied()
    if not parts or any(part in {".", ".."} for part in parts):
        denied()
    fds = []
    try:
        private_parent(root / "probe")
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        fds.append(fd)
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            denied()
        for part in parts[:-1]:
            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            fds.append(fd)
            info = os.fstat(fd)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid not in {0, 10001} or info.st_mode & 0o077:
                denied()
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        fds.append(fd)
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid not in {0, 10001} or
                before.st_nlink != 1 or before.st_mode & 0o077 or not 32 <= before.st_size <= 258):
            denied()
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(259)
        after = os.fstat(fd)
        fields = ("st_size", "st_mtime_ns", "st_ctime_ns", "st_mode", "st_uid", "st_nlink")
        if len(data) != before.st_size or any(getattr(before, k) != getattr(after, k) for k in fields):
            denied()
        return data.decode("ascii").removesuffix("\n").removesuffix("\r")
    finally:
        for fd in reversed(fds):
            os.close(fd)


def webhook_secret(gateway):
    env = dict(value.split("=", 1) for value in gateway.get("Config", {}).get("Env", []) if "=" in value)
    inline, file = env.get("NAKH_TELEGRAM_WEBHOOK_SECRET"), env.get("NAKH_TELEGRAM_WEBHOOK_SECRET_FILE")
    if inline is not None and file is not None:
        denied()
    if file is not None:
        if not re.fullmatch(r"/run/nakh-secrets/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", file):
            denied()
        mounts = [m for m in gateway.get("Mounts", []) if m.get("Destination") == "/run/nakh-secrets"]
        if len(mounts) != 1 or mounts[0].get("Type") != "bind" or mounts[0].get("RW") is not False:
            denied()
        source = mounts[0].get("Source")
        if (not isinstance(source, str) or not source.startswith((ROOT / "secrets").as_posix() + "/") or
                source != PurePosixPath(source).as_posix() or ".." in PurePosixPath(source).parts):
            denied()
        inline = private_webhook_file(Path(source) / PurePosixPath(file).name)
    if not isinstance(inline, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", inline):
        denied()
    return inline


def observe(binding):
    base = ["docker", "compose", "-p", "nakh-trial", "-f", str(ROOT / "compose.yaml"),
            "-f", str(ROOT / "compose.scanner.yaml")]
    ids = []
    for app in APPS:
        value = command(base + ["ps", "--all", "--quiet", app]).splitlines()
        if len(value) != 1 or not re.fullmatch(r"[a-f0-9]{64}", value[0]):
            denied()
        ids.extend(value)
    rows = json.loads(command(["docker", "inspect", *ids]))
    active = command(["docker", "ps", "--quiet", "--no-trunc"]).splitlines()
    running = json.loads(command(["docker", "inspect", *active])) if active else []
    node_pids = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            if (entry / "comm").read_text().strip() in {"node", "nodejs", "bun", "deno"}:
                node_pids.append(int(entry.name))
        except FileNotFoundError:
            continue
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", binding.get("databaseName", "")) or not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", binding.get("databaseUser", "")):
        denied()
    query = "SELECT json_build_object('policyId',id,'mode',result_code,'sourceSha',metadata->>'sourceSha','version',platform.launch_policy_version(id)) FROM platform.audit_logs WHERE event_type='platform.launch-policy-applied.v1' ORDER BY ((metadata->>'version')::bigint) DESC LIMIT 1"
    policy = json.loads(command(base + ["exec", "-T", "postgres", "psql", "-U", binding["databaseUser"], "-d", binding["databaseName"], "-v", "ON_ERROR_STOP=1", "-Atc", query]))
    gateway = next((row for row in rows if row.get("Config", {}).get("Labels", {}).get("com.docker.compose.service") == "telegram-gateway"), {})
    secret = webhook_secret(gateway)
    request = urllib.request.Request("https://bot.nakhtestbot.xyz/v1/providers/telegram/webhook", data=b"{}",
                                     headers={"Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            held = response.status == 503 and response.headers.get("Retry-After") == "60"
    except urllib.error.HTTPError as error:
        held = error.code == 503 and error.headers.get("Retry-After") == "60"
        error.close()
    return rows, running, node_pids, policy, held


def main(args):
    if sys.platform != "linux" or os.getuid() != 0 or len(args) != 4:
        denied()
    binding, build, accepted = [private_json(path) for path in args[:3]]
    machine = Path("/etc/machine-id").read_text().strip()
    if not re.fullmatch(r"[a-f0-9]{32}", machine) or binding.get("machineId") != machine:
        denied()
    first = validate_snapshot(binding, build, accepted, *observe(binding))
    second = validate_snapshot(binding, build, accepted, *observe(binding))
    if first != second or Path("/etc/machine-id").read_text().strip() != machine:
        denied()
    second.update({"observationScope": "actual_private_vps_producer_drain",
                   "hostIdentitySha256": hashlib.sha256(machine.encode()).hexdigest(),
                   "operatorCodeSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                   "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   "independentObservations": 2})
    body = (json.dumps(second, sort_keys=True, separators=(",", ":")) + "\n").encode()
    private_parent(args[3])
    fd = os.open(args[3], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as output:
            output.write(body)
            output.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    print(json.dumps({"producerDrainObserved": True, "receiptSha256": hashlib.sha256(body).hexdigest(),
                      "deletionAuthorized": False, "productionQualified": False}))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception:
        print("Private VPS deletion cutover unavailable; no usable observation was issued.", file=sys.stderr)
        sys.exit(1)
