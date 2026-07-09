import { Hono } from 'hono';

export const dashboardRoute = new Hono();

dashboardRoute.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bentley OS</title>
<style>
  body{background:#0b0e14;color:#e6e6e6;font-family:ui-monospace,Menlo,monospace;margin:0;padding:2rem;}
  .wrap{max-width:640px;margin:0 auto;}
  h1{font-size:1.4rem;letter-spacing:.02em;}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#3fb950;margin-right:8px;}
  .card{background:#151a23;border:1px solid #222b38;border-radius:10px;padding:1rem 1.25rem;margin:1rem 0;}
  a{color:#58a6ff;text-decoration:none;} a:hover{text-decoration:underline;}
  .muted{color:#8b949e;font-size:.85rem;}
</style></head>
<body><div class="wrap">
  <h1><span class="dot"></span>Bentley OS — online</h1>
  <div class="card" id="status">Checking services…</div>
  <div class="card">
    <div class="muted">Endpoints</div>
    <p><a href="/health">/health</a> — API + DB status (JSON)</p>
  </div>
  <p class="muted">Self-hosted ontology server · <span id="time"></span></p>
</div>
<script>
  fetch('/health').then(r=>r.json()).then(d=>{
    document.getElementById('status').innerHTML =
      'API: <b>'+d.status+'</b><br>Database: <b>'+d.db+'</b><br>Service: '+d.service;
  }).catch(e=>{document.getElementById('status').textContent='health check failed';});
  document.getElementById('time').textContent = new Date().toLocaleString();
</script>
</body></html>`);
});

