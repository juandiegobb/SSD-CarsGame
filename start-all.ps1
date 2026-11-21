<#
.SYNOPSIS
  Levanta todo el sistema con una sola orden: 3 auths, N coordinadores y el cliente.

.DESCRIPTION
  Cada servicio se abre en su propia ventana, con su nombre en el titulo, para poder
  matarlo con Ctrl+C durante la demo (caida del lider del auth, caida de un coordinador).

  Orden de arranque:
    1. Revisa node, las dependencias (node_modules) y los .env de cada servicio.
    2. Revisa que los puertos esten libres (no arranca nada si alguno esta ocupado).
    3. Abre auth-a, auth-b y auth-c (node index.js a|b|c) y espera a que elijan lider.
    4. Abre los coordinadores (coord-1..N) apuntando a los 3 auths.
    5. Abre el cliente (http://localhost:3000).

  Modos:
    -Mode Local   (por defecto) todo en localhost; ignora las URLs de ngrok de los .env.
    -Mode Tunnel  usa las URLs publicas (https://) de deploy.env, en la raiz del proyecto
                  (copia deploy.env.example). Con ellas arma PUBLIC_URL, PEER_URL, AUTH_URLS,
                  AUTH_PEERS y los origenes permitidos (CORS) de cada servicio. El mesh de los
                  auths (/auth-mesh) y de los coordinadores (/mesh) va por el mismo tunel HTTP.

  Varias PCs: con -Only cada PC levanta solo sus servicios (todas con el mismo deploy.env):
    PC 1: .\start-all.ps1 -Mode Tunnel -Only auth-a,coord-1,client
    PC 2: .\start-all.ps1 -Mode Tunnel -Only auth-b,coord-2
    PC 3: .\start-all.ps1 -Mode Tunnel -Only auth-c,coord-3

.EXAMPLE
  .\start-all.ps1
.EXAMPLE
  .\start-all.ps1 -Install
.EXAMPLE
  .\start-all.ps1 -Mode Tunnel
.EXAMPLE
  .\start-all.ps1 -Mode Tunnel -Only auth-b,coord-2
#>
[CmdletBinding()]
param(
  [ValidateSet('Local', 'Tunnel')] [string]$Mode = 'Local',
  [ValidateRange(1, 9)] [int]$Coordinators = 3,
  [string[]]$CoordinatorNames = @('Norte', 'Centro', 'Sur', 'Este', 'Oeste', 'Rio', 'Monte', 'Valle', 'Costa'),
  [string[]]$Only = @(),
  [string]$DeployFile = 'deploy.env',
  [int]$CoordinatorHttpPortStart = 5001,
  [int]$CoordinatorPeerPortStart = 6001,
  [int]$ClientPort = 3000,
  [int]$LeaderWaitSeconds = 20,
  [switch]$Install,
  [switch]$NoClient
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$isWindowsHost = $env:OS -eq 'Windows_NT'
$shell = if ($isWindowsHost) { 'powershell.exe' } else { 'pwsh' }

function Write-Step([string]$text) { Write-Host "`n== $text" -ForegroundColor Cyan }

# Abre una ventana nueva con su titulo, entra a la carpeta, pone las variables y corre el comando.
# Se manda como -EncodedCommand para no pelear con comillas.
function Start-ServiceWindow([string]$title, [string]$folder, [hashtable]$vars, [string]$command) {
  $lines = @("`$host.UI.RawUI.WindowTitle = '$($title -replace "'", "''")'")
  $lines += "Set-Location -LiteralPath '$($folder -replace "'", "''")'"
  foreach ($name in $vars.Keys) {
    $lines += "`$env:$name = '$("$($vars[$name])" -replace "'", "''")'"
  }
  $lines += "Write-Host '=== $($title -replace "'", "''") ===' -ForegroundColor Yellow"
  $lines += $command
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($lines -join "`n"))
  Start-Process -FilePath $shell -ArgumentList @('-NoExit', '-NoProfile', '-EncodedCommand', $encoded) | Out-Null
}

function Test-PortFree([int]$port) {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
  try { $listener.Start(); return $true } catch { return $false } finally { $listener.Stop() }
}

function Wait-Port([int]$port, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try { $client.Connect([System.Net.IPAddress]::Loopback, $port); return $true }
    catch { Start-Sleep -Milliseconds 200 }
    finally { $client.Dispose() }
  }
  return $false
}

# ---------------------------------------------------------------- 0. que se levanta aqui
$allNames = @('auth-a', 'auth-b', 'auth-c') + @(1..$Coordinators | ForEach-Object { "coord-$_" })
if (-not $NoClient) { $allNames += 'client' }
$selected = if ($Only.Count -gt 0) { @($Only | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ }) } else { $allNames }
foreach ($name in $selected) {
  if ($allNames -notcontains $name) { throw "Servicio desconocido en -Only: $name. Validos: $($allNames -join ', ')" }
}
function Wants([string]$name) { return $selected -contains $name }

# ---------------------------------------------------------------- deploy.env (modo Tunnel)
$deploy = @{}
function HttpsUrl([string]$key) {
  $value = "$($deploy[$key])".Trim().TrimEnd('/')
  if (-not $value) { throw "Falta $key en $DeployFile." }
  if ($value -notmatch '^https://[^/\s?#]+$') { throw "$key debe ser una URL https:// sin ruta (ejemplo: https://algo.ngrok-free.dev). Valor: $value" }
  return $value
}
function WssOf([string]$httpsUrl) { return $httpsUrl -replace '^https:', 'wss:' }

if ($Mode -eq 'Tunnel') {
  $deployPath = if ([IO.Path]::IsPathRooted($DeployFile)) { $DeployFile } else { Join-Path $root $DeployFile }
  if (-not (Test-Path -LiteralPath $deployPath)) {
    throw "Falta $DeployFile. Copia deploy.env.example a deploy.env y pon las URLs https:// de ngrok."
  }
  foreach ($line in Get-Content -LiteralPath $deployPath) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') { $deploy[$Matches[1]] = $Matches[2] }
  }
  # Siempre hacen falta las 3 URLs de los auths (son la lista AUTH_URLS y los peers del mesh)
  $tunnelAuth = @{ A = (HttpsUrl 'AUTH_A_URL'); B = (HttpsUrl 'AUTH_B_URL'); C = (HttpsUrl 'AUTH_C_URL') }
  $tunnelAuthUrls = "$($tunnelAuth.A),$($tunnelAuth.B),$($tunnelAuth.C)"
  $tunnelClient = if ($deploy['CLIENT_URL']) { HttpsUrl 'CLIENT_URL' } else { '' }
  $tunnelOrigins = (@('http://localhost:3000') + @($tunnelClient | Where-Object { $_ })) -join ','
}

# ---------------------------------------------------------------- 1. requisitos
Write-Step 'Revisando requisitos'
Get-Command node -ErrorAction Stop | Out-Null
Write-Host "node $(node --version)"

$services = @()
if ($selected | Where-Object { $_ -like 'auth-*' }) { $services += 'auth-service' }
if ($selected | Where-Object { $_ -like 'coord-*' }) { $services += 'coordinator' }
if (Wants 'client') { $services += 'client' }
foreach ($service in $services) {
  $folder = Join-Path $root $service
  if ($Install) {
    Write-Host "npm install en $service..."
    Push-Location $folder
    try { npm install --no-fund --no-audit | Out-Null } finally { Pop-Location }
  } elseif (-not (Test-Path (Join-Path $folder 'node_modules'))) {
    throw "Falta node_modules en $service. Corre: .\start-all.ps1 -Install"
  }
  if (-not (Test-Path (Join-Path $folder '.env'))) {
    throw "Falta $service\.env. Copia $service\.env.example a $service\.env y completa los secretos."
  }
}

if ($CoordinatorNames.Count -lt $Coordinators) {
  throw "-CoordinatorNames debe tener al menos $Coordinators nombres."
}

# ---------------------------------------------------------------- 2. puertos
Write-Step 'Revisando puertos'
$coordHttpPorts = @(0..($Coordinators - 1) | ForEach-Object { $CoordinatorHttpPortStart + $_ })
$coordPeerPorts = @(0..($Coordinators - 1) | ForEach-Object { $CoordinatorPeerPortStart + $_ })
$ports = @()
foreach ($pair in @(@('auth-a', 4001), @('auth-b', 4002), @('auth-c', 4003))) {
  if (Wants $pair[0]) { $ports += $pair[1]; $ports += $pair[1] + 100 }
}
for ($i = 0; $i -lt $Coordinators; $i++) {
  if (Wants "coord-$($i + 1)") { $ports += $coordHttpPorts[$i]; $ports += $coordPeerPorts[$i] }
}
if (Wants 'client') { $ports += $ClientPort }
$busy = @($ports | Where-Object { -not (Test-PortFree $_) })
if ($busy.Count -gt 0) {
  throw "Puertos ocupados: $($busy -join ', '). Cierra las ventanas de una ejecucion anterior y vuelve a intentar. No se inicio nada."
}
Write-Host "Libres: $($ports -join ', ')"

# ---------------------------------------------------------------- 3. auths
$startedAuths = @()
Write-Step 'Iniciando los auths'
$authFolder = Join-Path $root 'auth-service'
$auths = @(
  @{ Id = 'auth-a'; Arg = 'a'; Port = 4001; Key = 'A' },
  @{ Id = 'auth-b'; Arg = 'b'; Port = 4002; Key = 'B' },
  @{ Id = 'auth-c'; Arg = 'c'; Port = 4003; Key = 'C' }
)
foreach ($auth in $auths) {
  if (-not (Wants $auth.Id)) { continue }
  $vars = @{}
  foreach ($other in $auths) {
    if ($Mode -eq 'Local') {
      # En local se ignoran las URLs de ngrok que tenga el .env
      $vars["AUTH_$($other.Key)_URL"] = "http://localhost:$($other.Port)"
      $vars["AUTH_$($other.Key)_PEER_URL"] = "ws://localhost:$($other.Port + 100)"
    } else {
      # Por tunel: el mesh va por el mismo tunel HTTP con wss:// (/auth-mesh)
      $vars["AUTH_$($other.Key)_URL"] = $tunnelAuth[$other.Key]
      $vars["AUTH_$($other.Key)_PEER_URL"] = WssOf $tunnelAuth[$other.Key]
    }
  }
  if ($Mode -eq 'Tunnel') { $vars.CORS_ORIGINS = $tunnelOrigins }
  Start-ServiceWindow "$($auth.Id) (HTTP :$($auth.Port) / mesh :$($auth.Port + 100))" $authFolder $vars "node index.js $($auth.Arg)"
  $startedAuths += $auth
  Write-Host "Abierto $($auth.Id)"
}

foreach ($auth in $startedAuths) {
  if (-not (Wait-Port $auth.Port 20)) { throw "$($auth.Id) no abrio el puerto $($auth.Port). Revisa su ventana." }
}

$leader = $null
$deadline = (Get-Date).AddSeconds($LeaderWaitSeconds)
if ($startedAuths.Count -gt 0) { Write-Host 'Esperando la eleccion del lider (unos 7 s)...' }
while ($startedAuths.Count -gt 0 -and -not $leader -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 1
  foreach ($auth in $startedAuths) {
    try {
      $status = Invoke-RestMethod -Uri "http://localhost:$($auth.Port)/status" -TimeoutSec 2
      if ($status.role -eq 'leader') { $leader = $status; break }
    } catch { }
  }
}
if ($leader) {
  Write-Host "Lider: $($leader.authId) (term $($leader.term))" -ForegroundColor Green
} elseif ($startedAuths.Count -gt 0) {
  Write-Warning "Todavia no hay lider. Los coordinadores reintentan solos; revisa las ventanas de los auths."
}

# ---------------------------------------------------------------- 4. coordinadores
Write-Step 'Iniciando los coordinadores'
$coordFolder = Join-Path $root 'coordinator'
$authUrls = if ($Mode -eq 'Local') { 'http://localhost:4001,http://localhost:4002,http://localhost:4003' } else { $tunnelAuthUrls }
for ($i = 0; $i -lt $Coordinators; $i++) {
  $id = "coord-$($i + 1)"
  if (-not (Wants $id)) { continue }
  $coordPublic = if ($Mode -eq 'Tunnel') { WssOf (HttpsUrl "COORD_$($i + 1)_URL") } else { '' }
  $name = $CoordinatorNames[$i]
  $httpPort = $coordHttpPorts[$i]
  $peerPort = $coordPeerPorts[$i]
  $vars = @{
    PORT = $httpPort
    PEER_PORT = $peerPort
    COORDINATOR_ID = $id
    COORDINATOR_NAME = $name
    # Por tunel el mesh de coordinadores va por el mismo tunel HTTP (ruta /mesh)
    PUBLIC_URL = if ($coordPublic) { $coordPublic } else { "ws://localhost:$httpPort" }
    PEER_URL = if ($coordPublic) { $coordPublic } else { "ws://localhost:$peerPort" }
    AUTH_URLS = $authUrls
  }
  if ($Mode -eq 'Tunnel') { $vars.CLIENT_ORIGINS = $tunnelOrigins }
  Start-ServiceWindow "$id $name (HTTP :$httpPort / mesh :$peerPort)" $coordFolder $vars 'node index.js'
  if (-not (Wait-Port $httpPort 20)) { throw "$id no abrio el puerto $httpPort. Revisa su ventana." }
  Write-Host "Abierto $id ($name) en :$httpPort"
}

# ---------------------------------------------------------------- 5. cliente
if (Wants 'client') {
  Write-Step 'Iniciando el cliente'
  $clientVars = @{ PORT = $ClientPort; LOCAL_AUTH_URLS = 'http://localhost:4001,http://localhost:4002,http://localhost:4003' }
  if ($Mode -eq 'Tunnel') {
    # Quien entre por la URL de ngrok del cliente usa los auths por tunel
    $clientVars.AUTH_URLS = $tunnelAuthUrls
    $clientVars.COORDINATOR_WS_URL = WssOf (HttpsUrl 'COORD_1_URL')
  }
  Start-ServiceWindow "cliente (:$ClientPort)" (Join-Path $root 'client') $clientVars 'node server.js'
  if (-not (Wait-Port $ClientPort 20)) { throw "El cliente no abrio el puerto $ClientPort. Revisa su ventana." }
}

# ---------------------------------------------------------------- resumen
Write-Step "Listo (modo $Mode): $($selected -join ', ')"
if ($Mode -eq 'Tunnel') {
  Write-Host "Auths:          $($tunnelAuth.A)/status  $($tunnelAuth.B)/status  $($tunnelAuth.C)/status"
  if ($tunnelClient) { Write-Host "Cliente:        $tunnelClient" -ForegroundColor Green }
  Write-Host 'Recuerda tener abiertos los tuneles de ngrok de estos servicios (ngrok.example.yml).'
} else {
  Write-Host 'Auths:          http://localhost:4001/status  :4002/status  :4003/status'
  Write-Host "Coordinadores:  $(($coordHttpPorts | ForEach-Object { "http://localhost:$_/health" }) -join '  ')"
  if (Wants 'client') { Write-Host "Cliente:        http://localhost:$ClientPort" -ForegroundColor Green }
}
Write-Host 'Para la demo: Ctrl+C en la ventana de un servicio lo apaga; flecha arriba + Enter lo revive.'
