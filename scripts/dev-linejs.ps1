param(
  [string]$ChatId = $env:LINE_IMAGE_LISTENER_CHAT_ID
)

$ErrorActionPreference = "Stop"

$env:HTTP_ENABLED = "true"
$env:LINEJS_TEST_ENABLED = "true"

if (-not $env:LINEJS_TEST_DEVICE) {
  $env:LINEJS_TEST_DEVICE = "IOSIPAD"
}

if (-not $env:LINEJS_TEST_STORAGE_PATH) {
  $env:LINEJS_TEST_STORAGE_PATH = "data/linejs-storage.json"
}

if (-not $env:CODEX_IMAGE_TIMEOUT_MS) {
  $env:CODEX_IMAGE_TIMEOUT_MS = "120000"
}

if ($ChatId) {
  $env:LINE_IMAGE_LISTENER_CHAT_ID = $ChatId
} else {
  Write-Warning "LINE_IMAGE_LISTENER_CHAT_ID is empty. The server will run, but group image listening will not start."
  Write-Warning "Run again with: .\scripts\dev-linejs.ps1 -ChatId `"cxxxxxxxxxxxxxxxx`""
}

Write-Host "Starting SPX dev server for LINE JS testing..."
Write-Host "Backend: HTTP_ENABLED=$env:HTTP_ENABLED LINEJS_TEST_ENABLED=$env:LINEJS_TEST_ENABLED"
Write-Host "Image listener chat: $env:LINE_IMAGE_LISTENER_CHAT_ID"
Write-Host "Frontend: Vite"

npx concurrently --kill-others --names backend,frontend --prefix-colors blue,green "npx tsx src/app.ts" "npx vite"
