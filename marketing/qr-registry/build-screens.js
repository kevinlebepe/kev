// The driver's QR screen (phone) and Corruseal's live register (web), as HTML mockups.
const fs = require('fs');
const css = `@import url('../fonts.css');*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Plus Jakarta Sans',Arial,sans-serif;color:#141a2e;background:transparent}
.phone{width:400px;height:820px;margin:20px;border-radius:46px;background:#0f1424;padding:14px;box-shadow:0 20px 50px rgba(0,0,0,.25)}
.scr{width:100%;height:100%;border-radius:34px;background:#f2f5fb;overflow:hidden;display:flex;flex-direction:column}
.hd{background:#fff;padding:22px 20px 14px;border-bottom:1px solid #e4e9f2}
.hd small{display:block;font-size:12px;font-weight:700;color:#5b6b7e;letter-spacing:1.5px}
.hd b{display:block;font-size:20px;font-weight:800;margin-top:3px}
.seg{display:grid;grid-template-columns:1fr 1fr;background:#e8edf6;border-radius:12px;padding:4px;margin-top:12px}
.seg span{text-align:center;padding:8px 0;font-weight:800;font-size:14px;color:#5b6b7e;border-radius:9px}
.seg .on{background:#2456d6;color:#fff}
.acts{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:14px 16px 0}
.acts span{border-radius:14px;padding:13px 0;text-align:center;font-weight:800;font-size:16px;border:2px solid transparent}
.acts .in{background:#2456d6;color:#fff}.acts .out{background:#fff;color:#c4561a;border-color:#f3c3a4}
.cam{margin:14px 16px 0;height:230px;border-radius:20px;background:#1b2338;position:relative;text-align:center}
.cam i{position:absolute;top:76px;left:50%;margin-left:-64px;width:128px;height:128px;border:4px solid #3ad0b8;border-radius:18px}
.cam em{position:absolute;left:0;right:0;bottom:12px;color:#cfe0ff;font-style:normal;font-size:13px;font-weight:700}
.cam .ok{position:absolute;top:12px;left:12px;right:12px;background:#e6f7ef;color:#11643f;border-radius:12px;padding:9px 12px;font-weight:800;font-size:14px}
.cnt{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:12px 16px 0}
.cnt div{background:#fff;border-radius:14px;padding:10px 14px}
.cnt small{font-size:11px;font-weight:800;color:#5b6b7e;letter-spacing:1.2px}
.cnt b{display:block;font-size:30px;font-weight:800}
.list{padding:10px 16px 0;flex:1}
.it{display:flex;align-items:center;gap:10px;background:#fff;border-radius:12px;padding:9px 12px;margin-bottom:7px;font-size:14px;font-weight:700}
.it .d{width:10px;height:10px;border-radius:50%;background:#1fa36b;flex:none}
.it .d.m{background:#e2a33b}
.it span{margin-left:auto;color:#5b6b7e;font-weight:700;font-size:13px}
.type{margin:0 16px;text-align:center;font-weight:800;color:#2456d6;font-size:14px;padding:8px}
.dep{margin:6px 16px 16px;background:#141a2e;color:#fff;border-radius:16px;padding:14px;text-align:center;font-weight:800;font-size:16px}
.dep small{display:block;color:#ffcf8a;font-size:12.5px;margin-top:2px}
.web{width:1200px;height:700px;margin:20px;border-radius:18px;background:#f4f6fb;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.18);display:flex;flex-direction:column}
.wtop{background:#17324d;color:#fff;padding:18px 28px;display:flex;justify-content:space-between;align-items:center}
.wtop b{font-size:22px;font-weight:800}.wtop small{opacity:.8;font-weight:600}
.wb{padding:22px 28px;display:grid;grid-template-columns:380px 1fr;grid-template-rows:auto 1fr;gap:22px;flex:1}
.tiles{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;grid-column:1/-1}
.tile{background:#fff;border-radius:16px;padding:16px 20px}
.tile small{font-size:12px;font-weight:800;letter-spacing:1.4px;color:#5b6b7e}
.tile b{display:block;font-size:44px;font-weight:800;line-height:1.1}
.g{color:#14874f}.r{color:#c23b2f}
.veh{background:#fff;border-radius:16px;padding:14px}
.vr{display:grid;grid-template-columns:1fr auto;padding:9px 6px;border-bottom:1px solid #eef1f6;font-size:14.5px;font-weight:700}
.vr span{color:#5b6b7e}
.vr.sel{background:#eef4ff;border-radius:10px;border-bottom-color:transparent}
.tbl{background:#fff;border-radius:16px;padding:14px 18px}
.tbl h4{font-size:16px;font-weight:800;margin:2px 0 10px}
.tr{display:grid;grid-template-columns:1.4fr .8fr 1fr .7fr;padding:9px 4px;border-bottom:1px solid #eef1f6;font-size:14.5px;font-weight:600}
.tr.h{font-size:11.5px;font-weight:800;letter-spacing:1.2px;color:#5b6b7e}
.pill{display:inline-block;border-radius:99px;padding:2px 10px;font-size:12.5px;font-weight:800}
.pill.g{background:#e3f6ec}.pill.r{background:#fde8e6}`;
const it = (n, t, m) => `<div class="it"><i class="d${m ? ' m' : ''}"></i>${n}<span>${t}</span></div>`;
const phone = `<div class="phone" id="driver"><div class="scr">
<div class="hd"><small>VEHICLE 03 · TRIP 1 MORNING</small><b>Vosloorus to Corruseal</b><div class="seg"><span>Standard</span><span class="on">QR mode</span></div></div>
<div class="acts"><span class="in">Board</span><span class="out">Drop off</span></div>
<div class="cam"><div class="ok">Thabo Mokoena, 10452: boarded 05h47</div><i></i></div>
<div class="cnt"><div><small>EXPECTED</small><b>12</b></div><div><small>BOARDED</small><b>10</b></div></div>
<div class="list">${it('Thabo Mokoena', '05h47')}${it('Sipho Dlamini', '05h51')}${it('Lerato Nkosi', '05h52')}${it('Kabelo Molefe', '05h55 typed', true)}</div>
<div class="type">Type a passenger number instead</div>
<div class="dep">Depart<small>2 passengers not scanned</small></div>
</div></div>`;
const row = (n, c, s, t) => `<div class="tr"><span>${n}</span><span>${c}</span><span><span class="pill ${s ? 'g' : 'r'}">${s ? 'Boarded' : 'Not boarded'}</span></span><span>${t}</span></div>`;
const web = `<div class="web" id="dashboard"><div class="wtop"><div><b>Live transport register</b><br><small>Corruseal Group · Thursday, 8 October 2026</small></div><small>Transport by Maponya and Moragi</small></div>
<div class="wb"><div class="tiles"><div class="tile"><small>BOARDED</small><b class="g">34</b></div><div class="tile"><small>NOT BOARDED</small><b class="r">2</b></div><div class="tile"><small>EXPECTED</small><b>36</b></div></div>
<div class="veh">${[['Vehicle 01 · Soweto', '6 of 6'], ['Vehicle 02 · Thokoza', '5 of 5'], ['Vehicle 03 · Vosloorus', '10 of 12'], ['Vehicle 04 · Katlehong', '7 of 7'], ['Vehicle 05 · Tembisa', '4 of 4'], ['Vehicle 06 · Germiston', '2 of 2']].map(([v, n], i) => `<div class="vr${i === 2 ? ' sel' : ''}">${v}<span>${n}</span></div>`).join('')}</div>
<div class="tbl"><h4>Vehicle 03 · Vosloorus · Trip 1 morning · 10 of 12 boarded</h4><div class="tr h"><span>EMPLOYEE</span><span>CLOCK NO.</span><span>STATUS</span><span>TIME</span></div>
${row('Ayanda Zulu', '10533', 0, 'none')}${row('Naledi Khumalo', '10548', 0, 'none')}${row('Thabo Mokoena', '10452', 1, '05h47')}${row('Sipho Dlamini', '10483', 1, '05h51')}${row('Lerato Nkosi', '10501', 1, '05h52')}${row('Kabelo Molefe', '10517', 1, '05h55')}${row('Mpho Sithole', '10560', 1, '05h56')}</div></div></div>`;
fs.writeFileSync('screens.html', `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${phone}${web}</body></html>`);
