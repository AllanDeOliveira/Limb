import test from 'node:test';
import assert from 'node:assert/strict';
import { snowflake, fromTimestamp, timestampOf, parseSearch, searchToSql } from './lib.js';

test('snowflake: carrega a data, é único e crescente', () => {
  const ms = Date.UTC(2026, 9, 13);
  assert.equal(timestampOf(snowflake(ms)), ms);
  // id real do Discord (exemplo da documentação oficial): 175928847299117063 → 2016-04-30T11:18:25.796Z
  assert.equal(new Date(timestampOf(175928847299117063n)).toISOString(), '2016-04-30T11:18:25.796Z');
  const ids = Array.from({ length: 5000 }, () => snowflake(ms)); // > 4096 no mesmo ms
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id, i) => i === 0 || id > ids[i - 1]));
});

test('busca: filtros, OU, negação, aspas, texto e datas → faixa de snowflake', () => {
  const p = parseSearch('from:ana from:@Bia -in:geral has:link "bom dia" after:2026-10-01 before:2026-10-10 has:xyz');
  assert.deepEqual(p.filtros, { from: { sim: ['ana', '@Bia'], nao: [] }, in: { sim: [], nao: ['geral'] }, has: { sim: ['link'], nao: [] } });
  assert.deepEqual(p.texto, ['bom dia', 'has:xyz']); // has desconhecido vira texto
  assert.equal(p.min_id, fromTimestamp(new Date(2026, 9, 2).getTime())); // after = a partir do dia seguinte
  assert.equal(p.max_id, fromTimestamp(new Date(2026, 9, 10).getTime()));

  const { sql, params } = searchToSql(p);
  assert.match(sql, /^\(\(m\.author_id IN .+\) OR \(m\.author_id IN .+\)\) AND NOT \(m\.channel_id IN/);
  assert.deepEqual(params.slice(0, 3), ['ana', 'bia', 'geral']);
  assert.ok(params.includes('%bom dia%'));
});

test('busca: curingas do LIKE são escapados e vazio não filtra', () => {
  assert.deepEqual(searchToSql(parseSearch('100%_')).params, ['%100\\%\\_%']);
  assert.deepEqual(searchToSql(parseSearch('')), { sql: '1', params: [] });
});
