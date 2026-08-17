// Sonda v2: mensagens de validação + caminhos de API embutidos nas páginas.
const ML_COOKIE = process.env.ML_COOKIE;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const range = '2026-08-10T00:00:00.000-03:00--2026-08-16T23:59:59.999-03:00';
const BASE = 'https://www.mercadolivre.com.br/affiliate-program';
const H = { 'user-agent': UA, accept: 'application/json', cookie: ML_COOKIE };

(async () => {
  // 1) O 400 de type=LINKS diz quais valores o enum aceita?
  for (const tp of ['LINKS', 'XX']) {
    const r = await fetch(`${BASE}/api/dashboard/general?filter_time_range=${encodeURIComponent(range)}&metric_tab=general&type=${tp}&page=1`, { headers: H });
    let j = {}; try { j = await r.json(); } catch {}
    console.log(`[erro type=${tp}] ${r.status} :: details=${j.details || '-'} | message=${j.message || '-'}`);
  }

  // 2) Raspar páginas em busca de caminhos de API e enums
  const paginas = ['/dashboard', '/hub', '/links', '/my-links', '/panel', ''];
  const apis = new Set(), tipos = new Set();
  for (const pg of paginas) {
    try {
      const r = await fetch(BASE + pg, { headers: { ...H, accept: 'text/html' }, redirect: 'follow' });
      const html = await r.text();
      for (const m of html.matchAll(/affiliate-program\/api\/[A-Za-z0-9/_.-]+/g)) apis.add(m[0]);
      for (const m of html.matchAll(/type["']?\s*[:=]\s*["']([A-Z_]{3,20})["']/g)) tipos.add(m[1]);
      console.log(`[pagina ${pg || '/'}] ${r.status} html=${html.length}b`);
    } catch (e) { console.log(`[pagina ${pg}] ERRO ${e.message}`); }
    await new Promise((res) => setTimeout(res, 300));
  }
  console.log('[apis embutidas] ' + ([...apis].join(' | ') || 'nenhuma'));
  console.log('[tipos citados] ' + ([...tipos].join(', ') || 'nenhum'));

  // 3) Bundles JS citados nas páginas que mencionem 'dashboard' — raspar tambem
  try {
    const r = await fetch(BASE + '/dashboard', { headers: { ...H, accept: 'text/html' } });
    const html = await r.text();
    const srcs = [...html.matchAll(/src="(https?:\/\/[^"]+\.js)"/g)].map(m => m[1])
      .filter(u => /affiliat|dashboard/i.test(u)).slice(0, 6);
    console.log('[bundles candidatos] ' + (srcs.join(' | ') || 'nenhum'));
    for (const u of srcs) {
      const rb = await fetch(u, { headers: { 'user-agent': UA } });
      const js = await rb.text();
      const rotas = new Set([...js.matchAll(/affiliate-program\/api\/[A-Za-z0-9/_.${}-]+/g)].map(m => m[0]));
      const enums = new Set([...js.matchAll(/["'](GENERAL|LINK\w*|TAG\w*|PRODUCT\w*|ORDER\w*|CAMPAIGN\w*|LABEL\w*)["']/g)].map(m => m[1]));
      console.log(`[bundle ${u.slice(-40)}] rotas: ${[...rotas].slice(0, 15).join(' | ') || '-'} :: enums: ${[...enums].slice(0, 15).join(',') || '-'}`);
    }
  } catch (e) { console.log('[bundles] ERRO ' + e.message); }
})();
