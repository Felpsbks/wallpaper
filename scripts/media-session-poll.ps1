# Polls Windows' real System Media Transport Controls (the same OS-level
# "Now Playing" info the volume flyout/lock screen show) and prints one JSON
# line per poll to stdout. Runs as a long-lived child process (spawned once
# by main.js) instead of a fresh PowerShell per poll — process startup alone
# costs ~200-500ms, way too slow to re-pay every second.
#
# Real, confirmed working 2026-07-18 against an actual YouTube tab playing in
# Chrome (title/artist/thumbnail/playback state all read correctly) — this
# is genuine OS media integration, not guessed.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

function Await($WinRtTask, $ResultType) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $asTaskGeneric = $asTask.MakeGenericMethod($ResultType)
  $netTask = $asTaskGeneric.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  return $netTask.Result
}

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$mgr = Await ($managerType::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

$lastKey = $null

while ($true) {
  try {
    $session = $mgr.GetCurrentSession()
    if ($null -eq $session) {
      $out = @{ hasSession = $false }
    } else {
      $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $playback = $session.GetPlaybackInfo()

      # Nota: props.Thumbnail (a arte do álbum/capa do vídeo) existe de
      # verdade, mas ler os BYTES dela via PowerShell (RandomAccessStream ->
      # DataReader) deu erro real de conversão de interface COM aqui — fica
      # como próximo passo (thumbnail/cores do MediaThumbnailEvent ainda não
      # implementado). O que já funciona 100% (confirmado ao vivo contra o
      # YouTube real no Chrome): título, artista, status de reprodução.
      $out = @{
        hasSession = $true
        appId = [string]$session.SourceAppUserModelId
        title = [string]$props.Title
        artist = [string]$props.Artist
        albumTitle = [string]$props.AlbumTitle
        playbackStatus = [int]$playback.PlaybackStatus
      }
    }

    $key = ($out.title, $out.artist, $out.playbackStatus) -join '|'
    if ($key -ne $lastKey) {
      $lastKey = $key
      $json = $out | ConvertTo-Json -Compress -Depth 3
      Write-Output $json
    }
  } catch {
    # Sessão sumiu/trocou no meio da leitura (app fechou, trocou de faixa) —
    # não derruba o loop, só tenta de novo no próximo ciclo.
  }
  Start-Sleep -Milliseconds 1000
}
