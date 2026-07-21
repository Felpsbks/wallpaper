# Diagnóstico do Engine Wallpaper — problema de vídeo/GPU
# Gera um relatório em .txt na Área de Trabalho e abre no Bloco de Notas.

$ErrorActionPreference = 'SilentlyContinue'
$out = New-Object System.Text.StringBuilder
function Add($linha = '') { [void]$out.AppendLine($linha) }

# OneDrive costuma redirecionar a Área de Trabalho pra fora de
# $env:USERPROFILE\Desktop — usar a API do Windows pra achar o caminho real.
$desktopPath = [Environment]::GetFolderPath('Desktop')

Add "=== DIAGNÓSTICO ENGINE WALLPAPER ==="
Add "Gerado em: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Add ""

# --- 1. Encontrar a pasta instalada do app ---
Add "--- 1. Localização do app ---"
$searchRoots = @(
    "$env:LOCALAPPDATA",
    $desktopPath,
    "$env:USERPROFILE\Downloads",
    "$env:ProgramFiles",
    "${env:ProgramFiles(x86)}",
    "$env:USERPROFILE"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

$exePath = $null
foreach ($root in $searchRoots) {
    $found = Get-ChildItem -Path $root -Filter "Engine Wallpaper.exe" -Recurse -File -Depth 4 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $exePath = $found.FullName; break }
}

if (-not $exePath) {
    Add "NÃO ENCONTRADO automaticamente (Engine Wallpaper.exe não apareceu na busca)."
    Add "Procurei em: $($searchRoots -join ', ')"
    $appDir = $null
} else {
    Add "Encontrado em: $exePath"
    $appDir = Split-Path $exePath -Parent
}
Add ""

# --- 2. Checar as DLLs de GPU ---
Add "--- 2. DLLs de GPU (essenciais pro Chromium desenhar na tela) ---"
$dlls = @(
    @{ Nome = "d3dcompiler_47.dll"; EsperadoKB = 4801 },
    @{ Nome = "libEGL.dll";         EsperadoKB = 469  },
    @{ Nome = "libGLESv2.dll";      EsperadoKB = 7245 },
    @{ Nome = "vk_swiftshader.dll"; EsperadoKB = 5128 },
    @{ Nome = "vulkan-1.dll";       EsperadoKB = 910  }
)

if ($appDir) {
    foreach ($d in $dlls) {
        $p = Join-Path $appDir $d.Nome
        if (Test-Path $p) {
            $sizeKB = [math]::Round((Get-Item $p).Length / 1KB)
            $status = "OK"
            if ($sizeKB -lt ($d.EsperadoKB * 0.5)) { $status = "SUSPEITO (tamanho bem menor que o esperado — pode ter sido corrompido/adulterado)" }
            Add ("  {0,-22} {1,10} KB  [{2}]" -f $d.Nome, $sizeKB, $status)
        } else {
            Add ("  {0,-22} {1,10}      [FALTANDO]" -f $d.Nome, "---")
        }
    }
} else {
    Add "  (pulado — pasta do app não encontrada)"
}
Add ""

# --- 3. Histórico de proteção do Windows Defender (últimos 30 dias) ---
Add "--- 3. Histórico do Windows Defender (detecções recentes) ---"
$since = (Get-Date).AddDays(-30)
$defenderEvents = Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; StartTime = $since } -ErrorAction SilentlyContinue |
    Where-Object { $_.Id -in 1116, 1117 }

if ($defenderEvents) {
    foreach ($ev in $defenderEvents) {
        $msg = $ev.Message -replace "`r`n", " | "
        Add "  [$($ev.TimeCreated)] $msg"
        Add ""
    }
} else {
    Add "  Nenhuma detecção do Defender nos últimos 30 dias (ou o log não pôde ser lido)."
}
Add ""

# --- 4. Log interno do app (linha [GPU], gravada em disco desde a v1.0.10) ---
Add "--- 4. Log interno do app (linha [GPU]) ---"
$appLog = Join-Path $env:APPDATA "engine-wallpaper\app-log.txt"
if (Test-Path $appLog) {
    $gpuLines = Select-String -Path $appLog -Pattern "\[GPU" -ErrorAction SilentlyContinue
    if ($gpuLines) {
        foreach ($l in $gpuLines) { Add "  $($l.Line)" }
    } else {
        Add "  Arquivo existe mas não tem nenhuma linha [GPU] (atualize o app pra versão mais recente e abra ele de novo)."
    }
} else {
    Add "  Não encontrado em $appLog (atualize o app pra versão mais recente e abra ele pelo menos uma vez antes de rodar este diagnóstico)."
}
Add ""

Add "--- 4b. Log completo de boot (boot-log.txt) ---"
$bootLog = Join-Path $env:APPDATA "engine-wallpaper\boot-log.txt"
if (Test-Path $bootLog) {
    Get-Content $bootLog | ForEach-Object { Add "  $_" }
} else {
    Add "  Não encontrado em $bootLog."
}
Add ""

# --- 5. Placa de vídeo / driver, segundo o Windows ---
Add "--- 5. GPU segundo o Windows ---"
$gpus = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
foreach ($g in $gpus) {
    Add "  Nome: $($g.Name)"
    Add "  Versão do driver: $($g.DriverVersion)"
    Add "  Data do driver: $($g.DriverDate)"
    Add "  Status: $($g.Status)"
    Add ""
}

# --- 6. Versão do Windows ---
Add "--- 6. Sistema ---"
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
Add "  $($os.Caption) — Build $($os.BuildNumber)"
Add ""

Add "=== FIM DO DIAGNÓSTICO ==="

$destino = Join-Path $desktopPath "diagnostico-engine-wallpaper.txt"
$out.ToString() | Out-File -FilePath $destino -Encoding utf8

Start-Process notepad.exe $destino
