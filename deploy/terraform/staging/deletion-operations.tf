locals {
  m8_open_phases = [for phase in local.m8_telemetry.phases : phase if phase != "completed"]
  m8_age_alarms = { for item in flatten([for phase in local.m8_open_phases : [
    { key = "${phase}-due", phase = phase, metric = "nakh.m8.deletion.due_age", threshold = var.account_deletion_due_age_seconds },
    { key = "${phase}-oldest", phase = phase, metric = "nakh.m8.deletion.oldest_age", threshold = var.account_deletion_oldest_age_seconds }
  ]]) : item.key => item }
  m8_global_alarms = {
    failure        = { metric = "nakh.m8.deletion.failures", threshold = 1 }
    health_failure = { metric = "nakh.m8.deletion.health.failures", threshold = 1 }
    lease_lost     = { metric = "nakh.m8.deletion.lease_lost", threshold = 10 }
    retries        = { metric = "nakh.m8.deletion.retries", threshold = 10 }
  }
}
resource "aws_cloudwatch_metric_alarm" "deletion_alignment" {
  for_each            = var.account_deletion_monitoring_enabled ? toset(local.m8_telemetry.phases) : toset([])
  alarm_name          = "${local.name}-m8-alignment-${replace(each.value, "_", "-")}"
  alarm_description   = "Deletion queue alignment drift. Check freshness, then diagnose; this is not completion proof. Runbook: deploy/runbooks/m8-operations.md"
  metric_name         = "nakh.m8.deletion.inconsistent"
  dimensions          = { phase = each.value }
  statistic           = "Maximum"
  threshold           = 1
  namespace           = "Nakh/Platform"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
}
resource "aws_cloudwatch_metric_alarm" "deletion_age" {
  for_each            = var.account_deletion_monitoring_enabled ? local.m8_age_alarms : {}
  alarm_name          = "${local.name}-m8-${replace(each.key, "_", "-")}"
  alarm_description   = "Deletion work age exceeds an operational threshold. Not retention-release authority. Runbook: deploy/runbooks/m8-operations.md"
  metric_name         = each.value.metric
  dimensions          = { phase = each.value.phase }
  statistic           = "Maximum"
  threshold           = each.value.threshold
  namespace           = "Nakh/Platform"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
}
resource "aws_cloudwatch_metric_alarm" "deletion_failure" {
  for_each            = var.account_deletion_monitoring_enabled ? local.m8_global_alarms : {}
  alarm_name          = "${local.name}-m8-${replace(each.key, "_", "-")}"
  alarm_description   = "Deletion ${each.key}. Inspect bounded worker outcomes without private errors. Runbook: deploy/runbooks/m8-operations.md"
  metric_name         = each.value.metric
  statistic           = "Sum"
  threshold           = each.value.threshold
  namespace           = "Nakh/Platform"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
}
resource "aws_cloudwatch_metric_alarm" "deletion_freshness" {
  count               = var.account_deletion_monitoring_enabled ? 1 : 0
  alarm_name          = "${local.name}-m8-sample-age"
  alarm_description   = "Missing/stale deletion health sample: backlog counts are unavailable. Runbook: deploy/runbooks/m8-operations.md"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 300
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
  metric_query {
    id          = "sample"
    return_data = false
    metric {
      namespace   = "Nakh/Platform"
      metric_name = "nakh.m8.deletion.sampled_at"
      period      = 60
      stat        = "Maximum"
    }
  }
  metric_query {
    id          = "age"
    expression  = "EPOCH(sample)-sample"
    label       = "Deletion health sample age in seconds"
    return_data = true
  }
}
resource "aws_cloudwatch_dashboard" "deletion" {
  count          = var.account_deletion_monitoring_enabled ? 1 : 0
  dashboard_name = "${local.name}-m8-deletion"
  dashboard_body = jsonencode({ widgets = concat([
    for index, item in [
      { name = "records", title = "Pending deletion records by phase" },
      { name = "oldest_age", title = "Oldest pending deletion in seconds" },
      { name = "due_age", title = "Overdue unleased work in seconds" },
      { name = "inconsistent", title = "Deletion queue alignment inconsistencies" },
      { name = "leased", title = "Current deletion leases" },
      { name = "retrying", title = "Records with a retry indication" }
      ] : {
      type = "metric", x = (index % 2) * 12, y = floor(index / 2) * 6, width = 12, height = 6,
      properties = { title = item.title, region = var.aws_region, view = "timeSeries", period = 300, stat = "Maximum",
      metrics = [for phase in(item.name == "inconsistent" ? local.m8_telemetry.phases : local.m8_open_phases) : ["Nakh/Platform", "nakh.m8.deletion.${item.name}", "phase", phase]] }
    }
    ], [
    { type = "metric", x = 0, y = 18, width = 12, height = 6,
      properties = { title = "Deletion failures, retries and lease loss", region = var.aws_region, view = "timeSeries", period = 300, stat = "Sum",
    metrics = [for item in values(local.m8_global_alarms) : ["Nakh/Platform", item.metric]] } },
    { type = "metric", x = 12, y = 18, width = 12, height = 6,
      properties = { title = "Deletion health sample age in seconds", region = var.aws_region, view = "timeSeries", period = 60,
    metrics = [["Nakh/Platform", "nakh.m8.deletion.sampled_at", { id = "sample", visible = false, stat = "Maximum" }], [{ expression = "EPOCH(sample)-sample", id = "age", label = "Sample age" }]] } }
  ]) })
}
