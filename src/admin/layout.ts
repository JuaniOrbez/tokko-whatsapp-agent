/** Layout compartido por las páginas de /admin que no son el formulario de configuración. */
export function esc(value: string | number | undefined): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function pageShell(title: string, body: string, backHref = "/admin"): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --brand: #6d5ef8; --brand-dark: #5646e0; --bg: #f4f5fb; --card: #ffffff; --border: #eaeaf3; --text: #16162a; --text-muted: #75758c; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--text); }
  header { background: linear-gradient(120deg, var(--brand) 0%, var(--brand-dark) 55%, #4433c9 100%); color: white; padding: 22px 24px; display: flex; align-items: center; gap: 12px; }
  header a { color: white; text-decoration: none; font-size: 0.85rem; opacity: 0.85; }
  header h1 { font-size: 1.15rem; margin: 0; font-weight: 700; }
  main { max-width: 780px; margin: 28px auto 64px; padding: 0 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; margin-bottom: 12px; box-shadow: 0 1px 2px rgba(23,21,60,0.05); }
  .card a { color: var(--text); text-decoration: none; display: flex; justify-content: space-between; align-items: center; }
  .card a:hover { color: var(--brand); }
  .card .meta { font-size: 0.8rem; color: var(--text-muted); }
  .empty { color: var(--text-muted); padding: 20px 0; }
  .mermaid-card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 20px 24px 16px; box-shadow: 0 1px 2px rgba(23,21,60,0.05); overflow-x: auto; }
  .flow-legend { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 8px; padding-top: 14px; border-top: 1px solid var(--border); }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.78rem; color: var(--text-muted); }
  .legend-item .swatch { display: inline-block; width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .msg-log { margin-top: 24px; }
  .msg { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; margin-bottom: 8px; font-size: 0.88rem; }
  .msg.user { border-left: 3px solid var(--brand); }
  .msg.assistant { border-left: 3px solid var(--text-muted); }
  .msg .role { font-weight: 600; font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; }
</style>
</head>
<body>
  <header>
    <div>
      <a href="${esc(backHref)}">← Panel</a>
      <h1>${esc(title)}</h1>
    </div>
  </header>
  <main>${body}</main>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script>
    if (window.mermaid) {
      mermaid.initialize({
        startOnLoad: true,
        theme: "base",
        flowchart: { curve: "basis" },
        themeVariables: {
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
          fontSize: "13px",
          lineColor: "#c3c2cf",
          edgeLabelBackground: "#f4f5fb",
        },
      });
    }
  </script>
</body>
</html>`;
}
