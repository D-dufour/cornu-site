$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    & node build.js
    if ($LASTEXITCODE -ne 0) { throw 'Website build failed. No upload package was created.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $releaseDirectory = Join-Path $PSScriptRoot 'release'
    New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
    $archivePath = Join-Path $releaseDirectory 'cornu-yourhosting.zip'
    if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath }
    $websiteDirectory = Join-Path $PSScriptRoot 'docs'
    $archive = [System.IO.Compression.ZipFile]::Open($archivePath, 'Create')
    try {
        foreach ($file in Get-ChildItem -LiteralPath $websiteDirectory -Recurse -File -Force) {
            # ZIP entry names use forward slashes for extraction on Linux hosts.
            $entryName = $file.FullName.Substring($websiteDirectory.Length + 1).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $file.FullName, $entryName,
                [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally {
        $archive.Dispose()
    }
    Write-Output "Upload package: $archivePath"
} finally {
    Pop-Location
}
