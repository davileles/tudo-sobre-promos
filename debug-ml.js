// Sonda temporária: procurar a visão por link/etiqueta no dashboard de
// afiliados do ML. Imprime status + chaves de estrutura, sem valores.
const ML_COOKIE = process.env.ML_COOKIE;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const range = '2026-08-10T00:00:00.000-03:00--2026-08-16T23:59:59.999-03:00';
const BASE = 'https://www.mercadolivre.com.br/affiliate-program/api';

const forma = (v, prof = 0) => {
  if (prof > 2) return '…';
  if (Array.isArray(v)) return v.length ? '[' + v.length + 'x ' + forma(v[0], prof + 1) + ']' : '[]';
  if (v && typeof v === 'object') {
    const ks = Object.keys(v).slice(0, 12);
    return '{' + ks.map((k) => k + ':' + (typeof v[k] === 'object' && v[k] ? forma(v[k], prof + 1) : typeof v[k])).join(',') + '}';
  }
  return typeof v;
};

const candidatos = [
  ['general (controle)', `${BASE}/dashboard/general?filter_time_range=${encodeURIComponent(range)}&metric_tab=general&type=GENERAL&page=1`],
  ['type=LINKS',         `${BASE}/dashboard/general?filter_time_range=${encodeURIComponent(range)}&metric_tab=general&type=LINKS&page=1`],
  ['type=LINK',          `${BASE}/dashboard/general?filter_time_range=${encodeURIComponent(range)}&metric_tab=general&type=LINK&page=1`],
  ['type=TAGS',          `${BASE}/dashboard/general?filter_time_range=${encodeURIComponent(range)}&metric_tab=general&type=TAGS&page=1`],
  ['metric_tab=links',   `${BASE}/dashboard/general?filter_time_range=${encodeURIComponent(range)}&metric_tab=links&type=GENERAL&page=1`],
  ['metric_tab=orders',  `${BASE}/dashboard/general?filter_time_range=${encodeURIComponent(range)}&metric_tab=orders&type=GENERAL&page=1`],
  ['dashboard/links',    `${BASE}/dashboard/links?filter_time_range=${encodeURIComponent(range)}&page=1`],
  ['dashboard/table',    `${BASE}/dashboard/table?filter_time_range=${encodeURIComponent(range)}&page=1`],
  ['dashboard/detail',   `${BASE}/dashboard/detail?filter_time_range=${encodeURIComponent(range)}&page=1`],
  ['v2/links (lista)',   `${BASE}/v2/affiliates/links?page=1`],
  ['links (lista)',      `${BASE}/links?page=1`],
  ['tags (etiquetas)',   `${BASE}/tags`],
  ['labels',             `${BASE}/labels`],
  ['v2/labels',          `${BASE}/v2/affiliates/labels`],
];

(async () => {
  for (const [nome, url] of candidatos) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', cookie: ML_COOKIE } });
      const ct = r.headers.get('content-type') || '';
      let corpo = '';
      if (ct.includes('json')) {
        try { corpo = forma(await r.json()); } catch { corpo = '(json inválido)'; }
      } else { corpo = '(' + ct.split(';')[0] + ')'; }
      console.log(`[${nome}] ${r.status} :: ${String(corpo).slice(0, 350)}`);
    } catch (e) { console.log(`[${nome}] ERRO ${e.message}`); }
    await new Promise((res) => setTimeout(res, 400));
  }
})();
