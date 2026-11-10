param(
  [int[]]$HttpPorts = @(5001, 5002, 5003),
  [int[]]$PeerPorts = @(6001, 6002, 6003),
  [string[]]$PublicUrls = @()
)

$ErrorActionPreference = 'Stop'

if ($HttpPorts.Count -ne 3 -or $PeerPorts.Count -ne 3) {
  throw 'Debes proporcionar exactamente tres puertos HTTP y tres puertos peer.'
}
if ($PublicUrls.Count -gt 0 -and $PublicUrls.Count -ne 3) {
  throw 'Debes proporcionar exactamente tres PUBLIC_URL o no proporcionar ninguno.'
}

$normalizedPublicUrls = @()
if ($PublicUrls.Count -eq 3) {
  foreach ($publicUrl in $PublicUrls) {
    try {
      $publicUri = [Uri]$publicUrl
      if ($publicUri.Scheme -notin @('ws', 'wss') -or
          [string]::IsNullOrWhiteSpace($publicUri.Host) -or
          $publicUri.UserInfo -or $publicUri.Query -or $publicUri.Fragment -or
          $publicUri.AbsolutePath -notin @('', '/')) {
        throw 'PUBLIC_URL debe usar ws:// o wss:// sin credenciales, ruta, query ni fragmento.'
      }
      $normalizedPublicUrls += $publicUri.GetLeftPart([System.UriPartial]::Authority)
    } catch {
      throw 'Cada PUBLIC_URL debe ser una URL WebSocket válida (ws:// o wss://).'
    }
  }
  if (($normalizedPublicUrls | Select-Object -Unique).Count -ne 3) {
    throw 'Cada coordinador debe tener una PUBLIC_URL distinta.'
  }
}

$allPorts = @($HttpPorts) + @($PeerPorts)
if ($allPorts | Where-Object { $_ -lt 1 -or $_ -gt 65535 } | Select-Object -First 1) {
  throw 'Todos los puertos deben estar entre 1 y 65535.'
}
if (($HttpPorts | Select-Object -Unique).Count -ne 3 -or
    ($PeerPorts | Select-Object -Unique).Count -ne 3 -or
    (@($HttpPorts | Where-Object { $PeerPorts -contains $_ }).Count -gt 0)) {
  throw 'Los puertos HTTP y PEER_PORT deben ser únicos y no coincidir entre sí.'
}

$envPath = Join-Path $PSScriptRoot '.env'
$dotenvDirectory = Join-Path $PSScriptRoot 'node_modules\dotenv'
$nodeCommand = Get-Command node -ErrorAction Stop
$dotenvValues = @{}

if (Test-Path -LiteralPath $envPath) {
  if (-not (Test-Path -LiteralPath $dotenvDirectory)) {
    throw 'No se encontró dotenv. Ejecuta npm install en la carpeta coordinator.'
  }

  $dotenvJson = & $nodeCommand.Source -e `
    'const fs=require("node:fs"); const dotenv=require(process.argv[1]); process.stdout.write(JSON.stringify(dotenv.parse(fs.readFileSync(process.argv[2]))));' `
    $dotenvDirectory $envPath
  if ($LASTEXITCODE -ne 0) {
    throw 'No se pudo leer la configuración del archivo coordinator/.env.'
  }
  $parsedDotenv = $dotenvJson | ConvertFrom-Json
  foreach ($property in $parsedDotenv.PSObject.Properties) {
    $dotenvValues[$property.Name] = [string]$property.Value
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

foreach ($port in $HttpPorts) {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
  try {
    $listener.Start()
  } catch {
    throw "El puerto HTTP $port ya está ocupado o no se puede reservar. No se inició ningún coordinador."
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
  for ($index = 0; $index -lt 3; $index++) {
    $instanceNumber = $index + 1
    $httpPort = $HttpPorts[$index]
    $peerPort = $PeerPorts[$index]
    $coordinatorId = "coord-$instanceNumber"
    $publicUrl = if ($normalizedPublicUrls.Count -eq 3) {
      $normalizedPublicUrls[$index]
    } else {
      "ws://localhost:$httpPort"
    }
    $peerUrl = "ws://localhost:$peerPort"
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
  throw "No se pudieron iniciar las tres instancias; se detuvieron las iniciadas por este script. Detalle: $($_.Exception.Message)"
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

Write-Host 'Las tres instancias iniciaron; los coordinadores establecen el mesh por sus puertos peer.'
$startedInstances.ToArray()
