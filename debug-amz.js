// Diagnóstico temporário da API de relatórios por tag — remover após uso.
const crypto = require('crypto');
const AMAZON_COOKIE = process.env.AMAZON_COOKIE;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const mask = (s) => s ? `${String(s).length}ch#${crypto.createHash('sha1').update(String(s)).digest('hex').slice(0,8)}` : '(vazio)';

(async () => {
  const r = await fetch('https://associados.amazon.com.br/p/reporting/earnings', {
    headers: { 'user-agent': UA, 'accept-language': 'pt-BR,pt;q=0.9', cookie: AMAZON_COOKIE },
    redirect: 'manual',
  });
  console.log('pagina status:', r.status);
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  console.log('set-cookies emitidos:', sc.map((s) => s.split('=')[0]).join(', ') || '(nenhum)');
  const html = await r.text();
  console.log('html:', html.length, 'bytes | ocorrencias de associateIdentityToken:', (html.match(/associateIdentityToken/g) || []).length);

  const Q = '(?:\\\\"|"|&quot;)';
  const campo = (nome, ultimo) => {
    const re = new RegExp(nome + Q + '\\s*:\\s*' + Q + '([^"\\\\&]+)', 'g');
    const ms = [...html.matchAll(re)].map((m) => m[1]);
    return ms.length ? (ultimo ? ms[ms.length - 1] : ms[0]) : null;
  };
  const camposArr = (nome) => {
    const m = html.match(new RegExp(nome + Q + '\\s*:\\s*\\[([^\\]]*)\\]'));
    if (!m) return [];
    return [...m[1].matchAll(new RegExp(Q + '([^"\\\\&,\\]]+)' + Q, 'g'))].map((x) => x[1]);
  };

  const tok1 = campo('associateIdentityToken', false);
  const tokN = campo('associateIdentityToken', true);
  console.log('token[primeiro]:', mask(tok1), '| token[ultimo]:', mask(tokN), '| iguais:', tok1 === tokN);
  const ctx = {
    storeId: campo('storeId'), marketplaceId: campo('marketplaceId'),
    customerId: campo('customerId'), programId: campo('programId'),
    locale: campo('locale'), language: campo('language'), roles: camposArr('roles'),
  };
  console.log('ctx:', JSON.stringify({ ...ctx, customerId: mask(ctx.customerId) }));

  const cookieMerged = [AMAZON_COOKIE, ...sc.map((s) => s.split(';')[0].trim())].filter(Boolean).join('; ');
  const url = 'https://associados.amazon.com.br/reporting/table?' + new URLSearchParams({
    'query[type]': 'overview', 'query[start_date]': '2026-08-16', 'query[end_date]': '2026-08-16',
    'query[group_by]': 'tag_id', 'query[columns]': 'tag_value,clicks',
    'query[order]': 'desc', 'query[sort]': 'clicks',
    'query[skip]': '0', 'query[limit]': '10', 'query[next_token]': '',
    'query[storeId]': ctx.storeId, 'query[locale]': 'BR', store_id: ctx.storeId,
  }).toString();

  const baseH = (tok) => ({
    'user-agent': UA, accept: 'application/json',
    authorization: 'Bearer ' + tok,
    marketplaceid: ctx.marketplaceId || '', locale: ctx.locale || 'BR',
    storeid: ctx.storeId || '', customerid: ctx.customerId || '',
    programid: ctx.programId || '', roles: ctx.roles.join(','),
    language: ctx.language || 'pt_BR', 'x-requested-with': 'XMLHttpRequest',
  });

  const variantes = [
    ['A: cookie original', { ...baseH(tok1), cookie: AMAZON_COOKIE }],
    ['B: cookie mesclado', { ...baseH(tok1), cookie: cookieMerged }],
    ['C: B + referer/origin', { ...baseH(tok1), cookie: cookieMerged,
      referer: 'https://associados.amazon.com.br/p/reporting/earnings',
      origin: 'https://associados.amazon.com.br', 'accept-language': 'pt-BR,pt;q=0.9' }],
    ['D: C com ultimo token', { ...baseH(tokN), cookie: cookieMerged,
      referer: 'https://associados.amazon.com.br/p/reporting/earnings',
      origin: 'https://associados.amazon.com.br', 'accept-language': 'pt-BR,pt;q=0.9' }],
  ];
  for (const [nome, H] of variantes) {
    const t = await fetch(url, { headers: H });
    const info = ['www-authenticate', 'x-amzn-errortype', 'x-amzn-requestid', 'content-type']
      .map((k) => k + '=' + (t.headers.get(k) || '-')).join(' | ');
    let corpo = '';
    try { corpo = (await t.text()).slice(0, 200).replace(/[A-Za-z0-9+/=]{30,}/g, '<VAL>').replace(/\s+/g, ' '); } catch {}
    console.log(`[${nome}] status ${t.status} :: ${info} :: corpo: ${corpo}`);
    await new Promise((res) => setTimeout(res, 400));
  }
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
