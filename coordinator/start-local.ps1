# Script para levantar coordinadores locales con puertos y nombres distintos.
# Uso: .\start-local.ps1  (te pregunta puerto y nombre)
# Tambien se puede llamar con parametros:
#   .\start-local.ps1 -Puerto 5001 -Nombre "Pista Norte"
param(
  [int]$Puerto = 0,
  [string]$Nombre = ""
)

if ($Puerto -eq 0) {
  $input = Read-Host "Puerto para este coordinador (ej. 5001, 5002, 5003) [5001]"
  $Puerto = if ($input.Trim()) { [int]$input.Trim() } else { 5001 }
}
if (-not $Nombre) {
  $defaultNombre = "Pista $Puerto"
  $input = Read-Host "Nombre visible del coordinador [$defaultNombre]"
  $Nombre = if ($input.Trim()) { $input.Trim() } else { $defaultNombre }
}

$PeerPort  = $Puerto + 1000
$CoordId   = "coord-$Puerto"
$envFile   = Join-Path $PSScriptRoot ".env"

Write-Host ""
Write-Host "Iniciando '$Nombre' (ID: $CoordId) en modo LOCAL en puerto $Puerto (Peers: $PeerPort)..." -ForegroundColor Cyan

$env:LOCAL_MODE        = "1"
$env:PORT              = "$Puerto"
$env:PEER_PORT         = "$PeerPort"
$env:COORDINATOR_ID    = $CoordId
$env:COORDINATOR_NAME  = $Nombre
$env:LOCAL_PUBLIC_URL  = "ws://localhost:$Puerto"
$env:LOCAL_PEER_URL    = "ws://localhost:$PeerPort"
$env:PUBLIC_URL        = "ws://localhost:$Puerto"
$env:PEER_URL          = "ws://localhost:$PeerPort"
$env:LOCAL_AUTH_URLS   = "http://localhost:4001,http://localhost:4002,http://localhost:4003,http://localhost:4000"
$env:AUTH_URLS         = $env:LOCAL_AUTH_URLS
$env:AUTH_URL          = "http://localhost:4000"
$env:CLIENT_ORIGINS    = "http://localhost:3000"
$env:WORLD_WIDTH       = "800"
$env:WORLD_HEIGHT      = "600"
$env:PLAYER_RADIUS     = "20"
$env:PLAYER_SPEED      = "200"
$env:TICK_RATE         = "20"

# Solo usar secretos de respaldo si no existe coordinator/.env
if (-not (Test-Path -LiteralPath $envFile)) {
  if (-not $env:COORDINATOR_SHARED_SECRET) {
    $env:COORDINATOR_SHARED_SECRET = "992d8c11e8a20d062319c7f3d029ec95a2dbf2ce63e5fa5782c4e1e30408b69c"
  }
  if (-not $env:JWT_SECRET) {
    $env:JWT_SECRET = "4b1c13f7a798be79339732763dbbd82db985fed1040705664e33c1ab04bc578b"
  }
}

Set-Location "$PSScriptRoot"
node index.js --local

