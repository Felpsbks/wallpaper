# Diagnóstico do Lively Wallpaper — só pra comparação/investigação, não mexe
# em nada. Precisa que o Lively esteja ABERTO com um wallpaper de vídeo
# tocando antes de rodar isso.
# Gera um relatório em .txt na Área de Trabalho e abre no Bloco de Notas.

$ErrorActionPreference = 'SilentlyContinue'
$out = New-Object System.Text.StringBuilder
function Add($linha = '') { [void]$out.AppendLine($linha) }

$desktopPath = [Environment]::GetFolderPath('Desktop')

Add "=== DIAGNÓSTICO LIVELY WALLPAPER ==="
Add "Gerado em: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Add ""

# --- 1. Processos do Lively rodando ---
Add "--- 1. Processos do Lively rodando ---"
$livelyProcs = Get-Process | Where-Object { $_.ProcessName -match "Lively" }
if ($livelyProcs) {
    foreach ($p in $livelyProcs) {
        Add "  $($p.ProcessName) (PID $($p.Id))"
        Add "    Caminho: $($p.Path)"
    }
} else {
    Add "  Nenhum processo com 'Lively' no nome encontrado."
    Add "  Abra o Lively, ative um wallpaper de vídeo, espere ele aparecer na tela, e rode este script de novo."
}
Add ""

# --- 2. Bibliotecas de vídeo/gráfico carregadas por cada processo ---
# Se aparecer libmpv/vlc/avcodec, é player nativo (não passa pelo Chromium).
# Se aparecer libcef/chromium, ele também usa um navegador por dentro, igual
# ao nosso app — nesse caso a explicação "Live não usa Chromium" cairia.
Add "--- 2. Bibliotecas carregadas por processo (indica a tecnologia de vídeo) ---"
$keywords = 'mpv|libvlc|vlc|libcef|cef|chromium|d3d11|d3d9|dxgi|opengl|avcodec|avformat|swscale|mediafoundation|mfplat|wmvcore|evr|quartz'
foreach ($p in $livelyProcs) {
    Add "  [$($p.ProcessName) PID $($p.Id)]"
    try {
        $mods = $p.Modules | Select-Object -ExpandProperty ModuleName -ErrorAction Stop
        $found = $mods | Where-Object { $_ -imatch $keywords } | Sort-Object -Unique
        if ($found) {
            foreach ($m in $found) { Add "    $m" }
        } else {
            Add "    (nenhuma DLL conhecida encontrada nesse processo)"
        }
    } catch {
        Add "    Não consegui ler os módulos desse processo (comum sem rodar como administrador)."
    }
    Add ""
}

Add "=== FIM DO DIAGNÓSTICO ==="

$destino = Join-Path $desktopPath "diagnostico-lively.txt"
$out.ToString() | Out-File -FilePath $destino -Encoding utf8

Start-Process notepad.exe $destino
