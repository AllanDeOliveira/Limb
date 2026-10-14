import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  deepLink, ehTailscale, explicarErroFunnel, gerarCodigo, lerConvite, lerConviteCopiado, lerDeepLink, lerFunnelStatus, linkConvite, mensagemConvite,
  urlDeLogin,
} from './desktop/convite.js';

const HOST = 'https://theocarvalho.tailef554c.ts.net';

test('convite: link novo, mensagem inteira, deep link e formatos antigos', () => {
  assert.deepEqual(lerConvite(`${HOST}/convite/abc234`), { url: HOST, codigo: 'abc234' });
  assert.deepEqual(lerConvite(`${HOST}/convite/abc234/`), { url: HOST, codigo: 'abc234' });
  // a mensagem que o Limb gera, colada inteira
  assert.deepEqual(lerConvite(mensagemConvite(linkConvite(HOST, 'k7m2pq'))), { url: HOST, codigo: 'k7m2pq' });
  // código com espaço/acentos vai codificado no caminho e volta igual
  assert.deepEqual(lerConvite(linkConvite(HOST, 'minha senha ç')), { url: HOST, codigo: 'minha senha ç' });
  // pontuação e negrito do WhatsApp no fim não fazem parte do código
  assert.deepEqual(lerConvite(`Entra aqui: ${HOST}/convite/abc234.`), { url: HOST, codigo: 'abc234' });
  assert.deepEqual(lerConvite(`*${HOST}/convite/abc234*`), { url: HOST, codigo: 'abc234' });
  // outro link na mesma mensagem: o de /convite/ vence
  assert.deepEqual(lerConvite(`Baixe em https://github.com/x/y/releases e entre: ${HOST}/convite/q9`), { url: HOST, codigo: 'q9' });
  // sem https (o navegador do celular às vezes cola assim)
  assert.deepEqual(lerConvite('theocarvalho.tailef554c.ts.net/convite/abc234'), { url: HOST, codigo: 'abc234' });
  // limb:// colado
  assert.deepEqual(lerConvite(deepLink(HOST, 'abc234')), { url: HOST, codigo: 'abc234' });
  // convite do modo Tailscale (1.8): também é um link /convite/, com o endereço 100.x
  const tailscale = 'Bora conversar no Limb! 🎧\nAbre no app: http://100.101.102.103:3000/convite/k7m2pq9xa3bc\n(Antes, aceite o link do Tailscale que eu te mandei.)';
  assert.deepEqual(lerConvite(tailscale), { url: 'http://100.101.102.103:3000', codigo: 'k7m2pq9xa3bc' });
  assert.deepEqual(lerConviteCopiado(tailscale), { url: 'http://100.101.102.103:3000', codigo: 'k7m2pq9xa3bc' });
  // formatos de antes: mensagem do Tailscale, URL solta, IP solto, "Código: x"
  assert.deepEqual(lerConvite('Bora conversar no Limb! 🎧\nEndereço: http://100.101.102.103:3000\nCódigo de convite: xyz789\nAntes, aceite o link'),
    { url: 'http://100.101.102.103:3000', codigo: 'xyz789' });
  assert.deepEqual(lerConvite('http://100.1.2.3:4000/qualquer/coisa'), { url: 'http://100.1.2.3:4000', codigo: '' });
  assert.deepEqual(lerConvite('100.101.102.103'), { url: 'http://100.101.102.103:3000', codigo: '' });
  assert.deepEqual(lerConvite('100.101.102.103:3100\nCodigo: abc'), { url: 'http://100.101.102.103:3100', codigo: 'abc' });
  assert.deepEqual(lerConvite(`${HOST}/#convite=abc234`), { url: HOST, codigo: 'abc234' });
  // nada que pareça endereço
  assert.equal(lerConvite('Código: abc'), null);
  assert.equal(lerConvite(''), null);
  assert.equal(lerConvite(null), null);
  // código absurdo: fica o endereço, sem código
  assert.deepEqual(lerConvite(`${HOST}/convite/${'a'.repeat(101)}`), { url: HOST, codigo: '' });
  assert.deepEqual(lerConvite(`${HOST}/convite/%E0%A4%A`), { url: HOST, codigo: '' }); // % quebrado
});

test('convite copiado: só o que é mesmo convite do Limb vira "Entrar"', () => {
  assert.deepEqual(lerConviteCopiado(mensagemConvite(linkConvite(HOST, 'k7m2pq'))), { url: HOST, codigo: 'k7m2pq' });
  assert.deepEqual(lerConviteCopiado(`${HOST}/convite/abc`), { url: HOST, codigo: 'abc' });
  assert.deepEqual(lerConviteCopiado(deepLink(HOST, 'abc')), { url: HOST, codigo: 'abc' });
  assert.deepEqual(lerConviteCopiado('Bora conversar no Limb! 🎧\nEndereço: http://100.1.2.3:3000\nCódigo de convite: x'), { url: 'http://100.1.2.3:3000', codigo: 'x' });
  assert.equal(lerConviteCopiado('https://www.google.com/search?q=limbo'), null);
  assert.equal(lerConviteCopiado('192.168.0.1'), null);
  assert.equal(lerConviteCopiado('Limb é legal'), null); // fala do Limb, mas sem endereço
  // o link do download (da página de convite, do README) ainda copiado ao abrir o app: não é convite
  assert.equal(lerConviteCopiado('https://github.com/AllanDeOliveira/Limb/releases/latest'), null);
  assert.equal(lerConviteCopiado('baixa aqui: https://github.com/AllanDeOliveira/Limb/releases/download/v1.8.0/Limb-1.8.0-instalador.exe'), null);
  assert.equal(lerConviteCopiado('baixa o Limb: https://github.com/AllanDeOliveira/Limb'), null);
  assert.equal(lerConviteCopiado(''), null);
});

test('deep link: só limb://entrar com servidor http(s) e código curto', () => {
  assert.deepEqual(lerDeepLink(deepLink(HOST, 'abc234')), { url: HOST, codigo: 'abc234' });
  assert.deepEqual(lerDeepLink(`limb://entrar/?servidor=${encodeURIComponent(HOST)}&convite=x`), { url: HOST, codigo: 'x' });
  assert.deepEqual(lerDeepLink('limb://entrar?servidor=http%3A%2F%2F100.1.2.3%3A3000'), { url: 'http://100.1.2.3:3000', codigo: '' });
  assert.deepEqual(lerDeepLink(deepLink(HOST, 'ç é')), { url: HOST, codigo: 'ç é' });
  for (const ruim of [
    'limb://entrar?servidor=javascript%3Aalert(1)&convite=x',
    'limb://entrar?servidor=file%3A%2F%2F%2FC%3A%2FWindows&convite=x',
    'limb://entrar?servidor=data%3Atext%2Fhtml%2Cx',
    'limb://entrar?convite=abc', // sem servidor
    'limb://entrar',
    'limb://entrar?servidor=&convite=abc',
    `limb://outra?servidor=${encodeURIComponent(HOST)}&convite=x`, // ação desconhecida
    `limb://entrar/mais?servidor=${encodeURIComponent(HOST)}`,
    `limb://entrar?servidor=${encodeURIComponent(`${HOST}/caminho`)}`, // só a origem
    `limb://entrar?servidor=${encodeURIComponent(`${HOST}/?x=1`)}`,
    `limb://entrar?servidor=${encodeURIComponent('https://user:senha@x.ts.net')}`,
    `limb://entrar?servidor=${encodeURIComponent(HOST)}&convite=${'a'.repeat(101)}`, // código comprido demais
    `limb://entrar?servidor=${encodeURIComponent(HOST)}&convite=a%0Ab`, // quebra de linha no código
    `https://entrar?servidor=${encodeURIComponent(HOST)}`,
    `limb://entrar?servidor=${encodeURIComponent(HOST)}&x=${'a'.repeat(2000)}`,
    'nada', '', null,
  ]) assert.equal(lerDeepLink(ruim), null, String(ruim).slice(0, 80));
  assert.deepEqual(lerDeepLink(`limb://entrar?servidor=${encodeURIComponent(HOST)}&convite=${'a'.repeat(100)}`), { url: HOST, codigo: 'a'.repeat(100) });
});

test('funnel status: ligado, desligado, outra porta, outro alvo', () => {
  const ligado = (proxy) => JSON.stringify({
    TCP: { 443: { HTTPS: true } },
    Web: { 'theocarvalho.tailef554c.ts.net:443': { Handlers: { '/': proxy } } },
    AllowFunnel: { 'theocarvalho.tailef554c.ts.net:443': true },
  });
  assert.deepEqual(lerFunnelStatus(ligado({ Proxy: 'http://127.0.0.1:3000' })), { ativo: true, url: HOST, porta: 3000 });
  assert.deepEqual(lerFunnelStatus(ligado({ Proxy: 'http://localhost:3100' })), { ativo: true, url: HOST, porta: 3100 });
  assert.deepEqual(lerFunnelStatus(ligado({ Proxy: '3000' })), { ativo: true, url: HOST, porta: 3000 });
  // publicado, mas não para um servidor local: não é o Limb
  assert.deepEqual(lerFunnelStatus(ligado({ Proxy: 'http://192.168.0.5:3000' })), { ativo: true, url: HOST, porta: null });
  assert.deepEqual(lerFunnelStatus(ligado({ Path: 'C:\\site' })), { ativo: true, url: HOST, porta: null });
  const desligado = { ativo: false, url: null, porta: null };
  assert.deepEqual(lerFunnelStatus('{}'), desligado);
  assert.deepEqual(lerFunnelStatus(''), desligado);
  assert.deepEqual(lerFunnelStatus('não é json'), desligado);
  assert.deepEqual(lerFunnelStatus(null), desligado);
  // só serve (dentro da tailnet), sem Funnel
  assert.deepEqual(lerFunnelStatus({ Web: { 'x.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }), desligado);
  assert.deepEqual(lerFunnelStatus({ AllowFunnel: { 'x.ts.net:443': false } }), desligado);
  // Funnel em outra porta pública (8443): o convite usa a 443
  assert.deepEqual(lerFunnelStatus({ AllowFunnel: { 'x.ts.net:8443': true } }), desligado);
});

test('funnel: URL de autorização só inteira, e erros em português', () => {
  const saida = 'Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=nAbC123\n\n';
  assert.equal(urlDeLogin(saida), 'https://login.tailscale.com/f/funnel?node=nAbC123');
  assert.equal(urlDeLogin('HTTPS is not enabled. To enable, visit: https://login.tailscale.com/f/https?node=n1 \n'), 'https://login.tailscale.com/f/https?node=n1');
  assert.equal(urlDeLogin('visit: https://login.tailscale.com/f/fun'), null); // ainda chegando
  assert.equal(urlDeLogin('https://evil.example/login.tailscale.com/x\n'), null);
  assert.equal(urlDeLogin(''), null);
  assert.match(explicarErroFunnel('failed to connect to local tailscaled; it doesn\'t appear to be running'), /ligue no passo 1/);
  assert.match(explicarErroFunnel('Access denied: serve config denied'), /não deixou/);
  assert.match(explicarErroFunnel('error: something odd\n'), /não conseguiu publicar: error: something odd/);
  assert.match(explicarErroFunnel('', 'desligar a publicação'), /não conseguiu desligar a publicação/);
});

test('convite: link e código de 12 caracteres, gerado só no app', () => {
  assert.equal(linkConvite(HOST, 'a b/c'), `${HOST}/convite/a%20b%2Fc`);
  assert.equal(deepLink(HOST, 'x&y'), `limb://entrar?servidor=${encodeURIComponent(HOST)}&convite=x%26y`);
  assert.match(gerarCodigo(), /^[a-hjkmnp-z2-9]{12}$/);
  assert.notEqual(gerarCodigo(), gerarCodigo());
  assert.ok(ehTailscale('http://100.101.102.103:3000') && ehTailscale('http://100.64.0.1') && !ehTailscale('http://100.1.2.3') && !ehTailscale(HOST) && !ehTailscale('lixo'));
  const janela = readFileSync(new URL('./desktop/conexao.js', import.meta.url), 'utf8');
  // o código nasce só no app (main): a janela não tem gerador próprio que possa ficar para trás
  assert.ok(!/gerarCodigo|getRandomValues/.test(janela));
});
