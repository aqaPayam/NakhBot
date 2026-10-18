# Shared runtime resources

Use the guarded staging or production root. This module owns the existing
network, database, cache, ECS, secret, release-evidence and telemetry resources;
calling roots own provider account pins and encrypted backends.

Staging preserves the accepted names and one shared NAT gateway. Production
requires its own observed account, a different staging account, purpose database
credentials, deletion protection and final snapshots. Each production AZ has
its own NAT and matching private route. Both roots keep services inactive unless
the existing controlled activation gates pass.

The staging root retains its complete legacy move inventory. Targeted migration
registration includes the bootstrap metadata needed by the controller, while
ordinary service definitions remain outside that target. Actual provider plans,
costs and launch acceptance still require review.
