# Minimal static file server using built-in .NET HttpListener (no Python or Node required).
# Serves only this folder, only on localhost. Usage: serve.ps1 -Port 8765
param([int]$Port = 8765)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'

$mime = @{
    '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
    '.json' = 'application/json'; '.webmanifest' = 'application/manifest+json'; '.png' = 'image/png'; '.ico' = 'image/x-icon'
    '.svg' = 'image/svg+xml'; '.txt' = 'text/plain; charset=utf-8'; '.md' = 'text/plain; charset=utf-8'
}

$listener = New-Object Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$Port/  (close this window to stop)"

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $res = $ctx.Response
        try {
            $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
            if ($rel -eq '') { $rel = 'index.html' }
            $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
            # Block path traversal outside the app folder
            if (-not $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $path -PathType Leaf)) {
                $res.StatusCode = 404
            } else {
                $bytes = [IO.File]::ReadAllBytes($path)
                $ext = [IO.Path]::GetExtension($path).ToLower()
                $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
                $res.Headers['Cache-Control'] = 'no-cache'
                $res.ContentLength64 = $bytes.Length
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        } catch {
            $res.StatusCode = 500
        } finally {
            $res.Close()
        }
    }
} finally {
    $listener.Close()
}
