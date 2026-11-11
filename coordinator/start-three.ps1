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

Write-Warning 'start-three.ps1 se conserva por compatibilidad; usa start-coordinators.ps1.'
& (Join-Path $PSScriptRoot 'start-coordinators.ps1') `
  -Count $Count `
  -HttpPortStart $HttpPortStart `
  -PeerPortStart $PeerPortStart `
  -HttpPorts $HttpPorts `
  -PeerPorts $PeerPorts `
  -CoordinatorIds $CoordinatorIds `
  -PublicUrls $PublicUrls `
  -PeerUrls $PeerUrls
