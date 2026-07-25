// Assinatura Authenticode com certificado AUTOASSINADO, gerado e mantido
// nesta máquina de build (codesign/, fora do git — ver .gitignore).
//
// Importante: isso NÃO contorna o Smart App Control do Windows (ver memória
// project_styled_installer / project_gui_testing_limitation) — o SAC decide
// confiança pela reputação na nuvem da Microsoft atrelada a uma CA
// comercial real, não pelo repositório de certificados raiz local. O que
// isso resolve é o aviso comum do SmartScreen ("editor desconhecido"), e
// só nas máquinas onde este certificado específico foi importado como
// raiz confiável (feito automaticamente aqui, nesta máquina, na primeira
// vez que assina algo). Decisão explícita do usuário de seguir esse
// caminho mesmo sabendo da limitação, como medida paliativa enquanto o
// caminho de verdade (certificado pago ou SignPath Foundation) não sai do
// papel.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const codesignDir = path.join(root, 'codesign');
const pfxPath = path.join(codesignDir, 'codesign-cert.pfx');
const pwPath = path.join(codesignDir, 'codesign-cert.pw.txt');
const CERT_SUBJECT = 'CN=Engine Wallpaper (autoassinado, dev local)';

function runPs(script) {
  return spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'inherit' });
}

function ensureCert() {
  if (fs.existsSync(pfxPath) && fs.existsSync(pwPath)) return;
  fs.mkdirSync(codesignDir, { recursive: true });
  const password = crypto.randomBytes(24).toString('base64');
  fs.writeFileSync(pwPath, password, 'utf8');
  console.log('[sign] gerando certificado de assinatura de código autoassinado (uma vez só, fica salvo em codesign/)...');
  const ps = `
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "${CERT_SUBJECT}" -KeyUsage DigitalSignature -FriendlyName "Engine Wallpaper Dev Codesign" -CertStoreLocation "Cert:\\CurrentUser\\My" -NotAfter (Get-Date).AddYears(5)
$pw = ConvertTo-SecureString -String '${password}' -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath "${pfxPath}" -Password $pw | Out-Null
Move-Item -Path "Cert:\\CurrentUser\\My\\$($cert.Thumbprint)" -Destination "Cert:\\CurrentUser\\Root" -Force
Write-Host "[sign] certificado criado e importado em Raizes Confiaveis (CurrentUser) — thumbprint: $($cert.Thumbprint)"
`;
  const result = runPs(ps);
  if (result.status !== 0 || !fs.existsSync(pfxPath)) {
    throw new Error('Falha ao gerar/exportar o certificado autoassinado — build segue sem assinatura.');
  }
}

function signExe(exePath) {
  if (!fs.existsSync(exePath)) {
    console.warn(`[sign] arquivo não encontrado, pulando: ${exePath}`);
    return false;
  }
  try {
    ensureCert();
  } catch (err) {
    console.warn(`[sign] ${err.message}`);
    return false;
  }
  const password = fs.readFileSync(pwPath, 'utf8');
  // Get-PfxCertificate -Password não existe no Windows PowerShell 5.1 (só
  // no pwsh 7+) — carregar via X509Certificate2 direto funciona nas duas
  // versões, sem prompt interativo.
  const ps = `
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2("${pfxPath}", '${password}')
$result = Set-AuthenticodeSignature -FilePath "${exePath}" -Certificate $cert -HashAlgorithm SHA256
if ($result.Status -ne 'Valid') { Write-Error "assinatura ficou com status $($result.Status): $($result.StatusMessage)"; exit 1 }
`;
  const result = runPs(ps);
  if (result.status !== 0) {
    console.warn(`[sign] falha ao assinar ${exePath} — build segue sem assinatura nesse arquivo.`);
    return false;
  }
  console.log(`[sign] assinado (certificado autoassinado local): ${path.basename(exePath)}`);
  return true;
}

module.exports = { signExe, ensureCert };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('uso: node scripts/sign.js <caminho para o .exe>');
    process.exit(1);
  }
  signExe(path.resolve(target));
}
