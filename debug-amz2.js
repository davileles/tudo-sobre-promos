// Sonda temporária: descobrir group_by/colunas válidos para itens pedidos.
const AMAZON_COOKIE = process.env.AMAZON_COOKIE;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

(async () => {
  const r = await fetch('https://associados.amazon.com.br/p/reporting/earnings', {
    headers: { 'user-agent': UA, 'accept-language': 'pt-BR,pt;q=0.9', cookie: AMAZON_COOKIE },
    redirect: 'manual',
  });
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  const html = await r.text();
  const Q = '(?:\\\\"|"|&quot;)';
  const campo = (n) => { const m = html.match(new RegExp(n + Q + '\\s*:\\s*' + Q + '([^"\\\\&]+)')); return m ? m[1] : null; };
  const arr = (n) => { const m = html.match(new RegExp(n + Q + '\\s*:\\s*\\[([^\\]]*)\\]')); return m ? [...m[1].matchAll(new RegExp(Q + '([^"\\\\&,\\]]+)' + Q,'g'))].map(x=>x[1]) : []; };
  const storeId = campo('storeId');
  const H = {
    'user-agent': UA, accept: 'application/json',
    cookie: [AMAZON_COOKIE, ...sc.map(s=>s.split(';')[0].trim())].filter(Boolean).join('; '),
    authorization: 'Bearer ' + campo('associateIdentityToken'),
    marketplaceid: campo('marketplaceId')||'', locale: campo('locale')||'BR',
    storeid: storeId, customerid: campo('customerId')||'', programid: campo('programId')||'',
    roles: arr('roles').join(','), language: campo('language')||'pt_BR',
    'x-requested-with': 'XMLHttpRequest',
    referer: 'https://associados.amazon.com.br/p/reporting/earnings',
    origin: 'https://associados.amazon.com.br', 'accept-language': 'pt-BR,pt;q=0.9',
  };

  const tenta = async (rotulo, params) => {
    const qs = new URLSearchParams(Object.assign({
      'query[start_date]': '2026-08-10', 'query[end_date]': '2026-08-16',
      'query[order]': 'desc', 'query[skip]': '0', 'query[limit]': '5', 'query[next_token]': '',
      'query[storeId]': storeId, 'query[locale]': 'BR', store_id: storeId,
    }, params));
    const t = await fetch('https://associados.amazon.com.br/reporting/table?' + qs, { headers: H });
    let corpo = '';
    try {
      const txt = await t.text();
      if (t.status === 200) {
        const j = JSON.parse(txt);
        const rec = (j.records||[])[0];
        corpo = 'chaves=' + (rec ? Object.keys(rec).join(',') : '(sem registros)');
      } else corpo = txt.slice(0,220).replace(/\s+/g,' ');
    } catch(e){ corpo = 'erro ' + e.message; }
    console.log(`[${rotulo}] ${t.status} :: ${corpo}`);
    await new Promise(res=>setTimeout(res,500));
  };

  // Sem columns: descobrir o default de cada group_by
  for (const gb of ['asin','product','item','tag_id']) {
    await tenta('type=earning gb=' + gb, { 'query[type]':'earning', 'query[group_by]': gb });
  }
  for (const tp of ['orders','item','product','earning']) {
    await tenta('type=' + tp + ' gb=asin', { 'query[type]': tp, 'query[group_by]':'asin' });
  }
})();
