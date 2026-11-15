# start-auths.ps1 - Inicia las 3 instancias de Auth Service replicadas del Taller 7
# Cada instancia corre en su propia ventana de consola independiente para facilitar
# la simulación de caídas (failover) con Ctrl+C durante la sustentación.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$portsToCheck = @(4001, 4002, 4003, 4101, 4102, 4103)
$occupiedPorts = @()

foreach ($port in $portsToCheck) {
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
    $listener.Start()
  } catch {
    $occupiedPorts += $port
  } finally {
    if ($null -ne $listener) {
      $listener.Stop()
    }
  }
}

if ($occupiedPorts.Count -gt 0) {
  Write-Warning "Los siguientes puertos ya están ocupados o no se pueden reservar: $($occupiedPorts -join ', '). Detén los procesos existentes antes de iniciar."
  throw "No se puede iniciar el clúster de autenticación: puertos en conflicto ($($occupiedPorts -join ', '))."
}

$instances = @(
  @{
    AuthId    = 'auth-a'
    Port      = 4001
    PublicUrl = 'http://localhost:4001'
    PeerPort  = 4101
    PeerUrl   = 'ws://localhost:4101'
    DbPath    = 'users-auth-a.db'
    AuthPeers = 'auth-b=ws://localhost:4102|http://localhost:4002,auth-c=ws://localhost:4103|http://localhost:4003'
  },
  @{
    AuthId    = 'auth-b'
    Port      = 4002
    PublicUrl = 'http://localhost:4002'
    PeerPort  = 4102
    PeerUrl   = 'ws://localhost:4102'
    DbPath    = 'users-auth-b.db'
    AuthPeers = 'auth-a=ws://localhost:4101|http://localhost:4001,auth-c=ws://localhost:4103|http://localhost:4003'
  },
  @{
    AuthId    = 'auth-c'
    Port      = 4003
    PublicUrl = 'http://localhost:4003'
    PeerPort  = 4103
    PeerUrl   = 'ws://localhost:4103'
    DbPath    = 'users-auth-c.db'
    AuthPeers = 'auth-a=ws://localhost:4101|http://localhost:4001,auth-b=ws://localhost:4102|http://localhost:4002'
  }
)

$envNames = @(
  'AUTH_ID',
  'PORT',
  'PUBLIC_URL',
  'PEER_PORT',
  'PEER_URL',
  'DB_PATH',
  'AUTH_PEERS'
)

$originalEnv = @{}
foreach ($name in $envNames) {
  $item = Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue
  $originalEnv[$name] = if ($null -eq $item) {
    @{ Exists = $false; Value = $null }
  } else {
    @{ Exists = $true; Value = $item.Value }
  }
}

try {
  $scriptDir = $PSScriptRoot

  foreach ($inst in $instances) {
    $authId = $inst.AuthId
    $port = $inst.Port
    $publicUrl = $inst.PublicUrl
    $peerPort = $inst.PeerPort
    $peerUrl = $inst.PeerUrl
    $dbPath = $inst.DbPath
    $authPeers = $inst.AuthPeers
    $windowTitle = "$authId (HTTP :$port / Mesh :$peerPort)"

    Write-Host "Iniciando nodo $authId en HTTP :$port y Mesh :$peerPort..." -ForegroundColor Cyan

    $command = @"
`$host.UI.RawUI.WindowTitle = '$windowTitle';
Set-Location -LiteralPath '$scriptDir';
`$env:AUTH_ID = '$authId';
`$env:PORT = '$port';
`$env:PUBLIC_URL = '$publicUrl';
`$env:PEER_PORT = '$peerPort';
`$env:PEER_URL = '$peerUrl';
`$env:DB_PATH = '$dbPath';
`$env:AUTH_PEERS = '$authPeers';
Write-Host '===================================================' -ForegroundColor Yellow;
Write-Host ' NODO $authId - PUERTO $port - MESH $peerPort' -ForegroundColor Yellow;
Write-Host '===================================================' -ForegroundColor Yellow;
node index.js
"@

    Start-Process powershell.exe -ArgumentList @('-NoExit', '-Command', $command)
  }

  Write-Host "`nLas 3 instancias de Auth Service fueron lanzadas en ventanas independientes." -ForegroundColor Green
  Write-Host "Verificando disponibilidad de puertos HTTP (4001, 4002, 4003)..."

  $allReady = $true
  foreach ($inst in $instances) {
    $port = $inst.Port
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      $client = [System.Net.Sockets.TcpClient]::new()
      try {
        $client.Connect([System.Net.IPAddress]::Loopback, $port)
        $ready = $true
        break
      } catch {
        Start-Sleep -Milliseconds 150
      } finally {
        $client.Dispose()
      }
    }
    if ($ready) {
      Write-Host "  [OK] $($inst.AuthId) escuchando en puerto $port" -ForegroundColor Green
    } else {
      Write-Warning "  [!] $($inst.AuthId) aún no responde en puerto $port tras el tiempo de espera."
      $allReady = $false
    }
  }

  if ($allReady) {
    Write-Host "`nClúster de 3 Auth Services listo para Taller 7." -ForegroundColor Green
  }

} finally {
  foreach ($name in $envNames) {
    $saved = $originalEnv[$name]
    if ($saved.Exists) {
      Set-Item -Path "Env:$name" -Value $saved.Value
    } else {
      Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
    }
  }
}
