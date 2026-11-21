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
    -Mode Local   (por defecto) todo en localhost; ignora las URLs de ngrok del .env.
    -Mode Tunnel  usa las URLs publicas del .env de cada servicio (AUTH_A_URL..AUTH_C_URL,
                  AUTH_URLS) y las de los coordinadores que pases en -CoordinatorPublicUrls.

.EXAMPLE
  .\start-all.ps1
.EXAMPLE
  .\start-all.ps1 -Install
.EXAMPLE
  .\start-all.ps1 -Mode Tunnel -CoordinatorPublicUrls wss://c1.ngrok-free.dev,wss://c2.ngrok-free.dev,wss://c3.ngrok-free.dev
#>
[CmdletBinding()]
param(
  [ValidateSet('Local', 'Tunnel')] [string]$Mode = 'Local',
  [ValidateRange(1, 9)] [int]$Coordinators = 3,
  [string[]]$CoordinatorNames = @('Norte', 'Centro', 'Sur', 'Este', 'Oeste', 'Rio', 'Monte', 'Valle', 'Costa'),
  [string[]]$CoordinatorPublicUrls = @(),
  [string[]]$CoordinatorPeerUrls = @(),
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

# ---------------------------------------------------------------- 1. requisitos
Write-Step 'Revisando requisitos'
Get-Command node -ErrorAction Stop | Out-Null
Write-Host "node $(node --version)"

$services = @('auth-service', 'coordinator', 'client')
if ($NoClient) { $services = @('auth-service', 'coordinator') }
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

if ($Mode -eq 'Tunnel' -and $CoordinatorPublicUrls.Count -ne $Coordinators) {
  throw "En modo Tunnel pasa una URL publica (wss://...) por coordinador en -CoordinatorPublicUrls ($Coordinators en total)."
}
if ($CoordinatorPeerUrls.Count -gt 0 -and $CoordinatorPeerUrls.Count -ne $Coordinators) {
  throw "-CoordinatorPeerUrls debe tener una URL por coordinador ($Coordinators en total)."
}
if ($CoordinatorNames.Count -lt $Coordinators) {
  throw "-CoordinatorNames debe tener al menos $Coordinators nombres."
}

# ---------------------------------------------------------------- 2. puertos
Write-Step 'Revisando puertos'
$authPorts = @(4001, 4002, 4003, 4101, 4102, 4103)
$coordHttpPorts = @(0..($Coordinators - 1) | ForEach-Object { $CoordinatorHttpPortStart + $_ })
$coordPeerPorts = @(0..($Coordinators - 1) | ForEach-Object { $CoordinatorPeerPortStart + $_ })
$ports = $authPorts + $coordHttpPorts + $coordPeerPorts
if (-not $NoClient) { $ports += $ClientPort }
$busy = @($ports | Where-Object { -not (Test-PortFree $_) })
if ($busy.Count -gt 0) {
  throw "Puertos ocupados: $($busy -join ', '). Cierra las ventanas de una ejecucion anterior y vuelve a intentar. No se inicio nada."
}
Write-Host "Libres: $($ports -join ', ')"

# ---------------------------------------------------------------- 3. auths
Write-Step 'Iniciando los 3 auths'
$authFolder = Join-Path $root 'auth-service'
$auths = @(
  @{ Id = 'auth-a'; Arg = 'a'; Port = 4001; Key = 'A' },
  @{ Id = 'auth-b'; Arg = 'b'; Port = 4002; Key = 'B' },
  @{ Id = 'auth-c'; Arg = 'c'; Port = 4003; Key = 'C' }
)
foreach ($auth in $auths) {
  $vars = @{}
  if ($Mode -eq 'Local') {
    # En local se ignoran las URLs de ngrok que tenga el .env
    foreach ($other in $auths) {
      $vars["AUTH_$($other.Key)_URL"] = "http://localhost:$($other.Port)"
      $vars["AUTH_$($other.Key)_PEER_URL"] = "ws://localhost:$($other.Port + 100)"
    }
  }
  Start-ServiceWindow "$($auth.Id) (HTTP :$($auth.Port) / mesh :$($auth.Port + 100))" $authFolder $vars "node index.js $($auth.Arg)"
  Write-Host "Abierto $($auth.Id)"
}

foreach ($auth in $auths) {
  if (-not (Wait-Port $auth.Port 20)) { throw "$($auth.Id) no abrio el puerto $($auth.Port). Revisa su ventana." }
}

Write-Host 'Esperando la eleccion del lider (unos 7 s)...'
$leader = $null
$deadline = (Get-Date).AddSeconds($LeaderWaitSeconds)
while (-not $leader -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 1
  foreach ($auth in $auths) {
    try {
      $status = Invoke-RestMethod -Uri "http://localhost:$($auth.Port)/status" -TimeoutSec 2
      if ($status.role -eq 'leader') { $leader = $status; break }
    } catch { }
  }
}
if ($leader) {
  Write-Host "Lider: $($leader.authId) (term $($leader.term))" -ForegroundColor Green
} else {
  Write-Warning "Todavia no hay lider. Los coordinadores reintentan solos; revisa las ventanas de los auths."
}

# ---------------------------------------------------------------- 4. coordinadores
Write-Step "Iniciando $Coordinators coordinadores"
$coordFolder = Join-Path $root 'coordinator'
$authUrls = if ($Mode -eq 'Local') { 'http://localhost:4001,http://localhost:4002,http://localhost:4003' } else { '' }
for ($i = 0; $i -lt $Coordinators; $i++) {
  $id = "coord-$($i + 1)"
  $name = $CoordinatorNames[$i]
  $httpPort = $coordHttpPorts[$i]
  $peerPort = $coordPeerPorts[$i]
  $vars = @{
    PORT = $httpPort
    PEER_PORT = $peerPort
    COORDINATOR_ID = $id
    COORDINATOR_NAME = $name
    PUBLIC_URL = if ($CoordinatorPublicUrls.Count -gt 0) { $CoordinatorPublicUrls[$i] } else { "ws://localhost:$httpPort" }
    PEER_URL = if ($CoordinatorPeerUrls.Count -gt 0) { $CoordinatorPeerUrls[$i] } else { "ws://localhost:$peerPort" }
  }
  # En modo Tunnel AUTH_URLS sale de coordinator/.env
  if ($authUrls) { $vars.AUTH_URLS = $authUrls }
  Start-ServiceWindow "$id $name (HTTP :$httpPort / mesh :$peerPort)" $coordFolder $vars 'node index.js'
  if (-not (Wait-Port $httpPort 20)) { throw "$id no abrio el puerto $httpPort. Revisa su ventana." }
  Write-Host "Abierto $id ($name) en :$httpPort"
}

# ---------------------------------------------------------------- 5. cliente
if (-not $NoClient) {
  Write-Step 'Iniciando el cliente'
  $clientVars = @{ PORT = $ClientPort }
  if ($Mode -eq 'Local') { $clientVars.LOCAL_AUTH_URLS = 'http://localhost:4001,http://localhost:4002,http://localhost:4003' }
  Start-ServiceWindow "cliente (:$ClientPort)" (Join-Path $root 'client') $clientVars 'node server.js'
  if (-not (Wait-Port $ClientPort 20)) { throw "El cliente no abrio el puerto $ClientPort. Revisa su ventana." }
}

# ---------------------------------------------------------------- resumen
Write-Step "Listo (modo $Mode)"
Write-Host 'Auths:          http://localhost:4001/status  :4002/status  :4003/status'
Write-Host "Coordinadores:  $(($coordHttpPorts | ForEach-Object { "http://localhost:$_/health" }) -join '  ')"
if (-not $NoClient) { Write-Host "Cliente:        http://localhost:$ClientPort" -ForegroundColor Green }
Write-Host 'Para la demo: Ctrl+C en la ventana de un servicio lo apaga; flecha arriba + Enter lo revive.'
