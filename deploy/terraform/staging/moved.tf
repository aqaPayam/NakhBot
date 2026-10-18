moved {
  from = aws_vpc.main
  to   = module.runtime.aws_vpc.main
}

moved {
  from = aws_internet_gateway.main
  to   = module.runtime.aws_internet_gateway.main
}

moved {
  from = aws_subnet.public
  to   = module.runtime.aws_subnet.public
}

moved {
  from = aws_subnet.private
  to   = module.runtime.aws_subnet.private
}

moved {
  from = aws_eip.nat
  to   = module.runtime.aws_eip.nat["shared"]
}

moved {
  from = aws_nat_gateway.main
  to   = module.runtime.aws_nat_gateway.main["shared"]
}

moved {
  from = aws_route_table.public
  to   = module.runtime.aws_route_table.public
}

moved {
  from = aws_route.public_internet
  to   = module.runtime.aws_route.public_internet
}

moved {
  from = aws_route_table_association.public
  to   = module.runtime.aws_route_table_association.public
}

moved {
  from = aws_route_table.private
  to   = module.runtime.aws_route_table.private["shared"]
}

moved {
  from = aws_route.private_egress
  to   = module.runtime.aws_route.private_egress["shared"]
}

moved {
  from = aws_route_table_association.private
  to   = module.runtime.aws_route_table_association.private
}

moved {
  from = aws_security_group.load_balancer
  to   = module.runtime.aws_security_group.load_balancer
}

moved {
  from = aws_vpc_security_group_ingress_rule.alb_http
  to   = module.runtime.aws_vpc_security_group_ingress_rule.alb_http
}

moved {
  from = aws_vpc_security_group_ingress_rule.alb_https
  to   = module.runtime.aws_vpc_security_group_ingress_rule.alb_https
}

moved {
  from = aws_vpc_security_group_egress_rule.alb_to_services
  to   = module.runtime.aws_vpc_security_group_egress_rule.alb_to_services
}

moved {
  from = aws_security_group.services
  to   = module.runtime.aws_security_group.services
}

moved {
  from = aws_vpc_security_group_ingress_rule.service_api
  to   = module.runtime.aws_vpc_security_group_ingress_rule.service_api
}

moved {
  from = aws_vpc_security_group_egress_rule.service_egress
  to   = module.runtime.aws_vpc_security_group_egress_rule.service_egress
}

moved {
  from = aws_security_group.database
  to   = module.runtime.aws_security_group.database
}

moved {
  from = aws_vpc_security_group_ingress_rule.database_from_services
  to   = module.runtime.aws_vpc_security_group_ingress_rule.database_from_services
}

moved {
  from = aws_security_group.redis
  to   = module.runtime.aws_security_group.redis
}

moved {
  from = aws_vpc_security_group_ingress_rule.redis_from_services
  to   = module.runtime.aws_vpc_security_group_ingress_rule.redis_from_services
}

moved {
  from = aws_ecr_repository.service
  to   = module.runtime.aws_ecr_repository.service
}

moved {
  from = aws_ecr_lifecycle_policy.service
  to   = module.runtime.aws_ecr_lifecycle_policy.service
}

moved {
  from = aws_cloudwatch_log_group.service
  to   = module.runtime.aws_cloudwatch_log_group.service
}

moved {
  from = aws_cloudwatch_log_group.telemetry
  to   = module.runtime.aws_cloudwatch_log_group.telemetry
}

moved {
  from = aws_iam_role.ecs_execution
  to   = module.runtime.aws_iam_role.ecs_execution
}

moved {
  from = aws_iam_role_policy_attachment.ecs_execution
  to   = module.runtime.aws_iam_role_policy_attachment.ecs_execution
}

moved {
  from = aws_iam_role_policy.ecs_runtime_secrets
  to   = module.runtime.aws_iam_role_policy.ecs_runtime_secrets
}

moved {
  from = aws_iam_role.ecs_task
  to   = module.runtime.aws_iam_role.ecs_task
}

moved {
  from = aws_iam_role_policy.telemetry
  to   = module.runtime.aws_iam_role_policy.telemetry
}

moved {
  from = aws_ecs_cluster.main
  to   = module.runtime.aws_ecs_cluster.main
}

moved {
  from = aws_lb.public
  to   = module.runtime.aws_lb.public
}

moved {
  from = aws_lb_target_group.service
  to   = module.runtime.aws_lb_target_group.service
}

moved {
  from = aws_acm_certificate.public
  to   = module.runtime.aws_acm_certificate.public
}

moved {
  from = aws_route53_record.certificate_validation
  to   = module.runtime.aws_route53_record.certificate_validation
}

moved {
  from = aws_acm_certificate_validation.public
  to   = module.runtime.aws_acm_certificate_validation.public
}

moved {
  from = aws_lb_listener.http
  to   = module.runtime.aws_lb_listener.http
}

moved {
  from = aws_lb_listener.https
  to   = module.runtime.aws_lb_listener.https
}

moved {
  from = aws_lb_listener_rule.telegram
  to   = module.runtime.aws_lb_listener_rule.telegram
}

moved {
  from = aws_route53_record.public
  to   = module.runtime.aws_route53_record.public
}

moved {
  from = aws_ecs_task_definition.service
  to   = module.runtime.aws_ecs_task_definition.service
}

moved {
  from = aws_ecs_task_definition.migration
  to   = module.runtime.aws_ecs_task_definition.migration
}

moved {
  from = aws_ecs_service.service
  to   = module.runtime.aws_ecs_service.service
}

moved {
  from = aws_appautoscaling_target.service
  to   = module.runtime.aws_appautoscaling_target.service
}

moved {
  from = aws_appautoscaling_policy.cpu
  to   = module.runtime.aws_appautoscaling_policy.cpu
}

moved {
  from = random_password.database
  to   = module.runtime.random_password.database
}

moved {
  from = random_password.redis
  to   = module.runtime.random_password.redis
}

moved {
  from = aws_db_subnet_group.main
  to   = module.runtime.aws_db_subnet_group.main
}

moved {
  from = aws_db_parameter_group.postgres
  to   = module.runtime.aws_db_parameter_group.postgres
}

moved {
  from = aws_iam_role.rds_monitoring
  to   = module.runtime.aws_iam_role.rds_monitoring
}

moved {
  from = aws_iam_role_policy_attachment.rds_monitoring
  to   = module.runtime.aws_iam_role_policy_attachment.rds_monitoring
}

moved {
  from = aws_db_instance.postgres
  to   = module.runtime.aws_db_instance.postgres
}

moved {
  from = aws_elasticache_subnet_group.main
  to   = module.runtime.aws_elasticache_subnet_group.main
}

moved {
  from = aws_elasticache_parameter_group.redis
  to   = module.runtime.aws_elasticache_parameter_group.redis
}

moved {
  from = aws_elasticache_replication_group.redis
  to   = module.runtime.aws_elasticache_replication_group.redis
}

moved {
  from = aws_secretsmanager_secret.runtime
  to   = module.runtime.aws_secretsmanager_secret.runtime
}

moved {
  from = aws_secretsmanager_secret_version.runtime
  to   = module.runtime.aws_secretsmanager_secret_version.runtime
}

moved {
  from = aws_sns_topic.operations
  to   = module.runtime.aws_sns_topic.operations
}

moved {
  from = aws_sns_topic_subscription.email
  to   = module.runtime.aws_sns_topic_subscription.email
}

moved {
  from = aws_budgets_budget.staging
  to   = module.runtime.aws_budgets_budget.staging
}

moved {
  from = aws_wafv2_web_acl.public
  to   = module.runtime.aws_wafv2_web_acl.public
}

moved {
  from = aws_wafv2_web_acl_association.public
  to   = module.runtime.aws_wafv2_web_acl_association.public
}

moved {
  from = aws_cloudwatch_metric_alarm.alb_5xx
  to   = module.runtime.aws_cloudwatch_metric_alarm.alb_5xx
}

moved {
  from = aws_cloudwatch_metric_alarm.unhealthy_targets
  to   = module.runtime.aws_cloudwatch_metric_alarm.unhealthy_targets
}

moved {
  from = aws_cloudwatch_metric_alarm.database_cpu
  to   = module.runtime.aws_cloudwatch_metric_alarm.database_cpu
}

moved {
  from = aws_cloudwatch_metric_alarm.database_free_storage
  to   = module.runtime.aws_cloudwatch_metric_alarm.database_free_storage
}

moved {
  from = aws_cloudwatch_metric_alarm.service_running_count
  to   = module.runtime.aws_cloudwatch_metric_alarm.service_running_count
}

moved {
  from = aws_cloudwatch_metric_alarm.telegram_liked_by
  to   = module.runtime.aws_cloudwatch_metric_alarm.telegram_liked_by
}

moved {
  from = aws_cloudwatch_metric_alarm.nakh_lifecycle
  to   = module.runtime.aws_cloudwatch_metric_alarm.nakh_lifecycle
}

moved {
  from = aws_cloudwatch_metric_alarm.chat_delivery
  to   = module.runtime.aws_cloudwatch_metric_alarm.chat_delivery
}

moved {
  from = aws_cloudwatch_metric_alarm.moderation_current_integrity
  to   = module.runtime.aws_cloudwatch_metric_alarm.moderation_current_integrity
}

moved {
  from = aws_cloudwatch_metric_alarm.moderation_integrity_freshness
  to   = module.runtime.aws_cloudwatch_metric_alarm.moderation_integrity_freshness
}

moved {
  from = aws_cloudwatch_metric_alarm.moderation
  to   = module.runtime.aws_cloudwatch_metric_alarm.moderation
}

moved {
  from = aws_cloudwatch_metric_alarm.deletion_alignment
  to   = module.runtime.aws_cloudwatch_metric_alarm.deletion_alignment
}

moved {
  from = aws_cloudwatch_metric_alarm.deletion_age
  to   = module.runtime.aws_cloudwatch_metric_alarm.deletion_age
}

moved {
  from = aws_cloudwatch_metric_alarm.deletion_failure
  to   = module.runtime.aws_cloudwatch_metric_alarm.deletion_failure
}

moved {
  from = aws_cloudwatch_metric_alarm.deletion_freshness
  to   = module.runtime.aws_cloudwatch_metric_alarm.deletion_freshness
}

moved {
  from = aws_cloudwatch_dashboard.deletion
  to   = module.runtime.aws_cloudwatch_dashboard.deletion
}

moved {
  from = aws_s3_bucket.release_evidence
  to   = module.runtime.aws_s3_bucket.release_evidence
}

moved {
  from = aws_s3_bucket_public_access_block.release_evidence
  to   = module.runtime.aws_s3_bucket_public_access_block.release_evidence
}

moved {
  from = aws_s3_bucket_ownership_controls.release_evidence
  to   = module.runtime.aws_s3_bucket_ownership_controls.release_evidence
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.release_evidence
  to   = module.runtime.aws_s3_bucket_server_side_encryption_configuration.release_evidence
}

moved {
  from = aws_s3_bucket_versioning.release_evidence
  to   = module.runtime.aws_s3_bucket_versioning.release_evidence
}

moved {
  from = aws_s3_bucket_policy.release_evidence
  to   = module.runtime.aws_s3_bucket_policy.release_evidence
}

moved {
  from = terraform_data.product_runtime
  to   = module.runtime.terraform_data.product_runtime
}

moved {
  from = random_bytes.database_purpose
  to   = module.runtime.random_bytes.database_purpose
}

