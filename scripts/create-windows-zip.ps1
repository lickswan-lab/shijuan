param(
  [string]$SourceDir = "dist-packager\拾卷-win32-x64",
  [string]$Destination = "dist-packager\shijuan-win-x64.zip",
  [string]$RootName = "shijuan-win-x64"
)

$ErrorActionPreference = "Stop"

$resolvedSource = Resolve-Path -LiteralPath $SourceDir
$sourcePath = $resolvedSource.ProviderPath.TrimEnd('\', '/')
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
$destinationDir = [System.IO.Path]::GetDirectoryName($destinationPath)
$tempPath = [System.IO.Path]::Combine($destinationDir, ([System.IO.Path]::GetFileName($destinationPath) + ".tmp"))

if (-not (Test-Path -LiteralPath $destinationDir)) {
  New-Item -ItemType Directory -Path $destinationDir | Out-Null
}
if (Test-Path -LiteralPath $tempPath) {
  Remove-Item -LiteralPath $tempPath -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open($tempPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $files = Get-ChildItem -LiteralPath $sourcePath -Recurse -File
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($sourcePath.Length).TrimStart([char[]]@('\', '/'))
    $entryName = ($RootName.TrimEnd('/', '\') + '/' + $relative).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip,
      $file.FullName,
      $entryName,
      [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
} finally {
  $zip.Dispose()
}

if (Test-Path -LiteralPath $destinationPath) {
  Remove-Item -LiteralPath $destinationPath -Force
}
Move-Item -LiteralPath $tempPath -Destination $destinationPath

$sizeMb = ((Get-Item -LiteralPath $destinationPath).Length / 1MB).ToString("0.0")
Write-Host "[create-windows-zip] $destinationPath ($sizeMb MB)"
