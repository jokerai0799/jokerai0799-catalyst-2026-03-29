const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITEMAP_PATH = path.join(ROOT, 'sitemap.xml');
const SITE_HOST = 'quotechaser.online';
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim();
}

function findKeyFile() {
  if (process.env.INDEXNOW_KEY) {
    const key = process.env.INDEXNOW_KEY.trim();
    return {
      key,
      keyPath: `/${key}.txt`,
      keyLocation: `https://${SITE_HOST}/${key}.txt`,
    };
  }

  const candidates = fs.readdirSync(ROOT)
    .filter((name) => /^[a-f0-9]{32}\.txt$/i.test(name))
    .sort();

  for (const candidate of candidates) {
    const absolute = path.join(ROOT, candidate);
    const key = readFile(absolute);
    if (!/^[a-f0-9]{32}$/i.test(key)) continue;
    if (`${key}.txt`.toLowerCase() !== candidate.toLowerCase()) continue;
    return {
      key,
      keyPath: `/${candidate}`,
      keyLocation: `https://${SITE_HOST}/${candidate}`,
    };
  }

  throw new Error('No valid IndexNow key file found at the project root.');
}

function parseUrlsFromSitemap(rawXml) {
  const urls = [...rawXml.matchAll(/<loc>(.*?)<\/loc>/gi)].map((match) => match[1].trim());
  if (!urls.length) throw new Error('No URLs found in sitemap.xml');
  return urls;
}

async function submit() {
  const sitemap = readFile(SITEMAP_PATH);
  const urlList = parseUrlsFromSitemap(sitemap);
  const { key, keyLocation } = findKeyFile();

  const payload = {
    host: SITE_HOST,
    key,
    keyLocation,
    urlList,
  };

  const response = await fetch(INDEXNOW_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`IndexNow submission failed (${response.status}): ${body || '<empty>'}`);
  }

  console.log(`IndexNow accepted ${urlList.length} URL(s) for ${SITE_HOST}.`);
  console.log(`Key location: ${keyLocation}`);
  if (body) console.log(body);
}

submit().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
