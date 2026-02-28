$root = $PSScriptRoot
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://localhost:8888/')
$listener.Start()
Write-Host "Server running on http://localhost:8888 (root: $root)"

$mimeTypes = @{
    '.html'  = 'text/html; charset=utf-8'
    '.css'   = 'text/css; charset=utf-8'
    '.js'    = 'application/javascript; charset=utf-8'
    '.png'   = 'image/png'
    '.jpg'   = 'image/jpeg'
    '.gif'   = 'image/gif'
    '.svg'   = 'image/svg+xml'
    '.ico'   = 'image/x-icon'
    '.woff'  = 'font/woff'
    '.woff2' = 'font/woff2'
}

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $localPath = $ctx.Request.Url.LocalPath
    if ($localPath -eq '/') { $localPath = '/index.html' }

    # Decode URL encoding and build file path
    $decoded = [System.Uri]::UnescapeDataString($localPath).TrimStart('/')
    $file = Join-Path $root $decoded

    Write-Host "$($ctx.Request.HttpMethod) $localPath -> $file"

    if (Test-Path $file -PathType Leaf) {
        $bytes = [System.IO.File]::ReadAllBytes($file)
        $ext = [System.IO.Path]::GetExtension($file).ToLower()
        $ctx.Response.ContentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { 'application/octet-stream' }
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
    else {
        $ctx.Response.StatusCode = 404
        $body = [System.Text.Encoding]::UTF8.GetBytes("<h1>404 - Dosya bulunamadi: $decoded</h1>")
        $ctx.Response.ContentType = 'text/html; charset=utf-8'
        $ctx.Response.ContentLength64 = $body.Length
        $ctx.Response.OutputStream.Write($body, 0, $body.Length)
    }
    $ctx.Response.Close()
}
