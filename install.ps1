# Instala ou atualiza o Limb pelo terminal (PowerShell), sem perguntas:
#
#   irm https://raw.githubusercontent.com/AllanDeOliveira/Limb/main/install.ps1 | iex
#
# Baixa o instalador da última versão publicada no GitHub, fecha o Limb se estiver aberto, instala para o
# usuário atual (sem precisar de administrador) e abre o app. Seus dados (%APPDATA%\Limb) são mantidos.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # a barra de progresso deixa o download muito mais lento no PowerShell 5
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'AllanDeOliveira/Limb'
Write-Host 'Procurando a versão mais recente do Limb...'
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'limb-install' }
$asset = $release.assets | Where-Object { $_.name -like '*-instalador.exe' } | Select-Object -First 1
if (-not $asset) { throw "O release $($release.tag_name) não tem o instalador." }

$exe = Join-Path $env:LOCALAPPDATA 'Programs\Limb\Limb.exe'
$atual = if (Test-Path $exe) { (Get-Item $exe).VersionInfo.ProductVersion } else { $null }
$nova = $release.tag_name.TrimStart('v')
if ($atual -eq $nova) {
  Write-Host "O Limb $nova já está instalado. Nada a fazer." -ForegroundColor Green
  return
}

$destino = Join-Path $env:TEMP $asset.name
Write-Host "Baixando o Limb $nova ($([math]::Round($asset.size / 1MB)) MB)..."
Invoke-WebRequest $asset.browser_download_url -OutFile $destino -UseBasicParsing

$aberto = Get-Process -Name 'Limb' -ErrorAction SilentlyContinue
if ($aberto) {
  Write-Host 'Fechando o Limb para atualizar...'
  $aberto | Stop-Process -Force
  Start-Sleep -Seconds 2
}

Write-Host 'Instalando...'
Start-Process -FilePath $destino -ArgumentList '/S' -Wait # /S = silencioso, instala para o usuário atual
Remove-Item $destino -ErrorAction SilentlyContinue

if (Test-Path $exe) {
  $acao = if ($atual) { "atualizado de $atual para $nova" } else { "$nova instalado" }
  Write-Host "Limb $acao. Abrindo..." -ForegroundColor Green
  Start-Process $exe
} else {
  Write-Host 'A instalação terminou, mas não achei o Limb em' $exe -ForegroundColor Yellow
}
