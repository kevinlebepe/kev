// Builds the passenger card mockups as HTML, in Corruseal's look (orange and charcoal, their logo first).
const fs = require('fs');
const QR = require('/home/user/registry/node_modules/qrcode');
const uri = (f, t) => `data:${t};base64,${fs.readFileSync(f).toString('base64')}`;
(async () => {
  const qr = await QR.toString('NQ1:7K4M2Q9P', { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#262626', light: '#ffffff' } });
  const logo = uri('corruseal-logo@3x.png', 'image/png');
  const photo = uri('sample-photo.jpg', 'image/jpeg');
  const nextqDark = fs.readFileSync('../logo-dark.svg', 'utf8');
  const nextqLight = fs.readFileSync('../logo-light.svg', 'utf8');
  const css = `
  @import url('../fonts.css');
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:transparent;font-family:'Plus Jakarta Sans',Arial,sans-serif;color:#262626}
  .card{--o:#e9782d;--k:#262626;width:856px;height:540px;border-radius:34px;overflow:hidden;position:relative;background:#fff;margin:20px}
  .top{height:118px;display:flex;align-items:center;justify-content:space-between;padding:0 38px 0 34px}
  .top img{height:74px;width:auto;display:block}
  .tag{text-align:right;font-weight:800;letter-spacing:3px;font-size:15px;color:var(--k);line-height:1.35}
  .tag b{display:block;color:var(--o);font-size:21px;letter-spacing:2px}
  .rule{height:8px;background:var(--o)}
  .mid{display:flex;gap:32px;padding:26px 38px 0}
  .photo{width:206px;height:258px;border-radius:16px;overflow:hidden;flex:none;border:5px solid var(--o)}
  .photo img{width:100%;height:100%;object-fit:cover;display:block}
  .who h2{font-weight:800;font-size:48px;line-height:1.02;margin:4px 0 16px;color:var(--k)}
  .row{display:grid;grid-template-columns:160px 1fr;font-size:21px;line-height:1.25;margin-bottom:11px}
  .row span{color:#777;font-weight:600}
  .row b{font-weight:800}
  .clock{display:inline-block;background:var(--o);color:#fff;border-radius:10px;padding:5px 14px;font-weight:800;font-size:26px;letter-spacing:2px;margin-bottom:16px}
  .mono{width:206px;height:206px;border-radius:50%;background:var(--k);color:#fff;display:grid;place-items:center;font-weight:800;font-size:80px;flex:none;margin-top:14px;border:7px solid var(--o)}
  .foot{position:absolute;left:0;right:0;bottom:0;height:60px;background:var(--k);display:flex;align-items:center;justify-content:space-between;padding:0 38px;font-size:15.5px;color:#fff;font-weight:600}
  .foot svg{height:28px;width:auto}
  .back{display:flex}
  .qrside{width:420px;display:grid;place-items:center;background:#fff}
  .qrbox{width:336px;height:336px;padding:18px;border-radius:22px;border:7px solid var(--o)}
  .qrbox svg{width:100%;height:100%;display:block}
  .info{flex:1;background:var(--k);color:#fff;padding:40px 34px 0;position:relative}
  .info img{height:40px;background:#fff;border-radius:8px;padding:6px 10px;box-sizing:content-box}
  .info h3{font-weight:800;font-size:44px;line-height:1;margin-top:26px}
  .info h3 em{font-style:normal;color:var(--o)}
  .info .id{margin:20px 0 4px;font-size:14px;font-weight:700;color:#bdbdbd;letter-spacing:2px}
  .info .num{font-weight:800;font-size:38px;letter-spacing:4px;color:var(--o)}
  .info p{font-size:15.5px;line-height:1.42;color:#e6e6e6;margin-top:14px;font-weight:600}
  .info .ret{font-size:13.5px;color:#a8a8a8;margin-top:10px}
  .info .by{position:absolute;left:34px;right:34px;bottom:20px;display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#bdbdbd;font-weight:600}
  .info .by svg{height:24px;width:auto}
  `;
  const front = (withPhoto) => `<div class="card" id="${withPhoto ? 'front-photo' : 'front-plain'}">
    <div class="top"><img src="${logo}" alt="Corruseal Group"><div class="tag"><b>STAFF TRANSPORT</b>PASSENGER CARD</div></div>
    <div class="rule"></div>
    <div class="mid">
      ${withPhoto ? `<div class="photo"><img src="${photo}" alt=""></div>` : '<div class="mono">TM</div>'}
      <div class="who">
        <h2>Thabo<br>Mokoena</h2>
        ${withPhoto ? '<div class="row"><span>Clock number</span><b>10452</b></div>' : '<div class="clock">CLOCK NO. 10452</div>'}
        <div class="row"><span>Pickup point</span><b>Vosloorus, Ext 28 rank</b></div>
        <div class="row"><span>Route</span><b>Vosloorus to Corruseal</b></div>
      </div>
    </div>
    <div class="foot"><span>Transport by Maponya and Moragi (Pty) Ltd</span>${nextqLight}</div>
  </div>`;
  const back = `<div class="card back" id="back">
    <div class="qrside"><div class="qrbox">${qr}</div></div>
    <div class="info">
      <img src="${logo}" alt="Corruseal Group">
      <h3>Scan to <em>register</em></h3>
      <div class="id">PASSENGER ID</div>
      <div class="num">7K4M 2Q9P</div>
      <p>Show this card to the driver when you board and when you get off. If it does not scan, read the number to the driver.</p>
      <p class="ret">If found, please return to Corruseal Group reception.</p>
      <div class="by"><span>Powered by</span>${nextqLight}</div>
    </div>
  </div>`;
  fs.writeFileSync('cards.html', `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${front(true)}${front(false)}${back}</body></html>`);
})();
