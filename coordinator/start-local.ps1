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
$AuthSecret = "992d8c11e8a20d062319c7f3d029ec95a2dbf2ce63e5fa5782c4e1e30408b69c"
$JwtSecret  = "4b1c13f7a798be79339732763dbbd82db985fed1040705664e33c1ab04bc578b"

Write-Host ""
Write-Host "Iniciando '$Nombre' (ID: $CoordId) en puerto $Puerto (Peers: $PeerPort)..." -ForegroundColor Cyan

$env:PORT                    = "$Puerto"
$env:PEER_PORT               = "$PeerPort"
$env:COORDINATOR_ID          = $CoordId
$env:COORDINATOR_NAME        = $Nombre
$env:PUBLIC_URL              = "ws://localhost:$Puerto"
$env:PEER_URL                = "ws://localhost:$PeerPort"
$env:AUTH_URL                = "http://localhost:4000"
$env:JWT_SECRET              = $JwtSecret
$env:COORDINATOR_SHARED_SECRET = $AuthSecret
$env:CLIENT_ORIGINS          = "http://localhost:3000"
$env:WORLD_WIDTH             = "800"
$env:WORLD_HEIGHT            = "600"
$env:PLAYER_RADIUS           = "20"
$env:PLAYER_SPEED            = "200"
$env:TICK_RATE               = "20"

Set-Location "$PSScriptRoot"
node index.js
