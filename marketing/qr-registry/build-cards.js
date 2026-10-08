// Builds the card and screen mockups as HTML, ready to photograph with Playwright.
const fs = require('fs');
const QR = require('/home/user/registry/node_modules/qrcode');
(async () => {
  const qr = await QR.toString('NQ1:7K4M2Q9P', { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#0f2236', light: '#ffffff' } });
  const nextqDark = fs.readFileSync('../logo-dark.svg', 'utf8');
  const nextqLight = fs.readFileSync('../logo-light.svg', 'utf8');
  const person = `<svg viewBox="0 0 120 150" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="150" fill="#dfe6ee"/><circle cx="60" cy="58" r="27" fill="#9fb0c3"/><path d="M14 150c3-36 22-54 46-54s43 18 46 54z" fill="#9fb0c3"/><text x="60" y="140" font-family="Plus Jakarta Sans" font-size="11" font-weight="700" fill="#6b7d92" text-anchor="middle">PHOTO</text></svg>`;
  const css = `
  @import url('../fonts.css');
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:transparent;font-family:'Plus Jakarta Sans',Arial,sans-serif;color:#0f2236}
  .card{width:856px;height:540px;border-radius:34px;overflow:hidden;position:relative;background:#fff;margin:20px}
  .navy{--c:#17324d;--a:#2bb3a3}
  .top{height:118px;background:var(--c);display:flex;align-items:center;justify-content:space-between;padding:0 40px;color:#fff}
  .brand b{display:block;font-family:'Bricolage Grotesque';font-weight:800;font-size:44px;letter-spacing:3px;line-height:1}
  .brand small{display:block;font-size:17px;font-weight:600;letter-spacing:4px;opacity:.85;margin-top:6px;text-transform:uppercase}
  .chip{background:var(--a);color:#06231f;font-weight:800;font-size:20px;letter-spacing:3px;padding:10px 20px;border-radius:12px}
  .mid{display:flex;gap:34px;padding:30px 40px 0}
  .photo{width:216px;height:272px;border-radius:20px;overflow:hidden;border:4px solid #eef2f6;flex:none}
  .photo svg{width:100%;height:100%;display:block}
  .who h2{font-family:'Bricolage Grotesque';font-weight:800;font-size:52px;line-height:1.02;margin-bottom:18px}
  .row{display:grid;grid-template-columns:170px 1fr;font-size:22px;line-height:1.25;margin-bottom:12px}
  .row span{color:#5b6b7e;font-weight:600}
  .row b{font-weight:800}
  .foot{position:absolute;left:0;right:0;bottom:0;height:62px;background:#f1f5f8;display:flex;align-items:center;justify-content:space-between;padding:0 40px;font-size:16px;color:#3e5064;font-weight:600}
  .foot svg{height:30px;width:auto}
  .mono{width:216px;height:216px;border-radius:50%;background:var(--c);color:#fff;display:grid;place-items:center;font-family:'Bricolage Grotesque';font-weight:800;font-size:84px;flex:none;margin-top:10px}
  .clockbig{display:inline-block;background:#eaf6f4;color:#0b5c52;border-radius:12px;padding:6px 16px;font-weight:800;font-size:28px;letter-spacing:2px;margin-bottom:16px}
  .back{display:flex;align-items:stretch}
  .qrside{width:420px;background:#fff;display:grid;place-items:center;border-right:2px dashed #dbe3ea}
  .qrbox{width:340px;height:340px;padding:18px;border-radius:24px;border:6px solid var(--c)}
  .qrbox svg{width:100%;height:100%;display:block}
  .info{flex:1;padding:44px 36px 0;position:relative}
  .info h3{font-family:'Bricolage Grotesque';font-weight:800;font-size:48px;line-height:1;color:var(--c)}
  .info .id{margin:18px 0 6px;font-size:16px;font-weight:700;color:#5b6b7e;letter-spacing:2px}
  .info .num{font-family:'Bricolage Grotesque';font-weight:800;font-size:40px;letter-spacing:4px}
  .info p{font-size:17px;line-height:1.4;color:#33465a;margin-top:16px;font-weight:600}
  .info .ret{font-size:14.5px;color:#5b6b7e;margin-top:14px}
  .bstrip{position:absolute;left:0;right:0;bottom:0;height:62px;background:var(--c);color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 30px;font-size:15px;font-weight:600}
  .bstrip svg{height:28px;width:auto}
  `;
  const front = (photo) => `<div class="card navy" id="${photo ? 'front-photo' : 'front-plain'}">
    <div class="top"><div class="brand"><b>CORRUSEAL</b><small>Staff transport</small></div><div class="chip">PASSENGER</div></div>
    <div class="mid">
      ${photo ? `<div class="photo">${person}</div>` : `<div class="mono">TM</div>`}
      <div class="who">
        <h2>Thabo<br>Mokoena</h2>
        ${photo ? '' : '<div class="clockbig">CLOCK NO. 10452</div>'}
        ${photo ? '<div class="row"><span>Clock number</span><b>10452</b></div>' : ''}
        <div class="row"><span>Pickup point</span><b>Vosloorus, Ext 28 rank</b></div>
        <div class="row"><span>Route</span><b>Vosloorus to Corruseal</b></div>
      </div>
    </div>
    <div class="foot"><span>Transport by Maponya and Moragi (Pty) Ltd</span>${nextqDark}</div>
  </div>`;
  const back = `<div class="card navy back" id="back">
    <div class="qrside"><div class="qrbox">${qr}</div></div>
    <div class="info">
      <h3>Scan to<br>register</h3>
      <div class="id">PASSENGER ID</div>
      <div class="num">7K4M 2Q9P</div>
      <p>Show this card to the driver when you board and when you get off. If it does not scan, read the number to the driver.</p>
      <p class="ret">If found, please return to Corruseal Group reception.</p>
      <div class="bstrip"><span>www.nextq.co.za</span>${nextqLight}</div>
    </div>
  </div>`;
  fs.writeFileSync('cards.html', `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${front(true)}${front(false)}${back}</body></html>`);
})();
