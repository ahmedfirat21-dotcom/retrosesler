# ============================================================
# RetroSesler v2 -> Oracle Cloud Deploy Script
# Usage:
#   powershell .\deploy-to-oracle.ps1
# ============================================================

$RemoteHost = "130.61.116.233"
$RemoteUser = "ubuntu"
$KeyPath = "C:\Users\yogun\.gemini\antigravity\scratch\oracle_key.key"
$RemoteDir = "/home/ubuntu/retrosesler-v2"
$LocalDir = $PSScriptRoot

Write-Host "==> 1/5 Sunucu baglantisi kontrol ediliyor..." -ForegroundColor Cyan
ssh -i $KeyPath -o StrictHostKeyChecking=no "$RemoteUser@$RemoteHost" "uname -a"

if ($LASTEXITCODE -ne 0) {
    Write-Error "Sunucuya baglanilamadi! Lutfen anahtari ve IP adresini kontrol edin."
    exit 1
}

Write-Host "==> 2/5 Yerelde deploy paketi olusturuluyor (deploy.tar.gz)..." -ForegroundColor Cyan
# Windows native tar to package files
tar -czf deploy.tar.gz --exclude="node_modules" --exclude=".git" --exclude="retrosesler.db" --exclude=".env" --exclude="data" --exclude="deploy.tar.gz" --exclude="*.log" .

Write-Host "==> 3/5 Paket sunucuya kopyalaniyor..." -ForegroundColor Cyan
scp -i $KeyPath -o StrictHostKeyChecking=no deploy.tar.gz "$RemoteUser@$RemoteHost`:/home/ubuntu/"

if ($LASTEXITCODE -ne 0) {
    Write-Error "Kopyalama hatasi!"
    exit 1
}

Write-Host "==> 3.5/5 Zaman Tuneli seed verisi kopyalaniyor..." -ForegroundColor Cyan
scp -i $KeyPath -o StrictHostKeyChecking=no data/timeline_seed.json "$RemoteUser@$RemoteHost`:/home/ubuntu/retrosesler-v2/data/"

Write-Host "==> 4/5 Sunucuda paket aciliyor ve bagimliliklar kuruluyor..." -ForegroundColor Cyan
ssh -i $KeyPath -o StrictHostKeyChecking=no "$RemoteUser@$RemoteHost" "tar -xzf /home/ubuntu/deploy.tar.gz -C $RemoteDir/ && cd $RemoteDir && npm install --omit=dev"

Write-Host "==> 5/5 PM2 servisi yeniden baslatiliyor..." -ForegroundColor Cyan
ssh -i $KeyPath -o StrictHostKeyChecking=no "$RemoteUser@$RemoteHost" "pm2 restart retrosesler-v2"

# Local cleanup
Remove-Item -Path "$LocalDir\deploy.tar.gz" -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "==> DEPLOY BASARIYLA TAMAMLANDI! 🚀" -ForegroundColor Green
Write-Host "Sunucu PM2 durumunu gormek icin: ssh -i $KeyPath ubuntu@$RemoteHost 'pm2 status'"
