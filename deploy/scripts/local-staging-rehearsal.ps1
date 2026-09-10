param(
  [switch]$KeepEnvironment
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$ComposeFiles = @(
  "-f", (Join-Path $RepositoryRoot "deploy\docker\compose.yml"),
  "-f", (Join-Path $RepositoryRoot "deploy\docker\compose.staging.yml")
)
$WebhookSecret = "local-rehearsal-webhook-secret-000001"
$SyntheticTelegramId = 900000001

function Invoke-Compose {
  & docker compose @ComposeFiles @args
  if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose failed with exit code $LASTEXITCODE."
  }
}

function Wait-HealthyUrl {
  param([string]$Url)
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri $Url -TimeoutSec 3
      if ($response.StatusCode -eq 200) { return }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  throw "Timed out waiting for $Url."
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker Desktop with Compose is required for the free local rehearsal."
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "pnpm is required for the integration and concurrency checks."
}

Push-Location $RepositoryRoot
try {
  Invoke-Compose --profile telemetry up --build --detach
  Wait-HealthyUrl "http://127.0.0.1:3000/health/ready"
  Wait-HealthyUrl "http://127.0.0.1:3001/health/ready"

  $body = @{
    update_id = 910001
    message = @{
      text = "/start"
      from = @{ id = $SyntheticTelegramId; username = "synthetic_staging_user" }
    }
  } | ConvertTo-Json -Depth 5

  $invalidStatus = try {
    (Invoke-WebRequest -Uri "http://127.0.0.1:3001/v1/providers/telegram/webhook" -Method Post -ContentType "application/json" -Headers @{ "x-telegram-bot-api-secret-token" = "invalid" } -Body $body).StatusCode
  } catch {
    [int]$_.Exception.Response.StatusCode
  }
  if ($invalidStatus -ne 401) { throw "Invalid webhook secret returned $invalidStatus instead of 401." }

  $headers = @{ "x-telegram-bot-api-secret-token" = $WebhookSecret }
  1..2 | ForEach-Object {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:3001/v1/providers/telegram/webhook" -Method Post -ContentType "application/json" -Headers $headers -Body $body
    if ($response.StatusCode -ne 201) { throw "Valid webhook returned $($response.StatusCode)." }
  }

  $identityCount = (& docker compose @ComposeFiles exec -T postgres psql -U nakh -d nakh -tAc "select count(*) from identity.telegram_identities where telegram_user_id = '$SyntheticTelegramId'").Trim()
  if ($LASTEXITCODE -ne 0 -or $identityCount -ne "1") {
    throw "Duplicate Telegram update did not converge on one identity."
  }

  Invoke-Compose restart telegram-gateway
  Wait-HealthyUrl "http://127.0.0.1:3001/health/ready"
  $restartResponse = Invoke-WebRequest -Uri "http://127.0.0.1:3001/v1/providers/telegram/webhook" -Method Post -ContentType "application/json" -Headers $headers -Body $body
  if ($restartResponse.StatusCode -ne 201) { throw "Replay after restart failed." }

  $env:NAKH_ENV = "test"
  $env:NAKH_SERVICE_NAME = "local-staging-rehearsal"
  $env:NAKH_RELEASE = "local-rehearsal"
  $env:NAKH_DATABASE_URL = "postgresql://nakh:nakh_local@127.0.0.1:5432/nakh"
  $env:NAKH_TEST_DATABASE_URL = $env:NAKH_DATABASE_URL
  $env:NAKH_REDIS_URL = "redis://127.0.0.1:6379"
  $env:NAKH_TEST_REDIS_URL = $env:NAKH_REDIS_URL
  $env:NAKH_TELEGRAM_BOT_TOKEN_REF = "disabled-local-rehearsal"
  $env:NAKH_TELEGRAM_WEBHOOK_SECRET = $WebhookSecret
  $env:NAKH_R2_ENDPOINT = "https://disabled-until-m2.invalid"
  $env:NAKH_R2_BUCKET = "disabled-until-m2"
  $env:NAKH_R2_ACCESS_KEY_REF = "disabled-until-m2"
  $env:NAKH_R2_SECRET_KEY_REF = "disabled-until-m2"
  $env:NAKH_MEDIA_CACHE_PURGE_ENABLED = "false"
  $env:NAKH_MEDIA_CDN_HOST = "disabled-until-m2.invalid"
  $env:NAKH_MEDIA_SIGNING_KEY_REF = "disabled-until-m2"
  $env:NAKH_CLOUDFLARE_ZONE_ID = "disabled"
  $env:NAKH_CLOUDFLARE_API_TOKEN_REF = "NAKH_CLOUDFLARE_API_TOKEN"

  pnpm db:verify
  if ($LASTEXITCODE -ne 0) { throw "Migration verification failed." }
  pnpm test:integration
  if ($LASTEXITCODE -ne 0) { throw "Integration tests failed." }
  pnpm test:m1-load-smoke
  if ($LASTEXITCODE -ne 0) { throw "M1 load smoke failed." }

  Write-Host "Local staging rehearsal passed. This is rehearsal evidence only, not real staging acceptance."
} finally {
  if (-not $KeepEnvironment) {
    Invoke-Compose --profile telemetry down --volumes --remove-orphans
  }
  Pop-Location
}
