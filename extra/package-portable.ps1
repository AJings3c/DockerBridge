param(
    [string]$OutputDirectory = "artifacts"
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$outputRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))

if (!$outputRoot.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Output directory must be inside the repository."
}

$package = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$nodePlatform = & node -p "process.platform"
$nodeArch = & node -p "process.arch"
$platformName = switch ($nodePlatform.Trim()) {
    "win32" { "windows" }
    "darwin" { "macos" }
    "linux" { "linux" }
    default { throw "Unsupported platform: $nodePlatform" }
}
$assetName = "dockerbridge-$($package.version)-$platformName-$($nodeArch.Trim())"
$bundleRoot = [IO.Path]::GetFullPath((Join-Path $outputRoot $assetName))

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (Test-Path -LiteralPath $bundleRoot) {
    Remove-Item -LiteralPath $bundleRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $bundleRoot "runtime") | Out-Null

foreach ($directory in @("backend", "common", "frontend-dist", "node_modules")) {
    $source = Join-Path $repoRoot $directory
    if (!(Test-Path -LiteralPath $source)) {
        throw "Required release directory is missing: $directory"
    }
    Copy-Item -LiteralPath $source -Destination $bundleRoot -Recurse
}

foreach ($file in @("LICENSE", "README.md", "package.json")) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $bundleRoot
}

$nodeBinary = (Get-Command node -ErrorAction Stop).Source
$runtimeName = if ($nodePlatform.Trim() -eq "win32") { "node.exe" } else { "node" }
Copy-Item -LiteralPath $nodeBinary -Destination (Join-Path $bundleRoot "runtime/$runtimeName")
$nodeLicense = Join-Path (Split-Path $nodeBinary -Parent) "LICENSE"
if (Test-Path -LiteralPath $nodeLicense) {
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $bundleRoot "runtime/NODE-LICENSE")
}

if ($nodePlatform.Trim() -eq "win32") {
    Copy-Item -LiteralPath (Join-Path $repoRoot "packaging/dockerbridge.cmd") -Destination $bundleRoot
    $archive = Join-Path $outputRoot "$assetName.zip"
    if (Test-Path -LiteralPath $archive) {
        Remove-Item -LiteralPath $archive -Force
    }
    Compress-Archive -LiteralPath $bundleRoot -DestinationPath $archive -CompressionLevel Optimal
} else {
    Copy-Item -LiteralPath (Join-Path $repoRoot "packaging/dockerbridge") -Destination $bundleRoot
    & chmod +x (Join-Path $bundleRoot "dockerbridge") (Join-Path $bundleRoot "runtime/node")
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to mark portable launchers as executable."
    }
    $archive = Join-Path $outputRoot "$assetName.tar.gz"
    if (Test-Path -LiteralPath $archive) {
        Remove-Item -LiteralPath $archive -Force
    }
    & tar -czf $archive -C $outputRoot $assetName
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create portable archive."
    }
}

Remove-Item -LiteralPath $bundleRoot -Recurse -Force
Write-Output $archive
