param(
  [ValidateRange(1, 65535)] [int]$Count = 3,
  [int]$HttpPortStart = 5001,
  [int]$PeerPortStart = 6001,
  [int[]]$HttpPorts = @(),
  [int[]]$PeerPorts = @(),
  [string[]]$CoordinatorIds = @(),
  [string[]]$PublicUrls = @(),
  [string[]]$PeerUrls = @()
)

$ErrorActionPreference = 'Stop'

if ($HttpPorts.Count -eq 0) {
  $HttpPorts = @($HttpPortStart..($HttpPortStart + $Count - 1))
}
if ($PeerPorts.Count -eq 0) {
  $PeerPorts = @($PeerPortStart..($PeerPortStart + $Count - 1))
}

if ($HttpPorts.Count -lt 1 -or $HttpPorts.Count -ne $PeerPorts.Count) {
  throw 'Debes proporcionar la misma cantidad (al menos uno) de puertos HTTP y peer.'
}
if ($CoordinatorIds.Count -gt 0 -and $CoordinatorIds.Count -ne $HttpPorts.Count) {
  throw 'Debes proporcionar un COORDINATOR_ID por cada instancia o no proporcionar ninguno.'
}
foreach ($coordinatorId in $CoordinatorIds) {
  if ($coordinatorId -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') {
    throw 'Cada COORDINATOR_ID debe tener de 1 a 64 caracteres alfanuméricos, guion o guion bajo.'
  }
}
if ($CoordinatorIds.Count -gt 0 -and ($CoordinatorIds | Select-Object -Unique).Count -ne $CoordinatorIds.Count) {
  throw 'Cada COORDINATOR_ID debe ser único.'
}
if ($PublicUrls.Count -gt 0 -and $PublicUrls.Count -ne $HttpPorts.Count) {
  throw 'Debes proporcionar una PUBLIC_URL por instancia o no proporcionar ninguna.'
}
if ($PeerUrls.Count -gt 0 -and $PeerUrls.Count -ne $HttpPorts.Count) {
  throw 'Debes proporcionar una PEER_URL por instancia o no proporcionar ninguna.'
}

function Normalize-WebSocketUrl([string]$value, [string]$name) {
  try {
    $uri = [Uri]$value
    if ($uri.Scheme -notin @('ws', 'wss') -or
        [string]::IsNullOrWhiteSpace($uri.Host) -or
        $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
      throw "$name debe usar ws:// o wss:// sin credenciales, query ni fragmento."
    }
    return $uri.GetLeftPart([System.UriPartial]::Path).TrimEnd('/')
  } catch {
    throw "Cada $name debe ser una URL WebSocket válida (ws:// o wss://)."
  }
}

$normalizedPublicUrls = @()
if ($PublicUrls.Count -gt 0) {
  foreach ($publicUrl in $PublicUrls) {
    $normalizedPublicUrls += Normalize-WebSocketUrl $publicUrl 'PUBLIC_URL'
  }
  if ($normalizedPublicUrls | Where-Object { ([Uri]$_).AbsolutePath -notin @('', '/') } | Select-Object -First 1) {
    throw 'Cada PUBLIC_URL debe ser una URL WebSocket sin ruta.'
  }
  if (($normalizedPublicUrls | Select-Object -Unique).Count -ne $normalizedPublicUrls.Count) {
    throw 'Cada coordinador debe tener una PUBLIC_URL distinta.'
  }
}

$normalizedPeerUrls = @()
if ($PeerUrls.Count -gt 0) {
  foreach ($peerUrl in $PeerUrls) {
    $normalizedPeerUrls += Normalize-WebSocketUrl $peerUrl 'PEER_URL'
  }
  if (($normalizedPeerUrls | Select-Object -Unique).Count -ne $normalizedPeerUrls.Count) {
    throw 'Cada coordinador debe tener una PEER_URL distinta.'
  }
}

$allPorts = @($HttpPorts) + @($PeerPorts)
if ($allPorts | Where-Object { $_ -lt 1 -or $_ -gt 65535 } | Select-Object -First 1) {
  throw 'Todos los puertos deben estar entre 1 y 65535.'
}
if (($HttpPorts | Select-Object -Unique).Count -ne $HttpPorts.Count -or
    ($PeerPorts | Select-Object -Unique).Count -ne $PeerPorts.Count -or
    (@($HttpPorts | Where-Object { $PeerPorts -contains $_ }).Count -gt 0)) {
  throw 'Los puertos HTTP y PEER_PORT deben ser únicos y no coincidir entre sí.'
}

$envPath = Join-Path $PSScriptRoot '.env'
$nodeCommand = Get-Command node -ErrorAction Stop
$dotenvValues = @{}

if (Test-Path -LiteralPath $envPath) {
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $name = $Matches[1]
      $value = $Matches[2].Trim()
      if ($value.Length -ge 2 -and
          (($value.StartsWith('"') -and $value.EndsWith('"')) -or
           ($value.StartsWith("'") -and $value.EndsWith("'")))) {
        $value = $value.Substring(1, $value.Length - 2)
      } else {
        $value = ($value -split '\s+#', 2)[0].Trim()
      }
      $dotenvValues[$name] = $value
    }
  }
}

$authUrl = if (-not [string]::IsNullOrWhiteSpace($env:AUTH_URL)) {
  $env:AUTH_URL
} elseif ($dotenvValues.ContainsKey('AUTH_URL') -and
    -not [string]::IsNullOrWhiteSpace($dotenvValues['AUTH_URL'])) {
  $dotenvValues['AUTH_URL']
} else {
  'http://localhost:4000'
}

$sharedSecret = if (-not [string]::IsNullOrWhiteSpace($env:COORDINATOR_SHARED_SECRET)) {
  $env:COORDINATOR_SHARED_SECRET
} elseif ($dotenvValues.ContainsKey('COORDINATOR_SHARED_SECRET')) {
  $dotenvValues['COORDINATOR_SHARED_SECRET']
} else {
  $null
}
if ([string]::IsNullOrWhiteSpace($sharedSecret)) {
  throw 'Configura COORDINATOR_SHARED_SECRET en coordinator/.env o en el entorno antes de iniciar las instancias.'
}

try {
  $authUri = [Uri]$authUrl
  if ($authUri.Scheme -notin @('http', 'https') -or
      [string]::IsNullOrWhiteSpace($authUri.Host) -or
      $authUri.UserInfo -or $authUri.Query -or $authUri.Fragment) {
    throw 'AUTH_URL debe ser una URL HTTP(S) sin credenciales, query ni fragmento.'
  }
} catch {
  throw 'AUTH_URL no es una URL HTTP(S) válida.'
}

foreach ($port in $allPorts) {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
  try {
    $listener.Start()
  } catch {
    throw "El puerto $port ya está ocupado o no se puede reservar. No se inició ningún coordinador."
  } finally {
    $listener.Stop()
  }
}

$nodePath = $nodeCommand.Source
$instanceEnvironment = @(
  'PORT',
  'COORDINATOR_ID',
  'PEER_PORT',
  'PUBLIC_URL',
  'PEER_URL',
  'AUTH_URL',
  'COORDINATOR_SHARED_SECRET'
)
$originalEnvironment = @{}
foreach ($name in $instanceEnvironment) {
  $item = Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue
  $originalEnvironment[$name] = if ($null -eq $item) {
    @{ Exists = $false; Value = $null }
  } else {
    @{ Exists = $true; Value = $item.Value }
  }
}

$startedProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$startedInstances = [System.Collections.Generic.List[object]]::new()
try {
  for ($index = 0; $index -lt $HttpPorts.Count; $index++) {
    $instanceNumber = $index + 1
    $httpPort = $HttpPorts[$index]
    $peerPort = $PeerPorts[$index]
    $coordinatorId = if ($CoordinatorIds.Count -gt 0) {
      $CoordinatorIds[$index]
    } else {
      "coord-$instanceNumber"
    }
    $publicUrl = if ($normalizedPublicUrls.Count -gt 0) {
      $normalizedPublicUrls[$index]
    } else {
      "ws://localhost:$httpPort"
    }
    $peerUrl = if ($normalizedPeerUrls.Count -gt 0) {
      $normalizedPeerUrls[$index]
    } else {
      "ws://localhost:$peerPort"
    }
    $normalizedAuthUrl = $authUri.GetLeftPart([System.UriPartial]::Authority) + $authUri.PathAndQuery.TrimEnd('/')

    $env:PORT = [string]$httpPort
    $env:COORDINATOR_ID = $coordinatorId
    $env:PEER_PORT = [string]$peerPort
    $env:PUBLIC_URL = $publicUrl
    $env:PEER_URL = $peerUrl
    $env:AUTH_URL = $normalizedAuthUrl
    if ($null -ne $sharedSecret) {
      $env:COORDINATOR_SHARED_SECRET = $sharedSecret
    } else {
      Remove-Item Env:COORDINATOR_SHARED_SECRET -ErrorAction SilentlyContinue
    }

    Write-Host "Iniciando ${coordinatorId}: PORT=$httpPort, PEER_PORT=$peerPort, AUTH_URL=$authUrl"
    $process = Start-Process `
      -FilePath $nodePath `
      -ArgumentList @('index.js') `
      -WorkingDirectory $PSScriptRoot `
      -PassThru `
      -NoNewWindow
    $startedProcesses.Add($process)

    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      $process.Refresh()
      if ($process.HasExited) {
        throw "El proceso de $coordinatorId terminó durante el arranque."
      }

      $client = [System.Net.Sockets.TcpClient]::new()
      try {
        $client.Connect([System.Net.IPAddress]::Loopback, $httpPort)
        $ready = $true
        break
      } catch {
        Start-Sleep -Milliseconds 100
      } finally {
        $client.Dispose()
      }
    }
    if (-not $ready) {
      throw "El puerto HTTP de $coordinatorId no quedó disponible a tiempo."
    }
    $startedInstances.Add([pscustomobject]@{
      CoordinatorId = $coordinatorId
      ProcessId = $process.Id
      Port = $httpPort
      PeerPort = $peerPort
      PublicUrl = $publicUrl
      PeerUrl = $peerUrl
      AuthUrl = $normalizedAuthUrl
      HasSharedSecret = $null -ne $sharedSecret
    })
  }
} catch {
  foreach ($process in $startedProcesses) {
    $process.Refresh()
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
  throw "No se pudieron iniciar las $($HttpPorts.Count) instancias; se detuvieron las iniciadas por este script. Detalle: $($_.Exception.Message)"
} finally {
  foreach ($name in $instanceEnvironment) {
    $saved = $originalEnvironment[$name]
    if ($saved.Exists) {
      Set-Item -Path "Env:$name" -Value $saved.Value
    } else {
      Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
    }
  }
}

Write-Host "Las $($startedInstances.Count) instancias iniciaron; los coordinadores establecen el mesh por sus URLs peer."
$startedInstances.ToArray()
