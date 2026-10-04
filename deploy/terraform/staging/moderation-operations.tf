locals {
  moderation_alarms = {
    pending_age = {
      metric_name = "nakh.m7.backlog.pending_report_oldest_age"
      statistic   = "Maximum"
      threshold   = 900
    }
    in_review_age = {
      metric_name = "nakh.m7.backlog.in_review_oldest_age"
      statistic   = "Maximum"
      threshold   = 900
    }
    active_scan_age = {
      metric_name = "nakh.m7.reconciliation.active_age"
      statistic   = "Maximum"
      threshold   = 1800
    }
    completed_scan_age = {
      metric_name = "nakh.m7.reconciliation.completed_age"
      statistic   = "Maximum"
      threshold   = 3600
    }
    never_completed = {
      metric_name = "nakh.m7.reconciliation.never_completed"
      statistic   = "Maximum"
      threshold   = 1
    }
    new_findings = {
      metric_name = "nakh.m7.reconciliation.new_findings"
      statistic   = "Sum"
      threshold   = 1
    }
    reconciliation_failure = {
      metric_name = "nakh.m7.reconciliation.failures"
      statistic   = "Sum"
      threshold   = 1
    }
    health_failure = {
      metric_name = "nakh.m7.operational_health.failures"
      statistic   = "Sum"
      threshold   = 1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "moderation" {
  for_each = local.moderation_alarms

  alarm_name          = "${local.name}-m7-${replace(each.key, "_", "-")}"
  alarm_description   = "M7 moderation ${each.key}. Runbook: deploy/runbooks/m7-operations.md"
  namespace           = "Nakh/Platform"
  metric_name         = each.value.metric_name
  statistic           = each.value.statistic
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = each.key == "completed_scan_age" ? "breaching" : "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
}
