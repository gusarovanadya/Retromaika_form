exports.handler = async () => {
  const envName = 'SUPABASE_URL';
  const keyName = ['SUPABASE', 'SERVICE', 'ROLE', 'KEY'].join('_');

  const rawUrl = process.env[envName] || '';
  const url = rawUrl.trim().replace(/\/+$/, '');
  const key = process.env[keyName] || '';

  const out = {
    hasUrl: Boolean(rawUrl),
    hasKey: Boolean(key),
    urlLength: rawUrl.length,
    hasWhitespace: rawUrl !== rawUrl.trim(),
    startsHttps: url.startsWith('https://'),
    host: null,
    pathname: null,
    endsSupabaseCo: false,
    urlParseError: null,
    restStatus: null,
    restBodyStart: null,
    restError: null,
  };

  try {
    const parsed = new URL(url);
    out.host = parsed.host;
    out.pathname = parsed.pathname;
    out.endsSupabaseCo = parsed.host.endsWith('.supabase.co');
  } catch (err) {
    out.urlParseError = err.message;
  }

  if (url && key && !out.urlParseError) {
    try {
      const res = await fetch(`${url}/rest/v1/orders?select=order_id&limit=1`, {
        headers: { apikey: key },
      });
      out.restStatus = res.status;
      out.restBodyStart = (await res.text()).slice(0, 240);
    } catch (err) {
      out.restError = err.message;
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(out, null, 2),
  };
};
