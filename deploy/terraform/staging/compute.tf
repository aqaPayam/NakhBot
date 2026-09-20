locals {
  services = {
    api = {
      port        = 3000
      health_path = "/health/ready"
    }
    telegram-gateway = {
      port        = 3001
      health_path = "/health/ready"
    }
    worker = {
      port        = null
      health_path = null
    }
    scheduler = {
      port        = null
      health_path = null
    }
  }
  http_services = { for name, service in local.services : name => service if service.port != null }
  dns_enabled   = var.public_hostname != null && var.route53_zone_id != null

  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "NAKH_ENV", value = var.environment },
    { name = "NAKH_RELEASE", value = var.image_tag },
    { name = "NAKH_HTTP_HOST", value = "0.0.0.0" },
    { name = "NAKH_DATABASE_POOL_MAX", value = "10" },
    { name = "NAKH_DATABASE_STATEMENT_TIMEOUT_MS", value = "5000" },
    { name = "NAKH_DATABASE_LOCK_TIMEOUT_MS", value = "1000" },
    { name = "NAKH_QUEUE_PREFIX", value = local.name },
    { name = "NAKH_TELEGRAM_BOT_TOKEN_REF", value = "NAKH_TELEGRAM_BOT_TOKEN" },
    { name = "NAKH_TELEGRAM_ACTION_TOKEN_KEY_REF", value = "NAKH_TELEGRAM_ACTION_TOKEN_KEY" },
    { name = "NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED", value = "false" },
    { name = "NAKH_R2_ENDPOINT", value = "https://disabled-until-m2.invalid" },
    { name = "NAKH_R2_BUCKET", value = "disabled-until-m2" },
    { name = "NAKH_R2_ACCESS_KEY_REF", value = "disabled-until-m2" },
    { name = "NAKH_R2_SECRET_KEY_REF", value = "disabled-until-m2" },
    { name = "NAKH_R2_CLEANUP_ACCESS_KEY_REF", value = "NAKH_R2_CLEANUP_ACCESS_KEY" },
    { name = "NAKH_R2_CLEANUP_SECRET_KEY_REF", value = "NAKH_R2_CLEANUP_SECRET_KEY" },
    { name = "NAKH_MEDIA_CDN_HOST", value = "disabled-until-m2.invalid" },
    { name = "NAKH_MEDIA_SIGNING_KEY_REF", value = "disabled-until-m2" },
    { name = "NAKH_MEDIA_AUDIENCE_KEY_ID", value = "audience-v1" },
    { name = "NAKH_MEDIA_AUDIENCE_KEY_REF", value = "NAKH_MEDIA_AUDIENCE_KEY" },
    { name = "NAKH_MEDIA_CACHE_PURGE_ENABLED", value = "false" },
    { name = "NAKH_MEDIA_CLEANUP_ENABLED", value = "false" },
    { name = "NAKH_MEDIA_ORPHAN_RECONCILIATION_ENABLED", value = "false" },
    { name = "NAKH_MEDIA_ORPHAN_GRACE_MS", value = "86400000" },
    { name = "NAKH_CLOUDFLARE_ZONE_ID", value = "disabled" },
    { name = "NAKH_CLOUDFLARE_API_TOKEN_REF", value = "NAKH_CLOUDFLARE_API_TOKEN" },
    { name = "NAKH_OTEL_ENABLED", value = "true" },
    { name = "NAKH_OTEL_EXPORTER_ENDPOINT", value = "http://127.0.0.1:4318" },
  ]

  runtime_secrets = [
    {
      name      = "NAKH_DATABASE_URL"
      valueFrom = "${aws_secretsmanager_secret.runtime.arn}:NAKH_DATABASE_URL::"
    },
    {
      name      = "NAKH_REDIS_URL"
      valueFrom = "${aws_secretsmanager_secret.runtime.arn}:NAKH_REDIS_URL::"
    },
    {
      name      = "NAKH_TELEGRAM_WEBHOOK_SECRET"
      valueFrom = "${aws_secretsmanager_secret.runtime.arn}:NAKH_TELEGRAM_WEBHOOK_SECRET::"
    },
    {
      name      = "NAKH_TELEGRAM_BOT_TOKEN"
      valueFrom = "${aws_secretsmanager_secret.runtime.arn}:NAKH_TELEGRAM_BOT_TOKEN::"
    },
    {
      name      = "NAKH_TELEGRAM_ACTION_TOKEN_KEY"
      valueFrom = "${aws_secretsmanager_secret.runtime.arn}:NAKH_TELEGRAM_ACTION_TOKEN_KEY::"
    },
  ]

  adot_config = <<-YAML
    receivers:
      otlp:
        protocols:
          http:
            endpoint: 0.0.0.0:4318
    processors:
      batch: {}
      memory_limiter:
        check_interval: 5s
        limit_mib: 192
    exporters:
      awsxray: {}
      awsemf:
        namespace: Nakh/M1
        log_group_name: ${aws_cloudwatch_log_group.telemetry.name}
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [awsxray]
        metrics:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [awsemf]
  YAML
}

resource "aws_ecr_repository" "service" {
  for_each = local.services

  name                 = "${local.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "service" {
  for_each = aws_ecr_repository.service

  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the newest 30 immutable releases"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 30
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = local.services

  name              = "/nakh/${var.environment}/${each.key}"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "telemetry" {
  name              = "/nakh/${var.environment}/telemetry"
  retention_in_days = 30
}

data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "ecs_runtime_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.runtime.arn]
  }
}

resource "aws_iam_role_policy" "ecs_runtime_secrets" {
  name   = "runtime-secrets"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.ecs_runtime_secrets.json
}

resource "aws_iam_role" "ecs_task" {
  name               = "${local.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

data "aws_iam_policy_document" "telemetry" {
  statement {
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "cloudwatch:PutMetricData",
      "logs:CreateLogStream",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "telemetry" {
  name   = "telemetry-export"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.telemetry.json
}

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  lifecycle {
    precondition {
      condition     = !var.activate_services || (local.dns_enabled && var.image_tag != "bootstrap")
      error_message = "Activation requires public_hostname, route53_zone_id, and an immutable deployed image tag."
    }
    precondition {
      condition     = !var.activate_services || !var.skip_final_snapshot
      error_message = "Accepted staging cannot activate while database final snapshots are disabled."
    }
  }
}

resource "aws_lb" "public" {
  name                       = "${local.name}-alb"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.load_balancer.id]
  subnets                    = values(aws_subnet.public)[*].id
  drop_invalid_header_fields = true
  enable_deletion_protection = false
}

resource "aws_lb_target_group" "service" {
  for_each = local.http_services

  name        = "${local.name}-${replace(each.key, "telegram-", "tg-")}"
  port        = each.value.port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = each.value.health_path
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_acm_certificate" "public" {
  count = local.dns_enabled ? 1 : 0

  domain_name       = var.public_hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate_validation" {
  count = local.dns_enabled ? 1 : 0

  zone_id = var.route53_zone_id
  name    = tolist(aws_acm_certificate.public[0].domain_validation_options)[0].resource_record_name
  type    = tolist(aws_acm_certificate.public[0].domain_validation_options)[0].resource_record_type
  records = [tolist(aws_acm_certificate.public[0].domain_validation_options)[0].resource_record_value]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "public" {
  count = local.dns_enabled ? 1 : 0

  certificate_arn         = aws_acm_certificate.public[0].arn
  validation_record_fqdns = [aws_route53_record.certificate_validation[0].fqdn]
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.public.arn
  port              = 80
  protocol          = "HTTP"

  dynamic "default_action" {
    for_each = local.dns_enabled ? [1] : []
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }

  dynamic "default_action" {
    for_each = local.dns_enabled ? [] : [1]
    content {
      type = "fixed-response"
      fixed_response {
        content_type = "text/plain"
        message_body = "staging is not activated"
        status_code  = "503"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count = local.dns_enabled ? 1 : 0

  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.public[0].certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["api"].arn
  }
}

resource "aws_lb_listener_rule" "telegram" {
  count = local.dns_enabled ? 1 : 0

  listener_arn = aws_lb_listener.https[0].arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["telegram-gateway"].arn
  }

  condition {
    path_pattern {
      values = ["/v1/providers/telegram/*"]
    }
  }
}

resource "aws_route53_record" "public" {
  count = local.dns_enabled ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.public_hostname
  type    = "A"

  alias {
    name                   = aws_lb.public.dns_name
    zone_id                = aws_lb.public.zone_id
    evaluate_target_health = true
  }
}

resource "aws_ecs_task_definition" "service" {
  for_each = local.services

  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name                   = each.key
      image                  = "${aws_ecr_repository.service[each.key].repository_url}:${var.image_tag}"
      essential              = true
      readonlyRootFilesystem = true
      cpu                    = 384
      memory                 = 768
      environment = concat(local.common_environment, [
        { name = "NAKH_SERVICE_NAME", value = each.key },
        { name = "NAKH_HTTP_PORT", value = tostring(coalesce(each.value.port, 3000)) },
      ])
      secrets      = local.runtime_secrets
      portMappings = each.value.port == null ? [] : [{ containerPort = each.value.port, hostPort = each.value.port, protocol = "tcp" }]
      dependsOn    = [{ containerName = "otel-collector", condition = "START" }]
      linuxParameters = {
        initProcessEnabled = true
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "service"
        }
      }
    },
    {
      name                   = "otel-collector"
      image                  = var.otel_collector_image
      essential              = true
      readonlyRootFilesystem = true
      cpu                    = 128
      memory                 = 256
      environment = [
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AOT_CONFIG_CONTENT", value = local.adot_config },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.telemetry.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = each.key
        }
      }
    },
  ])
}

resource "aws_ecs_task_definition" "migration" {
  family                   = "${local.name}-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name                   = "migration"
    image                  = "${aws_ecr_repository.service["api"].repository_url}:${var.image_tag}"
    essential              = true
    readonlyRootFilesystem = true
    environment = concat(local.common_environment, [
      { name = "NAKH_SERVICE_NAME", value = "migration" },
      { name = "NAKH_HTTP_PORT", value = "3000" },
    ])
    secrets = local.runtime_secrets
    command = ["node", "node_modules/@nakh/persistence-postgres/dist/cli/migrate.js"]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["api"].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "migration"
      }
    }
  }])
}

resource "aws_ecs_service" "service" {
  for_each = local.services

  name                              = each.key
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.service[each.key].arn
  desired_count                     = var.activate_services ? var.service_min_replicas : 0
  launch_type                       = "FARGATE"
  platform_version                  = "1.4.0"
  health_check_grace_period_seconds = each.value.port == null ? null : 60
  enable_execute_command            = false
  propagate_tags                    = "SERVICE"
  wait_for_steady_state             = true

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    subnets          = values(aws_subnet.private)[*].id
    security_groups  = [aws_security_group.services.id]
  }

  dynamic "load_balancer" {
    for_each = each.value.port == null ? [] : [each.value]
    content {
      target_group_arn = aws_lb_target_group.service[each.key].arn
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  depends_on = [aws_lb_listener.http, aws_secretsmanager_secret_version.runtime]
}

resource "aws_appautoscaling_target" "service" {
  for_each = var.activate_services ? local.services : {}

  max_capacity       = var.service_max_replicas
  min_capacity       = var.service_min_replicas
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.service[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each = aws_appautoscaling_target.service

  name               = "${local.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension
  service_namespace  = each.value.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
