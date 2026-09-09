import http from 'node:http';
import {invoices, formatAmount, newestFirst} from './invoices.mjs';
import { exportInvoicesCsv } from './invoices.mjs';

http.createServer((req,res)=>{
  if (req.url === '/export.csv') {
    const csv = exportInvoicesCsv(newestFirst(invoices));
    res.writeHead(200, {'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="invoices.csv"'});
    res.end(csv);
    return;
  }

  res.writeHead(200,{'Content-Type':'text/html'});
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice Desk</title><style>*{box-sizing:border-box}body{margin:0;background:#111314;color:#f4f4f1;font:16px system-ui;padding:60px}main{max-width:1100px;margin:auto}.eyebrow{color:#82ddbd;font-size:13px;letter-spacing:2px}h1{font-size:44px;margin:15px 0}p{color:#a4aaa8}.cards{display:flex;gap:20px;margin:40px 0}.card{flex:1;background:#1b1e1f;border:1px solid #323837;border-radius:16px;padding:24px}.card strong{display:block;font-size:30px;margin-top:14px}table{border-collapse:collapse;width:100%;text-align:left}th{color:#a4aaa8;font-size:12px;letter-spacing:1px}td,th{padding:24px 16px;border-bottom:1px solid #303535}.badge{background:#253d34;color:#a9efd5;border-radius:20px;padding:6px 12px;font-size:13px}footer{margin-top:40px;color:#818c86;font-size:13px}</style><main><div class="eyebrow">INVOICE DESK / BILLING</div><h1>Keep your billing in view.</h1><p>Track invoices, payments, and outstanding balances.</p><div class="cards"><div class="card">Total invoiced<strong>${formatAmount(invoices.reduce((a,b)=>a+b.cents,0))}</strong></div><div class="card">Invoices<strong>3</strong></div><div class="card">Paid<strong>2 / 3</strong></div></div><div><button onclick="location.href='/export.csv'" style="background:#253d34;color:#a9efd5;border:none;padding:12px 24px;border-radius:12px;font-size:14px;cursor:pointer;">Export CSV</button></div><table><thead><tr><th>INVOICE</th><th>CLIENT</th><th>ISSUED</th><th>AMOUNT</th><th>STATUS</th></tr></thead><tbody>${newestFirst(invoices).map(i=>`<tr><td>${i.id}</td><td>${i.client}</td><td>${i.date}</td><td>${formatAmount(i.cents)}</td><td><span class="badge">${i.status}</span></td></tr>`).join('')}</tbody></table><footer>Invoice Desk · Billing overview</footer></main></html>`);
}).listen(Number(process.env.PORT ?? 3000),process.env.HOST ?? '0.0.0.0',()=>console.log('Invoice Desk is listening on port 3000'));
